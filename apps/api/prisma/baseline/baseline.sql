CREATE TYPE public."MembershipStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'REMOVED'
);
CREATE TYPE public."UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE public."User" (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  "passwordHash" TEXT,
  status public."UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."Tenant" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."Branch" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  name TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Branch_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Branch_tenant_name_key" UNIQUE ("tenantId", name)
);

CREATE TABLE public."TenantMembership" (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  status public."MembershipStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantMembership_user_fkey"
    FOREIGN KEY ("userId") REFERENCES public."User"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenantMembership_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenantMembership_user_tenant_key" UNIQUE ("userId", "tenantId"),
  CONSTRAINT "TenantMembership_id_tenant_key" UNIQUE (id, "tenantId")
);

CREATE TABLE public."Role" (
  id TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Role_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES public."Tenant"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Role_tenant_name_key" UNIQUE ("tenantId", name),
  CONSTRAINT "Role_id_tenant_key" UNIQUE (id, "tenantId")
);

CREATE TABLE public."TenantPermission" (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  "supportEligible" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."TenantRolePermission" (
  id TEXT PRIMARY KEY,
  "roleId" TEXT NOT NULL,
  "permissionId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantRolePermission_role_fkey"
    FOREIGN KEY ("roleId") REFERENCES public."Role"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenantRolePermission_permission_fkey"
    FOREIGN KEY ("permissionId") REFERENCES public."TenantPermission"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenantRolePermission_role_permission_key"
    UNIQUE ("roleId", "permissionId")
);

CREATE TABLE public."MembershipRole" (
  id TEXT PRIMARY KEY,
  "membershipId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipRole_membership_tenant_fkey"
    FOREIGN KEY ("membershipId", "tenantId")
    REFERENCES public."TenantMembership"(id, "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MembershipRole_role_tenant_fkey"
    FOREIGN KEY ("roleId", "tenantId")
    REFERENCES public."Role"(id, "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MembershipRole_membership_role_key"
    UNIQUE ("membershipId", "roleId")
);

CREATE TABLE public."PlatformRole" (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."PlatformPermission" (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."UserPlatformRole" (
  "userId" TEXT NOT NULL,
  "platformRoleId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserPlatformRole_pkey" PRIMARY KEY ("userId", "platformRoleId"),
  CONSTRAINT "UserPlatformRole_user_fkey"
    FOREIGN KEY ("userId") REFERENCES public."User"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserPlatformRole_role_fkey"
    FOREIGN KEY ("platformRoleId") REFERENCES public."PlatformRole"(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE public."PlatformRolePermission" (
  "platformRoleId" TEXT NOT NULL,
  "platformPermissionId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformRolePermission_pkey"
    PRIMARY KEY ("platformRoleId", "platformPermissionId"),
  CONSTRAINT "PlatformRolePermission_role_fkey"
    FOREIGN KEY ("platformRoleId") REFERENCES public."PlatformRole"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PlatformRolePermission_permission_fkey"
    FOREIGN KEY ("platformPermissionId") REFERENCES public."PlatformPermission"(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE public."SupportAccessAuditLog" (
  id TEXT PRIMARY KEY,
  "grantId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  action VARCHAR(100) NOT NULL,
  "permissionKey" VARCHAR(200),
  reason VARCHAR(1000) NOT NULL,
  resource VARCHAR(500),
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "TenantMembership_tenantId_idx"
  ON public."TenantMembership" ("tenantId");
CREATE INDEX "Role_tenantId_idx" ON public."Role" ("tenantId");
CREATE INDEX "TenantRolePermission_permissionId_idx"
  ON public."TenantRolePermission" ("permissionId");
CREATE INDEX "MembershipRole_tenant_membership_idx"
  ON public."MembershipRole" ("tenantId", "membershipId");
CREATE INDEX "MembershipRole_role_tenant_idx"
  ON public."MembershipRole" ("roleId", "tenantId");
CREATE INDEX "UserPlatformRole_platformRoleId_idx"
  ON public."UserPlatformRole" ("platformRoleId");
CREATE INDEX "PlatformRolePermission_permissionId_idx"
  ON public."PlatformRolePermission" ("platformPermissionId");
