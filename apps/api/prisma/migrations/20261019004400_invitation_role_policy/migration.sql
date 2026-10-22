-- Proposed only. Apply after the tenant-invitations migration and after
-- confirming the baseline Role and TenantInvitation tables are present.
-- No tenant role is approved automatically; all existing roles remain denied.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public."Role"') IS NULL
     OR to_regclass('public."TenantInvitation"') IS NULL
     OR to_regclass('public."TenantRolePermission"') IS NULL
     OR to_regclass('public."TenantPermission"') IS NULL THEN
    RAISE EXCEPTION
      'Baseline role and tenant-invitation tables must exist before invitation role policy';
  END IF;

END;
$$;

LOCK TABLE public."Role", public."TenantInvitation"
  IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."TenantInvitation") THEN
    RAISE EXCEPTION
      'Existing invitations must be expired or revoked and reissued before adding permission snapshots';
  END IF;
END;
$$;

ALTER TABLE public."Role"
  ADD COLUMN "isInviteAssignable" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public."TenantInvitation"
  ADD COLUMN "rolePermissionsHash" CHAR(64) NOT NULL;

COMMIT;
