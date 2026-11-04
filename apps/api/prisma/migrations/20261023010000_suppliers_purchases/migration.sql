BEGIN;

CREATE TYPE public."PurchaseStatus" AS ENUM ('DRAFT', 'RECEIVED', 'CANCELLED');
CREATE TYPE public."SupplierPaymentMethod" AS ENUM (
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'OTHER'
);

CREATE TABLE public."Supplier" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(40),
  email VARCHAR(320),
  address VARCHAR(500),
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Supplier_id_tenantId_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "Supplier_tenant_name_key" UNIQUE ("tenantId", name),
  CONSTRAINT "Supplier_name_nonblank" CHECK (btrim(name) <> ''),
  CONSTRAINT "Supplier_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Supplier_tenant_active_name_idx"
  ON public."Supplier" ("tenantId", "isActive", name);

CREATE TABLE public."Purchase" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "receivedByUserId" TEXT,
  "receiptNumber" VARCHAR(64) NOT NULL,
  "supplierInvoiceNumber" VARCHAR(100),
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  status public."PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
  subtotal NUMERIC(12, 2) NOT NULL,
  "receivedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Purchase_id_tenantId_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "Purchase_tenant_receiptNumber_key"
    UNIQUE ("tenantId", "receiptNumber"),
  CONSTRAINT "Purchase_idempotency_key"
    UNIQUE ("tenantId", "branchId", "createdByUserId", "idempotencyKey"),
  CONSTRAINT "Purchase_supplier_invoice_key"
    UNIQUE ("tenantId", "supplierId", "supplierInvoiceNumber"),
  CONSTRAINT "Purchase_subtotal_nonnegative" CHECK (subtotal >= 0),
  CONSTRAINT "Purchase_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Purchase_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Purchase_supplier_tenant_fkey"
    FOREIGN KEY ("supplierId", "tenantId")
    REFERENCES public."Supplier"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Purchase_creator_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Purchase_receiver_fkey"
    FOREIGN KEY ("receivedByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Purchase_received_fields_check"
    CHECK (
      (status = 'DRAFT' AND "receivedAt" IS NULL AND "receivedByUserId" IS NULL)
      OR
      (status = 'RECEIVED' AND "receivedAt" IS NOT NULL AND "receivedByUserId" IS NOT NULL)
      OR
      (status = 'CANCELLED' AND "receivedAt" IS NULL AND "receivedByUserId" IS NULL)
    )
);
CREATE INDEX "Purchase_tenant_branch_created_idx"
  ON public."Purchase" ("tenantId", "branchId", "createdAt");
CREATE INDEX "Purchase_tenant_supplier_created_idx"
  ON public."Purchase" ("tenantId", "supplierId", "createdAt");

CREATE TABLE public."PurchaseItem" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productName" VARCHAR(200) NOT NULL,
  "productSku" VARCHAR(64) NOT NULL,
  quantity INTEGER NOT NULL,
  "unitCost" NUMERIC(12, 2) NOT NULL,
  "lineTotal" NUMERIC(12, 2) NOT NULL,
  CONSTRAINT "PurchaseItem_id_tenantId_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "PurchaseItem_purchase_product_key" UNIQUE ("purchaseId", "productId"),
  CONSTRAINT "PurchaseItem_quantity_positive" CHECK (quantity > 0),
  CONSTRAINT "PurchaseItem_unitCost_nonnegative" CHECK ("unitCost" >= 0),
  CONSTRAINT "PurchaseItem_lineTotal_matches_quantity"
    CHECK ("lineTotal" = "unitCost" * quantity),
  CONSTRAINT "PurchaseItem_purchase_tenant_fkey"
    FOREIGN KEY ("purchaseId", "tenantId")
    REFERENCES public."Purchase"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseItem_product_tenant_fkey"
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES public."Product"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PurchaseItem_tenant_product_idx"
  ON public."PurchaseItem" ("tenantId", "productId");

ALTER TABLE public."InventoryMovement"
  ADD COLUMN "purchaseItemId" TEXT;
ALTER TABLE public."InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_purchaseItem_key"
  UNIQUE ("purchaseItemId", "tenantId");
