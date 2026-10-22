-- Proposed migration only. Before applying:
-- 1. Apply an approved baseline migration that creates every table referenced
--    below. This repository currently has no such baseline migration.
-- 2. Run with SET ROLE to a verified NOLOGIN, non-superuser object-owner role.
-- 3. Verify that no application login owns or can SET ROLE to any protected
--    table owner. Protected writes are restricted to each table's owner.
-- 4. Configure app-role grants separately; the app role name is not known here.
-- This migration creates no user and assigns no platform owner.

BEGIN;

DO $$
DECLARE
  effective_role_can_login BOOLEAN;
  effective_role_is_superuser BOOLEAN;
  session_role_is_superuser BOOLEAN;
BEGIN
  SELECT rolcanlogin, rolsuper
  INTO effective_role_can_login, effective_role_is_superuser
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user;

  SELECT rolsuper
  INTO session_role_is_superuser
  FROM pg_catalog.pg_roles
  WHERE rolname = session_user;

  IF effective_role_can_login IS DISTINCT FROM FALSE
     OR effective_role_is_superuser IS DISTINCT FROM FALSE
     OR session_role_is_superuser IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'Migration must run as a NOLOGIN, non-superuser object-owner role via a non-superuser session';
  END IF;

  IF to_regclass('public."User"') IS NULL
     OR to_regclass('public."PlatformRole"') IS NULL
     OR to_regclass('public."PlatformPermission"') IS NULL
     OR to_regclass('public."UserPlatformRole"') IS NULL
     OR to_regclass('public."PlatformRolePermission"') IS NULL
     OR to_regclass('public."SupportAccessAuditLog"') IS NULL THEN
    RAISE EXCEPTION
      'Required baseline tables are missing; apply and verify the baseline migration first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner_role
      ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'User',
        'PlatformRole',
        'PlatformPermission',
        'UserPlatformRole',
        'PlatformRolePermission',
        'SupportAccessAuditLog'
      )
      AND (owner_role.rolcanlogin OR owner_role.rolsuper)
  ) THEN
    RAISE EXCEPTION
      'Protected baseline tables must be owned by NOLOGIN, non-superuser roles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."PlatformRole"
    WHERE key IN ('PLATFORM_OWNER', 'PLATFORM_ADMIN')
  ) THEN
    RAISE EXCEPTION
      'Reserved platform roles already exist; reconcile them before this migration';
  END IF;
END;
$$;

