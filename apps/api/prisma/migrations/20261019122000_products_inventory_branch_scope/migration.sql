-- Proposed only. Do not apply before the actual baseline and database grants
-- are reviewed. This migration intentionally grants no role any permission or
-- branch access; existing and new memberships start with selected branches
-- and no BranchMembership rows.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."User"') IS NULL
     OR to_regclass('public."Tenant"') IS NULL
     OR to_regclass('public."Branch"') IS NULL
     OR to_regclass('public."TenantMembership"') IS NULL
     OR to_regclass('public."TenantPermission"') IS NULL THEN
    RAISE EXCEPTION
      'Baseline User, Tenant, Branch, TenantMembership, and TenantPermission tables are required';
  END IF;
END;
$$;

CREATE TYPE public."BranchAccessMode" AS ENUM (
  'ALL_BRANCHES',
  'SELECTED_BRANCHES'
);

ALTER TABLE public."Branch"
  ADD CONSTRAINT "Branch_id_tenantId_key" UNIQUE (id, "tenantId");

ALTER TABLE public."TenantMembership"
  ADD COLUMN "branchAccessMode" public."BranchAccessMode"
  NOT NULL DEFAULT 'SELECTED_BRANCHES';

CREATE TABLE public."BranchMembership" (
  id TEXT PRIMARY KEY,
  "membershipId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BranchMembership_membership_tenant_fkey"
    FOREIGN KEY ("membershipId", "tenantId")
    REFERENCES public."TenantMembership"(id, "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BranchMembership_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BranchMembership_membership_branch_key"
    UNIQUE ("membershipId", "branchId")
);

CREATE INDEX "BranchMembership_tenantId_branchId_idx"
  ON public."BranchMembership" ("tenantId", "branchId");
CREATE INDEX "BranchMembership_membershipId_tenantId_idx"
  ON public."BranchMembership" ("membershipId", "tenantId");

CREATE TABLE public."Product" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  price NUMERIC(12, 2) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Product_sku_nonblank" CHECK (btrim(sku) <> ''),
  CONSTRAINT "Product_name_nonblank" CHECK (btrim(name) <> ''),
  CONSTRAINT "Product_price_nonnegative" CHECK (price >= 0),
  CONSTRAINT "Product_tenant_sku_key" UNIQUE ("tenantId", sku),
  CONSTRAINT "Product_id_tenantId_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "Product_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Product_creator_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Product_tenantId_isActive_name_idx"
  ON public."Product" ("tenantId", "isActive", name);

CREATE TABLE public."InventoryMovement" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "quantityDelta" INTEGER NOT NULL,
  reason VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryMovement_nonzero_delta"
    CHECK ("quantityDelta" <> 0),
  CONSTRAINT "InventoryMovement_reason_nonblank"
    CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT "InventoryMovement_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryMovement_product_tenant_fkey"
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES public."Product"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryMovement_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "InventoryMovement_tenant_branch_product_created_idx"
  ON public."InventoryMovement" ("tenantId", "branchId", "productId", "createdAt");
CREATE INDEX "InventoryMovement_actor_created_idx"
  ON public."InventoryMovement" ("actorUserId", "createdAt");

CREATE FUNCTION public.enforce_nonnegative_inventory_movement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_quantity NUMERIC;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(NEW."tenantId"),
    hashtext(NEW."branchId" || ':' || NEW."productId")
  );

  SELECT COALESCE(SUM("quantityDelta"), 0)
  INTO current_quantity
  FROM public."InventoryMovement"
  WHERE "tenantId" = NEW."tenantId"
    AND "branchId" = NEW."branchId"
    AND "productId" = NEW."productId";

  IF current_quantity + NEW."quantityDelta" < 0
     OR current_quantity + NEW."quantityDelta" > 2000000000 THEN
    RAISE EXCEPTION 'Inventory quantity would be out of range';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "InventoryMovement_enforce_nonnegative_stock"
  BEFORE INSERT ON public."InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_nonnegative_inventory_movement();

CREATE FUNCTION public.reject_inventory_movement_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Inventory movements are append-only';
END;
$$;

CREATE TRIGGER "InventoryMovement_no_update_delete"
  BEFORE UPDATE OR DELETE ON public."InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION public.reject_inventory_movement_mutation();

CREATE TRIGGER "InventoryMovement_no_truncate"
  BEFORE TRUNCATE ON public."InventoryMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_inventory_movement_mutation();

CREATE TABLE public."TenantAuditLog" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "targetMembershipId" TEXT NOT NULL,
  action VARCHAR(100) NOT NULL,
  metadata JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantAuditLog_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TenantAuditLog_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TenantAuditLog_membership_tenant_fkey"
    FOREIGN KEY ("targetMembershipId", "tenantId")
    REFERENCES public."TenantMembership"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "TenantAuditLog_tenantId_occurredAt_idx"
  ON public."TenantAuditLog" ("tenantId", "occurredAt");
CREATE INDEX "TenantAuditLog_actorUserId_occurredAt_idx"
  ON public."TenantAuditLog" ("actorUserId", "occurredAt");
CREATE INDEX "TenantAuditLog_targetMembership_tenant_occurred_idx"
  ON public."TenantAuditLog" ("targetMembershipId", "tenantId", "occurredAt");

CREATE FUNCTION public.reject_tenant_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Tenant audit log is append-only';
END;
$$;

CREATE TRIGGER "TenantAuditLog_no_update_delete"
  BEFORE UPDATE OR DELETE ON public."TenantAuditLog"
  FOR EACH ROW EXECUTE FUNCTION public.reject_tenant_audit_mutation();

CREATE TRIGGER "TenantAuditLog_no_truncate"
  BEFORE TRUNCATE ON public."TenantAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_tenant_audit_mutation();

INSERT INTO public."TenantPermission" (id, key, description)
VALUES
  ('permission-catalog-products-read', 'catalog.products.read', 'Read tenant products'),
  ('permission-catalog-products-manage', 'catalog.products.manage', 'Create and update tenant products'),
  ('permission-inventory-read', 'inventory.read', 'Read branch inventory and movements'),
  ('permission-inventory-adjust', 'inventory.adjust', 'Create branch inventory movements'),
  ('permission-tenant-members-manage', 'tenant.members.manage', 'Manage tenant membership branch access')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON TABLE public."BranchMembership" FROM PUBLIC;
REVOKE ALL ON TABLE public."Product" FROM PUBLIC;
REVOKE ALL ON TABLE public."InventoryMovement" FROM PUBLIC;
REVOKE ALL ON TABLE public."TenantAuditLog" FROM PUBLIC;

COMMIT;
