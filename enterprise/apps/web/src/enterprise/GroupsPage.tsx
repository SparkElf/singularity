import { useState } from "react";
import {
  createUserGroupRequestSchema,
  updateUserGroupRequestSchema,
} from "@singularity/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UserRoundCogIcon,
} from "lucide-react";
import { useParams } from "react-router";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";
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
  addGroupMember,
  createOrganizationGroup,
  getGroupMembers,
  getOrganizationGroups,
  getOrganizationMembers,
  groupMembersQueryKey,
  organizationGroupsQueryKey,
  organizationMembersQueryKey,
  removeGroupMember,
  updateOrganizationGroup,
} from "@/enterprise/api.ts";

export function GroupsPage() {
  const organizationId = useParams().organizationId ?? "";
  const queryClient = useQueryClient();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [createError, setCreateError] = useState(false);
  const groupsQuery = useQuery({
    queryKey: organizationGroupsQueryKey(organizationId),
    queryFn: ({ signal }) => getOrganizationGroups(organizationId, signal),
  });
  const organizationMembersQuery = useQuery({
    queryKey: organizationMembersQueryKey(organizationId),
    queryFn: ({ signal }) => getOrganizationMembers(organizationId, signal),
  });
  const groupMembersQuery = useQuery({
    enabled: selectedGroupId !== null,
    queryKey: groupMembersQueryKey(organizationId, selectedGroupId ?? ""),
    queryFn: ({ signal }) =>
      getGroupMembers(organizationId, selectedGroupId as string, signal),
  });
  const createGroupMutation = useMutation({
    mutationFn: (request: Parameters<typeof createOrganizationGroup>[1]) =>
      createOrganizationGroup(organizationId, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: organizationGroupsQueryKey(organizationId),
      });
    },
  });
  const updateGroupMutation = useMutation({
    mutationFn: (input: {
      groupId: string;
      request: Parameters<typeof updateOrganizationGroup>[2];
    }) => updateOrganizationGroup(organizationId, input.groupId, input.request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: organizationGroupsQueryKey(organizationId),
      });
    },
  });
  const addMemberMutation = useMutation({
    mutationFn: (input: { groupId: string; userId: string }) =>
      addGroupMember(organizationId, input.groupId, input.userId),
    onSuccess: async (_, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: groupMembersQueryKey(organizationId, input.groupId),
        }),
        queryClient.invalidateQueries({
          queryKey: organizationGroupsQueryKey(organizationId),
        }),
      ]);
    },
  });
  const removeMemberMutation = useMutation({
    mutationFn: (input: { groupId: string; userId: string }) =>
      removeGroupMember(organizationId, input.groupId, input.userId),
    onSuccess: async (_, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: groupMembersQueryKey(organizationId, input.groupId),
        }),
        queryClient.invalidateQueries({
          queryKey: organizationGroupsQueryKey(organizationId),
        }),
      ]);
    },
  });

  if (groupsQuery.error || organizationMembersQuery.error) {
    return (
      <PageFailure
        error={groupsQuery.error ?? organizationMembersQuery.error}
        onRetry={() => {
          void groupsQuery.refetch();
          void organizationMembersQuery.refetch();
        }}
      />
    );
  }

  const groups = groupsQuery.data?.groups ?? [];
  const selectedGroup =
    selectedGroupId === null
      ? null
      : groups.find((group) => group.groupId === selectedGroupId) ?? null;
  const groupMembers = groupMembersQuery.data?.members ?? [];
  const memberIds = new Set(groupMembers.map((member) => member.userId));
  const candidates = (organizationMembersQuery.data?.members ?? []).filter(
    (member) => member.status === "active" && !memberIds.has(member.userId),
  );
  const mutationError =
    createGroupMutation.error ??
    updateGroupMutation.error ??
    addMemberMutation.error ??
    removeMemberMutation.error;

  return (
    <div className="flex flex-col">
      <PageHeader description="组织级权限分组" title="用户组" />
      <MutationFailure error={mutationError} />

      <form
        className="grid grid-cols-[minmax(200px,420px)_auto] items-end gap-3 border-b bg-muted/25 p-3 max-sm:grid-cols-1"
        onInput={() => setCreateError(false)}
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const request = createUserGroupRequestSchema.safeParse({
            name: new FormData(form).get("name"),
          });
          if (!request.success) {
            setCreateError(true);
            return;
          }
          createGroupMutation.mutate(request.data, {
            onSuccess: () => form.reset(),
          });
        }}
      >
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">组名</span>
          <Input aria-invalid={createError || undefined} name="name" required />
        </label>
        <Button disabled={createGroupMutation.isPending} type="submit">
          {createGroupMutation.isPending ? (
            <Spinner data-icon="inline-start" aria-label="正在创建用户组" />
          ) : (
            <PlusIcon data-icon="inline-start" />
          )}
          创建用户组
        </Button>
        {createError ? (
          <p className="col-span-full text-sm text-destructive" role="alert">
            组名不能为空且不能超过 120 个字符。
          </p>
        ) : null}
      </form>

      <section>
        <SectionHeading count={groups.length} title="全部用户组" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>成员数</TableHead>
              <TableHead className="w-[240px] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupsQuery.isPending ? (
              <LoadingTableRows columns={4} />
            ) : groups.length === 0 ? (
              <EmptyTableRow columns={4} label="暂无用户组" />
            ) : (
              groups.map((group) => {
                const updating =
                  updateGroupMutation.isPending &&
                  updateGroupMutation.variables?.groupId === group.groupId;
                return (
                  <TableRow key={group.groupId}>
                    <TableCell colSpan={2}>
                      <form
                        className="flex min-w-[340px] items-center gap-2"
                        key={`${group.groupId}:${group.name}:${group.status}`}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const formData = new FormData(event.currentTarget);
                          const request = updateUserGroupRequestSchema.safeParse({
                            name: formData.get("name"),
                            status: formData.get("status"),
                          });
                          if (request.success) {
                            updateGroupMutation.mutate({
                              groupId: group.groupId,
                              request: request.data,
                            });
                          }
                        }}
                      >
                        <label className="sr-only" htmlFor={`group-name-${group.groupId}`}>
                          用户组名称
                        </label>
                        <Input
                          className="min-w-44"
                          defaultValue={group.name}
                          id={`group-name-${group.groupId}`}
                          name="name"
                          required
                        />
                        <label className="sr-only" htmlFor={`group-status-${group.groupId}`}>
                          用户组状态
                        </label>
                        <Select
                          defaultValue={group.status}
                          id={`group-status-${group.groupId}`}
                          name="status"
                        >
                          <option value="active">活跃</option>
                          <option value="disabled">停用</option>
                        </Select>
                        <Button disabled={updating} size="sm" type="submit" variant="outline">
                          {updating ? (
                            <Spinner data-icon="inline-start" aria-label="正在保存" />
                          ) : (
                            <SaveIcon data-icon="inline-start" />
                          )}
                          保存
                        </Button>
                      </form>
                    </TableCell>
                    <TableCell>{group.memberCount}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        onClick={() => setSelectedGroupId(group.groupId)}
                        size="sm"
                        variant="outline"
                      >
                        <UserRoundCogIcon data-icon="inline-start" />
                        管理成员
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      <Sheet
        onOpenChange={(open) => {
          if (!open) {
            setSelectedGroupId(null);
          }
        }}
        open={selectedGroup !== null}
      >
        <SheetContent className="w-full sm:max-w-lg">
          <SheetHeader className="border-b">
            <SheetTitle>{selectedGroup?.name ?? "用户组成员"}</SheetTitle>
            <SheetDescription>用户组成员</SheetDescription>
          </SheetHeader>
          <MutationFailure error={addMemberMutation.error ?? removeMemberMutation.error} />
          {groupMembersQuery.error ? (
            <PageFailure
              error={groupMembersQuery.error}
              onRetry={() => void groupMembersQuery.refetch()}
            />
          ) : (
            <>
              <form
                className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 border-b p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const userId = new FormData(form).get("userId");
                  if (typeof userId === "string" && userId !== "" && selectedGroup) {
                    addMemberMutation.mutate(
                      { groupId: selectedGroup.groupId, userId },
                      { onSuccess: () => form.reset() },
                    );
                  }
                }}
              >
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                  <span className="font-medium">组织成员</span>
                  <Select
                    disabled={
                      candidates.length === 0 || selectedGroup?.status === "disabled"
                    }
                    name="userId"
                    required
                  >
                    <option value="">选择成员</option>
                    {candidates.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.loginIdentifier}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button
                  disabled={
                    addMemberMutation.isPending ||
                    candidates.length === 0 ||
                    selectedGroup?.status === "disabled"
                  }
                >
                  {addMemberMutation.isPending ? (
                    <Spinner data-icon="inline-start" aria-label="正在添加成员" />
                  ) : (
                    <PlusIcon data-icon="inline-start" />
                  )}
                  添加
                </Button>
              </form>
              <div className="min-h-0 flex-1 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>账号</TableHead>
                      <TableHead className="w-16 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groupMembersQuery.isPending ? (
                      <LoadingTableRows columns={2} />
                    ) : groupMembers.length === 0 ? (
                      <EmptyTableRow columns={2} label="暂无组成员" />
                    ) : (
                      groupMembers.map((member) => {
                        const removing =
                          removeMemberMutation.isPending &&
                          removeMemberMutation.variables?.userId === member.userId;
                        return (
                          <TableRow key={member.userId}>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-medium">{member.loginIdentifier}</span>
                                <code className="text-xs text-muted-foreground">
                                  {member.userId}
                                </code>
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <ConfirmAction
                                confirmLabel="移出用户组"
                                description={`将 ${member.loginIdentifier} 移出 ${selectedGroup?.name ?? "当前用户组"}。`}
                                disabled={removing}
                                onConfirm={() => {
                                  if (selectedGroup) {
                                    removeMemberMutation.mutate({
                                      groupId: selectedGroup.groupId,
                                      userId: member.userId,
                                    });
                                  }
                                }}
                                title="移出用户组？"
                              >
                                <Button
                                  aria-label={`移出 ${member.loginIdentifier}`}
                                  disabled={removing}
                                  size="icon-sm"
                                  variant="ghost"
                                >
                                  {removing ? (
                                    <Spinner aria-label="正在移出成员" />
                                  ) : (
                                    <Trash2Icon aria-hidden="true" />
                                  )}
                                </Button>
                              </ConfirmAction>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
