# Provisions the protected PostgreSQL roles required by the platform-owner
# migrations, on a FRESH production database.
#
# Why: migrations 20261018230000_* guard themselves — they refuse to run as a
# superuser or a login role. The compose entrypoint container user is a
# superuser by definition, so migrations must run as a dedicated NOLOGIN
# "migrator" role via SET ROLE, and the API must connect as a separate
# non-owner "app" role.
#
# Idempotent; never drops data. Run ONCE against a fresh database:
#   powershell -File scripts\provision-prod-db.ps1 \
#     -Container metrivo-prod-db-1 -SuperUser metrivo -DbName metrivo_prod `
#     -OwnerPassword '<strong-owner-password>' -AppPassword '<strong-app-password>'
# Then set in .env.production:
#   MIGRATION_DATABASE_URL=postgresql://metrivo:<owner-password>@db:5432/<db>?schema=public&options=-c%20role%3Dmetrivo_dev_migrator
#   (or let the API entrypoint provision via METRIVO_PROVISION_ROLES=1)

param(
  [Parameter(Mandatory=$true)][string]$Container,
  [Parameter(Mandatory=$true)][string]$SuperUser,
  [Parameter(Mandatory=$true)][string]$DbName,
  [Parameter(Mandatory=$true)][string]$OwnerPassword,
  [Parameter(Mandatory=$true)][string]$AppPassword
)

$ErrorActionPreference = 'Stop'

# SQL to execute inside the container, with psql variable substitution.
$sql = @'
-- 1. Object-owner role (NOLOGIN, non-superuser) - owns protected tables
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrivo_dev_owner') THEN
    CREATE ROLE metrivo_dev_owner NOLOGIN NOSUPERUSER;
  END IF;
END $$;

-- 2. Migrator role: NOLOGIN; migrate deploy runs via SET ROLE from a session
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrivo_dev_migrator') THEN
    CREATE ROLE metrivo_dev_migrator NOLOGIN NOSUPERUSER;
  END IF;
END $$;
GRANT metrivo_dev_owner TO metrivo_dev_migrator;

-- 3. App role: LOGIN, non-superuser, used by the API at runtime
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrivo') THEN
    CREATE ROLE metrivo LOGIN NOSUPERUSER PASSWORD :'app_password';
  END IF;
END $$;

GRANT metrivo TO metrivo_dev_migrator;

-- 4. Database owned by the protected owner role
SELECT 'CREATE DATABASE :' 'dbname' '
OWNER metrivo_dev_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'dbname') \gexec

ALTER DATABASE :'dbname' OWNER TO metrivo_dev_owner;
'@

$sql | docker exec -i $Container psql -U $SuperUser -d postgres `
  -v dbname=$DbName -v app_password=$AppPassword

if ($LASTEXITCODE -ne 0) { throw 'provisioning failed' }
Write-Host 'Provisioning done.'
