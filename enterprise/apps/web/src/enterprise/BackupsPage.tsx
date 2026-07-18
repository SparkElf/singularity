import { useState } from "react";
import {
  createSpaceRestoreRequestSchema,
  type SpaceBackupStatus,
  type SpaceBackupView,
  type SpaceRestoreStatus,
  type SpaceRestoreView,
} from "@singularity/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DatabaseBackupIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useParams, useSearchParams } from "react-router";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";
import {
  ConfirmAction,
  EmptyTableRow,
  LoadingTableRows,
  MutationFailure,
  PageFailure,
  PageHeader,
  SectionHeading,
} from "@/enterprise/components.tsx";
import {
  activateSpaceRestore,
  createSpaceBackup,
  createSpaceRestore,
  getSpaceBackups,
  getSpaceRestore,
  managedSpacesQueryKey,
  spaceBackupsQueryKey,
  spaceRestoreQueryKey,
} from "@/enterprise/api.ts";
import { authorizedSpacesQueryKey } from "@/spaces/api.ts";

const backupStatusLabels: Record<SpaceBackupStatus, string> = {
  failed: "失败",
  queued: "等待处理",
  running: "备份中",
  succeeded: "可恢复",
};

const restoreStatusLabels: Record<SpaceRestoreStatus, string> = {
  activated: "已激活",
  failed: "失败",
  queued: "等待处理",
  restoring: "恢复中",
  "ready-for-activation": "等待激活",
};

