import { useState } from "react";
import type {
  AuditAction,
  AuditEventView,
  AuditOutcome,
  AuditTargetType,
} from "@singularity/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useParams } from "react-router";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import {
  EmptyTableRow,
  LoadingTableRows,
  PageFailure,
  PageHeader,
  SectionHeading,
} from "@/enterprise/components.tsx";
import {
  getOrganizationAuditEvents,
  getSpaceAuditEvents,
  organizationAuditEventsQueryKey,
  spaceAuditEventsQueryKey,
} from "@/enterprise/api.ts";

const PAGE_SIZE = 50;

const actionLabels: Record<AuditAction, string> = {
  "authentication.login": "登录",
  "backup.create": "创建备份",
  "content.delete": "删除内容",
  "content.edit": "编辑内容",
  "content.export": "导出内容",
  "permission.change": "变更权限",
  "restore.activate": "激活恢复空间",
  "restore.create": "创建恢复",
  "share.create": "创建分享",
  "share.password-change": "修改分享密码",
  "share.revoke": "撤销分享",
};

const targetTypeLabels: Record<AuditTargetType, string> = {
  backup: "备份",
  document: "文档",
  group: "用户组",
  invitation: "邀请",
  membership: "成员关系",
  "oidc-provider": "OIDC Provider",
  organization: "组织",
  restore: "恢复任务",
  session: "会话",
  share: "分享",
  space: "空间",
  user: "用户",
};

const outcomeLabels: Record<AuditOutcome, string> = {
  denied: "已拒绝",
  failed: "失败",
  succeeded: "成功",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function outcomeVariant(
  outcome: AuditOutcome,
): "destructive" | "outline" | "secondary" {
  switch (outcome) {
    case "denied":
      return "outline";
    case "failed":
      return "destructive";
    case "succeeded":
      return "secondary";
  }
}

interface AuditPageContentProps {
  organizationId: string;
  scope: "organization" | "space";
  spaceId: string | null;
}

function AuditPageContent({
  organizationId,
  scope,
  spaceId,
}: AuditPageContentProps) {
  const [beforeSequence, setBeforeSequence] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const resolvedSpaceId = spaceId ?? "";
  const queryKey =
    scope === "organization"
      ? organizationAuditEventsQueryKey(organizationId, beforeSequence)
      : spaceAuditEventsQueryKey(
          organizationId,
          resolvedSpaceId,
          beforeSequence,
        );
  const eventsQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      scope === "organization"
        ? getOrganizationAuditEvents(
            organizationId,
            beforeSequence,
            PAGE_SIZE + 1,
            signal,
          )
        : getSpaceAuditEvents(
            organizationId,
            resolvedSpaceId,
            beforeSequence,
            PAGE_SIZE + 1,
            signal,
          ),
  });

  if (eventsQuery.error) {
    return (
      <PageFailure
        error={eventsQuery.error}
        onRetry={() => void eventsQuery.refetch()}
      />
    );
  }

  const events = eventsQuery.data?.events ?? [];
  const pageEvents = events.slice(0, PAGE_SIZE);
  const hasNextPage = events.length > PAGE_SIZE;

  return (
    <div className="flex flex-col">
      <PageHeader
        actions={
          <Button
            aria-label="刷新审计事件"
            disabled={eventsQuery.isFetching}
            onClick={() => void eventsQuery.refetch()}
            size="icon-sm"
            variant="outline"
          >
            <RefreshCwIcon aria-hidden="true" />
          </Button>
        }
        description={
          scope === "organization"
            ? "组织内登录、权限与资源操作记录"
            : "当前空间的权限、内容与运维操作记录"
        }
        title={scope === "organization" ? "组织审计" : "空间审计"}
      />
      <section>
        <SectionHeading count={pageEvents.length} title="审计事件" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>序号</TableHead>
              <TableHead>发生时间</TableHead>
              <TableHead>动作</TableHead>
              <TableHead>操作者</TableHead>
              <TableHead>目标</TableHead>
              <TableHead>范围</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>链信息</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {eventsQuery.isPending ? (
              <LoadingTableRows columns={8} rows={6} />
            ) : pageEvents.length === 0 ? (
              <EmptyTableRow columns={8} label="当前页没有审计事件" />
            ) : (
              pageEvents.map((event: AuditEventView) => (
                <TableRow key={event.auditEventId}>
                  <TableCell className="font-mono text-xs">{event.sequence}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(event.occurredAt)}
                  </TableCell>
                  <TableCell>{actionLabels[event.action]}</TableCell>
                  <TableCell>
                    {event.actorUserId === null ? (
                      <span className="text-muted-foreground">系统</span>
                    ) : (
                      <code className="text-xs">{event.actorUserId}</code>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-40 flex-col">
                      <span>{targetTypeLabels[event.targetType]}</span>
                      <code className="truncate text-xs text-muted-foreground">
                        {event.targetId}
                      </code>
                    </div>
                  </TableCell>
                  <TableCell>
                    {event.spaceId === null ? (
                      <span>组织</span>
                    ) : (
                      <code className="text-xs">{event.spaceId}</code>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={outcomeVariant(event.outcome)}>
                      {outcomeLabels[event.outcome]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-28 flex-col font-mono text-xs">
                      <span title={event.mac}>{event.mac.slice(0, 12)}...</span>
                      <span className="text-muted-foreground">密钥 {event.keyVersion}</span>
                      <span className="text-muted-foreground" title={event.requestId}>
                        请求 {event.requestId.slice(0, 8)}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <div className="flex min-h-12 items-center justify-end gap-2 border-t px-3">
          <span className="mr-2 text-xs text-muted-foreground">
            第 {cursorHistory.length + 1} 页
          </span>
          <Button
            disabled={cursorHistory.length === 0 || eventsQuery.isFetching}
            onClick={() => {
              const previousCursor =
                cursorHistory[cursorHistory.length - 1] ?? null;
              setCursorHistory((history) => history.slice(0, -1));
              setBeforeSequence(previousCursor);
            }}
            size="sm"
            variant="outline"
          >
            <ChevronLeftIcon data-icon="inline-start" />
            上一页
          </Button>
          <Button
            disabled={!hasNextPage || eventsQuery.isFetching}
            onClick={() => {
              const lastEvent = pageEvents[pageEvents.length - 1];
              if (lastEvent !== undefined) {
                setCursorHistory((history) => [...history, beforeSequence]);
                setBeforeSequence(lastEvent.sequence);
              }
            }}
            size="sm"
            variant="outline"
          >
            下一页
            <ChevronRightIcon data-icon="inline-end" />
          </Button>
        </div>
      </section>
    </div>
  );
}

export function AuditPage({ scope }: { scope: "organization" | "space" }) {
  const parameters = useParams();
  const organizationId = parameters.organizationId ?? "";
  const spaceId = scope === "space" ? (parameters.spaceId ?? "") : null;
  const scopeKey = `${organizationId}:${spaceId ?? "organization"}`;

  return (
    <AuditPageContent
      key={scopeKey}
      organizationId={organizationId}
      scope={scope}
      spaceId={spaceId}
    />
  );
}
