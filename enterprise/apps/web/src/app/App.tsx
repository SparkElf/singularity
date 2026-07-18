import { Navigate, Route, Routes } from "react-router";

import { LoginPage } from "@/auth/LoginPage.tsx";
import { SPACES_PATH } from "@/auth/return-to.ts";
import { AuditPage } from "@/enterprise/AuditPage.tsx";
import { BackupsPage } from "@/enterprise/BackupsPage.tsx";
import { EnterpriseAdminLayout } from "@/enterprise/EnterpriseAdminLayout.tsx";
import { GroupsPage } from "@/enterprise/GroupsPage.tsx";
import { InvitationAcceptPage } from "@/enterprise/InvitationAcceptPage.tsx";
import { MembersPage } from "@/enterprise/MembersPage.tsx";
import { OidcPage } from "@/enterprise/OidcPage.tsx";
import { ObservabilityPage } from "@/enterprise/ObservabilityPage.tsx";
import { SharesPage } from "@/enterprise/SharesPage.tsx";
import { SpaceAccessPage } from "@/enterprise/SpaceAccessPage.tsx";
import { SpacesManagementPage } from "@/enterprise/SpacesManagementPage.tsx";
import { PublicSharePage } from "@/shares/PublicSharePage.tsx";
import {
  SpacePage,
  type SpaceProtyleFactoryProvider,
} from "@/spaces/SpacePage.tsx";
import { SpacesPage } from "@/spaces/SpacesPage.tsx";

export interface AppProps {
  readonly createProtyleFactoryForSpace: SpaceProtyleFactoryProvider;
}

export function App({ createProtyleFactoryForSpace }: AppProps) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invitations/accept" element={<InvitationAcceptPage />} />
      <Route path="/shares/:shareToken" element={<PublicSharePage />} />
      <Route path="/spaces" element={<SpacesPage />} />
      <Route
        path="/organizations/:organizationId/spaces/:spaceId"
        element={
          <SpacePage
            createProtyleFactoryForSpace={createProtyleFactoryForSpace}
          />
        }
      />
      <Route
        path="/organizations/:organizationId/settings"
        element={<EnterpriseAdminLayout />}
      >
        <Route index element={<Navigate replace to="members" />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="groups" element={<GroupsPage />} />
        <Route path="spaces" element={<SpacesManagementPage />} />
        <Route path="oidc" element={<OidcPage />} />
        <Route path="audit" element={<AuditPage scope="organization" />} />
        <Route path="spaces/:spaceId/access" element={<SpaceAccessPage />} />
        <Route path="spaces/:spaceId/shares" element={<SharesPage />} />
        <Route
          path="spaces/:spaceId/audit"
          element={<AuditPage scope="space" />}
        />
        <Route path="spaces/:spaceId/backups" element={<BackupsPage />} />
        <Route
          path="spaces/:spaceId/observability"
          element={<ObservabilityPage />}
        />
      </Route>
      <Route path="*" element={<Navigate replace to={SPACES_PATH} />} />
    </Routes>
  );
}
