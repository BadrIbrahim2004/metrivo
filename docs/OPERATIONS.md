# Metrivo — Local Development, Migration, Backup & Restore

All commands are verified Windows PowerShell. Placeholders like
`<min-12-chars-password>` must be replaced with your own values — never commit
real secrets, and never paste real credentials into documentation.

## 1. First-time setup, step by step (Windows 11)

Prerequisites: Docker Desktop running (whale icon in the tray), Node.js 20+,
and this repository cloned at `D:\My_Projects\Metrivo`.

Open PowerShell **in the repository root** (`D:\My_Projects\Metrivo`), then run
these commands one at a time, in order:

```powershell
# Step 1 — start the local PostgreSQL database
# (creates a container named metrivo-db-1 with a persistent volume;
#  port 54329 on 127.0.0.1 only; contains only local dev data)
docker compose -f compose.dev.yml up -d

# Step 2 — wait until the database is healthy, then verify
docker compose -f compose.dev.yml ps
# Expected: STATUS "healthy" for the db service.

# Step 3 — create the API environment file from the template
Copy-Item .env.example apps/api/.env
notepad apps/api/.env
# In the editor set:
#   DATABASE_URL=postgresql://metrivo:<your-db-password>@127.0.0.1:54329/metrivo_dev?schema=public
#   (the default compose password is metrivo_dev_password_change_me — change it
#    in compose.dev.yml AND in this URL to the same new value)
#   AUTH_ACCESS_TOKEN_SECRET=<paste 48 random bytes, base64>
#   AUTH_ACCESS_TOKEN_ISSUER=metrivo.api
#   AUTH_ACCESS_TOKEN_AUDIENCE=metrivo.app
# Save and close. This file is git-ignored; never commit it.

# Step 4 — install dependencies (first run only, or after package changes)
npm install
npm --prefix apps/api install

# Step 5 — apply migrations to the LOCAL dev database ONLY
# (safe here: the DATABASE_URL above points at the compose dev database)
npm --prefix apps/api run prisma:generate
Set-Location apps/api; npx prisma migrate deploy; Set-Location ../..

# Step 6 — create the first local platform admin (safe, repeatable)
Set-Location apps/api
$env:BOOTSTRAP_ADMIN_EMAIL  = "admin@example.invalid"
$env:BOOTSTRAP_ADMIN_PASSWORD = "<min-12-chars-password>"
npx ts-node scripts/bootstrap-local-admin.ts
Remove-Item Env:BOOTSTRAP_ADMIN_PASSWORD
Set-Location ../..
# Expected output: "Bootstrap complete. Platform owner created: ..."
# Running it again prints "Platform owner already exists; nothing to do."

# Step 7 — run the app (two separate terminals)
npm run api:dev      # terminal 1 — API at http://127.0.0.1:3000/api
npm run dev          # terminal 2 — frontend, open the printed localhost URL
```

Log in to the frontend with the bootstrap email/password. The platform
administration page is reachable via the "Platform administration" button
(separate from the shop dashboard).

## 2. Daily start / stop / verification

```powershell
docker compose -f compose.dev.yml start      # start DB after reboot
docker compose -f compose.dev.yml stop       # stop without deleting data
docker compose -f compose.dev.yml ps         # STATUS must be "healthy"

# Data survives stop/start (named volume). Deleting it is destructive:
docker compose -f compose.dev.yml down -v    # DELETES local dev data — dev only
```

## 3. Migration policy

- Migrations run ONLY against (a) the disposable integration-test database
  created by `npm --prefix apps/api run test:postgres` (loopback 55432, tmpfs,
  random project name, identity checks, self-cleanup), or (b) your local dev
  database via the `DATABASE_URL` configured in step 3 above.
- Apply in order with `npx prisma migrate deploy` (run inside `apps/api`).
- Never edit an already-applied migration; create a follow-up migration instead.
- Shared/persistent/production databases require explicit owner approval.

## 4. Backup (local dev database)

```powershell
# Find the running dev database container id, then dump it:
$container = docker compose -f compose.dev.yml ps -q db
docker exec -t $container pg_dump -U metrivo -d metrivo_dev -Fc `
  > backup_$(Get-Date -Format yyyyMMdd_HHmm).dump
```

Store backups outside the machine (encrypted). For production: schedule daily
full dumps plus WAL archiving, and define RPO/RTO with the business first.

## 5. Restore — always into a throwaway container first

```powershell
# 1. Start a disposable PostgreSQL container (delete it afterwards)
docker run -d --name metrivo-restore-test `
  -e POSTGRES_PASSWORD=restore_test_password `
  -p 127.0.0.1:54330:5432 postgres:18

# 2. Create the target database inside it
Start-Sleep -Seconds 5
docker exec metrivo-restore-test psql -U postgres -c "CREATE DATABASE restore_test;"

# 3. Restore the dump into it
Get-Content backup_YYYYMMDD_HHmm.dump -AsByteStream | `
  docker exec -i metrivo-restore-test pg_restore -U postgres -d restore_test

# 4. Validate inside the throwaway container
docker exec metrivo-restore-test psql -U postgres -d restore_test `
  -c 'SELECT COUNT(*) FROM "Tenant";'

# 5. Clean up the throwaway container
docker rm -f metrivo-restore-test
```

A backup is not "verified" until a restore has been tested against an isolated
target and row counts look sane. Never restore directly over a live database.

## 6. First-use verification checklist (after step 7 above)

1. Log in as the bootstrapped platform owner → "Platform administration" opens.
2. Create a monthly plan with trial days; assign it to a shop tenant id.
3. Log in as a shop user → shop dashboard works (subscription enforced).
4. Suspend the subscription from the platform page → shop endpoints return
   403 immediately; resume restores access.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose` says daemon not running | Start Docker Desktop and wait for the whale icon. |
| Port 54329 already in use | Another Postgres is bound there; change the left port in `compose.dev.yml`. |
| API fails at startup complaining about env vars | `apps/api/.env` is missing or has placeholder values — complete step 3. |
| `prisma migrate deploy` errors P1001 | The database is not up/healthy — repeat step 2. |
| Bootstrap says "not a local database host" | `DATABASE_URL` host must be `localhost`, `127.0.0.1`, or `::1`. |
| Bootstrap says "Ownership state already initialized" but you cannot log in | A platform owner row exists with a lost password. LOCAL DEV ONLY: reset the dev volume (`docker compose -f compose.dev.yml down -v`) and redo first-time setup. Never do this on shared/production databases. |
