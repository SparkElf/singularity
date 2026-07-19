import type { ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BookOpenIcon,
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
import {
  uuidSchema,
  type OrganizationManagementAccess,
  type OrganizationManagementCapability,
  type SpaceManagementCapability,
} from "@singularity/contracts";

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
  enterpriseManagementAccessQueryKey,
  getEnterpriseManagementAccess,
} from "@/enterprise/api.ts";
import {
  enterpriseManagementPath,
  organizationManagementSectionIsAccessible,
  organizationSettingsPath,
  spaceManagementPath,
  spaceManagementSectionIsAccessible,
  spaceSettingsPath,
} from "@/enterprise/routes.ts";

interface AdminNavigationItemProps {
  icon: ComponentType<{ "aria-hidden"?: boolean }>;
  label: string;
  to: string;
}

interface OrganizationNavigationItem {
  capability: OrganizationManagementCapability;
  icon: ComponentType<{ "aria-hidden"?: boolean }>;
  label: string;
  section: "audit" | "groups" | "members" | "oidc" | "spaces";
}

interface SpaceNavigationItem {
  capability: SpaceManagementCapability;
  icon: ComponentType<{ "aria-hidden"?: boolean }>;
  label: string;
}

const organizationNavigationItems = [
  { capability: "members", icon: UsersIcon, label: "成员与邀请", section: "members" },
  { capability: "groups", icon: BoxesIcon, label: "用户组", section: "groups" },
  { capability: "spaces", icon: BookOpenIcon, label: "空间", section: "spaces" },
  { capability: "oidc", icon: KeyRoundIcon, label: "单点登录", section: "oidc" },
  { capability: "audit", icon: FileClockIcon, label: "组织审计", section: "audit" },
] as const satisfies readonly OrganizationNavigationItem[];

const spaceNavigationItems = [
  { capability: "access", icon: ShieldCheckIcon, label: "访问权限" },
  { capability: "shares", icon: LinkIcon, label: "分享" },
  { capability: "audit", icon: FileClockIcon, label: "空间审计" },
  { capability: "backups", icon: DatabaseBackupIcon, label: "备份恢复" },
  { capability: "observability", icon: ActivityIcon, label: "健康容量" },
] as const satisfies readonly SpaceNavigationItem[];

export type EnterpriseAdminOutletContext = OrganizationManagementAccess;

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

export function EnterpriseAdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const organizationId = params.organizationId ?? "";
  const routeSpaceId = params.spaceId ?? null;
  const validOrganizationId = uuidSchema.safeParse(organizationId).success;
  const validSpaceId =
    routeSpaceId === null || uuidSchema.safeParse(routeSpaceId).success;
  const managementAccessQuery = useQuery({
    enabled: validOrganizationId,
    queryKey: enterpriseManagementAccessQueryKey,
    queryFn: ({ signal }) => getEnterpriseManagementAccess(signal),
    refetchOnMount: "always",
    staleTime: 0,
  });
  const logoutMutation = useLogout();
  const hasCurrentManagementAccess =
    managementAccessQuery.isSuccess &&
    managementAccessQuery.isFetchedAfterMount &&
    !managementAccessQuery.isFetching &&
    !managementAccessQuery.isPaused;
  const organizationAccess = hasCurrentManagementAccess
    ? managementAccessQuery.data.organizations.find(
        (access) => access.organizationId === organizationId,
      ) ?? null
    : null;
  const spaces = organizationAccess?.spaces ?? [];
  const currentSpace =
    routeSpaceId === null
      ? null
      : spaces.find((space) => space.spaceId === routeSpaceId) ?? null;
  const routeSection = location.pathname.split("/").at(-1) ?? "";
  const routeHasCapability =
    organizationAccess !== null &&
    (routeSpaceId === null
      ? organizationManagementSectionIsAccessible(
          organizationAccess.organizationCapabilities,
          routeSection,
        )
      : currentSpace !== null &&
        spaceManagementSectionIsAccessible(currentSpace.capabilities, routeSection));
  const fallbackManagementPath =
    organizationAccess === null ? null : enterpriseManagementPath(organizationAccess);
  const organizationItems = organizationAccess
    ? organizationNavigationItems.filter((item) =>
        organizationAccess.organizationCapabilities.includes(item.capability),
      )
    : [];
  const currentSpaceItems = currentSpace
    ? spaceNavigationItems.filter((item) =>
        currentSpace.capabilities.includes(item.capability),
      )
    : [];

  if (!validOrganizationId || !validSpaceId) {
    return <Navigate replace to={SPACES_PATH} />;
  }
  if (isApiProblem(managementAccessQuery.error, "unauthenticated")) {
    return <SessionRedirect returnTo={locationTarget(location)} />;
  }
  if (hasCurrentManagementAccess && (!routeHasCapability || organizationAccess === null)) {
    return <Navigate replace to={fallbackManagementPath ?? SPACES_PATH} />;
  }

  const content = managementAccessQuery.isPaused || managementAccessQuery.error ? (
    <PageFailure
      error={managementAccessQuery.error}
      onRetry={() => void managementAccessQuery.refetch()}
      title="无法打开企业管理"
    />
  ) : hasCurrentManagementAccess && organizationAccess !== null ? (
    <Outlet context={organizationAccess} />
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
            {organizationItems.length > 0 ? (
              <SidebarGroup>
                <SidebarGroupLabel>组织管理</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {organizationItems.map((item) => (
                      <AdminNavigationItem
                        icon={item.icon}
                        key={item.capability}
                        label={item.label}
                        to={organizationSettingsPath(organizationId, item.section)}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ) : null}

            {spaces.length > 0 ? (
              <SidebarGroup>
                <SidebarGroupLabel>空间管理</SidebarGroupLabel>
                <SidebarGroupContent className="flex flex-col gap-2">
                  <div className="px-2 group-data-[collapsible=icon]:hidden">
                    <label className="sr-only" htmlFor="managed-space-selector">
                      选择管理空间
                    </label>
                    <Select
                      className="w-full"
                      id="managed-space-selector"
                      onChange={(event) => {
                        const spaceId = event.currentTarget.value;
                        const space = spaces.find((candidate) => candidate.spaceId === spaceId);
                        if (space !== undefined) {
                          const path = spaceManagementPath(organizationId, space);
                          if (path !== null) {
                            void navigate(path);
                          }
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
                  {currentSpaceItems.length > 0 && currentSpace ? (
                    <SidebarMenu>
                      {currentSpaceItems.map((item) => (
                        <AdminNavigationItem
                          icon={item.icon}
                          key={item.capability}
                          label={item.label}
                          to={spaceSettingsPath(
                            organizationId,
                            currentSpace.spaceId,
                            item.capability,
                          )}
                        />
                      ))}
                    </SidebarMenu>
                  ) : null}
                </SidebarGroupContent>
              </SidebarGroup>
            ) : null}
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
