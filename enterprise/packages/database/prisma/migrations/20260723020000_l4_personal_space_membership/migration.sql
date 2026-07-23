ALTER TABLE "personal_spaces"
  ADD CONSTRAINT "personal_spaces_owner_membership_fkey"
  FOREIGN KEY ("organization_id", "user_id")
  REFERENCES "organization_memberships"("organization_id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
