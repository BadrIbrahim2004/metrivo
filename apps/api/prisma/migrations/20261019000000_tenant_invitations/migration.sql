-- Proposed only; do not apply until the baseline and platform foundation
-- migrations, current database state, and PostgreSQL role grants are reviewed.
-- Existing users are never renamed or deleted. This migration aborts before
-- backfill if emails are invalid, non-ASCII, or collide under the C-locale
-- lower(trim(email)) rule. Non-ASCII legacy emails require a separately
-- reviewed JavaScript-compatible backfill before this migration is adapted.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."User"') IS NULL
     OR to_regclass('public."Tenant"') IS NULL
     OR to_regclass('public."Role"') IS NULL
     OR to_regclass('public."PlatformAuditLog"') IS NULL THEN
    RAISE EXCEPTION
      'Baseline and platform foundation tables must exist before invitations';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."User"
    WHERE email IS NULL
       OR btrim(email) = ''
       OR email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) THEN
    RAISE EXCEPTION
      'Invalid existing user emails found; inspect and manually resolve before backfill';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."User"
    WHERE octet_length(email) <> char_length(email)
  ) THEN
    RAISE EXCEPTION
      'Non-ASCII existing emails require an explicitly reviewed normalization backfill';
  END IF;

  IF EXISTS (
    SELECT lower(btrim(email) COLLATE "C")
    FROM public."User"
    GROUP BY lower(btrim(email) COLLATE "C")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Case-insensitive email conflicts found; inspect and manually resolve before backfill';
  END IF;
END;
$$;

ALTER TABLE public."User"
  ADD COLUMN "emailNormalized" TEXT;

UPDATE public."User"
SET "emailNormalized" = lower(btrim(email) COLLATE "C");

ALTER TABLE public."User"
  ALTER COLUMN "emailNormalized" SET NOT NULL;

ALTER TABLE public."User"
  ADD CONSTRAINT "User_emailNormalized_key" UNIQUE ("emailNormalized");

CREATE TABLE public."TenantInvitation" (
  id TEXT PRIMARY KEY,
  "tokenHash" CHAR(64) NOT NULL UNIQUE,
  email TEXT NOT NULL,
  "emailNormalized" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "invitedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "acceptedAt" TIMESTAMPTZ(6),
  CONSTRAINT tenant_invitation_expiry_after_creation
    CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT tenant_invitation_single_terminal_state
    CHECK ("acceptedAt" IS NULL OR "revokedAt" IS NULL),
  CONSTRAINT tenant_invitation_tenant_fk
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_invitation_role_tenant_fk
    FOREIGN KEY ("roleId", "tenantId")
    REFERENCES public."Role"(id, "tenantId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT tenant_invitation_issuer_fk
    FOREIGN KEY ("invitedByUserId") REFERENCES public."User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "TenantInvitation_tenantId_createdAt_idx"
  ON public."TenantInvitation" ("tenantId", "createdAt");
CREATE INDEX "TenantInvitation_emailNormalized_tenantId_idx"
  ON public."TenantInvitation" ("emailNormalized", "tenantId");
CREATE INDEX "TenantInvitation_expiresAt_idx"
  ON public."TenantInvitation" ("expiresAt");

CREATE TABLE public."InvitationAcceptanceRateLimit" (
  "keyHash" CHAR(64) PRIMARY KEY,
  "windowStartedAt" TIMESTAMPTZ(6) NOT NULL,
  "requestCount" INTEGER NOT NULL CHECK ("requestCount" > 0),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL
);

CREATE INDEX "InvitationAcceptanceRateLimit_updatedAt_idx"
  ON public."InvitationAcceptanceRateLimit" ("updatedAt");

REVOKE ALL ON TABLE public."TenantInvitation" FROM PUBLIC;
REVOKE ALL ON TABLE public."InvitationAcceptanceRateLimit" FROM PUBLIC;

COMMIT;
