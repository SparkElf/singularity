import type {
    ProtyleSubscription,
    ProtyleSubscriptionOptions,
    ProtyleTransport,
} from "../../../../enterprise/packages/protyle-browser/src/contracts";

export type UpstreamLocalSubscriptionOptions<TMessage> = ProtyleSubscriptionOptions<TMessage> & {
    readonly sourceEditorId: string;
};

export type UpstreamLocalProtyleTransport<TMessage> = Omit<ProtyleTransport<TMessage>, "subscribe"> & {
    subscribe: (options: UpstreamLocalSubscriptionOptions<TMessage>) => ProtyleSubscription;
};

export interface UpstreamLocalTransportDependencies<TMessage> {
    readonly connect: (options: UpstreamLocalSubscriptionOptions<TMessage>) => ProtyleSubscription;
    readonly request: ProtyleTransport<TMessage>["request"];
    readonly upload: ProtyleTransport<TMessage>["upload"];
}

/** 创建带订阅所有权和显式 dispose 生命周期的上游本地 Transport。 */
export const createUpstreamLocalProtyleTransport = <TMessage>(
    dependencies: UpstreamLocalTransportDependencies<TMessage>,
): UpstreamLocalProtyleTransport<TMessage> => {
    const subscriptions = new Set<ProtyleSubscription>();
    let disposed = false;

    const assertAvailable = () => {
        if (disposed) {
            throw new Error("[protyle.upstream-local] transport is disposed");
        }
    };

    return {
        request: <TResponse>(path: string, body: unknown, options) => {
            assertAvailable();
            return dependencies.request<TResponse>(path, body, options);
        },
        upload: <TResponse>(body: FormData, options) => {
            assertAvailable();
            return dependencies.upload<TResponse>(body, options);
        },
        subscribe: (options) => {
            assertAvailable();
            const connection = dependencies.connect(options);
            let disconnected = false;
            const subscription: ProtyleSubscription = {
                disconnect: () => {
                    if (disconnected) {
                        return;
                    }
                    disconnected = true;
                    subscriptions.delete(subscription);
                    connection.disconnect();
                },
            };
            subscriptions.add(subscription);
            return subscription;
        },
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            const failures: unknown[] = [];
            Array.from(subscriptions).forEach((subscription) => {
                try {
                    subscription.disconnect();
                } catch (error) {
                    console.error("[protyle.upstream-local] subscription disconnect failed", error);
                    failures.push(error);
                }
            });
            if (failures.length > 0) {
                throw new AggregateError(failures, "[protyle.upstream-local] subscription disposal failed");
            }
        },
    };
};
