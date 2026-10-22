CREATE TABLE public.pos_test_controls (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  fail_sale_inventory_insert BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO public.pos_test_controls (singleton, fail_sale_inventory_insert)
VALUES (TRUE, FALSE);

CREATE FUNCTION public.pos_test_fail_sale_inventory_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."saleId" IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.pos_test_controls
       WHERE singleton = TRUE
         AND fail_sale_inventory_insert = TRUE
     ) THEN
    RAISE EXCEPTION 'Intentional POS integration-test failure';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pos_test_fail_sale_inventory_insert
  BEFORE INSERT ON public."InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION public.pos_test_fail_sale_inventory_insert();

GRANT SELECT, UPDATE ON public.pos_test_controls TO metrivo_pos_test_app;
