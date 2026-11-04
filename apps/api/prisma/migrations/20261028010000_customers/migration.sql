BEGIN;

DO $$
BEGIN
  IF to_regclass('public."Sale"') IS NULL
     OR to_regclass('public."Branch"') IS NULL THEN
    RAISE EXCEPTION 'Sales and branches must exist before customers';
  END IF;
END;
$$;

CREATE TABLE public."Customer" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(40),
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Customer_name_nonblank" CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT "Customer_id_tenant_key" UNIQUE (id, "tenantId"),
  CONSTRAINT "Customer_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Customer_creator_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Customer_tenant_phone_key"
  ON public."Customer" ("tenantId", phone) WHERE phone IS NOT NULL;
CREATE INDEX "Customer_tenant_name_idx" ON public."Customer" ("tenantId", name);

ALTER TABLE public."Sale"
  ADD COLUMN "customerId" TEXT;
ALTER TABLE public."Sale"
  ADD CONSTRAINT "Sale_customer_tenant_fkey"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES public."Customer"(id, "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Sale_tenant_customer_idx" ON public."Sale" ("tenantId", "customerId");

ALTER TABLE public."SaleReturn"
  ADD COLUMN "customerId" TEXT;
ALTER TABLE public."SaleReturn"
  ADD CONSTRAINT "SaleReturn_customer_tenant_fkey"
  FOREIGN KEY ("customerId", "tenantId")
  REFERENCES public."Customer"(id, "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SaleReturn_tenant_customer_idx" ON public."SaleReturn" ("tenantId", "customerId");

INSERT INTO public."TenantPermission" (id, key, description)
VALUES
  ('permission-customers-read', 'customers.read', 'View customers and their purchase history'),
  ('permission-customers-manage', 'customers.manage', 'Create, edit, and archive customers')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON TABLE public."Customer" FROM PUBLIC;

COMMIT;