function statusVariant(
  status: SpaceBackupStatus | SpaceRestoreStatus,
): "destructive" | "outline" | "secondary" {
  if (status === "failed") {
    return "destructive";
  }
  if (
    status === "queued" ||
    status === "running" ||
    status === "restoring"
  ) {
    return "outline";
  }
  return "secondary";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatBytes(value: string): string {
  const bytes = BigInt(value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unitIndex = 0;
  let divisor = 1n;
  while (unitIndex < units.length - 1 && bytes >= divisor * 1024n) {
    divisor *= 1024n;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${bytes.toLocaleString("zh-CN")} B`;
  }
  const tenths = (bytes * 10n) / divisor;
  return `${tenths / 10n}.${tenths % 10n} ${units[unitIndex]}`;
}

function restoreIsRunning(restore: SpaceRestoreView | null): boolean {
  return (
    restore !== null &&
    restore.status !== "activated" &&
    restore.status !== "failed"
  );
}

interface BackupsPageContentProps {
  organizationId: string;
  sourceSpaceId: string;
}

function BackupsPageContent({
  organizationId,
  sourceSpaceId,
}: BackupsPageContentProps) {
  const queryClient = useQueryClient();
  const [searchParameters, setSearchParameters] = useSearchParams();
  const restoreId = searchParameters.get("restoreId");
  const [restoreFormError, setRestoreFormError] = useState<string | null>(null);
  const backupsQuery = useQuery({
    queryKey: spaceBackupsQueryKey(organizationId, sourceSpaceId),
    queryFn: ({ signal }) =>
      getSpaceBackups(organizationId, sourceSpaceId, signal),
    refetchInterval: (query) =>
      query.state.data?.backups.some(
        (backup) => backup.status === "queued" || backup.status === "running",
      )
        ? 4_000
        : false,
  });
  const restoreQuery = useQuery({
    enabled: restoreId !== null,
    queryKey: spaceRestoreQueryKey(
      organizationId,
      sourceSpaceId,
      restoreId ?? "",
    ),
    queryFn: ({ signal }) =>
      getSpaceRestore(
        organizationId,
        sourceSpaceId,
        restoreId ?? "",
        signal,
      ),
    refetchInterval: (query) =>
      query.state.data?.status === "queued" ||
      query.state.data?.status === "restoring"
        ? 3_000
        : false,
  });
  const createBackupMutation = useMutation({
    mutationFn: () => createSpaceBackup(organizationId, sourceSpaceId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: spaceBackupsQueryKey(organizationId, sourceSpaceId),
      });
    },
  });
  const createRestoreMutation = useMutation({
    mutationFn: (input: {
      backupId: string;
      request: Parameters<typeof createSpaceRestore>[3];
    }) =>
      createSpaceRestore(
        organizationId,
        sourceSpaceId,
        input.backupId,
        input.request,
      ),
    onSuccess: async (restore) => {
      queryClient.setQueryData(
        spaceRestoreQueryKey(
          organizationId,
          sourceSpaceId,
          restore.restoreId,
        ),
        restore,
      );
      setSearchParameters({ restoreId: restore.restoreId }, { replace: true });
      await queryClient.invalidateQueries({
        queryKey: managedSpacesQueryKey(organizationId),
      });
    },
  });
  const activateRestoreMutation = useMutation({
    mutationFn: (input: { restoreId: string; targetSpaceId: string }) =>
      activateSpaceRestore(
        organizationId,
        input.targetSpaceId,
        input.restoreId,
      ),
    onSuccess: async (restore) => {
      queryClient.setQueryData(
        spaceRestoreQueryKey(
          organizationId,
          sourceSpaceId,
          restore.restoreId,
        ),
        restore,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: managedSpacesQueryKey(organizationId),
        }),
        queryClient.invalidateQueries({ queryKey: authorizedSpacesQueryKey }),
      ]);
    },
  });

  if (backupsQuery.error) {
    return (
      <PageFailure
        error={backupsQuery.error}
        onRetry={() => void backupsQuery.refetch()}
      />
    );
  }

  const backups = backupsQuery.data?.backups ?? [];
  const currentRestore = restoreQuery.data ?? null;
  const mutationError =
    createBackupMutation.error ??
    createRestoreMutation.error ??
    activateRestoreMutation.error ??
    restoreQuery.error;

  return (
    <div className="flex flex-col">
      <PageHeader
        actions={
          <div className="flex items-center gap-2">
            <Button
              aria-label="刷新备份列表"
              disabled={backupsQuery.isFetching}
              onClick={() => void backupsQuery.refetch()}
              size="icon-sm"
              variant="outline"
            >
              <RefreshCwIcon aria-hidden="true" />
            </Button>
            <Button
              disabled={createBackupMutation.isPending}
              onClick={() => createBackupMutation.mutate()}
            >
              {createBackupMutation.isPending ? (
                <Spinner data-icon="inline-start" aria-label="正在创建备份" />
              ) : (
                <DatabaseBackupIcon data-icon="inline-start" />
              )}
              创建备份
            </Button>
          </div>
        }
        description="版本化空间备份与隔离恢复"
        title="备份恢复"
      />
      <MutationFailure error={mutationError} />

      {currentRestore ? (
        <section className="border-b">
          <SectionHeading title="当前恢复" />
          <div className="grid grid-cols-[repeat(4,minmax(0,1fr))_auto] items-center gap-4 p-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">恢复任务</p>
              <code className="block truncate text-xs">{currentRestore.restoreId}</code>
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">目标空间</p>
              <code className="block truncate text-xs">
                {currentRestore.targetSpaceId ?? "正在创建"}
              </code>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">创建时间</p>
              <p className="text-sm">{formatDate(currentRestore.createdAt)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">状态</p>
              <Badge variant={statusVariant(currentRestore.status)}>
                {restoreStatusLabels[currentRestore.status]}
              </Badge>
            </div>
            <div className="flex items-center justify-end gap-2 max-sm:justify-start">
              <Button
                aria-label="刷新恢复状态"
                disabled={restoreQuery.isFetching}
                onClick={() => void restoreQuery.refetch()}
                size="icon-sm"
                variant="outline"
              >
                {restoreQuery.isFetching ? (
                  <Spinner aria-label="正在刷新恢复状态" />
                ) : (
                  <RefreshCwIcon aria-hidden="true" />
                )}
              </Button>
              {currentRestore.status === "ready-for-activation" &&
              currentRestore.targetSpaceId !== null ? (
                <ConfirmAction
                  confirmLabel="激活空间"
                  description="激活后恢复出的独立空间将对其授权成员开放。"
                  disabled={activateRestoreMutation.isPending}
                  onConfirm={() =>
                    activateRestoreMutation.mutate({
                      restoreId: currentRestore.restoreId,
                      targetSpaceId: currentRestore.targetSpaceId!,
                    })
                  }
                  title="激活恢复空间？"
                >
                  <Button disabled={activateRestoreMutation.isPending} size="sm">
                    {activateRestoreMutation.isPending ? (
                      <Spinner data-icon="inline-start" aria-label="正在激活恢复空间" />
                    ) : (
                      <PlayIcon data-icon="inline-start" />
                    )}
                    激活空间
                  </Button>
                </ConfirmAction>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <section>
        <SectionHeading count={backups.length} title="空间备份" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>创建时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>归档大小</TableHead>
              <TableHead>Kernel / 格式</TableHead>
              <TableHead>完整性摘要</TableHead>
              <TableHead className="min-w-[390px] text-right">恢复到独立空间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {backupsQuery.isPending ? (
              <LoadingTableRows columns={6} rows={5} />
            ) : backups.length === 0 ? (
              <EmptyTableRow columns={6} label="暂无空间备份" />
            ) : (
              backups.map((backup: SpaceBackupView) => {
                const restoring =
                  createRestoreMutation.isPending &&
                  createRestoreMutation.variables?.backupId === backup.backupId;
                return (
                  <TableRow key={backup.backupId}>
                    <TableCell>
                      <div className="flex min-w-40 flex-col">
                        <span>{formatDate(backup.createdAt)}</span>
                        <code className="text-xs text-muted-foreground">
                          {backup.backupId}
                        </code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(backup.status)}>
                        {backupStatusLabels[backup.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {backup.sizeBytes === null ? "-" : formatBytes(backup.sizeBytes)}
                    </TableCell>
                    <TableCell>
                      {backup.kernelVersion === null ? (
                        "-"
                      ) : (
                        <div className="flex min-w-28 flex-col">
                          <span>{backup.kernelVersion}</span>
                          <span className="text-xs text-muted-foreground">
                            格式 {backup.formatVersion ?? "-"}
                          </span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {backup.sha256 === null ? (
                        "-"
                      ) : (
                        <code className="text-xs" title={backup.sha256}>
                          {backup.sha256.slice(0, 16)}...
                        </code>
                      )}
                    </TableCell>
                    <TableCell>
                      {backup.status === "succeeded" &&
                      !restoreIsRunning(currentRestore) ? (
                        <form
                          className="flex min-w-[360px] items-center justify-end gap-2"
                          onInput={() => setRestoreFormError(null)}
                          onSubmit={(event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            const request = createSpaceRestoreRequestSchema.safeParse({
                              targetSpaceName: new FormData(form).get("targetSpaceName"),
                            });
                            if (!request.success) {
                              setRestoreFormError(backup.backupId);
                              return;
                            }
                            createRestoreMutation.mutate(
                              { backupId: backup.backupId, request: request.data },
                              { onSuccess: () => form.reset() },
                            );
                          }}
                        >
                          <label className="sr-only" htmlFor={`restore-name-${backup.backupId}`}>
                            恢复空间名称
                          </label>
                          <Input
                            aria-invalid={
                              restoreFormError === backup.backupId || undefined
                            }
                            className="w-52"
                            id={`restore-name-${backup.backupId}`}
                            name="targetSpaceName"
                            placeholder="恢复空间名称"
                            required
                          />
                          <Button disabled={restoring} size="sm" type="submit" variant="outline">
                            {restoring ? (
                              <Spinner data-icon="inline-start" aria-label="正在创建恢复任务" />
                            ) : (
                              <RotateCcwIcon data-icon="inline-start" />
                            )}
                            开始恢复
                          </Button>
                        </form>
                      ) : (
                        <span className="block text-right text-xs text-muted-foreground">
                          {backup.status === "succeeded"
                            ? "请先完成当前恢复任务"
                            : "备份完成后可恢复"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

export function BackupsPage() {
  const parameters = useParams();
  const organizationId = parameters.organizationId ?? "";
  const sourceSpaceId = parameters.spaceId ?? "";

  return (
    <BackupsPageContent
      key={`${organizationId}:${sourceSpaceId}`}
      organizationId={organizationId}
      sourceSpaceId={sourceSpaceId}
    />
  );
}
