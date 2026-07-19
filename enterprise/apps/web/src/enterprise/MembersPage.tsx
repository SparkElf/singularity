import { useState } from "react";
import {
  createOrganizationInvitationRequestSchema,
  updateOrganizationMemberRequestSchema,
  type OrganizationInvitationSummary,
  type OrganizationMemberSummary,
} from "@singularity/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeftIcon,
  CheckIcon,
  ClipboardIcon,
  PlusIcon,
  SaveIcon,
  ShieldOffIcon,
  Trash2Icon,
} from "lucide-react";
import { useOutletContext, useParams } from "react-router";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip.tsx";
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
  createOrganizationInvitation,
  enterpriseManagementAccessQueryKey,
  getOrganizationInvitations,
  getOrganizationMembers,
  organizationInvitationsQueryKey,
  organizationMembersQueryKey,
  revokeOrganizationInvitation,
  revokeOrganizationMemberSessions,
  transferOrganizationOwnership,
  updateOrganizationMember,
} from "@/enterprise/api.ts";
import type { EnterpriseAdminOutletContext } from "@/enterprise/EnterpriseAdminLayout.tsx";

function organizationRoleLabel(role: OrganizationMemberSummary["role"]): string {
  switch (role) {
    case "owner":
      return "所有者";
    case "admin":
      return "管理员";
    case "member":
      return "成员";
  }
}

