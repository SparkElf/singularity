import type { ComponentType, ReactNode } from "react";
import type { SpaceObservabilityView } from "@singularity/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  Clock3Icon,
  DatabaseIcon,
  FileIcon,
  HardDriveIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useParams } from "react-router";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  PageFailure,
  PageHeader,
  SectionHeading,
} from "@/enterprise/components.tsx";
import {
  getSpaceObservability,
  spaceObservabilityQueryKey,
} from "@/enterprise/api.ts";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
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

interface MetricProps {
  icon: ComponentType<{ "aria-hidden"?: boolean; className?: string }>;
  label: string;
  value: ReactNode;
}

function Metric({ icon: Icon, label, value }: MetricProps) {
  return (
    <div className="flex min-h-16 items-center gap-3 border-b px-3 py-2 last:border-b-0">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="truncate text-sm font-medium">{value}</div>
      </div>
    </div>
  );
}

function unavailableLabel(
  reason: "kernel-unavailable" | "no-sample" | "sample-failed",
): string {
  switch (reason) {
    case "kernel-unavailable":
      return "Kernel 当前不可用";
    case "no-sample":
      return "尚未收到采样";
    case "sample-failed":
      return "最近一次采样失败";
  }
}

function UnavailableObservation({
  reason,
}: {
  reason: "kernel-unavailable" | "no-sample" | "sample-failed";
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-2 p-6 text-center">
      <TriangleAlertIcon aria-hidden="true" className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">数据不可用</p>
      <p className="text-xs text-muted-foreground">{unavailableLabel(reason)}</p>
    </div>
  );
}

function HealthSection({
  health,
}: {
  health: SpaceObservabilityView["health"];
}) {
  return (
    <section className="min-w-0 border-r max-md:border-r-0 max-md:border-b">
      <SectionHeading title="Kernel 健康" />
      {health.status === "unavailable" ? (
        <>
          <UnavailableObservation reason={health.reason} />
          {"sampledAt" in health ? (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              最近采样：{formatDate(health.sampledAt)}
            </p>
          ) : null}
        </>
      ) : (
        <div>
          <Metric
            icon={ActivityIcon}
            label="运行状态"
            value={
              <Badge variant={health.status === "ready" ? "secondary" : "outline"}>
                {health.status === "ready" ? "就绪" : "样本已过期"}
              </Badge>
            }
          />
          <Metric icon={DatabaseIcon} label="Kernel 版本" value={health.kernelVersion} />
          <Metric
            icon={Clock3Icon}
            label="采样时间"
            value={formatDate(health.sampledAt)}
          />
        </div>
      )}
    </section>
  );
}

function CapacitySection({
  capacity,
}: {
  capacity: SpaceObservabilityView["capacity"];
}) {
  return (
    <section className="min-w-0">
      <SectionHeading title="空间容量" />
      {capacity.status === "unavailable" ? (
        <>
          <UnavailableObservation reason={capacity.reason} />
          {"sampledAt" in capacity ? (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              最近采样：{formatDate(capacity.sampledAt)}
            </p>
          ) : null}
        </>
      ) : (
        <div>
          <Metric icon={DatabaseIcon} label="数据文件" value={formatBytes(capacity.dataBytes)} />
          <Metric icon={HardDriveIcon} label="附件" value={formatBytes(capacity.assetBytes)} />
          <Metric
            icon={FileIcon}
            label="文件数量"
            value={BigInt(capacity.fileCount).toLocaleString("zh-CN")}
          />
          <Metric
            icon={Clock3Icon}
            label="采样"
            value={
              <span className="inline-flex items-center gap-2">
                <Badge variant={capacity.status === "fresh" ? "secondary" : "outline"}>
                  {capacity.status === "fresh" ? "最新" : "已过期"}
                </Badge>
                <span className="font-normal text-muted-foreground">
                  {formatDate(capacity.sampledAt)} / {capacity.sampleDurationMilliseconds} ms
                </span>
              </span>
            }
          />
        </div>
      )}
    </section>
  );
}

export function ObservabilityPage() {
  const parameters = useParams();
  const organizationId = parameters.organizationId ?? "";
  const spaceId = parameters.spaceId ?? "";
  const observabilityQuery = useQuery({
    queryKey: spaceObservabilityQueryKey(organizationId, spaceId),
    queryFn: ({ signal }) =>
      getSpaceObservability(organizationId, spaceId, signal),
  });

  if (observabilityQuery.error) {
    return (
      <PageFailure
        error={observabilityQuery.error}
        onRetry={() => void observabilityQuery.refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        actions={
          <Button
            aria-label="刷新健康与容量"
            disabled={observabilityQuery.isFetching}
            onClick={() => void observabilityQuery.refetch()}
            size="icon-sm"
            variant="outline"
          >
            <RefreshCwIcon aria-hidden="true" />
          </Button>
        }
        description="后台持久化的 Kernel 健康与容量采样"
        title="健康容量"
      />
      {observabilityQuery.isPending ? (
        <div className="grid grid-cols-2 border-b max-md:grid-cols-1">
          <section className="border-r p-3 max-md:border-r-0 max-md:border-b">
            <Skeleton className="h-48 w-full" />
          </section>
          <section className="p-3">
            <Skeleton className="h-48 w-full" />
          </section>
        </div>
      ) : (
        <div className="grid grid-cols-2 border-b max-md:grid-cols-1">
          <HealthSection health={observabilityQuery.data.health} />
          <CapacitySection capacity={observabilityQuery.data.capacity} />
        </div>
      )}
    </div>
  );
}
