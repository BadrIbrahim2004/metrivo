-- Adds an optional per-invitation branch scope. Data-safe: nullable column,
-- no rows touched. Legacy invitations keep branchId NULL, which after this
-- change means the accepted member starts with SELECTED_BRANCHES and no
-- branch scope (least privilege) — scope must be granted explicitly.

ALTER TABLE public."TenantInvitation"
  ADD COLUMN "branchId" TEXT;

ALTER TABLE public."TenantInvitation"
  ADD CONSTRAINT "TenantInvitation_branch_tenant_fk"
  FOREIGN KEY ("branchId", "tenantId")
  REFERENCES public."Branch"(id, "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "TenantInvitation_branchId_idx"
  ON public."TenantInvitation" ("branchId");
