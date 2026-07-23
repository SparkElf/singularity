ALTER TABLE "governance_policies"
  ADD CONSTRAINT "governance_policies_created_by_membership_fkey"
  FOREIGN KEY ("organization_id", "created_by_user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_governance"
  ADD CONSTRAINT "document_governance_owner_membership_fkey"
  FOREIGN KEY ("organization_id", "owner_user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "governance_approval_requests"
  ADD CONSTRAINT "governance_approval_submitted_membership_fkey"
  FOREIGN KEY ("organization_id", "submitted_by_user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "governance_approval_decided_membership_fkey"
  FOREIGN KEY ("organization_id", "decided_by_user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "governance_templates"
  ADD CONSTRAINT "governance_templates_created_by_membership_fkey"
  FOREIGN KEY ("organization_id", "created_by_user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "enterprise_api_keys"
  ADD CONSTRAINT "enterprise_api_keys_owner_membership_fkey"
  FOREIGN KEY ("organization_id", "user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "saml_providers"
  ADD CONSTRAINT "saml_providers_created_by_membership_fkey"
  FOREIGN KEY ("organization_id", "created_by_user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "scim_tokens"
  ADD CONSTRAINT "scim_tokens_created_by_membership_fkey"
  FOREIGN KEY ("organization_id", "created_by_user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "scim_external_identities"
  ADD CONSTRAINT "scim_external_identities_group_scope_fkey"
  FOREIGN KEY ("group_id", "organization_id")
  REFERENCES "user_groups"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "personal_spaces"
  ADD CONSTRAINT "personal_spaces_space_scope_fkey"
  FOREIGN KEY ("space_id", "organization_id")
  REFERENCES "spaces"("id", "organization_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_conversations"
  ADD CONSTRAINT "ai_conversations_owner_membership_fkey"
  FOREIGN KEY ("organization_id", "user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
