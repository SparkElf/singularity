import { useState } from "react";
import {
  createSpaceRequestSchema,
  updateSpaceRequestSchema,
} from "@singularity/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon,
  SaveIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Link, useParams } from "react-router";

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
  EmptyTableRow,
  LoadingTableRows,
  MutationFailure,
  PageFailure,
  PageHeader,
  SectionHeading,
} from "@/enterprise/components.tsx";
import {
  createManagedSpace,
  getManagedSpaces,
  managedSpacesQueryKey,
  updateManagedSpace,
} from "@/enterprise/api.ts";
import { spaceSettingsPath } from "@/enterprise/routes.ts";
import { authorizedSpacesQueryKey } from "@/spaces/api.ts";

function spaceStatusLabel(status: "active" | "archived" | "disabled"): string {
  switch (status) {
    case "active":
      return "活跃";
    case "archived":
      return "已归档";
    case "disabled":
      return "已停用";
  }
}

export function SpacesManagementPage() {
  const organizationId = useParams().organizationId ?? "";
  const queryClient = useQueryClient();
  const [createError, setCreateError] = useState(false);
  const spacesQuery = useQuery({
    queryKey: managedSpacesQueryKey(organizationId),
    queryFn: ({ signal }) => getManagedSpaces(organizationId, signal),
  });
  const invalidateSpaces = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: managedSpacesQueryKey(organizationId),
      }),
      queryClient.invalidateQueries({ queryKey: authorizedSpacesQueryKey }),
    ]);
  };
  const createSpaceMutation = useMutation({
    mutationFn: (request: Parameters<typeof createManagedSpace>[1]) =>
      createManagedSpace(organizationId, request),
    onSuccess: invalidateSpaces,
  });
  const updateSpaceMutation = useMutation({
    mutationFn: (input: {
      request: Parameters<typeof updateManagedSpace>[2];
      spaceId: string;
    }) => updateManagedSpace(organizationId, input.spaceId, input.request),
    onSuccess: invalidateSpaces,
  });

  if (spacesQuery.error) {
    return (
      <PageFailure
        error={spacesQuery.error}
        onRetry={() => void spacesQuery.refetch()}
      />
    );
  }

  const spaces = spacesQuery.data?.spaces ?? [];

  return (
    <div className="flex flex-col">
      <PageHeader description="组织知识空间与生命周期" title="空间" />
      <MutationFailure error={createSpaceMutation.error ?? updateSpaceMutation.error} />

      <form
        className="grid grid-cols-[minmax(200px,420px)_auto] items-end gap-3 border-b bg-muted/25 p-3 max-sm:grid-cols-1"
        onInput={() => setCreateError(false)}
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const request = createSpaceRequestSchema.safeParse({
            name: new FormData(form).get("name"),
          });
          if (!request.success) {
            setCreateError(true);
            return;
          }
          createSpaceMutation.mutate(request.data, {
            onSuccess: () => form.reset(),
          });
        }}
      >
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">空间名称</span>
          <Input aria-invalid={createError || undefined} name="name" required />
        </label>
        <Button disabled={createSpaceMutation.isPending} type="submit">
          {createSpaceMutation.isPending ? (
            <Spinner data-icon="inline-start" aria-label="正在创建空间" />
          ) : (
            <PlusIcon data-icon="inline-start" />
          )}
          创建空间
        </Button>
        {createError ? (
          <p className="col-span-full text-sm text-destructive" role="alert">
            空间名称不能为空且不能超过 120 个字符。
          </p>
        ) : null}
      </form>

      <section>
        <SectionHeading count={spaces.length} title="全部空间" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-[190px] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spacesQuery.isPending ? (
              <LoadingTableRows columns={3} />
            ) : spaces.length === 0 ? (
              <EmptyTableRow columns={3} label="暂无空间" />
            ) : (
              spaces.map((space) => {
                const updating =
                  updateSpaceMutation.isPending &&
                  updateSpaceMutation.variables?.spaceId === space.spaceId;
                return (
                  <TableRow key={space.spaceId}>
                    <TableCell colSpan={2}>
                      <form
                        className="flex min-w-[380px] items-center gap-2"
                        key={`${space.spaceId}:${space.spaceName}:${space.status}`}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const formData = new FormData(event.currentTarget);
                          const request = updateSpaceRequestSchema.safeParse({
                            name: formData.get("name"),
                            ...(space.status === "disabled"
                              ? {}
                              : { status: formData.get("status") }),
                          });
                          if (request.success) {
                            updateSpaceMutation.mutate({
                              request: request.data,
                              spaceId: space.spaceId,
                            });
                          }
                        }}
                      >
                        <label className="sr-only" htmlFor={`space-name-${space.spaceId}`}>
                          空间名称
                        </label>
                        <Input
                          className="min-w-48"
                          defaultValue={space.spaceName}
                          id={`space-name-${space.spaceId}`}
                          name="name"
                          required
                        />
                        {space.status === "disabled" ? (
                          <Badge variant="destructive">{spaceStatusLabel(space.status)}</Badge>
                        ) : (
                          <>
                            <label className="sr-only" htmlFor={`space-status-${space.spaceId}`}>
                              空间状态
                            </label>
                            <Select
                              defaultValue={space.status}
                              id={`space-status-${space.spaceId}`}
                              name="status"
                            >
                              <option value="active">活跃</option>
                              <option value="archived">归档</option>
                            </Select>
                          </>
                        )}
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
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link to={spaceSettingsPath(organizationId, space.spaceId, "access")}>
                          <ShieldCheckIcon data-icon="inline-start" />
                          访问权限
                        </Link>
                      </Button>
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
