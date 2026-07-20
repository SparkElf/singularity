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
import { useParams } from "react-router";

import { isApiProblem } from "@/api/http.ts";
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
  enterpriseManagementAccessQueryKey,
  getSpaceBackups,
  getSpaceRestores,
  managedSpacesQueryKey,
  spaceBackupsQueryKey,
  spaceRestoresQueryKey,
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

function restoreIsRunning(restores: readonly SpaceRestoreView[]): boolean {
  return restores.some(
    (restore) => restore.status !== "activated" && restore.status !== "failed",
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
  const restoresQuery = useQuery({
    queryKey: spaceRestoresQueryKey(organizationId, sourceSpaceId),
    queryFn: ({ signal }) =>
      getSpaceRestores(organizationId, sourceSpaceId, signal),
    refetchInterval: (query) =>
      query.state.data?.restores.some(
        (restore) => restore.status === "queued" || restore.status === "restoring",
      )
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
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: spaceRestoresQueryKey(organizationId, sourceSpaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: managedSpacesQueryKey(organizationId),
        }),
      ]);
    },
  });
  const activateRestoreMutation = useMutation({
    mutationFn: (input: { restoreId: string; targetSpaceId: string }) =>
      activateSpaceRestore(
        organizationId,
        input.targetSpaceId,
        input.restoreId,
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: spaceRestoresQueryKey(organizationId, sourceSpaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: managedSpacesQueryKey(organizationId),
        }),
        queryClient.invalidateQueries({ queryKey: authorizedSpacesQueryKey }),
        queryClient.invalidateQueries({
          queryKey: enterpriseManagementAccessQueryKey,
        }),
      ]);
    },
  });

  const queryErrors = [backupsQuery.error, restoresQuery.error];
  const mutationErrors = [
    createBackupMutation.error,
    createRestoreMutation.error,
    activateRestoreMutation.error,
  ];
  const authenticationError = [...queryErrors, ...mutationErrors].find((error) =>
    isApiProblem(error, "unauthenticated"),
  );
  if (authenticationError) {
    return <PageFailure error={authenticationError} />;
  }
  const queryError = queryErrors.find(
    (error) => error !== null && error !== undefined,
  );
  if (queryError) {
    return (
      <PageFailure
        error={queryError}
        onRetry={() => {
          void backupsQuery.refetch();
          void restoresQuery.refetch();
        }}
      />
    );
  }

  const backups = backupsQuery.data?.backups ?? [];
  const restores = restoresQuery.data?.restores ?? [];
  const restoreCollectionReady =
    restoresQuery.isSuccess &&
    !restoresQuery.isFetching &&
    !restoresQuery.isPaused;
  const restoreSubmissionAvailable =
    restoreCollectionReady && !restoreIsRunning(restores);
  const mutationError = mutationErrors.find(
    (error) => error !== null && error !== undefined,
  );

  return (
    <div className="flex flex-col">
      <PageHeader
        actions={
          <div className="flex items-center gap-2">
            <Button
              aria-label="刷新备份和恢复任务"
              disabled={backupsQuery.isFetching || restoresQuery.isFetching}
              onClick={() => {
                void backupsQuery.refetch();
                void restoresQuery.refetch();
              }}
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

      <section className="border-b">
        <SectionHeading count={restores.length} title="恢复任务" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>创建时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>目标空间</TableHead>
              <TableHead>来源备份</TableHead>
              <TableHead className="w-32 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {restoresQuery.isPending ? (
              <LoadingTableRows columns={5} rows={3} />
            ) : restores.length === 0 ? (
              <EmptyTableRow columns={5} label="暂无恢复任务" />
            ) : (
              restores.map((restore) => {
                const activating =
                  activateRestoreMutation.isPending &&
                  activateRestoreMutation.variables?.restoreId === restore.restoreId;
                return (
                  <TableRow key={restore.restoreId}>
                    <TableCell>
                      <div className="flex min-w-40 flex-col">
                        <span>{formatDate(restore.createdAt)}</span>
                        <code className="text-xs text-muted-foreground">
                          {restore.restoreId}
                        </code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(restore.status)}>
                        {restoreStatusLabels[restore.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <code className="block max-w-64 truncate text-xs">
                        {restore.targetSpaceId ?? "正在创建"}
                      </code>
                    </TableCell>
                    <TableCell>
                      <code className="block max-w-64 truncate text-xs">
                        {restore.backupId}
                      </code>
                    </TableCell>
                    <TableCell className="text-right">
                      {restore.status === "ready-for-activation" &&
                      restore.targetSpaceId !== null ? (
                        <ConfirmAction
                          confirmLabel="激活空间"
                          description="激活后恢复出的独立空间将对其授权成员开放。"
                          disabled={activating}
                          onConfirm={() =>
                            activateRestoreMutation.mutate({
                              restoreId: restore.restoreId,
                              targetSpaceId: restore.targetSpaceId!,
                            })
                          }
                          title="激活恢复空间？"
                        >
                          <Button disabled={activating} size="sm">
                            {activating ? (
                              <Spinner
                                data-icon="inline-start"
                                aria-label="正在激活恢复空间"
                              />
                            ) : (
                              <PlayIcon data-icon="inline-start" />
                            )}
                            激活空间
                          </Button>
                        </ConfirmAction>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

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
                      restoreSubmissionAvailable ? (
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
                            disabled={createRestoreMutation.isPending}
                            id={`restore-name-${backup.backupId}`}
                            name="targetSpaceName"
                            placeholder="恢复空间名称"
                            required
                          />
                          <Button
                            disabled={createRestoreMutation.isPending}
                            size="sm"
                            type="submit"
                            variant="outline"
                          >
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
                            ? !restoreCollectionReady
                              ? "正在确认恢复任务"
                              : "请先完成当前恢复任务"
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
