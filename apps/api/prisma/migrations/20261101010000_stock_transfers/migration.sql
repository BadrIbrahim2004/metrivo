BEGIN;

DO $$
BEGIN
  IF to_regclass('public."Product"') IS NULL
     OR to_regclass('public."InventoryMovement"') IS NULL
     OR to_regclass('public."Branch"') IS NULL
     OR to_regclass('public."TenantPermission"') IS NULL THEN
    RAISE EXCEPTION 'Products, inventory, branches, and permissions must exist before stock transfers';
  END IF;
END;
$$;

CREATE TYPE public."StockTransferStatus" AS ENUM ('COMPLETED');

CREATE TABLE public."StockTransfer" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "sourceBranchId" TEXT NOT NULL,
  "destinationBranchId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  quantity INTEGER NOT NULL,
  status public."StockTransferStatus" NOT NULL DEFAULT 'COMPLETED',
  note VARCHAR(500),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockTransfer_quantity_positive" CHECK (quantity > 0),
  CONSTRAINT "StockTransfer_distinct_branches" CHECK ("sourceBranchId" <> "destinationBranchId"),
  CONSTRAINT "StockTransfer_id_tenant_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "StockTransfer_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockTransfer_sourceBranchId_fkey"
    FOREIGN KEY ("sourceBranchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockTransfer_destinationBranchId_fkey"
    FOREIGN KEY ("destinationBranchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockTransfer_product_tenant_fkey"
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES public."Product"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StockTransfer_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "StockTransfer_tenant_actor_idempotency_key"
  ON public."StockTransfer" ("tenantId", "actorUserId", "idempotencyKey");
CREATE INDEX "StockTransfer_tenant_created_idx"
  ON public."StockTransfer" ("tenantId", "createdAt");

ALTER TABLE public."InventoryMovement"
  ADD COLUMN "stockTransferId" TEXT;
ALTER TABLE public."InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_stock_transfer_tenant_fkey"
  FOREIGN KEY ("stockTransferId", "tenantId")
  REFERENCES public."StockTransfer"(id, "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "InventoryMovement_transfer_branch_product_key"
  ON public."InventoryMovement" ("stockTransferId", "branchId", "productId", "tenantId");
CREATE INDEX "InventoryMovement_transfer_tenant_idx"
  ON public."InventoryMovement" ("stockTransferId", "tenantId");

CREATE FUNCTION public.guard_stock_transfer_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'COMPLETED' OR NEW.status <> 'COMPLETED'
     OR NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."sourceBranchId" <> OLD."sourceBranchId"
     OR NEW."destinationBranchId" <> OLD."destinationBranchId"
     OR NEW."productId" <> OLD."productId"
     OR NEW."actorUserId" <> OLD."actorUserId"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."requestHash" <> OLD."requestHash"
     OR NEW.quantity <> OLD.quantity OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Stock transfers are immutable after completion';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "StockTransfer_no_mutation"
  BEFORE UPDATE ON public."StockTransfer"
  FOR EACH ROW EXECUTE FUNCTION public.guard_stock_transfer_transition();

CREATE FUNCTION public.reject_stock_transfer_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Stock transfers cannot be deleted';
END;
$$;
CREATE TRIGGER "StockTransfer_no_delete"
  BEFORE DELETE ON public."StockTransfer"
  FOR EACH ROW EXECUTE FUNCTION public.reject_stock_transfer_deletion();

INSERT INTO public."TenantPermission" (id, key, description)
VALUES
  ('permission-inventory-transfer', 'inventory.transfer',
   'Move stock between branches of the tenant')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON TABLE public."StockTransfer" FROM PUBLIC;

COMMIT;