ALTER TABLE public."InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_purchaseItem_tenant_fkey"
  FOREIGN KEY ("purchaseItemId", "tenantId")
  REFERENCES public."PurchaseItem"(id, "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION public.guard_purchase_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'DRAFT'
     OR NEW.status NOT IN ('RECEIVED', 'CANCELLED')
     OR (to_jsonb(NEW) - ARRAY['status', 'receivedAt', 'receivedByUserId'])
        <> (to_jsonb(OLD) - ARRAY['status', 'receivedAt', 'receivedByUserId']) THEN
    RAISE EXCEPTION 'Purchases may only transition once from DRAFT to RECEIVED or CANCELLED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Purchase_transition_guard"
  BEFORE UPDATE ON public."Purchase"
  FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_transition();
CREATE FUNCTION public.reject_purchase_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Purchase records are immutable';
END;
$$;
CREATE TRIGGER "Purchase_no_delete"
  BEFORE DELETE ON public."Purchase"
  FOR EACH ROW EXECUTE FUNCTION public.reject_purchase_mutation();
CREATE TRIGGER "Purchase_no_truncate"
  BEFORE TRUNCATE ON public."Purchase"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_purchase_mutation();

CREATE FUNCTION public.guard_purchase_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  purchase_status public."PurchaseStatus";
  target_purchase_id TEXT;
BEGIN
  target_purchase_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."purchaseId" ELSE NEW."purchaseId" END;
  SELECT status INTO purchase_status
  FROM public."Purchase"
  WHERE id = target_purchase_id AND "tenantId" = CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END
  FOR UPDATE;
  IF purchase_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Received purchase items are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER "PurchaseItem_draft_only"
  BEFORE UPDATE OR DELETE ON public."PurchaseItem"
  FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_item_mutation();
CREATE TRIGGER "PurchaseItem_no_truncate"
  BEFORE TRUNCATE ON public."PurchaseItem"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_purchase_mutation();

CREATE FUNCTION public.validate_purchase_inventory_movement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  purchase_branch_id TEXT;
  purchase_status public."PurchaseStatus";
  purchase_product_id TEXT;
BEGIN
  IF NEW."purchaseItemId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p."branchId", p.status, pi."productId"
  INTO purchase_branch_id, purchase_status, purchase_product_id
  FROM public."PurchaseItem" pi
  JOIN public."Purchase" p
    ON p.id = pi."purchaseId" AND p."tenantId" = pi."tenantId"
  WHERE pi.id = NEW."purchaseItemId"
    AND pi."tenantId" = NEW."tenantId";
  IF purchase_status IS DISTINCT FROM 'RECEIVED'
     OR purchase_branch_id IS DISTINCT FROM NEW."branchId"
     OR purchase_product_id IS DISTINCT FROM NEW."productId" THEN
    RAISE EXCEPTION 'Purchase inventory movement does not match a received purchase item';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "InventoryMovement_purchase_match"
  BEFORE INSERT ON public."InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION public.validate_purchase_inventory_movement();

CREATE TABLE public."SupplierPayment" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  method public."SupplierPaymentMethod" NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierPayment_amount_positive" CHECK (amount > 0),
  CONSTRAINT "SupplierPayment_purchase_idempotency_key"
    UNIQUE ("tenantId", "purchaseId", "idempotencyKey"),
  CONSTRAINT "SupplierPayment_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupplierPayment_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupplierPayment_purchase_tenant_fkey"
    FOREIGN KEY ("purchaseId", "tenantId")
    REFERENCES public."Purchase"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SupplierPayment_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SupplierPayment_tenant_branch_created_idx"
  ON public."SupplierPayment" ("tenantId", "branchId", "createdAt");
CREATE INDEX "SupplierPayment_tenant_purchase_created_idx"
  ON public."SupplierPayment" ("tenantId", "purchaseId", "createdAt");
CREATE TRIGGER "SupplierPayment_no_mutation"
  BEFORE UPDATE OR DELETE ON public."SupplierPayment"
  FOR EACH ROW EXECUTE FUNCTION public.reject_purchase_mutation();
CREATE TRIGGER "SupplierPayment_no_truncate"
  BEFORE TRUNCATE ON public."SupplierPayment"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_purchase_mutation();

CREATE TABLE public."PurchaseAuditLog" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  action VARCHAR(100) NOT NULL,
  metadata JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseAuditLog_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseAuditLog_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseAuditLog_purchase_tenant_fkey"
    FOREIGN KEY ("purchaseId", "tenantId")
    REFERENCES public."Purchase"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PurchaseAuditLog_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "PurchaseAuditLog_tenant_branch_occurred_idx"
  ON public."PurchaseAuditLog" ("tenantId", "branchId", "occurredAt");
CREATE INDEX "PurchaseAuditLog_purchase_tenant_occurred_idx"
  ON public."PurchaseAuditLog" ("purchaseId", "tenantId", "occurredAt");
CREATE INDEX "PurchaseAuditLog_actor_occurred_idx"
  ON public."PurchaseAuditLog" ("actorUserId", "occurredAt");
CREATE TRIGGER "PurchaseAuditLog_no_mutation"
  BEFORE UPDATE OR DELETE ON public."PurchaseAuditLog"
  FOR EACH ROW EXECUTE FUNCTION public.reject_purchase_mutation();
CREATE TRIGGER "PurchaseAuditLog_no_truncate"
  BEFORE TRUNCATE ON public."PurchaseAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_purchase_mutation();

INSERT INTO public."TenantPermission" (id, key, description)
VALUES
  ('permission-suppliers-read', 'suppliers.read', 'Read suppliers in authorized branches'),
  ('permission-suppliers-manage', 'suppliers.manage', 'Manage suppliers in authorized branches'),
  ('permission-purchases-read', 'purchases.read', 'Read purchases in authorized branches'),
  ('permission-purchases-create', 'purchases.create', 'Create supplier purchases'),
  ('permission-purchases-receive', 'purchases.receive', 'Receive purchases into branch inventory'),
  ('permission-purchases-cancel', 'purchases.cancel', 'Cancel draft purchases'),
  ('permission-purchases-pay', 'purchases.pay', 'Record supplier payments')
ON CONFLICT (key) DO NOTHING;

COMMIT;
