import assert from "node:assert/strict";
import test from "node:test";

import { resolveCiImpact } from "./resolve-ci-impact.mjs";

test("documentation-only changes keep product lanes off", () => {
  const plan = resolveCiImpact(["docs/ui-governance.md", "README.md"]);
  assert.equal(plan.mode, "targeted");
  assert.equal(plan.reason, "governance or documentation only");
  assert.equal(plan.governance, true);
  assert.equal(plan.native_app, false);
  assert.equal(plan.enterprise_static, false);
  assert.equal(plan.integration, false);
  assert.equal(plan.browser, false);
  assert.equal(plan.e2e, false);
  assert.equal(plan.package, false);
});

test("enterprise web changes select static browser and e2e evidence", () => {
  const plan = resolveCiImpact(["enterprise/apps/web/src/spaces/SpacesPage.tsx"]);
  assert.equal(plan.mode, "targeted");
  assert.equal(plan.enterprise_static, true);
  assert.equal(plan.browser, true);
  assert.equal(plan.e2e, true);
  assert.equal(plan.integration, false);
});

test("native app changes include native, enterprise bridge, browser, and e2e lanes", () => {
  const plan = resolveCiImpact(["app/src/layout/dock/EnterpriseAdmin.ts"]);
  assert.equal(plan.native_app, true);
  assert.equal(plan.enterprise_static, true);
  assert.equal(plan.browser, true);
  assert.equal(plan.e2e, true);
});

test("kernel changes select integration e2e and package lanes", () => {
  const plan = resolveCiImpact(["kernel/api/router.go"]);
  assert.equal(plan.integration, true);
  assert.equal(plan.e2e, true);
  assert.equal(plan.package, true);
  assert.equal(plan.native_app, false);
});

test("upstream baseline changes always select full validation", () => {
  const plan = resolveCiImpact(["upstream/baseline.yaml", "diffs/upstream/registry.yaml"]);
  assert.equal(plan.mode, "full");
  for (const lane of ["governance", "native_app", "enterprise_static", "integration", "browser", "e2e", "package", "upstream"]) {
    assert.equal(plan[lane], true, lane);
  }
});

test("unknown paths fail open to full validation", () => {
  const plan = resolveCiImpact(["mystery/new-surface.txt"]);
  assert.equal(plan.mode, "full");
  assert.match(plan.reason, /fail open/);
});

test("force full overrides a recognized narrow change", () => {
  const plan = resolveCiImpact(["docs/ui-governance.md"], { forceFull: true });
  assert.equal(plan.mode, "full");
  assert.equal(plan.e2e, true);
});
