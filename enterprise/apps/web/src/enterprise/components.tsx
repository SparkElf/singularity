import type { ReactNode } from "react";
import {
  AlertCircleIcon,
  RefreshCwIcon,
  SearchXIcon,
} from "lucide-react";
import { Navigate, useLocation } from "react-router";

import {
  ApiProblemError,
  NetworkFailureError,
  isApiProblem,
} from "@/api/http.ts";
import { locationTarget, loginPath } from "@/auth/return-to.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  TableCell,
  TableRow,
} from "@/components/ui/table.tsx";

interface PageHeaderProps {
  actions?: ReactNode;
  description?: string;
  title: string;
}

export function PageHeader({ actions, description, title }: PageHeaderProps) {
  return (
    <header className="flex min-h-12 items-center justify-between gap-4 border-b px-4 py-2 max-sm:items-start max-sm:px-3">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold">{title}</h1>
        {description ? (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

interface SectionHeadingProps {
  count?: number;
  title: string;
}

export function SectionHeading({ count, title }: SectionHeadingProps) {
  return (
    <div className="flex min-h-10 items-center gap-2 border-b px-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {count === undefined ? null : <Badge variant="secondary">{count}</Badge>}
    </div>
  );
}

function problemMessage(error: ApiProblemError): string {
  switch (error.problem.code) {
    case "forbidden":
      return "当前账号没有执行此操作的权限。";
    case "not-found":
      return "目标资源不存在或已经被移除。";
    case "validation-failed":
      return "提交的数据未通过服务端校验。";
    case "conflict":
      return "资源状态已经变化，请刷新后重试。";
    case "rate-limited":
      return "请求过于频繁，请稍后重试。";
    case "service-unavailable":
      return "依赖服务当前不可用，请稍后重试。";
    case "unauthenticated":
      return "登录状态已失效。";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiProblemError) {
    return `${problemMessage(error)} 请求编号：${error.problem.requestId}`;
  }
  if (error instanceof NetworkFailureError) {
    return "无法连接到服务，请检查网络后重试。";
  }
  return "服务返回了无法处理的结果，请重试。";
}

interface PageFailureProps {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}

export function PageFailure({
  error,
  onRetry,
  title = "无法加载数据",
}: PageFailureProps) {
  const location = useLocation();

  if (isApiProblem(error, "unauthenticated")) {
    return <Navigate replace to={loginPath(locationTarget(location))} />;
  }

  return (
    <Empty className="m-4 min-h-64 rounded-md border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertCircleIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          <h2>{title}</h2>
        </EmptyTitle>
        <EmptyDescription>{errorMessage(error)}</EmptyDescription>
      </EmptyHeader>
      {onRetry ? (
        <EmptyContent>
          <Button onClick={onRetry} variant="outline">
            <RefreshCwIcon data-icon="inline-start" />
            重新加载
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

export function MutationFailure({ error }: { error: unknown }) {
  const location = useLocation();
  if (error === null || error === undefined) {
    return null;
  }
  if (isApiProblem(error, "unauthenticated")) {
    return <Navigate replace to={loginPath(locationTarget(location))} />;
  }
  return (
    <Alert className="mx-3 mt-3" variant="destructive">
      <AlertTitle>操作未完成</AlertTitle>
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}

export function EmptyTableRow({
  columns,
  label,
}: {
  columns: number;
  label: string;
}) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="h-28 text-center">
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <SearchXIcon aria-hidden="true" className="size-4" />
          {label}
        </span>
      </TableCell>
    </TableRow>
  );
}

export function LoadingTableRows({
  columns,
  rows = 3,
}: {
  columns: number;
  rows?: number;
}) {
  return Array.from({ length: rows }, (_, index) => (
    <TableRow key={index}>
      {Array.from({ length: columns }, (__, cellIndex) => (
        <TableCell key={cellIndex}>
          <Skeleton className="h-5 w-full max-w-40" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

interface ConfirmActionProps {
  cancelLabel?: string;
  children: ReactNode;
  confirmLabel: string;
  description: string;
  disabled?: boolean;
  onConfirm: () => void;
  title: string;
}

export function ConfirmAction({
  cancelLabel = "取消",
  children,
  confirmLabel,
  description,
  disabled,
  onConfirm,
  title,
}: ConfirmActionProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild disabled={disabled}>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
