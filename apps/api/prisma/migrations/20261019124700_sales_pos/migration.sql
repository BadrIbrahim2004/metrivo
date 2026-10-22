-- Proposed only. Requires the branch-scope/product/inventory migration
-- 20261019122000_products_inventory_branch_scope to be present in the baseline.
-- Do not apply until the actual database baseline and grants are reviewed.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."Tenant"') IS NULL
     OR to_regclass('public."User"') IS NULL
     OR to_regclass('public."Branch"') IS NULL
     OR to_regclass('public."Product"') IS NULL
     OR to_regclass('public."InventoryMovement"') IS NULL
     OR to_regclass('public."BranchMembership"') IS NULL
     OR to_regclass('public."TenantMembership"') IS NULL
     OR to_regclass('public."TenantPermission"') IS NULL
     OR to_regclass('public."Role"') IS NULL
     OR to_regclass('public."MembershipRole"') IS NULL
     OR to_regclass('public."TenantRolePermission"') IS NULL THEN
    RAISE EXCEPTION
      'Branch-scope, product/inventory, and tenant-authorization migrations must precede sales';
  END IF;
END;
$$;

CREATE TYPE public."SaleStatus" AS ENUM ('COMPLETED');
CREATE TYPE public."SalePaymentMethod" AS ENUM (
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'OTHER'
);

CREATE TABLE public."Sale" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "invoiceNumber" VARCHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  status public."SaleStatus" NOT NULL DEFAULT 'COMPLETED',
  "paymentMethod" public."SalePaymentMethod" NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Sale_id_tenantId_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "Sale_tenant_invoiceNumber_key" UNIQUE ("tenantId", "invoiceNumber"),
  CONSTRAINT "Sale_tenant_branch_actor_idempotency_key"
    UNIQUE ("tenantId", "branchId", "actorUserId", "idempotencyKey"),
  CONSTRAINT "Sale_subtotal_nonnegative" CHECK (subtotal >= 0),
  CONSTRAINT "Sale_discount_nonnegative" CHECK (discount >= 0),
  CONSTRAINT "Sale_discount_not_above_subtotal" CHECK (discount <= subtotal),
  CONSTRAINT "Sale_total_matches_amounts" CHECK (total = subtotal - discount),
  CONSTRAINT "Sale_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Sale_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Sale_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Sale_tenant_branch_created_idx"
  ON public."Sale" ("tenantId", "branchId", "createdAt");
CREATE INDEX "Sale_actor_created_idx"
  ON public."Sale" ("actorUserId", "createdAt");

CREATE TABLE public."SaleItem" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productName" VARCHAR(200) NOT NULL,
  "productSku" VARCHAR(64) NOT NULL,
  quantity INTEGER NOT NULL,
  "unitPrice" NUMERIC(12, 2) NOT NULL,
  "lineTotal" NUMERIC(12, 2) NOT NULL,
  CONSTRAINT "SaleItem_quantity_positive" CHECK (quantity > 0),
  CONSTRAINT "SaleItem_unitPrice_nonnegative" CHECK ("unitPrice" >= 0),
  CONSTRAINT "SaleItem_lineTotal_matches_quantity"
    CHECK ("lineTotal" = "unitPrice" * quantity),
  CONSTRAINT "SaleItem_sale_tenant_fkey"
    FOREIGN KEY ("saleId", "tenantId")
    REFERENCES public."Sale"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleItem_product_tenant_fkey"
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES public."Product"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "SaleItem_sale_tenant_idx"
  ON public."SaleItem" ("saleId", "tenantId");
CREATE INDEX "SaleItem_tenant_product_idx"
  ON public."SaleItem" ("tenantId", "productId");

ALTER TABLE public."InventoryMovement"
  ADD COLUMN "saleId" TEXT;

ALTER TABLE public."InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_sale_tenant_fkey"
  FOREIGN KEY ("saleId", "tenantId")
  REFERENCES public."Sale"(id, "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "InventoryMovement_sale_tenant_idx"
  ON public."InventoryMovement" ("saleId", "tenantId");

CREATE FUNCTION public.reject_sale_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Completed sales are immutable';
END;
$$;

CREATE TRIGGER "Sale_no_update_delete"
  BEFORE UPDATE OR DELETE ON public."Sale"
  FOR EACH ROW EXECUTE FUNCTION public.reject_sale_mutation();
CREATE TRIGGER "Sale_no_truncate"
  BEFORE TRUNCATE ON public."Sale"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_sale_mutation();
CREATE TRIGGER "SaleItem_no_update_delete"
  BEFORE UPDATE OR DELETE ON public."SaleItem"
  FOR EACH ROW EXECUTE FUNCTION public.reject_sale_mutation();
CREATE TRIGGER "SaleItem_no_truncate"
  BEFORE TRUNCATE ON public."SaleItem"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_sale_mutation();

INSERT INTO public."TenantPermission" (id, key, description)
VALUES
  ('permission-sales-create', 'sales.create', 'Create sales in authorized branches'),
  ('permission-sales-read', 'sales.read', 'Read sales in authorized branches')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON TABLE public."Sale" FROM PUBLIC;
REVOKE ALL ON TABLE public."SaleItem" FROM PUBLIC;

COMMIT;
