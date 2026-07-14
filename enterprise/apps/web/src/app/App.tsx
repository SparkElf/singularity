import { Navigate, Route, Routes } from "react-router";

import { LoginPage } from "@/auth/LoginPage.tsx";
import { SPACES_PATH } from "@/auth/return-to.ts";
import { SpacePage } from "@/spaces/SpacePage.tsx";
import { SpacesPage } from "@/spaces/SpacesPage.tsx";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/spaces" element={<SpacesPage />} />
      <Route
        path="/organizations/:organizationId/spaces/:spaceId"
        element={<SpacePage />}
      />
      <Route path="*" element={<Navigate replace to={SPACES_PATH} />} />
    </Routes>
  );
}
