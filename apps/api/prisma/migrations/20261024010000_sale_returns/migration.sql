BEGIN;

DO $$
BEGIN
  IF to_regclass('public."Sale"') IS NULL
     OR to_regclass('public."SaleItem"') IS NULL
     OR to_regclass('public."InventoryMovement"') IS NULL
     OR to_regclass('public."TenantPermission"') IS NULL THEN
    RAISE EXCEPTION
      'Sales, inventory, and tenant authorization migrations must precede sale returns';
  END IF;
END;
$$;

CREATE TYPE public."SaleReturnRefundStatus" AS ENUM ('PENDING');

CREATE TABLE public."SaleReturn" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  "refundAmount" NUMERIC(12, 2) NOT NULL,
  "refundStatus" public."SaleReturnRefundStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SaleReturn_id_tenant_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "SaleReturn_sale_tenant_key" UNIQUE ("saleId", "tenantId"),
  CONSTRAINT "SaleReturn_tenant_branch_actor_idempotency_key"
    UNIQUE ("tenantId", "branchId", "actorUserId", "idempotencyKey"),
  CONSTRAINT "SaleReturn_reason_nonblank"
    CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  CONSTRAINT "SaleReturn_refund_positive" CHECK ("refundAmount" > 0),
  CONSTRAINT "SaleReturn_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleReturn_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleReturn_sale_tenant_fkey"
    FOREIGN KEY ("saleId", "tenantId")
    REFERENCES public."Sale"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleReturn_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "SaleReturn_tenant_branch_created_idx"
  ON public."SaleReturn" ("tenantId", "branchId", "createdAt");
CREATE INDEX "SaleReturn_actor_created_idx"
  ON public."SaleReturn" ("actorUserId", "createdAt");

ALTER TABLE public."InventoryMovement"
  ADD COLUMN "saleReturnId" TEXT;

ALTER TABLE public."InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_sale_return_tenant_fkey"
  FOREIGN KEY ("saleReturnId", "tenantId")
  REFERENCES public."SaleReturn"(id, "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE public."InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_sale_or_return_check"
  CHECK ("saleId" IS NULL OR "saleReturnId" IS NULL);

ALTER TABLE public."InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_sale_return_product_key"
  UNIQUE ("saleReturnId", "productId", "tenantId");

CREATE INDEX "InventoryMovement_sale_return_tenant_idx"
  ON public."InventoryMovement" ("saleReturnId", "tenantId");

CREATE FUNCTION public.validate_sale_return()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  sale_total NUMERIC(12, 2);
BEGIN
  SELECT s.total
    INTO sale_total
    FROM public."Sale" s
   WHERE s.id = NEW."saleId"
     AND s."tenantId" = NEW."tenantId"
     AND s."branchId" = NEW."branchId"
     AND s.status = 'COMPLETED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale return must reference a completed sale in the same branch';
  END IF;
  IF NEW."refundAmount" <> sale_total THEN
    RAISE EXCEPTION 'Full sale return amount must match the original sale total';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "SaleReturn_validate"
  BEFORE INSERT ON public."SaleReturn"
  FOR EACH ROW EXECUTE FUNCTION public.validate_sale_return();

CREATE FUNCTION public.validate_sale_return_movement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_quantity BIGINT;
BEGIN
  IF NEW."saleReturnId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."saleId" IS NOT NULL OR NEW."quantityDelta" <= 0 THEN
    RAISE EXCEPTION 'Sale return movements must restore stock without a sale link';
  END IF;

  SELECT COALESCE(SUM(si.quantity), 0)
    INTO expected_quantity
    FROM public."SaleReturn" sr
    JOIN public."SaleItem" si
      ON si."saleId" = sr."saleId"
     AND si."tenantId" = sr."tenantId"
   WHERE sr.id = NEW."saleReturnId"
     AND sr."tenantId" = NEW."tenantId"
     AND sr."branchId" = NEW."branchId"
     AND si."productId" = NEW."productId";

  IF expected_quantity = 0 OR expected_quantity <> NEW."quantityDelta" THEN
    RAISE EXCEPTION 'Sale return movement must restore the original sold quantity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "InventoryMovement_sale_return_match"
  BEFORE INSERT ON public."InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION public.validate_sale_return_movement();

CREATE FUNCTION public.require_sale_return_inventory()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT si."productId"
      FROM (
        SELECT "productId", SUM(quantity) AS quantity
          FROM public."SaleItem"
         WHERE "saleId" = NEW."saleId"
           AND "tenantId" = NEW."tenantId"
         GROUP BY "productId"
      ) si
      LEFT JOIN (
        SELECT "productId", SUM("quantityDelta") AS quantity
          FROM public."InventoryMovement"
         WHERE "saleReturnId" = NEW.id
           AND "tenantId" = NEW."tenantId"
           AND "branchId" = NEW."branchId"
         GROUP BY "productId"
      ) im ON im."productId" = si."productId"
     WHERE COALESCE(im.quantity, 0) <> si.quantity
  ) THEN
    RAISE EXCEPTION 'Sale return must restore every sold product quantity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "SaleReturn_inventory_complete"
  AFTER INSERT ON public."SaleReturn"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.require_sale_return_inventory();

CREATE FUNCTION public.reject_sale_return_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Sale return records are immutable';
END;
$$;

CREATE TRIGGER "SaleReturn_no_update_delete"
  BEFORE UPDATE OR DELETE ON public."SaleReturn"
  FOR EACH ROW EXECUTE FUNCTION public.reject_sale_return_mutation();
CREATE TRIGGER "SaleReturn_no_truncate"
  BEFORE TRUNCATE ON public."SaleReturn"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_sale_return_mutation();

INSERT INTO public."TenantPermission" (id, key, description)
VALUES ('permission-sales-return', 'sales.return', 'Return completed sales in authorized branches')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON TABLE public."SaleReturn" FROM PUBLIC;

COMMIT;
