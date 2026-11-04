BEGIN;

DO $$
BEGIN
  IF to_regclass('public."Tenant"') IS NULL
     OR to_regclass('public."PlatformRole"') IS NULL THEN
    RAISE EXCEPTION 'Tenants and platform roles must exist before subscriptions';
  END IF;
END;
$$;

CREATE TYPE public."PlanPeriod" AS ENUM ('MONTHLY', 'ANNUAL');
CREATE TYPE public."SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'SUSPENDED', 'CANCELLED');

CREATE TABLE public."SubscriptionPlan" (
  id TEXT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  period public."PlanPeriod" NOT NULL,
  price NUMERIC(12, 2) NOT NULL,
  "trialDays" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionPlan_price_positive" CHECK (price > 0),
  CONSTRAINT "SubscriptionPlan_trial_positive" CHECK ("trialDays" >= 0),
  CONSTRAINT "SubscriptionPlan_period_name_key" UNIQUE (name, period)
);

CREATE TABLE public."TenantSubscription" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  status public."SubscriptionStatus" NOT NULL,
  "trialEndsAt" TIMESTAMPTZ(6),
  "currentPeriodEnd" TIMESTAMPTZ(6),
  "suspendedAt" TIMESTAMPTZ(6),
  "cancelledAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantSubscription_tenant_key" UNIQUE ("tenantId"),
  CONSTRAINT "TenantSubscription_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenantSubscription_plan_fkey"
    FOREIGN KEY ("planId") REFERENCES public."SubscriptionPlan"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TenantSubscription_dates_check" CHECK (
    (status = 'ACTIVE' AND "currentPeriodEnd" IS NOT NULL AND "trialEndsAt" IS NULL)
    OR (status = 'TRIAL' AND "trialEndsAt" IS NOT NULL AND "currentPeriodEnd" IS NULL)
    OR (status IN ('EXPIRED', 'SUSPENDED', 'CANCELLED'))
  )
);
CREATE INDEX "TenantSubscription_status_idx" ON public."TenantSubscription" (status);

CREATE TABLE public."SubscriptionAuditLog" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT,
  "actorUserId" TEXT NOT NULL,
  action VARCHAR(100) NOT NULL,
  metadata JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionAuditLog_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SubscriptionAuditLog_tenant_occurred_idx"
  ON public."SubscriptionAuditLog" ("tenantId", "occurredAt");

INSERT INTO public."PlatformRole" (id, key, name, description)
VALUES
  ('platform-role-subscriptions', 'platform.subscriptions', 'Subscription manager',
   'Manage subscription plans and tenant subscription states')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public."PlatformPermission" (id, key, description)
VALUES
  ('platform-permission-subscriptions-read', 'platform.subscriptions.read',
   'View subscription plans and tenant subscription states'),
  ('platform-permission-subscriptions-manage', 'platform.subscriptions.manage',
   'Create plans and change tenant subscription states')
ON CONFLICT (key) DO NOTHING;

REVOKE ALL ON TABLE public."SubscriptionPlan" FROM PUBLIC;
REVOKE ALL ON TABLE public."TenantSubscription" FROM PUBLIC;
REVOKE ALL ON TABLE public."SubscriptionAuditLog" FROM PUBLIC;

COMMIT;
