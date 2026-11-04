BEGIN;

DO $$
BEGIN
  IF to_regclass('public."SaleReturn"') IS NULL
     OR to_regclass('public."Sale"') IS NULL
     OR to_regclass('public."TenantPermission"') IS NULL THEN
    RAISE EXCEPTION
      'Sale returns and tenant permissions must exist before cash management';
  END IF;
END;
$$;

CREATE TYPE public."CashShiftStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE public."CashMovementType" AS ENUM ('CASH_IN', 'CASH_OUT');
CREATE TYPE public."CashSettlementMethod" AS ENUM (
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'OTHER'
);

ALTER TABLE public."SaleReturn"
  ALTER COLUMN "refundStatus" DROP DEFAULT;
ALTER TABLE public."SaleReturn"
  ALTER COLUMN "refundStatus" TYPE VARCHAR(16)
  USING "refundStatus"::text;
ALTER TABLE public."SaleReturn"
  ALTER COLUMN "refundStatus" SET DEFAULT 'PENDING';
DROP TYPE public."SaleReturnRefundStatus";
ALTER TABLE public."SaleReturn"
  ADD CONSTRAINT "SaleReturn_refund_status_check"
  CHECK ("refundStatus" IN ('PENDING', 'SETTLED'));

CREATE TABLE public."CashShift" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "openedByUserId" TEXT NOT NULL,
  "closedByUserId" TEXT,
  status public."CashShiftStatus" NOT NULL DEFAULT 'OPEN',
  "openingCash" NUMERIC(12, 2) NOT NULL,
  "expectedCash" NUMERIC(12, 2),
  "countedCash" NUMERIC(12, 2),
  discrepancy NUMERIC(12, 2),
  "openedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMPTZ(6),
  CONSTRAINT "CashShift_id_tenant_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "CashShift_id_tenant_branch_key" UNIQUE (id, "tenantId", "branchId"),
  CONSTRAINT "CashShift_opening_nonnegative" CHECK ("openingCash" >= 0),
  CONSTRAINT "CashShift_expected_nonnegative" CHECK ("expectedCash" IS NULL OR "expectedCash" >= 0),
  CONSTRAINT "CashShift_counted_nonnegative" CHECK ("countedCash" IS NULL OR "countedCash" >= 0),
  CONSTRAINT "CashShift_closed_fields_check" CHECK (
    (status = 'OPEN' AND "closedByUserId" IS NULL AND "closedAt" IS NULL
      AND "expectedCash" IS NULL AND "countedCash" IS NULL AND discrepancy IS NULL)
    OR
    (status = 'CLOSED' AND "closedByUserId" IS NOT NULL AND "closedAt" IS NOT NULL
      AND "expectedCash" IS NOT NULL AND "countedCash" IS NOT NULL
      AND discrepancy = "countedCash" - "expectedCash")
  ),
  CONSTRAINT "CashShift_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashShift_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashShift_opener_fkey"
    FOREIGN KEY ("openedByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashShift_closer_fkey"
    FOREIGN KEY ("closedByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CashShift_one_open_per_branch"
  ON public."CashShift" ("tenantId", "branchId")
  WHERE status = 'OPEN';
CREATE INDEX "CashShift_tenant_branch_opened_idx"
  ON public."CashShift" ("tenantId", "branchId", "openedAt");

CREATE TABLE public."CashMovement" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "cashShiftId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  type public."CashMovementType" NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CashMovement_amount_positive" CHECK (amount > 0),
  CONSTRAINT "CashMovement_reason_nonblank" CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT "CashMovement_tenant_shift_actor_key"
    UNIQUE ("tenantId", "cashShiftId", "actorUserId", "idempotencyKey"),
  CONSTRAINT "CashMovement_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashMovement_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashMovement_shift_tenant_fkey"
    FOREIGN KEY ("cashShiftId", "tenantId", "branchId")
    REFERENCES public."CashShift"(id, "tenantId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashMovement_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CashMovement_tenant_branch_shift_created_idx"
  ON public."CashMovement" ("tenantId", "branchId", "cashShiftId", "createdAt");

ALTER TABLE public."SaleReturn"
  ADD CONSTRAINT "SaleReturn_id_tenant_branch_key"
  UNIQUE (id, "tenantId", "branchId");

CREATE TABLE public."SaleReturnSettlement" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "saleReturnId" TEXT NOT NULL,
  "cashShiftId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  method public."CashSettlementMethod" NOT NULL,
  reference VARCHAR(200),
  "settledAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SaleReturnSettlement_amount_positive" CHECK (amount > 0),
  CONSTRAINT "SaleReturnSettlement_return_tenant_key"
    UNIQUE ("saleReturnId", "tenantId", "branchId"),
  CONSTRAINT "SaleReturnSettlement_tenant_return_actor_idempotency_key"
    UNIQUE ("tenantId", "saleReturnId", "actorUserId", "idempotencyKey"),
  CONSTRAINT "SaleReturnSettlement_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleReturnSettlement_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleReturnSettlement_return_tenant_fkey"
    FOREIGN KEY ("saleReturnId", "tenantId", "branchId")
    REFERENCES public."SaleReturn"(id, "tenantId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleReturnSettlement_shift_tenant_fkey"
    FOREIGN KEY ("cashShiftId", "tenantId", "branchId")
    REFERENCES public."CashShift"(id, "tenantId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SaleReturnSettlement_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SaleReturnSettlement_tenant_branch_settled_idx"
  ON public."SaleReturnSettlement" ("tenantId", "branchId", "settledAt");

CREATE TABLE public."CashAuditLog" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "cashShiftId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  action VARCHAR(100) NOT NULL,
  metadata JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CashAuditLog_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashAuditLog_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashAuditLog_shift_tenant_fkey"
    FOREIGN KEY ("cashShiftId", "tenantId", "branchId")
    REFERENCES public."CashShift"(id, "tenantId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CashAuditLog_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CashAuditLog_tenant_branch_occurred_idx"
  ON public."CashAuditLog" ("tenantId", "branchId", "occurredAt");
CREATE INDEX "CashAuditLog_shift_tenant_occurred_idx"
  ON public."CashAuditLog" ("cashShiftId", "tenantId", "occurredAt");

ALTER TABLE public."Sale"
  ADD COLUMN "cashShiftId" TEXT;
ALTER TABLE public."Sale"
  ADD CONSTRAINT "Sale_id_tenant_branch_key"
  UNIQUE (id, "tenantId", "branchId");
ALTER TABLE public."SaleReturn"
  DROP CONSTRAINT "SaleReturn_sale_tenant_fkey";
ALTER TABLE public."SaleReturn"
  ADD CONSTRAINT "SaleReturn_sale_tenant_branch_fkey"
  FOREIGN KEY ("saleId", "tenantId", "branchId")
  REFERENCES public."Sale"(id, "tenantId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."Sale"
  ADD CONSTRAINT "Sale_cash_shift_tenant_fkey"
  FOREIGN KEY ("cashShiftId", "tenantId", "branchId")
  REFERENCES public."CashShift"(id, "tenantId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Sale_cash_shift_tenant_idx"
  ON public."Sale" ("cashShiftId", "tenantId");

CREATE FUNCTION public.guard_cash_shift_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'OPEN' OR NEW.status <> 'CLOSED'
     OR NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."branchId" <> OLD."branchId"
     OR NEW."openedByUserId" <> OLD."openedByUserId"
     OR NEW."openingCash" <> OLD."openingCash"
     OR NEW."openedAt" <> OLD."openedAt" THEN
    RAISE EXCEPTION 'Cash shifts may only transition once from OPEN to CLOSED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CashShift_transition_guard"
  BEFORE UPDATE ON public."CashShift"
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_shift_transition();
CREATE FUNCTION public.reject_cash_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Cash ledger records are immutable';
END;
$$;
CREATE TRIGGER "CashShift_no_delete"
  BEFORE DELETE ON public."CashShift"
  FOR EACH ROW EXECUTE FUNCTION public.reject_cash_ledger_mutation();
CREATE TRIGGER "CashShift_no_truncate"
  BEFORE TRUNCATE ON public."CashShift"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_cash_ledger_mutation();
CREATE TRIGGER "CashMovement_no_mutation"
  BEFORE UPDATE OR DELETE ON public."CashMovement"
  FOR EACH ROW EXECUTE FUNCTION public.reject_cash_ledger_mutation();
CREATE TRIGGER "CashMovement_no_truncate"
  BEFORE TRUNCATE ON public."CashMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_cash_ledger_mutation();
CREATE TRIGGER "CashAuditLog_no_mutation"
  BEFORE UPDATE OR DELETE ON public."CashAuditLog"
  FOR EACH ROW EXECUTE FUNCTION public.reject_cash_ledger_mutation();
CREATE TRIGGER "CashAuditLog_no_truncate"
  BEFORE TRUNCATE ON public."CashAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_cash_ledger_mutation();
CREATE TRIGGER "SaleReturnSettlement_no_mutation"
  BEFORE UPDATE OR DELETE ON public."SaleReturnSettlement"
  FOR EACH ROW EXECUTE FUNCTION public.reject_cash_ledger_mutation();
CREATE TRIGGER "SaleReturnSettlement_no_truncate"
  BEFORE TRUNCATE ON public."SaleReturnSettlement"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_cash_ledger_mutation();

CREATE FUNCTION public.validate_cash_ledger_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  shift_status public."CashShiftStatus";
BEGIN
  SELECT status INTO shift_status
    FROM public."CashShift"
   WHERE id = NEW."cashShiftId"
     AND "tenantId" = NEW."tenantId"
     AND "branchId" = NEW."branchId"
   FOR UPDATE;
  IF NOT FOUND OR shift_status <> 'OPEN' THEN
    RAISE EXCEPTION 'Cash ledger entries require an open shift in the same branch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CashMovement_open_shift_guard"
  BEFORE INSERT ON public."CashMovement"
  FOR EACH ROW EXECUTE FUNCTION public.validate_cash_ledger_insert();
CREATE TRIGGER "SaleReturnSettlement_open_shift_guard"
  BEFORE INSERT ON public."SaleReturnSettlement"
  FOR EACH ROW EXECUTE FUNCTION public.validate_cash_ledger_insert();

CREATE FUNCTION public.validate_cash_movement_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_cash NUMERIC(12, 2);
BEGIN
  IF NEW.type <> 'CASH_OUT' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public."CashShift"
   WHERE id = NEW."cashShiftId" AND "tenantId" = NEW."tenantId"
   FOR UPDATE;
  SELECT cs."openingCash"
       + COALESCE((SELECT SUM(CASE WHEN cm.type = 'CASH_IN' THEN cm.amount ELSE -cm.amount END)
            FROM public."CashMovement" cm
           WHERE cm."cashShiftId" = cs.id AND cm."tenantId" = cs."tenantId"), 0)
       + COALESCE((SELECT SUM(s.total) FROM public."Sale" s
           WHERE s."cashShiftId" = cs.id AND s."tenantId" = cs."tenantId"), 0)
       - COALESCE((SELECT SUM(rs.amount) FROM public."SaleReturnSettlement" rs
           WHERE rs."cashShiftId" = cs.id AND rs."tenantId" = cs."tenantId"
             AND rs.method = 'CASH'), 0)
    INTO expected_cash
    FROM public."CashShift" cs
   WHERE cs.id = NEW."cashShiftId" AND cs."tenantId" = NEW."tenantId";
  IF NEW.amount > expected_cash THEN
    RAISE EXCEPTION 'Cash-out exceeds the expected drawer balance';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CashMovement_balance_guard"
  BEFORE INSERT ON public."CashMovement"
  FOR EACH ROW EXECUTE FUNCTION public.validate_cash_movement_balance();

CREATE FUNCTION public.validate_cash_refund_drawer_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_cash NUMERIC(12, 2);
BEGIN
  IF NEW.method <> 'CASH' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public."CashShift"
   WHERE id = NEW."cashShiftId" AND "tenantId" = NEW."tenantId"
   FOR UPDATE;
  SELECT cs."openingCash"
       + COALESCE((SELECT SUM(CASE WHEN cm.type = 'CASH_IN' THEN cm.amount ELSE -cm.amount END)
            FROM public."CashMovement" cm
           WHERE cm."cashShiftId" = cs.id AND cm."tenantId" = cs."tenantId"), 0)
       + COALESCE((SELECT SUM(s.total) FROM public."Sale" s
           WHERE s."cashShiftId" = cs.id AND s."tenantId" = cs."tenantId"), 0)
       - COALESCE((SELECT SUM(rs.amount) FROM public."SaleReturnSettlement" rs
           WHERE rs."cashShiftId" = cs.id AND rs."tenantId" = cs."tenantId"
             AND rs.method = 'CASH'), 0)
    INTO expected_cash
    FROM public."CashShift" cs
   WHERE cs.id = NEW."cashShiftId" AND cs."tenantId" = NEW."tenantId";
  IF NEW.amount > expected_cash THEN
    RAISE EXCEPTION 'Cash drawer balance is insufficient for refund settlement';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SaleReturnSettlement_cash_balance_guard"
  BEFORE INSERT ON public."SaleReturnSettlement"
  FOR EACH ROW EXECUTE FUNCTION public.validate_cash_refund_drawer_balance();

CREATE FUNCTION public.guard_sale_return_refund_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."refundStatus" <> 'PENDING' OR NEW."refundStatus" <> 'SETTLED'
     OR NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."branchId" <> OLD."branchId" OR NEW."saleId" <> OLD."saleId"
     OR NEW."actorUserId" <> OLD."actorUserId"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."requestHash" <> OLD."requestHash"
     OR NEW.reason <> OLD.reason OR NEW."refundAmount" <> OLD."refundAmount"
     OR NEW."createdAt" <> OLD."createdAt"
     OR NOT EXISTS (
       SELECT 1 FROM public."SaleReturnSettlement" s
        WHERE s."saleReturnId" = NEW.id AND s."tenantId" = NEW."tenantId"
     ) THEN
    RAISE EXCEPTION 'Sale return refund may only transition from PENDING to SETTLED with a settlement';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER "SaleReturn_no_update_delete" ON public."SaleReturn";
CREATE TRIGGER "SaleReturn_refund_transition_guard"
  BEFORE UPDATE ON public."SaleReturn"
  FOR EACH ROW EXECUTE FUNCTION public.guard_sale_return_refund_transition();
CREATE TRIGGER "SaleReturn_no_delete"
  BEFORE DELETE ON public."SaleReturn"
  FOR EACH ROW EXECUTE FUNCTION public.reject_sale_return_mutation();
CREATE FUNCTION public.validate_refund_settlement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  refund_amount NUMERIC(12, 2);
  refund_status TEXT;
BEGIN
  SELECT "refundAmount", "refundStatus"
    INTO refund_amount, refund_status
    FROM public."SaleReturn"
   WHERE id = NEW."saleReturnId"
     AND "tenantId" = NEW."tenantId"
     AND "branchId" = NEW."branchId"
   FOR UPDATE;
  IF NOT FOUND OR refund_status <> 'PENDING'
     OR NEW.amount <> refund_amount THEN
    RAISE EXCEPTION 'Settlement must exactly match a pending refund obligation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SaleReturnSettlement_validate"
  BEFORE INSERT ON public."SaleReturnSettlement"
  FOR EACH ROW EXECUTE FUNCTION public.validate_refund_settlement();

CREATE FUNCTION public.validate_cash_sale_shift()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  shift_status public."CashShiftStatus";
  shift_branch TEXT;
BEGIN
  IF NEW."paymentMethod" <> 'CASH' THEN
    IF NEW."cashShiftId" IS NOT NULL THEN
      RAISE EXCEPTION 'Non-cash sales cannot be assigned to a cash shift';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status, "branchId"
    INTO shift_status, shift_branch
    FROM public."CashShift"
   WHERE id = NEW."cashShiftId" AND "tenantId" = NEW."tenantId"
   FOR UPDATE;
  IF NOT FOUND OR shift_status <> 'OPEN' OR shift_branch <> NEW."branchId" THEN
    RAISE EXCEPTION 'Cash sales require an open cash shift in the same branch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Sale_cash_shift_guard"
  BEFORE INSERT ON public."Sale"
  FOR EACH ROW EXECUTE FUNCTION public.validate_cash_sale_shift();

INSERT INTO public."TenantPermission" (id, key, description)
VALUES
  ('permission-cash-read', 'cash.read', 'Read cash shifts and refund obligations'),
  ('permission-cash-manage', 'cash.manage', 'Open, close, and record cash movements'),
  ('permission-refunds-settle', 'refunds.settle', 'Record internal settlement of pending refunds')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON TABLE public."CashShift" FROM PUBLIC;
REVOKE ALL ON TABLE public."CashMovement" FROM PUBLIC;
REVOKE ALL ON TABLE public."SaleReturnSettlement" FROM PUBLIC;
REVOKE ALL ON TABLE public."CashAuditLog" FROM PUBLIC;

COMMIT;