function invitationStatus(invitation: OrganizationInvitationSummary): string {
  if (invitation.revokedAt !== undefined) {
    return "已撤销";
  }
  if (invitation.acceptedAt !== undefined) {
    return "已接受";
  }
  if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
    return "已过期";
  }
  return "等待接受";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function MembersPage() {
  const organizationId = useParams().organizationId ?? "";
  const managementAccess = useOutletContext<EnterpriseAdminOutletContext>();
  const canTransferOwnership =
    managementAccess.organizationCapabilities.includes("ownership");
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const membersQuery = useQuery({
    queryKey: organizationMembersQueryKey(organizationId),
    queryFn: ({ signal }) => getOrganizationMembers(organizationId, signal),
  });
  const invitationsQuery = useQuery({
    queryKey: organizationInvitationsQueryKey(organizationId),
    queryFn: ({ signal }) => getOrganizationInvitations(organizationId, signal),
  });
  const updateMemberMutation = useMutation({
    mutationFn: (input: {
      request: Parameters<typeof updateOrganizationMember>[2];
      userId: string;
    }) => updateOrganizationMember(organizationId, input.userId, input.request),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: organizationMembersQueryKey(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: enterpriseManagementAccessQueryKey,
        }),
      ]);
    },
  });
  const revokeSessionsMutation = useMutation({
    mutationFn: (userId: string) =>
      revokeOrganizationMemberSessions(organizationId, userId),
  });
  const transferOwnershipMutation = useMutation({
    mutationFn: (newOwnerUserId: string) =>
      transferOrganizationOwnership(organizationId, { newOwnerUserId }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: organizationMembersQueryKey(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: enterpriseManagementAccessQueryKey,
        }),
      ]);
    },
  });
  const createInvitationMutation = useMutation({
    mutationFn: (request: Parameters<typeof createOrganizationInvitation>[1]) =>
      createOrganizationInvitation(organizationId, request),
    onSuccess: async () => {
      setCopied(false);
      setCopyError(false);
      await queryClient.invalidateQueries({
        queryKey: organizationInvitationsQueryKey(organizationId),
      });
    },
  });
  const revokeInvitationMutation = useMutation({
    mutationFn: (invitationId: string) =>
      revokeOrganizationInvitation(organizationId, invitationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: organizationInvitationsQueryKey(organizationId),
      });
    },
  });

  const queryError = membersQuery.error ?? invitationsQuery.error;
  if (queryError) {
    return (
      <PageFailure
        error={queryError}
        onRetry={() => {
          void membersQuery.refetch();
          void invitationsQuery.refetch();
        }}
      />
    );
  }

  const mutationError =
    updateMemberMutation.error ??
    revokeSessionsMutation.error ??
    transferOwnershipMutation.error ??
    createInvitationMutation.error ??
    revokeInvitationMutation.error;
  const members = membersQuery.data?.members ?? [];
  const invitations = invitationsQuery.data?.invitations ?? [];
  const createdInvitationUrl = createInvitationMutation.data
    ? new URL(
        `/invitations/accept?token=${encodeURIComponent(createInvitationMutation.data.invitationToken)}`,
        window.location.origin,
      ).toString()
    : null;
  const copyInvitationUrl = async () => {
    if (createdInvitationUrl === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(createdInvitationUrl);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  const handleInvitationSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const request = createOrganizationInvitationRequestSchema.safeParse({
      expiresInHours: Number(formData.get("expiresInHours")),
      loginIdentifier: formData.get("loginIdentifier"),
      role: formData.get("role"),
    });
    if (!request.success) {
      setFormError("请输入有效账号、角色和有效期。");
      return;
    }
    setFormError(null);
    try {
      await createInvitationMutation.mutateAsync(request.data);
      form.reset();
    } catch {
      return;
    }
  };

  return (
    <div className="flex flex-col">
      <PageHeader description="组织成员、角色与邀请" title="成员与邀请" />
      <MutationFailure error={mutationError} />

      {revokeSessionsMutation.isSuccess ? (
        <Alert className="mx-3 mt-3">
          <CheckIcon aria-hidden="true" />
          <AlertTitle>成员会话已撤销</AlertTitle>
          <AlertDescription>该成员需要重新登录。</AlertDescription>
        </Alert>
      ) : null}

      <section className="border-b">
        <SectionHeading count={members.length} title="组织成员" />
        <div className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>账号</TableHead>
                <TableHead>组织角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="w-[360px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {membersQuery.isPending ? (
                <LoadingTableRows columns={4} />
              ) : members.length === 0 ? (
                <EmptyTableRow columns={4} label="暂无组织成员" />
              ) : (
                members.map((member) => {
                  const updatingThisMember =
                    updateMemberMutation.isPending &&
                    updateMemberMutation.variables?.userId === member.userId;
                  const revokingThisMember =
                    revokeSessionsMutation.isPending &&
                    revokeSessionsMutation.variables === member.userId;
                  const transferringToMember =
                    transferOwnershipMutation.isPending &&
                    transferOwnershipMutation.variables === member.userId;
                  return (
                    <TableRow key={member.userId}>
                      <TableCell>
                        <div className="flex min-w-44 flex-col">
                          <span className="font-medium">{member.loginIdentifier}</span>
                          <code className="text-xs text-muted-foreground">
                            {member.userId}
                          </code>
                        </div>
                      </TableCell>
                      {member.role === "owner" ? (
                        <>
                          <TableCell>
                            <Badge>{organizationRoleLabel(member.role)}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {member.status === "active" ? "活跃" : "停用"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <ConfirmAction
                              confirmLabel="撤销全部会话"
                              description={`将立即撤销 ${member.loginIdentifier} 的全部登录会话。`}
                              disabled={revokingThisMember}
                              onConfirm={() => revokeSessionsMutation.mutate(member.userId)}
                              title="撤销成员会话？"
                            >
                              <Button disabled={revokingThisMember} size="sm" variant="outline">
                                {revokingThisMember ? (
                                  <Spinner data-icon="inline-start" aria-label="正在撤销" />
                                ) : (
                                  <ShieldOffIcon data-icon="inline-start" />
                                )}
                                撤销会话
                              </Button>
                            </ConfirmAction>
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell colSpan={2}>
                            <form
                              className="flex min-w-[260px] items-center gap-2"
                              key={`${member.userId}:${member.role}:${member.status}`}
                              onSubmit={(event) => {
                                event.preventDefault();
                                const formData = new FormData(event.currentTarget);
                                const request = updateOrganizationMemberRequestSchema.safeParse({
                                  role: formData.get("role"),
                                  status: formData.get("status"),
                                });
                                if (request.success) {
                                  updateMemberMutation.mutate({
                                    request: request.data,
                                    userId: member.userId,
                                  });
                                }
                              }}
                            >
                              <label className="sr-only" htmlFor={`member-role-${member.userId}`}>
                                {member.loginIdentifier} 的组织角色
                              </label>
                              <Select
                                defaultValue={member.role}
                                id={`member-role-${member.userId}`}
                                name="role"
                              >
                                <option value="admin">管理员</option>
                                <option value="member">成员</option>
                              </Select>
                              <label className="sr-only" htmlFor={`member-status-${member.userId}`}>
                                {member.loginIdentifier} 的状态
                              </label>
                              <Select
                                defaultValue={member.status}
                                id={`member-status-${member.userId}`}
                                name="status"
                              >
                                <option value="active">活跃</option>
                                <option value="inactive">停用</option>
                              </Select>
                              <Button disabled={updatingThisMember} size="sm" type="submit" variant="outline">
                                {updatingThisMember ? (
                                  <Spinner data-icon="inline-start" aria-label="正在保存" />
                                ) : (
                                  <SaveIcon data-icon="inline-start" />
                                )}
                                保存
                              </Button>
                            </form>
                          </TableCell>
                          <TableCell>
                            <div className="flex min-w-[250px] justify-end gap-2">
                              {canTransferOwnership ? (
                                <ConfirmAction
                                  confirmLabel="转移所有权"
                                  description={`组织所有权将转移给 ${member.loginIdentifier}，当前所有者将变为管理员。`}
                                  disabled={transferringToMember}
                                  onConfirm={() =>
                                    transferOwnershipMutation.mutate(member.userId)
                                  }
                                  title="转移组织所有权？"
                                >
                                  <Button
                                    disabled={transferringToMember}
                                    size="sm"
                                    variant="outline"
                                  >
                                    {transferringToMember ? (
                                      <Spinner data-icon="inline-start" aria-label="正在转移" />
                                    ) : (
                                      <ArrowRightLeftIcon data-icon="inline-start" />
                                    )}
                                    转移所有权
                                  </Button>
                                </ConfirmAction>
                              ) : null}
                              <ConfirmAction
                                confirmLabel="撤销全部会话"
                                description={`将立即撤销 ${member.loginIdentifier} 的全部登录会话。`}
                                disabled={revokingThisMember}
                                onConfirm={() => revokeSessionsMutation.mutate(member.userId)}
                                title="撤销成员会话？"
                              >
                                <Button disabled={revokingThisMember} size="sm" variant="outline">
                                  {revokingThisMember ? (
                                    <Spinner data-icon="inline-start" aria-label="正在撤销" />
                                  ) : (
                                    <ShieldOffIcon data-icon="inline-start" />
                                  )}
                                  撤销会话
                                </Button>
                              </ConfirmAction>
                            </div>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <SectionHeading count={invitations.length} title="成员邀请" />
        <form
          className="grid grid-cols-[minmax(180px,1fr)_140px_140px_auto] items-end gap-3 border-b bg-muted/25 p-3 max-lg:grid-cols-2 max-sm:grid-cols-1"
          onInput={() => setFormError(null)}
          onSubmit={(event) => void handleInvitationSubmit(event)}
        >
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">账号</span>
            <Input autoComplete="off" name="loginIdentifier" required />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">角色</span>
            <Select defaultValue="member" name="role">
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </Select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">有效期</span>
            <Select defaultValue="72" name="expiresInHours">
              <option value="24">24 小时</option>
              <option value="72">3 天</option>
              <option value="168">7 天</option>
              <option value="720">30 天</option>
            </Select>
          </label>
          <Button disabled={createInvitationMutation.isPending} type="submit">
            {createInvitationMutation.isPending ? (
              <Spinner data-icon="inline-start" aria-label="正在创建邀请" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            创建邀请
          </Button>
          {formError ? (
            <p className="col-span-full text-sm text-destructive" role="alert">
              {formError}
            </p>
          ) : null}
        </form>

        {createInvitationMutation.data && createdInvitationUrl ? (
          <Alert className="m-3">
            <CheckIcon aria-hidden="true" />
            <AlertTitle>邀请已创建</AlertTitle>
            <AlertDescription className="flex min-w-0 items-center gap-2 max-sm:flex-col max-sm:items-stretch">
              <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-2 py-1">
                {createdInvitationUrl}
              </code>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="复制邀请链接"
                    onClick={() => void copyInvitationUrl()}
                    size="icon-sm"
                    variant="outline"
                  >
                    {copied ? <CheckIcon aria-hidden="true" /> : <ClipboardIcon aria-hidden="true" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copied ? "已复制" : "复制邀请链接"}</TooltipContent>
              </Tooltip>
            </AlertDescription>
            {copyError ? (
              <p className="text-sm text-destructive" role="alert">
                无法写入剪贴板。
              </p>
            ) : null}
          </Alert>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账号</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>到期时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitationsQuery.isPending ? (
              <LoadingTableRows columns={5} />
            ) : invitations.length === 0 ? (
              <EmptyTableRow columns={5} label="暂无成员邀请" />
            ) : (
              invitations.map((invitation) => {
                const status = invitationStatus(invitation);
                const canRevoke = status === "等待接受";
                const revoking =
                  revokeInvitationMutation.isPending &&
                  revokeInvitationMutation.variables === invitation.invitationId;
                return (
                  <TableRow key={invitation.invitationId}>
                    <TableCell className="font-medium">{invitation.loginIdentifier}</TableCell>
                    <TableCell>{invitation.role === "admin" ? "管理员" : "成员"}</TableCell>
                    <TableCell>{formatDate(invitation.expiresAt)}</TableCell>
                    <TableCell>
                      <Badge variant={canRevoke ? "secondary" : "outline"}>{status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canRevoke ? (
                        <ConfirmAction
                          confirmLabel="撤销邀请"
                          description={`撤销发给 ${invitation.loginIdentifier} 的邀请令牌。`}
                          disabled={revoking}
                          onConfirm={() =>
                            revokeInvitationMutation.mutate(invitation.invitationId)
                          }
                          title="撤销成员邀请？"
                        >
                          <Button
                            aria-label={`撤销 ${invitation.loginIdentifier} 的邀请`}
                            disabled={revoking}
                            size="icon-sm"
                            variant="ghost"
                          >
                            {revoking ? (
                              <Spinner aria-label="正在撤销邀请" />
                            ) : (
                              <Trash2Icon aria-hidden="true" />
                            )}
                          </Button>
                        </ConfirmAction>
                      ) : null}
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
