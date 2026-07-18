import type { ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BookOpenIcon,
  BookXIcon,
  BoxesIcon,
  DatabaseBackupIcon,
  FileClockIcon,
  KeyRoundIcon,
  LinkIcon,
  LogOutIcon,
  OrbitIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { uuidSchema } from "@singularity/contracts";

import { isApiProblem } from "@/api/http.ts";
import { SessionRedirect } from "@/auth/SessionRedirect.tsx";
import { SPACES_PATH, locationTarget } from "@/auth/return-to.ts";
import { useLogout } from "@/auth/use-logout.ts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { PageFailure } from "@/enterprise/components.tsx";
import {
  getManagedSpace,
  getManagedSpaces,
  managedSpaceQueryKey,
  managedSpacesQueryKey,
} from "@/enterprise/api.ts";
import {
  organizationSettingsPath,
  spaceSettingsPath,
} from "@/enterprise/routes.ts";

interface AdminNavigationItemProps {
  icon: ComponentType<{ "aria-hidden"?: boolean }>;
  label: string;
  to: string;
}

function AdminNavigationItem({ icon: Icon, label, to }: AdminNavigationItemProps) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={label}>
        <NavLink
          className={({ isActive }) => (isActive ? "bg-sidebar-accent" : "")}
          end
          onClick={() => {
            if (isMobile) {
              setOpenMobile(false);
            }
          }}
          to={to}
        >
          <Icon aria-hidden />
          <span>{label}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function LayoutLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner aria-label="正在加载企业管理" />
      <span>正在加载企业管理</span>
    </div>
  );
}

