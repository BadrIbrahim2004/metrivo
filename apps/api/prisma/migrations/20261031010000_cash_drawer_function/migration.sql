BEGIN;

-- Single canonical drawer-balance formula shared by all guard triggers.
-- Mirrors src/cash-drawer.ts (application-level calculation).
CREATE OR REPLACE FUNCTION public.compute_expected_drawer_cash(
  p_shift_id TEXT,
  p_tenant_id TEXT
) RETURNS NUMERIC(12, 2)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
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
    FROM public."CashShift" cs
   WHERE cs.id = p_shift_id AND cs."tenantId" = p_tenant_id
$$;

-- Rewrite the cash-management guards to use the shared function.
CREATE OR REPLACE FUNCTION public.validate_cash_movement_balance()
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
  SELECT public.compute_expected_drawer_cash(NEW."cashShiftId", NEW."tenantId")
    INTO expected_cash;
  IF NEW.amount > expected_cash THEN
    RAISE EXCEPTION 'Cash-out exceeds the expected drawer balance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_cash_refund_drawer_balance()
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
  SELECT public.compute_expected_drawer_cash(NEW."cashShiftId", NEW."tenantId")
    INTO expected_cash;
  IF NEW.amount > expected_cash THEN
    RAISE EXCEPTION 'Cash drawer balance is insufficient for refund settlement';
  END IF;
  RETURN NEW;
END;
$$;

-- Rewrite the expense drawer guard to use the shared function.
CREATE OR REPLACE FUNCTION public.validate_expense_shift_and_balance()
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
  SELECT public.compute_expected_drawer_cash(NEW."cashShiftId", NEW."tenantId")
    INTO expected_cash;
  IF NEW.amount > expected_cash THEN
    RAISE EXCEPTION 'Cash drawer balance is insufficient for this expense';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
