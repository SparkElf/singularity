import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import {
  DatabaseRuntime,
  Prisma,
  type DatabaseNotificationSubscription,
} from "@singularity/database";
import { z } from "zod";

import { kernelErrorContext } from "./error-context.js";
import { SpaceConnectionRegistry } from "./space-connection.registry.js";

export const ACCESS_CHANGE_CHANNEL = "singularity_access_changed";

const accessSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auth-session"), value: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("user"), value: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("organization"), value: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("space"), value: z.string().uuid() }).strict(),
]);

const accessChangedSchema = z
  .object({
    kind: z.literal("close"),
    reason: z.enum(["unauthenticated", "forbidden"]),
    requestId: z.string().uuid(),
    selectors: z.array(accessSelectorSchema).nonempty(),
  })
  .strict();

const sessionExpiryChangedSchema = z
  .object({
    authSessionId: z.string().uuid(),
    expiresAt: z.string().datetime({ offset: true }),
    kind: z.literal("session-expiry"),
    requestId: z.string().uuid(),
  })
  .strict();

const accessChangeNotificationSchema = z.discriminatedUnion("kind", [
  accessChangedSchema,
  sessionExpiryChangedSchema,
]);

export type AccessSelector = z.infer<typeof accessSelectorSchema>;
export type AccessChanged = z.infer<typeof accessChangedSchema>;
export type AccessChangeNotification = z.infer<
  typeof accessChangeNotificationSchema
>;

@Injectable()
export class AccessChangedPublisher {
  async publish(
    transaction: Prisma.TransactionClient,
    change: AccessChanged,
  ): Promise<void> {
    await this.#notify(transaction, change);
  }

  async refreshSessionExpiry(
    transaction: Prisma.TransactionClient,
    input: {
      authSessionId: string;
      expiresAt: Date;
      requestId: string;
    },
  ): Promise<void> {
    await this.#notify(transaction, {
      authSessionId: input.authSessionId,
      expiresAt: input.expiresAt.toISOString(),
      kind: "session-expiry",
      requestId: input.requestId,
    });
  }

  async #notify(
    transaction: Prisma.TransactionClient,
    notification: AccessChangeNotification,
  ): Promise<void> {
    const payload = JSON.stringify(notification);
    await transaction.$queryRaw(
      Prisma.sql`SELECT pg_notify(${ACCESS_CHANGE_CHANNEL}, ${payload})`,
    );
  }
}

@Injectable()
export class AccessChangedListener
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  readonly #logger = new Logger("AccessChangedListener");
  #failed = false;
  #subscription: DatabaseNotificationSubscription | undefined;
  #subscriptionClose: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly connections: SpaceConnectionRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      this.#subscription = await this.database.listen(
        ACCESS_CHANGE_CHANNEL,
        (payload) => this.#consume(payload),
        (error) => this.#fail("listener-failed", error),
      );
    } catch (error) {
      this.#fail("listener-unavailable", error);
      return;
    }
    if (!this.connections.markNotificationListenerReady("access")) {
      this.#failed = true;
      await this.#closeSubscription();
      return;
    }
    this.#logger.log({
      event: "access.notification",
      outcome: "listening",
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.#failed = true;
    this.connections.failNotificationListener("access");
    await this.#closeSubscription();
  }

  #consume(payload: string): void {
    if (this.#failed) {
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload);
    } catch (error) {
      this.#fail(
        "invalid-event",
        new Error("Access notification event is invalid", { cause: error }),
      );
      return;
    }
    const parsed = accessChangeNotificationSchema.safeParse(decoded);
    if (!parsed.success) {
      this.#fail("invalid-event", parsed.error);
      return;
    }
    if (parsed.data.kind === "close") {
      this.connections.closeByAccessChange(parsed.data);
      const selectorValues: Partial<
        Record<AccessSelector["kind"], string[]>
      > = {};
      for (const selector of parsed.data.selectors) {
        const values = selectorValues[selector.kind];
        if (values === undefined) {
          selectorValues[selector.kind] = [selector.value];
        } else {
          values.push(selector.value);
        }
      }
      this.#logger.debug({
        event: "authorization.change",
        kind: parsed.data.kind,
        outcome: "applied",
        requestId: parsed.data.requestId,
        selectorKinds: parsed.data.selectors.map((selector) => selector.kind),
        selectorValues,
      });
    } else {
      this.connections.refreshSessionExpiry(
        parsed.data.authSessionId,
        new Date(parsed.data.expiresAt),
      );
      this.#logger.debug({
        authSessionId: parsed.data.authSessionId,
        event: "authorization.change",
        kind: parsed.data.kind,
        outcome: "applied",
        requestId: parsed.data.requestId,
      });
    }
  }

  #fail(
    outcome: "invalid-event" | "listener-failed" | "listener-unavailable",
    error: unknown,
  ): void {
    if (this.#failed) {
      return;
    }
    this.#failed = true;
    this.#logger.error({
      ...kernelErrorContext(error, "Access notification lifecycle failed"),
      event: "access.notification",
      outcome,
    });
    this.connections.failNotificationListener("access");
    void this.#closeSubscription();
  }

  #closeSubscription(): Promise<void> {
    const subscription = this.#subscription;
    this.#subscription = undefined;
    if (subscription === undefined) {
      return this.#subscriptionClose;
    }
    this.#subscriptionClose = subscription.close().catch((error: unknown) => {
      this.#logger.error({
        ...kernelErrorContext(error, "Access notification close failed"),
        event: "access.notification",
        outcome: "close-failed",
      });
    });
    return this.#subscriptionClose;
  }
}
