import { useState } from "react";
import {
  createOidcProviderRequestSchema,
  updateOidcProviderRequestSchema,
  type ManagedOidcProvider,
} from "@singularity/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon,
  SaveIcon,
} from "lucide-react";
import { useParams } from "react-router";

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
  prioritizedError,
} from "@/enterprise/components.tsx";
import {
  createManagedOidcProvider,
  getManagedOidcProviders,
  managedOidcProvidersQueryKey,
  updateManagedOidcProvider,
} from "@/enterprise/api.ts";

interface ProviderRowProps {
  onSubmit: (
    providerId: string,
    request: Parameters<typeof updateManagedOidcProvider>[2],
  ) => void;
  pending: boolean;
  provider: ManagedOidcProvider;
}

function ProviderRow({ onSubmit, pending, provider }: ProviderRowProps) {
  const [secretAction, setSecretAction] = useState<"keep" | "remove" | "replace">(
    "keep",
  );
  const [validationError, setValidationError] = useState(false);
  const formId = `oidc-provider-${provider.providerId}`;
  return (
    <TableRow>
      <TableCell>
        <form
          id={formId}
          key={`${provider.providerId}:${provider.name}:${provider.issuer}:${provider.clientId}:${provider.status}`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const secretReference = formData.get("clientSecretReference");
            const request = updateOidcProviderRequestSchema.safeParse({
              clientId: formData.get("clientId"),
              ...(secretAction === "replace"
                ? { clientSecretReference: secretReference }
                : secretAction === "remove"
                  ? { clientSecretReference: null }
                  : {}),
              issuer: formData.get("issuer"),
              name: formData.get("name"),
              status: formData.get("status"),
            });
            if (!request.success) {
              setValidationError(true);
              return;
            }
            setValidationError(false);
            onSubmit(provider.providerId, request.data);
          }}
        >
          <label className="sr-only" htmlFor={`${formId}-name`}>
            Provider 名称
          </label>
          <Input
            className="min-w-40"
            defaultValue={provider.name}
            id={`${formId}-name`}
            name="name"
            required
            aria-invalid={validationError || undefined}
            onInput={() => setValidationError(false)}
          />
          {validationError ? (
            <p className="mt-1 text-xs text-destructive" role="alert">
              Provider 配置不符合公开合同，请检查各字段。
            </p>
          ) : null}
        </form>
      </TableCell>
      <TableCell>
        <label className="sr-only" htmlFor={`${formId}-issuer`}>
          Issuer
        </label>
        <Input
          className="min-w-64"
          defaultValue={provider.issuer}
          form={formId}
          id={`${formId}-issuer`}
          name="issuer"
          required
          type="url"
          aria-invalid={validationError || undefined}
          onInput={() => setValidationError(false)}
        />
      </TableCell>
      <TableCell>
        <label className="sr-only" htmlFor={`${formId}-client-id`}>
          Client ID
        </label>
        <Input
          className="min-w-48"
          defaultValue={provider.clientId}
          form={formId}
          id={`${formId}-client-id`}
          name="clientId"
          required
          aria-invalid={validationError || undefined}
          onInput={() => setValidationError(false)}
        />
      </TableCell>
      <TableCell>
        <div className="flex min-w-[260px] items-center gap-2">
          <label className="sr-only" htmlFor={`${formId}-secret-action`}>
            Client Secret 引用操作
          </label>
          <Select
            id={`${formId}-secret-action`}
            onChange={(event) =>
              setSecretAction(event.currentTarget.value as typeof secretAction)
            }
            onInput={() => setValidationError(false)}
            value={secretAction}
            aria-invalid={validationError || undefined}
          >
            <option value="keep">保持</option>
            <option value="replace">替换</option>
            <option value="remove">移除</option>
          </Select>
          {secretAction === "replace" ? (
            <>
              <label className="sr-only" htmlFor={`${formId}-secret-reference`}>
                Client Secret 引用
              </label>
              <Input
                className="min-w-40"
                form={formId}
                id={`${formId}-secret-reference`}
                name="clientSecretReference"
                required
                aria-invalid={validationError || undefined}
                onInput={() => setValidationError(false)}
              />
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {provider.clientSecretReference ?? "未返回引用"}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <label className="sr-only" htmlFor={`${formId}-status`}>
          Provider 状态
        </label>
        <Select
          defaultValue={provider.status}
          form={formId}
          id={`${formId}-status`}
          name="status"
          aria-invalid={validationError || undefined}
          onInput={() => setValidationError(false)}
        >
          <option value="active">活跃</option>
          <option value="disabled">停用</option>
        </Select>
      </TableCell>
      <TableCell className="text-right">
        <Button disabled={pending} form={formId} size="sm" type="submit" variant="outline">
          {pending ? (
            <Spinner data-icon="inline-start" aria-label="正在保存" />
          ) : (
            <SaveIcon data-icon="inline-start" />
          )}
          保存
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function OidcPage() {
  const organizationId = useParams().organizationId ?? "";
  const queryClient = useQueryClient();
  const [createError, setCreateError] = useState(false);
  const providersQuery = useQuery({
    queryKey: managedOidcProvidersQueryKey(organizationId),
    queryFn: ({ signal }) => getManagedOidcProviders(organizationId, signal),
  });
  const createProviderMutation = useMutation({
    mutationFn: (request: Parameters<typeof createManagedOidcProvider>[1]) =>
      createManagedOidcProvider(organizationId, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: managedOidcProvidersQueryKey(organizationId),
      });
    },
  });
  const updateProviderMutation = useMutation({
    mutationFn: (input: {
      providerId: string;
      request: Parameters<typeof updateManagedOidcProvider>[2];
    }) => updateManagedOidcProvider(organizationId, input.providerId, input.request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: managedOidcProvidersQueryKey(organizationId),
      });
    },
  });

  if (providersQuery.error) {
    return (
      <PageFailure
        error={providersQuery.error}
        onRetry={() => void providersQuery.refetch()}
      />
    );
  }

  const providers = providersQuery.data?.providers ?? [];
  const mutationErrors = [
    createProviderMutation.error,
    updateProviderMutation.error,
  ];
  const mutationError = prioritizedError(mutationErrors);

  return (
    <div className="flex flex-col">
      <PageHeader description="组织 OpenID Connect Provider" title="单点登录" />
      <MutationFailure error={mutationError} />

      <form
        className="grid grid-cols-4 items-end gap-3 border-b bg-muted/25 p-3 max-xl:grid-cols-2 max-sm:grid-cols-1"
        onInput={() => setCreateError(false)}
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const formData = new FormData(form);
          const secretReference = formData.get("clientSecretReference");
          const request = createOidcProviderRequestSchema.safeParse({
            clientId: formData.get("clientId"),
            ...(typeof secretReference === "string" && secretReference !== ""
              ? { clientSecretReference: secretReference }
              : {}),
            issuer: formData.get("issuer"),
            name: formData.get("name"),
          });
          if (!request.success) {
            setCreateError(true);
            return;
          }
          createProviderMutation.mutate(request.data, {
            onSuccess: () => form.reset(),
          });
        }}
      >
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">名称</span>
          <Input aria-invalid={createError || undefined} name="name" required />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">Issuer</span>
          <Input aria-invalid={createError || undefined} name="issuer" required type="url" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">Client ID</span>
          <Input aria-invalid={createError || undefined} name="clientId" required />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="font-medium">Client Secret 引用</span>
          <Input aria-invalid={createError || undefined} name="clientSecretReference" />
        </label>
        <div className="col-span-full flex items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
          {createError ? (
            <p className="text-sm text-destructive" role="alert">
              Provider 配置不符合公开合同，请检查各字段。
            </p>
          ) : (
            <span />
          )}
          <Button disabled={createProviderMutation.isPending} type="submit">
            {createProviderMutation.isPending ? (
              <Spinner data-icon="inline-start" aria-label="正在创建 Provider" />
            ) : (
              <PlusIcon data-icon="inline-start" />
            )}
            创建 Provider
          </Button>
        </div>
      </form>

      <section>
        <SectionHeading count={providers.length} title="已配置 Provider" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Issuer</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Secret 引用</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providersQuery.isPending ? (
              <LoadingTableRows columns={6} />
            ) : providers.length === 0 ? (
              <EmptyTableRow columns={6} label="暂无 OIDC Provider" />
            ) : (
              providers.map((provider) => (
                <ProviderRow
                  key={[
                    provider.providerId,
                    provider.name,
                    provider.issuer,
                    provider.clientId,
                    provider.clientSecretReference ?? "",
                    provider.status,
                  ].join(":")}
                  onSubmit={(providerId, request) =>
                    updateProviderMutation.mutate({ providerId, request })
                  }
                  pending={
                    updateProviderMutation.isPending &&
                    updateProviderMutation.variables?.providerId === provider.providerId
                  }
                  provider={provider}
                />
              ))
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
