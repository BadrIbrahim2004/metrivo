BEGIN;

DO $$
BEGIN
  IF to_regclass('public."CashShift"') IS NULL
     OR to_regclass('public."Branch"') IS NULL
     OR to_regclass('public."TenantPermission"') IS NULL THEN
    RAISE EXCEPTION
      'Cash shifts, branches, and tenant permissions must exist before expenses';
  END IF;
END;
$$;

CREATE TYPE public."ExpensePaymentMethod" AS ENUM (
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'OTHER'
);
CREATE TYPE public."ExpenseStatus" AS ENUM ('ACTIVE', 'VOIDED');

CREATE TABLE public."Expense" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "cashShiftId" TEXT,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  method public."ExpensePaymentMethod" NOT NULL,
  "expenseDate" DATE NOT NULL DEFAULT CURRENT_DATE,
  status public."ExpenseStatus" NOT NULL DEFAULT 'ACTIVE',
  "voidedByUserId" TEXT,
  "voidedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Expense_id_tenant_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "Expense_id_tenant_branch_key" UNIQUE (id, "tenantId", "branchId"),
  CONSTRAINT "Expense_amount_positive" CHECK (amount > 0),
  CONSTRAINT "Expense_category_nonblank"
    CHECK (length(btrim(category)) BETWEEN 1 AND 100),
  CONSTRAINT "Expense_description_nonblank"
    CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  CONSTRAINT "Expense_cash_method_requires_shift"
    CHECK ((method = 'CASH') = ("cashShiftId" IS NOT NULL)),
  CONSTRAINT "Expense_voided_fields_check" CHECK (
    (status = 'ACTIVE' AND "voidedByUserId" IS NULL AND "voidedAt" IS NULL)
    OR
    (status = 'VOIDED' AND "voidedByUserId" IS NOT NULL AND "voidedAt" IS NOT NULL)
  ),
  CONSTRAINT "Expense_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Expense_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Expense_shift_tenant_fkey"
    FOREIGN KEY ("cashShiftId", "tenantId", "branchId")
    REFERENCES public."CashShift"(id, "tenantId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Expense_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Expense_voider_fkey"
    FOREIGN KEY ("voidedByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Expense_tenant_actor_idempotency_key"
  ON public."Expense" ("tenantId", "actorUserId", "idempotencyKey");
CREATE INDEX "Expense_tenant_branch_date_idx"
  ON public."Expense" ("tenantId", "branchId", "expenseDate");
CREATE INDEX "Expense_tenant_branch_category_idx"
  ON public."Expense" ("tenantId", "branchId", category);
CREATE INDEX "Expense_tenant_shift_idx"
  ON public."Expense" ("tenantId", "cashShiftId");

CREATE TABLE public."ExpenseAuditLog" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "expenseId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  action VARCHAR(100) NOT NULL,
  metadata JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExpenseAuditLog_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExpenseAuditLog_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExpenseAuditLog_expense_tenant_fkey"
    FOREIGN KEY ("expenseId", "tenantId")
    REFERENCES public."Expense"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ExpenseAuditLog_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ExpenseAuditLog_tenant_branch_occurred_idx"
  ON public."ExpenseAuditLog" ("tenantId", "branchId", "occurredAt");
CREATE INDEX "ExpenseAuditLog_expense_tenant_occurred_idx"
  ON public."ExpenseAuditLog" ("expenseId", "tenantId", "occurredAt");

CREATE FUNCTION public.validate_expense_shift_and_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  shift_status public."CashShiftStatus";
  expected_cash NUMERIC(12, 2);
BEGIN
  IF NEW.method <> 'CASH' THEN
    RETURN NEW;
  END IF;
  SELECT status INTO shift_status
    FROM public."CashShift"
   WHERE id = NEW."cashShiftId"
     AND "tenantId" = NEW."tenantId"
     AND "branchId" = NEW."branchId"
   FOR UPDATE;
  IF NOT FOUND OR shift_status <> 'OPEN' THEN
    RAISE EXCEPTION 'Cash expenses require an open shift in the same branch';
  END IF;
  SELECT cs."openingCash"
       + COALESCE((SELECT SUM(CASE WHEN cm.type = 'CASH_IN' THEN cm.amount ELSE -cm.amount END)
            FROM public."CashMovement" cm
           WHERE cm."cashShiftId" = cs.id AND cm."tenantId" = cs."tenantId"), 0)
       + COALESCE((SELECT SUM(s.total) FROM public."Sale" s
           WHERE s."cashShiftId" = cs.id AND s."tenantId" = cs."tenantId"), 0)
       - COALESCE((SELECT SUM(rs.amount) FROM public."SaleReturnSettlement" rs
           WHERE rs."cashShiftId" = cs.id AND rs."tenantId" = cs."tenantId"
             AND rs.method = 'CASH'), 0)
       - COALESCE((SELECT SUM(e.amount) FROM public."Expense" e
           WHERE e."cashShiftId" = cs.id AND e."tenantId" = cs."tenantId"
             AND e.method = 'CASH' AND e.status = 'ACTIVE'), 0)
    INTO expected_cash
    FROM public."CashShift" cs
   WHERE cs.id = NEW."cashShiftId" AND cs."tenantId" = NEW."tenantId";
  IF NEW.amount > expected_cash THEN
    RAISE EXCEPTION 'Cash drawer balance is insufficient for this expense';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Expense_open_shift_and_balance_guard"
  BEFORE INSERT ON public."Expense"
  FOR EACH ROW EXECUTE FUNCTION public.validate_expense_shift_and_balance();

CREATE FUNCTION public.guard_expense_void_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'VOIDED'
     OR NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."branchId" <> OLD."branchId"
     OR NEW."cashShiftId" IS DISTINCT FROM OLD."cashShiftId"
     OR NEW."actorUserId" <> OLD."actorUserId"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."requestHash" <> OLD."requestHash"
     OR NEW.category <> OLD.category OR NEW.description <> OLD.description
     OR NEW.amount <> OLD.amount OR NEW.method <> OLD.method
     OR NEW."expenseDate" <> OLD."expenseDate"
     OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."voidedByUserId" IS NULL OR NEW."voidedAt" IS NULL THEN
    RAISE EXCEPTION 'Expenses may only transition once from ACTIVE to VOIDED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Expense_void_transition_guard"
  BEFORE UPDATE ON public."Expense"
  FOR EACH ROW EXECUTE FUNCTION public.guard_expense_void_transition();

CREATE FUNCTION public.reject_expense_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Expense records cannot be deleted';
END;
$$;
CREATE TRIGGER "Expense_no_delete"
  BEFORE DELETE ON public."Expense"
  FOR EACH ROW EXECUTE FUNCTION public.reject_expense_deletion();
CREATE TRIGGER "ExpenseAuditLog_no_mutation"
  BEFORE UPDATE OR DELETE ON public."ExpenseAuditLog"
  FOR EACH ROW EXECUTE FUNCTION public.reject_expense_deletion();
CREATE TRIGGER "ExpenseAuditLog_no_truncate"
  BEFORE TRUNCATE ON public."ExpenseAuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_expense_deletion();

INSERT INTO public."TenantPermission" (id, key, description)
VALUES
  ('permission-expenses-read', 'expenses.read', 'List and view operating expenses'),
  ('permission-expenses-manage', 'expenses.manage', 'Record and void operating expenses')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON TABLE public."Expense" FROM PUBLIC;
REVOKE ALL ON TABLE public."ExpenseAuditLog" FROM PUBLIC;

COMMIT;
