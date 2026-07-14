import { useMemo, useState } from "react";
import type { AuthorizedSpacesResponse } from "@singularity/contracts";
import {
  ArrowRightIcon,
  BookOpenIcon,
  LogOutIcon,
  OrbitIcon,
  SearchIcon,
  SearchXIcon,
} from "lucide-react";
import { Link, Navigate, useLocation } from "react-router";

import { NetworkFailureError, isApiProblem } from "@/api/http.ts";
import { SessionRedirect } from "@/auth/SessionRedirect.tsx";
import { locationTarget } from "@/auth/return-to.ts";
import { useLogout } from "@/auth/use-logout.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
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
import {
  Field,
  FieldLabel,
} from "@/components/ui/field.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { roleBadgeVariant, roleLabel } from "@/spaces/space-labels.ts";
import {
  EXPLICIT_SPACE_LIST_STATE,
  spacePagePath,
} from "@/spaces/space-route.ts";
import { useAuthorizedSpaces } from "@/spaces/use-authorized-spaces.ts";

const EMPTY_SPACES: AuthorizedSpacesResponse["spaces"] = [];

function SpaceListLoading() {
  return (
    <div aria-label="正在加载空间" className="flex flex-col gap-2">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

export function SpacesPage() {
  const location = useLocation();
  const spacesQuery = useAuthorizedSpaces();
  const logoutMutation = useLogout();
  const [search, setSearch] = useState("");
  const explicitSpaceList = location.state === EXPLICIT_SPACE_LIST_STATE;

  const hasCurrentAuthorization =
    spacesQuery.isSuccess && !spacesQuery.isFetching;
  const spaces = hasCurrentAuthorization
    ? spacesQuery.data.spaces
    : EMPTY_SPACES;
  const normalizedSearch = search.trim().normalize("NFKC").toLocaleLowerCase();
  const filteredSpaces = useMemo(() => {
    if (!normalizedSearch) {
      return spaces;
    }

    return spaces.filter((space) =>
      `${space.organizationName}\n${space.spaceName}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(normalizedSearch),
    );
  }, [normalizedSearch, spaces]);

  if (isApiProblem(spacesQuery.error, "unauthenticated")) {
    return <SessionRedirect returnTo={locationTarget(location)} />;
  }

  if (
    hasCurrentAuthorization &&
    spaces.length === 1 &&
    spaces[0] &&
    !explicitSpaceList
  ) {
    return <Navigate replace to={spacePagePath(spaces[0])} />;
  }

  return (
    <div data-singularity-ui className="min-h-dvh bg-background">
      <header className="flex h-10 items-center justify-between gap-3 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <OrbitIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate text-sm font-semibold">奇点</span>
        </div>
        <Button
          disabled={logoutMutation.isPending}
          onClick={() => logoutMutation.mutate()}
          size="sm"
          variant="ghost"
        >
          {logoutMutation.isPending ? (
            <Spinner data-icon="inline-start" aria-label="正在退出" />
          ) : (
            <LogOutIcon data-icon="inline-start" />
          )}
          退出登录
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6 max-sm:p-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">选择知识空间</h1>
          <p className="text-sm text-muted-foreground">
            这里只显示你当前有权访问的空间。
          </p>
        </div>

        {logoutMutation.isError &&
        !isApiProblem(logoutMutation.error, "unauthenticated") ? (
          <Alert variant="destructive">
            <AlertTitle>无法退出</AlertTitle>
            <AlertDescription>请检查网络连接后重试。</AlertDescription>
          </Alert>
        ) : null}

        {spacesQuery.isPending || spacesQuery.isFetching ? (
          <SpaceListLoading />
        ) : null}

        {spacesQuery.isError ? (
          <Empty className="min-h-72 rounded-md border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchXIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>
                <h2>无法加载空间</h2>
              </EmptyTitle>
              <EmptyDescription>
                {spacesQuery.error instanceof NetworkFailureError
                  ? "无法连接到服务，请检查网络后重试。"
                  : "服务返回了无法处理的结果，请重试。"}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => void spacesQuery.refetch()} variant="outline">
                重新加载
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}

        {hasCurrentAuthorization && spaces.length === 0 ? (
          <Empty className="min-h-72 rounded-md border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpenIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>
                <h2>尚未获得空间访问权限</h2>
              </EmptyTitle>
              <EmptyDescription>
                请联系组织管理员为你分配知识空间。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {hasCurrentAuthorization &&
        (spaces.length > 1 || (explicitSpaceList && spaces.length === 1)) ? (
          <>
            {spaces.length > 1 ? (
              <Field>
                <FieldLabel className="sr-only" htmlFor="space-search">
                  搜索空间
                </FieldLabel>
                <InputGroup className="h-9 max-sm:h-10">
                  <InputGroupAddon>
                    <SearchIcon aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="space-search"
                    onChange={(event) => setSearch(event.currentTarget.value)}
                    placeholder="搜索组织或空间"
                    value={search}
                  />
                </InputGroup>
              </Field>
            ) : null}

            {filteredSpaces.length === 0 ? (
              <Empty className="min-h-56 rounded-md border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchXIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>
                    <h2>没有匹配的空间</h2>
                  </EmptyTitle>
                  <EmptyDescription>请尝试其他搜索词。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="overflow-hidden rounded-md border">
                {filteredSpaces.map((space) => (
                  <li key={space.spaceId} className="border-b last:border-b-0">
                    <Link
                      className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:min-h-16"
                      to={spacePagePath(space)}
                    >
                      <BookOpenIcon aria-hidden="true" className="size-4" />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium" title={space.spaceName}>
                          {space.spaceName}
                        </span>
                        <span
                          className="truncate text-xs text-muted-foreground"
                          title={space.organizationName}
                        >
                          {space.organizationName}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge variant={roleBadgeVariant(space.role)}>
                          {roleLabel(space.role)}
                        </Badge>
                        <ArrowRightIcon aria-hidden="true" className="size-4" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}
