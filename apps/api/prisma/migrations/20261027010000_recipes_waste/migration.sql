BEGIN;

DO $$
BEGIN
  IF to_regclass('public."Product"') IS NULL
     OR to_regclass('public."InventoryMovement"') IS NULL
     OR to_regclass('public."Branch"') IS NULL THEN
    RAISE EXCEPTION 'Products, inventory movements, and branches must exist before recipes';
  END IF;
END;
$$;

CREATE TYPE public."ProductType" AS ENUM ('RETAIL', 'INGREDIENT');
CREATE TYPE public."WasteStatus" AS ENUM ('ACTIVE', 'VOIDED');

ALTER TABLE public."Product"
  ADD COLUMN type public."ProductType" NOT NULL DEFAULT 'RETAIL';
CREATE INDEX "Product_tenant_type_idx" ON public."Product" ("tenantId", type);

CREATE TABLE public."Recipe" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "yieldQuantity" INTEGER NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Recipe_yield_positive" CHECK ("yieldQuantity" > 0),
  CONSTRAINT "Recipe_id_tenant_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "Recipe_product_tenant_key" UNIQUE ("productId", "tenantId"),
  CONSTRAINT "Recipe_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Recipe_product_fkey"
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES public."Product"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Recipe_creator_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Recipe_tenant_idx" ON public."Recipe" ("tenantId");

CREATE TABLE public."RecipeItem" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "recipeId" TEXT NOT NULL,
  "ingredientId" TEXT NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL,
  "wastePercent" NUMERIC(5, 2) NOT NULL DEFAULT 0,
  CONSTRAINT "RecipeItem_quantity_positive" CHECK (quantity > 0),
  CONSTRAINT "RecipeItem_waste_percent_range" CHECK ("wastePercent" >= 0 AND "wastePercent" <= 100),
  CONSTRAINT "RecipeItem_recipe_tenant_fkey"
    FOREIGN KEY ("recipeId", "tenantId")
    REFERENCES public."Recipe"(id, "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RecipeItem_ingredient_tenant_fkey"
    FOREIGN KEY ("ingredientId", "tenantId")
    REFERENCES public."Product"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RecipeItem_recipe_ingredient_key"
  ON public."RecipeItem" ("recipeId", "tenantId", "ingredientId");
CREATE INDEX "RecipeItem_tenant_ingredient_idx"
  ON public."RecipeItem" ("tenantId", "ingredientId");

CREATE TABLE public."ProductionBatch" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "recipeId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "batchQuantity" INTEGER NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'COMPLETED',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductionBatch_quantity_positive" CHECK ("batchQuantity" > 0),
  CONSTRAINT "ProductionBatch_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProductionBatch_recipe_tenant_fkey"
    FOREIGN KEY ("recipeId", "tenantId")
    REFERENCES public."Recipe"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProductionBatch_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductionBatch_tenant_actor_idempotency_key"
  ON public."ProductionBatch" ("tenantId", "actorUserId", "idempotencyKey");
CREATE INDEX "ProductionBatch_tenant_branch_created_idx"
  ON public."ProductionBatch" ("tenantId", "branchId", "createdAt");

CREATE TABLE public."WasteRecord" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  "costImpact" NUMERIC(12, 2) NOT NULL,
  status public."WasteStatus" NOT NULL DEFAULT 'ACTIVE',
  "voidedByUserId" TEXT,
  "voidedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WasteRecord_quantity_positive" CHECK (quantity > 0),
  CONSTRAINT "WasteRecord_reason_nonblank" CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT "WasteRecord_voided_fields_check" CHECK (
    (status = 'ACTIVE' AND "voidedByUserId" IS NULL AND "voidedAt" IS NULL)
    OR
    (status = 'VOIDED' AND "voidedByUserId" IS NOT NULL AND "voidedAt" IS NOT NULL)
  ),
  CONSTRAINT "WasteRecord_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WasteRecord_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WasteRecord_product_tenant_fkey"
    FOREIGN KEY ("productId", "tenantId")
    REFERENCES public."Product"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WasteRecord_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WasteRecord_voider_fkey"
    FOREIGN KEY ("voidedByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WasteRecord_tenant_actor_idempotency_key"
  ON public."WasteRecord" ("tenantId", "actorUserId", "idempotencyKey");
CREATE INDEX "WasteRecord_tenant_branch_created_idx"
  ON public."WasteRecord" ("tenantId", "branchId", "createdAt");

CREATE FUNCTION public.guard_waste_void_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'VOIDED'
     OR NEW.id <> OLD.id OR NEW."tenantId" <> OLD."tenantId"
     OR NEW."branchId" <> OLD."branchId" OR NEW."productId" <> OLD."productId"
     OR NEW."actorUserId" <> OLD."actorUserId"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."requestHash" <> OLD."requestHash"
     OR NEW.quantity <> OLD.quantity OR NEW.reason <> OLD.reason
     OR NEW."costImpact" <> OLD."costImpact"
     OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."voidedByUserId" IS NULL OR NEW."voidedAt" IS NULL THEN
    RAISE EXCEPTION 'Waste records may only transition once from ACTIVE to VOIDED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WasteRecord_void_transition_guard"
  BEFORE UPDATE ON public."WasteRecord"
  FOR EACH ROW EXECUTE FUNCTION public.guard_waste_void_transition();

CREATE TABLE public."RecipeAuditLog" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  action VARCHAR(100) NOT NULL,
  "actorUserId" TEXT NOT NULL,
  metadata JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecipeAuditLog_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RecipeAuditLog_branch_tenant_fkey"
    FOREIGN KEY ("branchId", "tenantId")
    REFERENCES public."Branch"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RecipeAuditLog_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "RecipeAuditLog_tenant_branch_occurred_idx"
  ON public."RecipeAuditLog" ("tenantId", "branchId", "occurredAt");

-- Production consumes ingredients (negative movements tied to the batch,
-- unique per batch+ingredient) and adds finished-product stock.
CREATE FUNCTION public.validate_production_batch_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Production batches are created completed only';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProductionBatch_insert_guard"
  BEFORE INSERT ON public."ProductionBatch"
  FOR EACH ROW EXECUTE FUNCTION public.validate_production_batch_insert();

CREATE FUNCTION public.reject_recipe_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Production and waste records are immutable';
END;
$$;
CREATE TRIGGER "ProductionBatch_no_mutation"
  BEFORE UPDATE OR DELETE ON public."ProductionBatch"
  FOR EACH ROW EXECUTE FUNCTION public.reject_recipe_ledger_mutation();
CREATE TRIGGER "RecipeAuditLog_no_mutation"
  BEFORE UPDATE OR DELETE ON public."RecipeAuditLog"
  FOR EACH ROW EXECUTE FUNCTION public.reject_recipe_ledger_mutation();

INSERT INTO public."TenantPermission" (id, key, description)
VALUES
  ('permission-recipes-read', 'recipes.read', 'View recipes, ingredients, and costs'),
  ('permission-recipes-manage', 'recipes.manage', 'Create recipes and record production'),
  ('permission-inventory-waste', 'inventory.waste', 'Record waste and spoilage')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON TABLE public."Recipe" FROM PUBLIC;
REVOKE ALL ON TABLE public."RecipeItem" FROM PUBLIC;
REVOKE ALL ON TABLE public."ProductionBatch" FROM PUBLIC;
REVOKE ALL ON TABLE public."WasteRecord" FROM PUBLIC;
REVOKE ALL ON TABLE public."RecipeAuditLog" FROM PUBLIC;

COMMIT;
