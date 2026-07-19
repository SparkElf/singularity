import {
  setSpaceGroupGrantRequestSchema,
  setSpaceMemberRequestSchema,
} from "@singularity/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { useParams } from "react-router";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { Select } from "@/components/ui/select.tsx";
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
  enterpriseManagementAccessQueryKey,
  getSpaceGroupCandidates,
  getSpaceGroupGrants,
  getSpaceMemberCandidates,
  getSpaceMembers,
  revokeSpaceGroupGrant,
  revokeSpaceMember,
  setSpaceGroupGrant,
  setSpaceMember,
  spaceGroupCandidatesQueryKey,
  spaceGroupGrantsQueryKey,
  spaceMemberCandidatesQueryKey,
  spaceMembersQueryKey,
} from "@/enterprise/api.ts";
import { authorizedSpacesQueryKey } from "@/spaces/api.ts";

function RoleOptions() {
  return (
    <>
      <option value="viewer">阅读者</option>
      <option value="editor">编辑者</option>
      <option value="admin">管理员</option>
    </>
  );
}

export function SpaceAccessPage() {
  const params = useParams();
  const organizationId = params.organizationId ?? "";
  const spaceId = params.spaceId ?? "";
  const queryClient = useQueryClient();
  const membersQuery = useQuery({
    queryKey: spaceMembersQueryKey(organizationId, spaceId),
    queryFn: ({ signal }) => getSpaceMembers(organizationId, spaceId, signal),
  });
  const grantsQuery = useQuery({
    queryKey: spaceGroupGrantsQueryKey(organizationId, spaceId),
    queryFn: ({ signal }) => getSpaceGroupGrants(organizationId, spaceId, signal),
  });
  const memberCandidatesQuery = useQuery({
    queryKey: spaceMemberCandidatesQueryKey(organizationId, spaceId),
    queryFn: ({ signal }) =>
      getSpaceMemberCandidates(organizationId, spaceId, signal),
  });
  const groupCandidatesQuery = useQuery({
    queryKey: spaceGroupCandidatesQueryKey(organizationId, spaceId),
    queryFn: ({ signal }) =>
      getSpaceGroupCandidates(organizationId, spaceId, signal),
  });
  const invalidateAuthorization = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: authorizedSpacesQueryKey }),
      queryClient.invalidateQueries({
        queryKey: enterpriseManagementAccessQueryKey,
      }),
    ]);
  };
  const setMemberMutation = useMutation({
    mutationFn: (input: {
      request: Parameters<typeof setSpaceMember>[3];
      userId: string;
    }) => setSpaceMember(organizationId, spaceId, input.userId, input.request),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: spaceMembersQueryKey(organizationId, spaceId),
        }),
        invalidateAuthorization(),
      ]);
    },
  });
  const revokeMemberMutation = useMutation({
    mutationFn: (userId: string) =>
      revokeSpaceMember(organizationId, spaceId, userId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: spaceMembersQueryKey(organizationId, spaceId),
        }),
        invalidateAuthorization(),
      ]);
    },
  });
  const setGroupGrantMutation = useMutation({
    mutationFn: (input: {
      groupId: string;
      request: Parameters<typeof setSpaceGroupGrant>[3];
    }) => setSpaceGroupGrant(organizationId, spaceId, input.groupId, input.request),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: spaceGroupGrantsQueryKey(organizationId, spaceId),
        }),
        invalidateAuthorization(),
      ]);
    },
  });
  const revokeGroupGrantMutation = useMutation({
    mutationFn: (groupId: string) =>
      revokeSpaceGroupGrant(organizationId, spaceId, groupId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: spaceGroupGrantsQueryKey(organizationId, spaceId),
        }),
        invalidateAuthorization(),
      ]);
    },
  });

  const queryError = membersQuery.error ?? grantsQuery.error;
  const directoryError =
    memberCandidatesQuery.error ?? groupCandidatesQuery.error;
  if (queryError) {
    return (
      <PageFailure
        error={queryError}
        onRetry={() => {
          void membersQuery.refetch();
          void grantsQuery.refetch();
          void memberCandidatesQuery.refetch();
          void groupCandidatesQuery.refetch();
        }}
      />
    );
  }

  const members = membersQuery.data?.members ?? [];
  const grants = grantsQuery.data?.grants ?? [];
  const memberIds = new Set(members.map((member) => member.userId));
  const memberCandidates = (memberCandidatesQuery.data?.members ?? []).filter(
    (member) => !memberIds.has(member.userId),
  );
  const grantedGroupIds = new Set(grants.map((grant) => grant.groupId));
  const groupCandidates = (groupCandidatesQuery.data?.groups ?? []).filter(
    (group) => !grantedGroupIds.has(group.groupId),
  );
  const mutationError =
    setMemberMutation.error ??
    revokeMemberMutation.error ??
    setGroupGrantMutation.error ??
    revokeGroupGrantMutation.error;

  return (
    <div className="flex flex-col">
      <PageHeader description="直接成员与用户组授权" title="访问权限" />
      <MutationFailure error={mutationError} />
      {directoryError ? (
        <Alert className="mx-3 mt-3" variant="destructive">
          <AlertTitle>组织目录不可用</AlertTitle>
          <AlertDescription>
            当前账号仍可调整已有授权，但暂时不能选择新的组织成员或用户组。
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="border-b">
        <SectionHeading count={members.length} title="直接成员" />
        <form
          className="grid grid-cols-[minmax(200px,1fr)_140px_auto] items-end gap-3 border-b bg-muted/25 p-3 max-sm:grid-cols-1"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const formData = new FormData(form);
            const userId = formData.get("userId");
            const request = setSpaceMemberRequestSchema.safeParse({
              role: formData.get("role"),
            });
            if (typeof userId === "string" && userId !== "" && request.success) {
              setMemberMutation.mutate(
                { request: request.data, userId },
                { onSuccess: () => form.reset() },
              );
            }
          }}
        >
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">组织成员</span>
            <Select
              disabled={directoryError !== null || memberCandidates.length === 0}
              name="userId"
              required
            >
              <option value="">选择成员</option>
              {memberCandidates.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.loginIdentifier}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">空间角色</span>
            <Select defaultValue="viewer" name="role">
              <RoleOptions />
            </Select>
          </label>
          <Button
            disabled={
              directoryError !== null ||
              setMemberMutation.isPending ||
              memberCandidates.length === 0
            }
          >
            {setMemberMutation.isPending &&
            !members.some(
              (member) => member.userId === setMemberMutation.variables?.userId,
            ) ? (
              <Spinner data-icon="inline-start" aria-label="正在添加成员" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            添加成员
          </Button>
        </form>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账号</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>空间角色</TableHead>
              <TableHead className="w-[190px] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {membersQuery.isPending ? (
              <LoadingTableRows columns={4} />
            ) : members.length === 0 ? (
              <EmptyTableRow columns={4} label="暂无直接成员" />
            ) : (
              members.map((member) => {
                const updating =
                  setMemberMutation.isPending &&
                  setMemberMutation.variables?.userId === member.userId;
                const revoking =
                  revokeMemberMutation.isPending &&
                  revokeMemberMutation.variables === member.userId;
                return (
                  <TableRow key={member.userId}>
                    <TableCell>
                      <div className="flex min-w-44 flex-col">
                        <span className="font-medium">{member.loginIdentifier}</span>
                        <code className="text-xs text-muted-foreground">{member.userId}</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={member.status === "active" ? "secondary" : "outline"}>
                        {member.status === "active" ? "活跃" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell colSpan={2}>
                      <form
                        className="flex min-w-[300px] items-center justify-end gap-2"
                        key={`${member.userId}:${member.role}`}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const request = setSpaceMemberRequestSchema.safeParse({
                            role: new FormData(event.currentTarget).get("role"),
                          });
                          if (request.success) {
                            setMemberMutation.mutate({
                              request: request.data,
                              userId: member.userId,
                            });
                          }
                        }}
                      >
                        <label className="sr-only" htmlFor={`space-member-role-${member.userId}`}>
                          {member.loginIdentifier} 的空间角色
                        </label>
                        <Select
                          defaultValue={member.role}
                          id={`space-member-role-${member.userId}`}
                          name="role"
                        >
                          <RoleOptions />
                        </Select>
                        <Button disabled={updating} size="sm" type="submit" variant="outline">
                          {updating ? (
                            <Spinner data-icon="inline-start" aria-label="正在保存" />
                          ) : (
                            <SaveIcon data-icon="inline-start" />
                          )}
                          保存
                        </Button>
                        <ConfirmAction
                          confirmLabel="撤销权限"
                          description={`撤销 ${member.loginIdentifier} 对当前空间的直接访问权限。`}
                          disabled={revoking}
                          onConfirm={() => revokeMemberMutation.mutate(member.userId)}
                          title="撤销直接成员权限？"
                        >
                          <Button
                            aria-label={`撤销 ${member.loginIdentifier} 的空间权限`}
                            disabled={revoking}
                            size="icon-sm"
                            variant="ghost"
                          >
                            {revoking ? (
                              <Spinner aria-label="正在撤销权限" />
                            ) : (
                              <Trash2Icon aria-hidden="true" />
                            )}
                          </Button>
                        </ConfirmAction>
                      </form>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      <section>
        <SectionHeading count={grants.length} title="用户组授权" />
        <form
          className="grid grid-cols-[minmax(200px,1fr)_140px_auto] items-end gap-3 border-b bg-muted/25 p-3 max-sm:grid-cols-1"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const formData = new FormData(form);
            const groupId = formData.get("groupId");
            const request = setSpaceGroupGrantRequestSchema.safeParse({
              role: formData.get("role"),
            });
            if (typeof groupId === "string" && groupId !== "" && request.success) {
              setGroupGrantMutation.mutate(
                { groupId, request: request.data },
                { onSuccess: () => form.reset() },
              );
            }
          }}
        >
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">用户组</span>
            <Select
              disabled={directoryError !== null || groupCandidates.length === 0}
              name="groupId"
              required
            >
              <option value="">选择用户组</option>
              {groupCandidates.map((group) => (
                <option key={group.groupId} value={group.groupId}>
                  {group.groupName}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">空间角色</span>
            <Select defaultValue="viewer" name="role">
              <RoleOptions />
            </Select>
          </label>
          <Button
            disabled={
              directoryError !== null ||
              setGroupGrantMutation.isPending ||
              groupCandidates.length === 0
            }
          >
            {setGroupGrantMutation.isPending &&
            !grants.some(
              (grant) => grant.groupId === setGroupGrantMutation.variables?.groupId,
            ) ? (
              <Spinner data-icon="inline-start" aria-label="正在授权用户组" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            添加授权
          </Button>
        </form>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户组</TableHead>
              <TableHead>组状态</TableHead>
              <TableHead>空间角色</TableHead>
              <TableHead className="w-[190px] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grantsQuery.isPending ? (
              <LoadingTableRows columns={4} />
            ) : grants.length === 0 ? (
              <EmptyTableRow columns={4} label="暂无用户组授权" />
            ) : (
              grants.map((grant) => {
                const updating =
                  setGroupGrantMutation.isPending &&
                  setGroupGrantMutation.variables?.groupId === grant.groupId;
                const revoking =
                  revokeGroupGrantMutation.isPending &&
                  revokeGroupGrantMutation.variables === grant.groupId;
                return (
                  <TableRow key={grant.groupId}>
                    <TableCell className="font-medium">{grant.groupName}</TableCell>
                    <TableCell>
                      <Badge variant={grant.groupStatus === "active" ? "secondary" : "outline"}>
                        {grant.groupStatus === "active" ? "活跃" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell colSpan={2}>
                      <form
                        className="flex min-w-[300px] items-center justify-end gap-2"
                        key={`${grant.groupId}:${grant.role}`}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const request = setSpaceGroupGrantRequestSchema.safeParse({
                            role: new FormData(event.currentTarget).get("role"),
                          });
                          if (request.success) {
                            setGroupGrantMutation.mutate({
                              groupId: grant.groupId,
                              request: request.data,
                            });
                          }
                        }}
                      >
                        <label className="sr-only" htmlFor={`space-group-role-${grant.groupId}`}>
                          {grant.groupName} 的空间角色
                        </label>
                        <Select
                          defaultValue={grant.role}
                          disabled={grant.groupStatus === "disabled"}
                          id={`space-group-role-${grant.groupId}`}
                          name="role"
                        >
                          <RoleOptions />
                        </Select>
                        <Button
                          disabled={updating || grant.groupStatus === "disabled"}
                          size="sm"
                          type="submit"
                          variant="outline"
                        >
                          {updating ? (
                            <Spinner data-icon="inline-start" aria-label="正在保存" />
                          ) : (
                            <SaveIcon data-icon="inline-start" />
                          )}
                          保存
                        </Button>
                        <ConfirmAction
                          confirmLabel="撤销授权"
                          description={`撤销用户组 ${grant.groupName} 对当前空间的访问权限。`}
                          disabled={revoking}
                          onConfirm={() => revokeGroupGrantMutation.mutate(grant.groupId)}
                          title="撤销用户组授权？"
                        >
                          <Button
                            aria-label={`撤销 ${grant.groupName} 的空间授权`}
                            disabled={revoking}
                            size="icon-sm"
                            variant="ghost"
                          >
                            {revoking ? (
                              <Spinner aria-label="正在撤销授权" />
                            ) : (
                              <Trash2Icon aria-hidden="true" />
                            )}
                          </Button>
                        </ConfirmAction>
                      </form>
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
