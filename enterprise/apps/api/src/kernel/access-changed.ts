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
  #subscription: DatabaseNotificationSubscription | undefined;

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly connections: SpaceConnectionRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      this.#subscription = await this.database.listen(
        ACCESS_CHANGE_CHANNEL,
        (payload) => this.#consume(payload),
        () => {
          this.#logger.error({
            event: "access.notification",
            outcome: "listener-failed",
          });
          this.connections.failNotificationListener();
        },
      );
    } catch {
      this.#logger.error({
        event: "access.notification",
        outcome: "listener-unavailable",
      });
      this.connections.failNotificationListener();
      return;
    }
    if (!this.connections.markNotificationListenerReady()) {
      await this.#subscription.close();
      this.#subscription = undefined;
      return;
    }
    this.#logger.log({
      event: "access.notification",
      outcome: "listening",
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.connections.failNotificationListener();
    await this.#subscription?.close();
  }

  #consume(payload: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload);
    } catch {
      decoded = undefined;
    }
    const parsed = accessChangeNotificationSchema.safeParse(decoded);
    if (!parsed.success) {
      this.#logger.error({
        event: "access.notification",
        outcome: "invalid-event",
      });
      this.connections.failNotificationListener();
      return;
    }
    if (parsed.data.kind === "close") {
      this.connections.closeByAccessChange(parsed.data);
    } else {
      this.connections.refreshSessionExpiry(
        parsed.data.authSessionId,
        new Date(parsed.data.expiresAt),
      );
    }
    this.#logger.debug({
      event: "authorization.change",
      kind: parsed.data.kind,
      outcome: "applied",
      requestId: parsed.data.requestId,
    });
  }
}
