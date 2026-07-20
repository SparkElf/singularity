import type {ProtyleContentIdentity} from "../../../../enterprise/packages/protyle-browser/src/contracts";
import {protyleContentIdentity} from "../util/contentLoad";

type ProtyleSpaceContentScopeIdentity = ProtyleContentIdentity & {readonly spaceId: string};

type ProtyleLocalContentScopeIdentity = ProtyleContentIdentity & {readonly localAppId: string};

export type ProtyleContentScopeIdentity =
    ProtyleSpaceContentScopeIdentity | ProtyleLocalContentScopeIdentity;

/** 判断两个编辑器来源是否属于同一空间或同一上游本地应用，禁止跨 scope 消费事件。 */
export const isSameProtyleContentScope = (
    current: ProtyleContentScopeIdentity,
    source: ProtyleContentScopeIdentity,
): boolean => {
    if ("spaceId" in source) {
        return "spaceId" in current && current.spaceId === source.spaceId;
    }
    return "localAppId" in current && current.localAppId === source.localAppId;
};

/** 从显式 Session/local runtime 取得内容 scope 身份，不从 DOM 或全局首响应推断。 */
export const protyleContentScopeIdentity = (protyle: IProtyle): ProtyleContentScopeIdentity => {
    const identity = protyleContentIdentity(protyle);
    if ("localAppId" in protyle.runtime) {
        return {...identity, localAppId: protyle.runtime.localAppId};
    }
    if (!protyle.session) {
        throw new Error("[protyle.runtime] bound editor has no content scope");
    }
    return {...identity, spaceId: protyle.session.spaceId};
};

/** 判断编辑器是否仍属于给定 scope，用于丢弃路由或文档代次变化后的迟到事件。 */
export const isCurrentProtyleContentScope = (
    protyle: IProtyle,
    source: ProtyleContentScopeIdentity,
): boolean => isSameProtyleContentScope(protyleContentScopeIdentity(protyle), source);