CREATE TABLE public."PlatformOwnershipState" (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  initialized BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO public."PlatformOwnershipState" (singleton, initialized)
VALUES (TRUE, FALSE);

CREATE TABLE public."PlatformOwnerRegistry" (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  "ownerUserId" TEXT NOT NULL UNIQUE
    REFERENCES public."User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."PlatformAuditLog" (
  id TEXT PRIMARY KEY,
  "actorUserId" VARCHAR(255) NOT NULL,
  action VARCHAR(100) NOT NULL,
  "targetType" VARCHAR(100) NOT NULL,
  "targetId" VARCHAR(255),
  outcome VARCHAR(32) NOT NULL,
  metadata JSONB,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT platform_audit_action_nonempty CHECK (length(btrim(action)) > 0),
  CONSTRAINT platform_audit_outcome_nonempty CHECK (length(btrim(outcome)) > 0)
);

CREATE INDEX "PlatformAuditLog_actorUserId_occurredAt_idx"
  ON public."PlatformAuditLog" ("actorUserId", "occurredAt");
CREATE INDEX "PlatformAuditLog_targetType_targetId_occurredAt_idx"
  ON public."PlatformAuditLog" ("targetType", "targetId", "occurredAt");
CREATE INDEX "PlatformAuditLog_action_occurredAt_idx"
  ON public."PlatformAuditLog" (action, "occurredAt");

INSERT INTO public."PlatformRole"
  (id, key, name, description, "createdAt", "updatedAt")
VALUES
  ('platform-owner-role', 'PLATFORM_OWNER', 'Platform Owner',
   'Reserved platform ownership role', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('platform-admin-role', 'PLATFORM_ADMIN', 'Platform Administrator',
   'Platform operational role with owner-approved permissions only',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO public."PlatformPermission"
  (id, key, description, "createdAt", "updatedAt")
VALUES
  ('platform-support-tenant-access', 'support.tenant_access',
   'Access an explicitly approved tenant for support',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('platform-support-approve-access', 'support.approve_access',
   'Approve explicitly scoped support access',
   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public."PlatformRolePermission"
  ("platformRoleId", "platformPermissionId", "createdAt")
SELECT role.id, permission.id, CURRENT_TIMESTAMP
FROM public."PlatformRole" role
CROSS JOIN public."PlatformPermission" permission
WHERE role.key = 'PLATFORM_OWNER'
  AND permission.key IN ('support.tenant_access', 'support.approve_access')
ON CONFLICT ("platformRoleId", "platformPermissionId") DO NOTHING;

-- PLATFORM_ADMIN intentionally receives no permissions by default.

CREATE FUNCTION public.lock_platform_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(127987, 1);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.guard_platform_owner_registry()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  relation_owner TEXT;
BEGIN
  SELECT pg_get_userbyid(relowner)
  INTO relation_owner
  FROM pg_catalog.pg_class
  WHERE oid = TG_RELID;

  IF current_user IS DISTINCT FROM relation_owner THEN
    RAISE EXCEPTION
      'Only the protected table owner may change platform ownership state';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.require_protected_table_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  relation_owner TEXT;
BEGIN
  SELECT pg_get_userbyid(relowner)
  INTO relation_owner
  FROM pg_catalog.pg_class
  WHERE oid = TG_RELID;

  IF current_user IS DISTINCT FROM relation_owner THEN
    RAISE EXCEPTION
      'Writes to protected platform tables require the table owner role';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_platform_admin_permission_allowlist()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_role_key TEXT;
  old_permission_key TEXT;
  new_role_key TEXT;
  new_permission_key TEXT;
  relation_owner TEXT;
BEGIN
  SELECT pg_get_userbyid(relowner)
  INTO relation_owner
  FROM pg_catalog.pg_class
  WHERE oid = TG_RELID;

  IF current_user IS DISTINCT FROM relation_owner THEN
    RAISE EXCEPTION
      'Platform permission assignments require protected table ownership';
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT role.key, permission.key
    INTO old_role_key, old_permission_key
    FROM public."PlatformRole" role
    JOIN public."PlatformPermission" permission
      ON permission.id = OLD."platformPermissionId"
    WHERE role.id = OLD."platformRoleId";

    IF old_role_key = 'PLATFORM_ADMIN'
       AND coalesce(
         old_permission_key NOT IN
           ('support.tenant_access', 'support.approve_access'),
         TRUE
       ) THEN
      RAISE EXCEPTION 'PLATFORM_ADMIN permission is outside the approved allowlist';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT role.key, permission.key
    INTO new_role_key, new_permission_key
    FROM public."PlatformRole" role
    JOIN public."PlatformPermission" permission
      ON permission.id = NEW."platformPermissionId"
    WHERE role.id = NEW."platformRoleId";

    IF new_role_key = 'PLATFORM_ADMIN'
       AND coalesce(
         new_permission_key NOT IN
           ('support.tenant_access', 'support.approve_access'),
         TRUE
       ) THEN
      RAISE EXCEPTION 'PLATFORM_ADMIN permission is outside the approved allowlist';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_platform_permission_definitions()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  relation_owner TEXT;
BEGIN
  SELECT pg_get_userbyid(relowner)
  INTO relation_owner
  FROM pg_catalog.pg_class
  WHERE oid = TG_RELID;

  IF current_user IS DISTINCT FROM relation_owner THEN
    RAISE EXCEPTION
      'Platform permission definitions require protected table ownership';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reject_platform_ownership_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE is prohibited on platform ownership tables';
END;
$$;

CREATE FUNCTION public.reject_support_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'SupportAccessAuditLog is append-only';
END;
$$;

CREATE FUNCTION public.reject_platform_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'PlatformAuditLog is append-only';
END;
$$;

CREATE FUNCTION public.assert_platform_owner_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  ownership_initialized BOOLEAN;
  registry_count BIGINT;
  registered_user_id TEXT;
  owner_assignment_count BIGINT;
  assigned_user_id TEXT;
  owner_is_active BOOLEAN;
BEGIN
  SELECT initialized
  INTO ownership_initialized
  FROM public."PlatformOwnershipState"
  WHERE singleton = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Platform ownership state row is missing';
  END IF;

  SELECT count(*), min("ownerUserId")
  INTO registry_count, registered_user_id
  FROM public."PlatformOwnerRegistry";

  SELECT count(*), min(upr."userId")
  INTO owner_assignment_count, assigned_user_id
  FROM public."UserPlatformRole" upr
  JOIN public."PlatformRole" role
    ON role.id = upr."platformRoleId"
  WHERE role.key = 'PLATFORM_OWNER';

  IF NOT ownership_initialized THEN
    IF registry_count <> 0 OR owner_assignment_count <> 0 THEN
      RAISE EXCEPTION 'Uninitialized ownership must not contain an owner';
    END IF;
    RETURN NULL;
  END IF;

  IF registry_count <> 1
     OR owner_assignment_count <> 1
     OR registered_user_id IS DISTINCT FROM assigned_user_id THEN
    RAISE EXCEPTION
      'Initialized ownership requires one matching registered owner';
  END IF;

  SELECT (status::text = 'ACTIVE')
  INTO owner_is_active
  FROM public."User"
  WHERE id = registered_user_id;

  IF owner_is_active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Registered platform owner must be active';
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER platform_role_owner_lock
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformRole"
FOR EACH STATEMENT EXECUTE FUNCTION public.lock_platform_ownership();

CREATE TRIGGER user_platform_role_owner_lock
BEFORE INSERT OR UPDATE OR DELETE ON public."UserPlatformRole"
FOR EACH STATEMENT EXECUTE FUNCTION public.lock_platform_ownership();

CREATE TRIGGER platform_role_permission_owner_lock
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformRolePermission"
FOR EACH STATEMENT EXECUTE FUNCTION public.lock_platform_ownership();

CREATE TRIGGER platform_owner_registry_lock
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformOwnerRegistry"
FOR EACH STATEMENT EXECUTE FUNCTION public.lock_platform_ownership();

CREATE TRIGGER platform_owner_state_lock
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformOwnershipState"
FOR EACH STATEMENT EXECUTE FUNCTION public.lock_platform_ownership();

CREATE TRIGGER platform_owner_user_lock
BEFORE UPDATE OR DELETE ON public."User"
FOR EACH STATEMENT EXECUTE FUNCTION public.lock_platform_ownership();

CREATE TRIGGER platform_owner_registry_guard
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformOwnerRegistry"
FOR EACH ROW EXECUTE FUNCTION public.guard_platform_owner_registry();

CREATE TRIGGER platform_owner_state_guard
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformOwnershipState"
FOR EACH ROW EXECUTE FUNCTION public.guard_platform_owner_registry();

CREATE TRIGGER platform_owner_role_guard
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformRole"
FOR EACH ROW EXECUTE FUNCTION public.require_protected_table_owner();

CREATE TRIGGER platform_owner_assignment_guard
BEFORE INSERT OR UPDATE OR DELETE ON public."UserPlatformRole"
FOR EACH ROW EXECUTE FUNCTION public.require_protected_table_owner();

CREATE TRIGGER platform_owner_permission_guard
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformRolePermission"
FOR EACH ROW EXECUTE FUNCTION public.require_protected_table_owner();

CREATE TRIGGER platform_admin_permission_allowlist_guard
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformRolePermission"
FOR EACH ROW EXECUTE FUNCTION public.guard_platform_admin_permission_allowlist();

CREATE TRIGGER platform_permission_definition_guard
BEFORE INSERT OR UPDATE OR DELETE ON public."PlatformPermission"
FOR EACH ROW EXECUTE FUNCTION public.guard_platform_permission_definitions();

CREATE TRIGGER support_access_audit_no_update_delete
BEFORE UPDATE OR DELETE ON public."SupportAccessAuditLog"
FOR EACH ROW EXECUTE FUNCTION public.reject_support_audit_mutation();

CREATE TRIGGER support_access_audit_no_truncate
BEFORE TRUNCATE ON public."SupportAccessAuditLog"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_support_audit_mutation();

CREATE TRIGGER platform_audit_no_update_delete
BEFORE UPDATE OR DELETE ON public."PlatformAuditLog"
FOR EACH ROW EXECUTE FUNCTION public.reject_platform_audit_mutation();

CREATE TRIGGER platform_audit_no_truncate
BEFORE TRUNCATE ON public."PlatformAuditLog"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_platform_audit_mutation();

CREATE TRIGGER platform_role_no_truncate
BEFORE TRUNCATE ON public."PlatformRole"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_platform_ownership_truncate();

CREATE TRIGGER user_platform_role_no_truncate
BEFORE TRUNCATE ON public."UserPlatformRole"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_platform_ownership_truncate();

CREATE TRIGGER platform_role_permission_no_truncate
BEFORE TRUNCATE ON public."PlatformRolePermission"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_platform_ownership_truncate();

CREATE TRIGGER platform_permission_no_truncate
BEFORE TRUNCATE ON public."PlatformPermission"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_platform_ownership_truncate();

CREATE TRIGGER platform_owner_registry_no_truncate
BEFORE TRUNCATE ON public."PlatformOwnerRegistry"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_platform_ownership_truncate();

CREATE TRIGGER platform_owner_state_no_truncate
BEFORE TRUNCATE ON public."PlatformOwnershipState"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_platform_ownership_truncate();

CREATE TRIGGER platform_user_no_truncate
BEFORE TRUNCATE ON public."User"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_platform_ownership_truncate();

CREATE CONSTRAINT TRIGGER platform_owner_registry_consistency
AFTER INSERT OR UPDATE OR DELETE ON public."PlatformOwnerRegistry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_platform_owner_consistency();

CREATE CONSTRAINT TRIGGER platform_owner_state_consistency
AFTER INSERT OR UPDATE OR DELETE ON public."PlatformOwnershipState"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_platform_owner_consistency();

CREATE CONSTRAINT TRIGGER platform_owner_assignment_consistency
AFTER INSERT OR UPDATE OR DELETE ON public."UserPlatformRole"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_platform_owner_consistency();

CREATE CONSTRAINT TRIGGER platform_owner_role_consistency
AFTER INSERT OR UPDATE OR DELETE ON public."PlatformRole"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_platform_owner_consistency();

CREATE CONSTRAINT TRIGGER platform_owner_user_consistency
AFTER UPDATE OR DELETE ON public."User"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_platform_owner_consistency();

REVOKE ALL ON FUNCTION public.lock_platform_ownership() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_platform_owner_registry() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_protected_table_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_platform_admin_permission_allowlist() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_platform_permission_definitions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_platform_ownership_truncate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_support_audit_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_platform_audit_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_platform_owner_consistency() FROM PUBLIC;

REVOKE ALL ON TABLE public."PlatformOwnershipState" FROM PUBLIC;
REVOKE ALL ON TABLE public."PlatformOwnerRegistry" FROM PUBLIC;
REVOKE ALL ON TABLE public."PlatformRole" FROM PUBLIC;
REVOKE ALL ON TABLE public."PlatformPermission" FROM PUBLIC;
REVOKE ALL ON TABLE public."UserPlatformRole" FROM PUBLIC;
REVOKE ALL ON TABLE public."PlatformRolePermission" FROM PUBLIC;
REVOKE ALL ON TABLE public."SupportAccessAuditLog" FROM PUBLIC;
REVOKE ALL ON TABLE public."PlatformAuditLog" FROM PUBLIC;
REVOKE TRUNCATE ON TABLE public."User" FROM PUBLIC;

-- Offline bootstrap is intentionally deferred until deployment verifies
-- non-login object ownership, app-role non-membership, and explicit grants.
-- It must run as the verified owner of the protected tables in one transaction:
--   acquire pg_advisory_xact_lock(127987, 1);
--   assign PLATFORM_OWNER to one already-existing ACTIVE User;
--   insert that user into PlatformOwnerRegistry;
--   set PlatformOwnershipState.initialized = TRUE;
--   COMMIT (deferred consistency triggers validate final state).
-- The Nest application role cannot perform these writes under this policy.
COMMIT;