function MissingSpace() {
  return (
    <Empty className="m-4 min-h-64 rounded-md border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookXIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          <h2>空间不存在</h2>
        </EmptyTitle>
        <EmptyDescription>
          当前组织的空间列表中没有这个空间。
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function EnterpriseAdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const organizationId = params.organizationId ?? "";
  const routeSpaceId = params.spaceId ?? null;
  const validOrganizationId = uuidSchema.safeParse(organizationId).success;
  const validSpaceId =
    routeSpaceId === null || uuidSchema.safeParse(routeSpaceId).success;
  const managedSpacesQuery = useQuery({
    enabled: validOrganizationId && routeSpaceId === null,
    queryKey: managedSpacesQueryKey(organizationId),
    queryFn: ({ signal }) => getManagedSpaces(organizationId, signal),
    refetchOnMount: "always",
    staleTime: 0,
  });
  const managedSpaceQuery = useQuery({
    enabled: validOrganizationId && routeSpaceId !== null,
    queryKey: managedSpaceQueryKey(organizationId, routeSpaceId ?? ""),
    queryFn: ({ signal }) =>
      getManagedSpace(organizationId, routeSpaceId as string, signal),
    refetchOnMount: "always",
    staleTime: 0,
  });
  const logoutMutation = useLogout();
  const organizationRoute = routeSpaceId === null;
  const hasCurrentManagedSpaces =
    managedSpacesQuery.isSuccess &&
    managedSpacesQuery.isFetchedAfterMount &&
    !managedSpacesQuery.isFetching &&
    !managedSpacesQuery.isPaused;
  const hasCurrentManagedSpace =
    managedSpaceQuery.isSuccess &&
    managedSpaceQuery.isFetchedAfterMount &&
    !managedSpaceQuery.isFetching &&
    !managedSpaceQuery.isPaused;
  const hasCurrentSpaces = organizationRoute
    ? hasCurrentManagedSpaces
    : hasCurrentManagedSpace;
  const spaces = organizationRoute
    ? hasCurrentManagedSpaces
      ? managedSpacesQuery.data.spaces
      : []
    : hasCurrentManagedSpace
      ? [managedSpaceQuery.data]
      : [];
  const currentSpace =
    routeSpaceId === null
      ? null
      : spaces.find((space) => space.spaceId === routeSpaceId) ?? null;

  if (!validOrganizationId || !validSpaceId) {
    return <Navigate replace to={SPACES_PATH} />;
  }
  const spacesError = organizationRoute
    ? managedSpacesQuery.error
    : managedSpaceQuery.error;
  const spacesPaused = organizationRoute
    ? managedSpacesQuery.isPaused
    : managedSpaceQuery.isPaused;
  if (isApiProblem(spacesError, "unauthenticated")) {
    return <SessionRedirect returnTo={locationTarget(location)} />;
  }

  const content = spacesPaused || spacesError ? (
    <PageFailure
      error={spacesError}
      onRetry={() => {
        if (organizationRoute) {
          void managedSpacesQuery.refetch();
        } else {
          void managedSpaceQuery.refetch();
        }
      }}
      title="无法打开企业管理"
    />
  ) : hasCurrentSpaces && routeSpaceId !== null && currentSpace === null ? (
    <MissingSpace />
  ) : hasCurrentSpaces ? (
    <Outlet />
  ) : (
    <LayoutLoading />
  );

  return (
    <div data-singularity-ui className="min-h-dvh bg-background">
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader className="h-10 justify-center border-b border-sidebar-border px-2 py-0">
            <div className="flex min-w-0 items-center gap-2 px-1.5 text-sm font-semibold">
              <OrbitIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate group-data-[collapsible=icon]:hidden">奇点</span>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>组织管理</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <AdminNavigationItem
                    icon={UsersIcon}
                    label="成员与邀请"
                    to={organizationSettingsPath(organizationId, "members")}
                  />
                  <AdminNavigationItem
                    icon={BoxesIcon}
                    label="用户组"
                    to={organizationSettingsPath(organizationId, "groups")}
                  />
                  <AdminNavigationItem
                    icon={BookOpenIcon}
                    label="空间"
                    to={organizationSettingsPath(organizationId, "spaces")}
                  />
                  <AdminNavigationItem
                    icon={KeyRoundIcon}
                    label="单点登录"
                    to={organizationSettingsPath(organizationId, "oidc")}
                  />
                  <AdminNavigationItem
                    icon={FileClockIcon}
                    label="组织审计"
                    to={organizationSettingsPath(organizationId, "audit")}
                  />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel>空间管理</SidebarGroupLabel>
              <SidebarGroupContent className="flex flex-col gap-2">
                <div className="px-2 group-data-[collapsible=icon]:hidden">
                  <label className="sr-only" htmlFor="managed-space-selector">
                    选择管理空间
                  </label>
                  <Select
                    className="w-full"
                    disabled={spaces.length === 0}
                    id="managed-space-selector"
                    onChange={(event) => {
                      const spaceId = event.currentTarget.value;
                      if (spaceId !== "") {
                        void navigate(spaceSettingsPath(organizationId, spaceId));
                      }
                    }}
                    value={routeSpaceId ?? ""}
                  >
                    <option value="">选择空间</option>
                    {spaces.map((space) => (
                      <option key={space.spaceId} value={space.spaceId}>
                        {space.spaceName}
                      </option>
                    ))}
                  </Select>
                </div>
                {currentSpace ? (
                  <SidebarMenu>
                    <AdminNavigationItem
                      icon={ShieldCheckIcon}
                      label="访问权限"
                      to={spaceSettingsPath(organizationId, currentSpace.spaceId, "access")}
                    />
                    <AdminNavigationItem
                      icon={LinkIcon}
                      label="分享"
                      to={spaceSettingsPath(organizationId, currentSpace.spaceId, "shares")}
                    />
                    <AdminNavigationItem
                      icon={FileClockIcon}
                      label="空间审计"
                      to={spaceSettingsPath(organizationId, currentSpace.spaceId, "audit")}
                    />
                    <AdminNavigationItem
                      icon={DatabaseBackupIcon}
                      label="备份恢复"
                      to={spaceSettingsPath(organizationId, currentSpace.spaceId, "backups")}
                    />
                    <AdminNavigationItem
                      icon={ActivityIcon}
                      label="健康容量"
                      to={spaceSettingsPath(
                        organizationId,
                        currentSpace.spaceId,
                        "observability",
                      )}
                    />
                  </SidebarMenu>
                ) : null}
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="border-t border-sidebar-border p-2">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  disabled={logoutMutation.isPending}
                  onClick={() => logoutMutation.mutate()}
                  tooltip="退出登录"
                >
                  {logoutMutation.isPending ? (
                    <Spinner aria-label="正在退出" />
                  ) : (
                    <LogOutIcon aria-hidden="true" />
                  )}
                  <span>退出登录</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <header className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
            <SidebarTrigger />
            <Button asChild size="icon-sm" variant="ghost">
              <Link
                aria-label={currentSpace ? "返回知识空间" : "返回空间列表"}
                to={
                  currentSpace
                    ? `/organizations/${encodeURIComponent(organizationId)}/spaces/${encodeURIComponent(currentSpace.spaceId)}`
                    : SPACES_PATH
                }
              >
                <ArrowLeftIcon aria-hidden="true" />
              </Link>
            </Button>
            <Separator orientation="vertical" className="h-4" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-sm font-medium">企业管理</span>
              {currentSpace ? (
                <>
                  <span aria-hidden="true" className="text-muted-foreground">/</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {currentSpace.spaceName}
                  </span>
                </>
              ) : null}
            </div>
          </header>

          {logoutMutation.isError &&
          !isApiProblem(logoutMutation.error, "unauthenticated") ? (
            <Alert className="m-3 mb-0" variant="destructive">
              <AlertTitle>无法退出</AlertTitle>
              <AlertDescription>请检查网络连接后重试。</AlertDescription>
            </Alert>
          ) : null}

          <main className="flex min-h-0 flex-1 flex-col overflow-auto">{content}</main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
