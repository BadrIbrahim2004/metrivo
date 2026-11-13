# Metrivo API

NestJS API scaffold for Metrivo. This app runs separately from the existing Vite frontend.

## Requirements

- Node.js 20 or newer
- npm
- PostgreSQL 18 running locally on port `5432`, with a database named `metrivo_dev`

## Commands

From the repository root:

```bash
npm run api:dev
npm run api:build
npm run api:start
```

Or from `apps/api`:

```bash
npm run start:dev
npm run build
npm start
```

The API listens on `127.0.0.1:3000` by default to avoid exposing the service to the local network. `GET /api/health` runs a database query and returns `database: "connected"` on success, or HTTP 503 with `database: "disconnected"` when PostgreSQL cannot be reached. The response never includes connection credentials. Set `HOST=0.0.0.0` only in a deployment environment where network exposure is intentionally managed by infrastructure controls.

Create `apps/api/.env` with a local `DATABASE_URL` and the required `AUTH_ACCESS_TOKEN_SECRET`, `AUTH_ACCESS_TOKEN_ISSUER`, and `AUTH_ACCESS_TOKEN_AUDIENCE` values, using `.env.example` as a template. The signing secret must be unique and at least 32 bytes; the API fails to start if it is absent or too short. URL-encode reserved characters in the PostgreSQL password. Never commit `.env`; it is ignored by Git. Prisma commands are `npm run prisma:validate` and `npm run prisma:generate`. Schema validation and client generation do not establish a database connection; use the health endpoint to verify connectivity.

`POST /api/auth/login` accepts a normalized email and password and returns a ten-minute Bearer access token. Login attempts are limited to five per minute per client using in-memory throttling; this limit is per API process and needs shared storage or edge-level rate limiting before a multi-instance deployment. No public registration, invitation issuance, or refresh-token flow is implemented. Account creation remains administrative-only and must be implemented through a later invitation workflow.

The authentication guard verifies the access-token signature, algorithm, issuer, audience, expiry, and active database account before setting `request.user.userId` from the verified subject. It does not trust user IDs from request data. The authorization guard runs afterward and separates platform roles and permissions from tenant roles and permissions. Tenant routes must use `@RequireTenantPermission('permission.key')` and include `:tenantId` as a route parameter; platform routes must use `@RequirePlatformPermission('permission.key')`. Routes without an explicit policy are denied, except those marked `@Public()`.

Support access is issued through `SupportAccessService` only to a specifically named tenant, for a required reason and up to five explicitly `supportEligible` tenant permissions, for at most one hour. A different platform-authorized approver is required; grant handlers must take the approver ID from the authenticated principal, never from request data. Access is checked on each request, can be revoked, and is audited. The proposed platform migration seeds the role and permission records but is not applied; authenticated grant-management endpoints remain to be implemented.

The platform administration foundation defines `PLATFORM_OWNER` and `PLATFORM_ADMIN` over the existing platform-role tables. The proposed migration seeds the role definitions and the existing support permission keys; it assigns no owner and gives `PLATFORM_ADMIN` no permissions by default. Its write triggers permit platform-role, role-assignment, permission-definition, owner-state, and owner-registry changes only when `current_user` is the protected table owner; `PLATFORM_ADMIN` permission mappings are additionally limited to `support.tenant_access` and `support.approve_access`. This deliberately fails closed for an ordinary application login and does not identify the authenticated Metrivo user inside PostgreSQL. The internal `PlatformAdministrationService` therefore cannot perform its writes through a non-owner application connection under these proposed triggers; a separately reviewed privilege boundary is required before those operations can be used. No platform-administration HTTP endpoints or owner bootstrap API exist.

`PlatformAuditLog` is a general platform-administration audit model, separate from `SupportAccessAuditLog`. The service records successful administrator assignment, revocation, and permission-set changes in the same Prisma transaction as each operation. Audit insert failures propagate and abort that transaction. Events contain the actor ID supplied to the internal service, target, action, successful outcome, timestamp, and only the changed permission keys; secrets are not recorded. This service currently has no HTTP endpoint: a future controller must pass the authenticated principal ID, never a request-body actor ID. Because audit insertion is in the same transaction, denied or rolled-back attempts do not leave a committed event; durable logging of failed attempts requires a separate explicitly designed channel. Ownership bootstrap or transfer remains an offline-only procedure and has no application audit writer in this change.

Tenant invitations have a service and a narrowly scoped controller; there is no general registration endpoint. Creation and revocation require the registered active platform owner. A tenant role is invite-assignable only when its `Role.isInviteAssignable` flag is explicitly true; new and existing roles default to false, and no roles are approved by this schema change. Platform-role names are rejected, and the flow writes only tenant membership-role records, never platform-role assignments. Acceptance receives only a bearer token and password: email, tenant, and role are loaded from the stored invitation, so the acceptor cannot change those values. The database stores only a SHA-256 hash of a 32-byte random token; the raw token is returned once in the creation response and must be delivered through a separately approved secure channel. Invitations expire after 72 hours. Issuance stores a hash of the sorted tenant permission keys assigned to the role; acceptance rechecks the allow flag and permission hash in a serializable transaction, rejecting an invitation if the role's permissions have changed since issuance. An existing normalized email produces the same generic unavailable-invitation error and does not create an account. The invitation-role-policy migration is proposed only and must be applied after the existing invitation migration; an authorized operator must explicitly approve eligible role records after reviewing their permissions. No platform role or platform permission is assignable from this flow.

The invitation API is exposed at `POST /api/invitations`, `DELETE /api/invitations/:invitationId`, and `POST /api/invitations/accept`. Creation and revocation carry a dedicated registered-owner policy in `AuthorizationGuard`; the guard uses the authenticated principal populated by `AuthenticationGuard` and checks the active registry and `PLATFORM_OWNER` assignment. Acceptance is the only public route and accepts only token/password DTO fields. The global validation pipe rejects unexpected input fields. The controller never accepts an actor ID from body/query data and returns the raw token only in the creation response.

Acceptance is limited to 10 attempts per direct TCP peer address per 60-second database-backed window across API replicas. It hashes the address for storage and ignores forwarded-address headers; if the limiter table cannot be accessed, acceptance fails closed. The limiter uses the existing PostgreSQL dependency, not an in-process or external cache. In deployments behind a proxy, `socket.remoteAddress` may identify the shared proxy; configure network-level rate limiting at the trusted edge and verify that this conservative shared bucket will not block all customers. The rate-limit table needs controlled DML privileges and stale rows are pruned on requests. The invite issuer remains platform-owner-only because no tenant invitation permission is approved; `PLATFORM_ADMIN` is not authorized. Database roles and inherited grants must be verified; the application login must not own protected tables, be superuser, or be able to assume an owner role. PostgreSQL cannot distinguish the human owner from requests using the shared application login, so the application authorization boundary remains essential.

The migrations are not ready to apply: this repository has no baseline migration, the platform foundation migration is still only proposed, the invitation migration depends on both that foundation and the pre-existing `User`, `Tenant`, and `Role` tables, and actual database ownership/role grants are unknown. The invitation migration aborts on invalid email values, non-ASCII legacy email values, or duplicate C-locale `lower(trim(email))` values; operators must inspect and manually resolve conflicts before retrying. The non-ASCII stop is deliberate: PostgreSQL `lower` cannot be assumed to match JavaScript `toLowerCase()` for every database locale and Unicode value.

For a non-ASCII legacy dataset, do not remove the guard or guess at PostgreSQL casing. Prepare a read-only inventory of `(user id, original email, normalizeEmail(email))` using the same application helper; identify invalid values and groups with duplicate normalized values and require explicit manual resolution without changing the original `email`. After review, use a separately approved staged migration: add `emailNormalized` nullable; load the approved `(user id, original email, normalized email)` mapping into a temporary staging table using parameterized/bulk load; verify every current user has exactly one row and the staged original email still equals `User.email`; verify no duplicate staged normalized values; update only `emailNormalized` from that mapping; then add NOT NULL and UNIQUE constraints in a final migration step. Abort if any verification fails. The current SQL migration is for verified ASCII-compatible data only; the staged Unicode path requires a separate reviewed migration before deployment. The application login uses the shared JavaScript normalizer. Migrations revoke `PUBLIC` privileges but cannot remove direct or inherited grants through unknown deployment roles. Both audit tables receive UPDATE, DELETE, and TRUNCATE rejection triggers; table owners and PostgreSQL superusers remain privileged. Runtime roles need explicitly approved least-privilege grants for invitation operations, the distributed limiter, and audit inserts; no role name or grant is assumed. A shared application login cannot let PostgreSQL independently verify a human actor.

The platform audit table and protections are in the existing proposed platform foundation migration; email normalization and invitations are in a separate proposed dependent migration. If either migration has already been applied in any deployment, these files do not update that database and must instead be reviewed as separate forward migrations after checking the actual migration history. No database was checked as part of this code change.

The guard validates authorization against the requested `:tenantId`; it cannot scope business queries inside a handler. Every tenant-data query must also filter by that same authorized tenant ID, and branch-level queries must verify the branch belongs to it.

Products and branch inventory are available under:

- `GET/POST /api/tenants/:tenantId/branches/:branchId/products`
- `PATCH /api/tenants/:tenantId/branches/:branchId/products/:productId`
- `GET /api/tenants/:tenantId/branches/:branchId/products/:productId/stock`
- `GET/POST /api/tenants/:tenantId/branches/:branchId/products/:productId/movements`
- `PUT /api/tenants/:tenantId/memberships/:membershipId/branch-access`

Products belong to a tenant and SKU is unique within that tenant. Inventory is derived from append-only quantity movements per tenant, branch, and product; there is no directly writable stock balance. The movement insert locks the product/branch bucket and runs in a serializable transaction; negative stock is rejected. The branch-access model defaults each membership to `SELECTED_BRANCHES` with no grants. An explicit membership manager permission (`tenant.members.manage`) is required to change another active member's scope, and a scoped manager may grant only branches inside their own scope; assigning `ALL_BRANCHES` requires that the actor already has all-branch scope. Scope changes and inventory movements are recorded with the authenticated actor. Platform roles confer no tenant or branch access.

The proposed products/inventory migration creates permission keys `catalog.products.read`, `catalog.products.manage`, `inventory.read`, and `inventory.adjust`, but assigns none of them to any role. No tenant role receives permissions or branch access automatically. The authorized operator must review and provision role permissions and an initial membership branch scope through a separately approved deployment procedure before this feature can be used. The membership access API itself is guarded by `tenant.members.manage`. The frontend products page uses a short-lived API token kept in component memory and loads only workspaces returned by `GET /api/auth/workspaces`; the Vite development server proxies `/api` to the local API. Production must provide same-origin API routing or a separately reviewed deployment configuration.

The migration at `20261019122000_products_inventory_branch_scope` is proposed only. It requires the actual baseline tables (`User`, `Tenant`, `Branch`, `TenantMembership`, and `TenantPermission`) and has not been applied or tested against PostgreSQL. Its composite foreign keys prevent memberships, branches, products, and inventory movements from crossing tenant boundaries. The SQL append-only triggers and isolation/concurrency behavior require verification on an isolated PostgreSQL instance; the current tests use mocks only.

Sales and cashier POS endpoints are defined at:

- `GET /api/tenants/:tenantId/branches/:branchId/sales/catalog` (`sales.create`)
- `POST /api/tenants/:tenantId/branches/:branchId/sales` (`sales.create`, requires an `Idempotency-Key` header)
- `GET /api/tenants/:tenantId/branches/:branchId/sales` (`sales.read`)
- `GET /api/tenants/:tenantId/branches/:branchId/sales/:saleId` (`sales.read`)

The sale service rechecks active membership, tenant role permission, branch membership scope, and active user status inside its transaction. The server loads active product prices from the database; request bodies contain only product IDs, quantities, discount, and payment method. It calculates money in integer cents, snapshots the product name/SKU/unit price, inserts the completed invoice and negative inventory movements together, and uses branch/product advisory locks shared with inventory adjustment. The idempotency key is scoped to tenant, branch, and authenticated actor; reusing it with a different normalized payload returns a conflict. Database uniqueness constraints back the invoice and idempotency keys. Completed sales and their items are append-only in the proposed SQL. No cancellation, refund, split payment, or customer/accounting integration is implemented.

The proposed migration `20261019124700_sales_pos` depends on `20261019122000_products_inventory_branch_scope` and the same actual baseline; it creates the sale/payment enums, `Sale`/`SaleItem`, sale-linked inventory movements, and `sales.create`/`sales.read` permission keys. It grants neither permission to any role. Apply order and whether either preceding migration has already run must be verified against the target's actual migration history before planning deployment. This migration has not been applied or tested against PostgreSQL. Unit tests use mocked Prisma transactions; they do not prove database rollback, advisory-lock behavior, constraints, or real concurrent oversell prevention. Isolated PostgreSQL integration tests remain required before production use.

The Prisma schema includes a nullable password hash and an active/disabled user status, but the proposed platform migration does not create or update those authentication columns. Existing users do not gain credentials from this schema change: users without a password hash cannot log in. Before authentication can be used against an existing database, an approved baseline/authentication migration must add these columns and decide how existing emails will be normalized and how duplicate case variants will be resolved.

## Local activation-only deployment

For a free deployment that does not require adding a payment card, use the
Cloudflare Workers implementation in `../activation-worker/README.md`. The
Render instructions below are an alternative if the account's card verification
is acceptable.

The activation API can be deployed separately from the unfinished general API
using `npm run start:activation`. This entry point exposes only
`GET /api/health`, `POST /api/activation/request`, and
`POST /api/activation/verify`; it does not expose the other Metrivo API routes.
For an initial free deployment, use a Render free web service and a Neon free
PostgreSQL project. Render free services sleep after 15 minutes without traffic
and can take about a minute to wake. Neon free usage is limited and scales to
zero, so this is suitable for a low-volume start, not a production availability
guarantee.

Configure Render with root directory `apps/api`, build command
`npm ci && npm run prisma:generate && npm run build`, and start command
`npm run start:activation`. Set `HOST=0.0.0.0` and `NODE_ENV=production`.
Configure `DATABASE_URL` using the Neon pooled or direct connection string,
with any reserved password characters URL-encoded.

The repository has no production baseline migration and contains other
unapplied migrations. Do not run `prisma migrate deploy` against this
activation-only database. In a new, dedicated Neon database, execute only the
SQL from
`prisma/migrations/20261113010000_local_activation_challenges/migration.sql`
in Neon's SQL Editor; this creates the table and indexes used by activation.
Do not use the shop's data database for this service.

Set these additional Render variables in its environment dashboard; never
commit them or send them in chat:

- `ACTIVATION_OWNER_EMAIL`: the one email address that receives all codes.
- `ACTIVATION_OTP_PEPPER`: a unique random value of at least 32 bytes.
- `ACTIVATION_SIGNING_PRIVATE_KEY_PEM`: the Ed25519 private key matching the
  public key included in the Desktop build.
- `ACTIVATION_MAIL_WEBHOOK_URL`: the deployed Google Apps Script `/exec` URL.
- `ACTIVATION_MAILER_SHARED_SECRET`: a unique random value of at least 32 bytes,
  identical to the Apps Script `METRIVO_MAILER_SHARED_SECRET` property.

The Google Apps Script mail relay setup and signed request protocol are
documented in `scripts/google-apps-script/README.md`. The relay runs as your
Google account and is protected by an HMAC signature; Google account email
quotas and Render's free-instance limits still apply. Verify
`https://<render-service>.onrender.com/api/health` reports a connected
database, then test code delivery before building the Desktop installer.

The Prisma schema does not express PostgreSQL `CHECK` constraints for non-blank support reasons and `expiresAt > startsAt` with a maximum one-hour duration. The five-permission limit and support-eligibility check are enforced by `SupportAccessService`, not by a database constraint. Add and review SQL constraints/triggers for those invariants before relying on database-enforced duration or permission limits. The proposed platform migration adds append-only triggers for `SupportAccessAuditLog`; they have not been applied or tested against PostgreSQL.

Run all API unit tests with `npm test`. They use Node's built-in test runner and mocks; they do not replace integration tests against an isolated PostgreSQL test database.

Run `npm run test:postgres` from `apps/api` to execute the POS HTTP/Prisma integration suite in the repository's dedicated `compose.pos-test.yml` service. Compose starts only the PostgreSQL bootstrap server: it has no test-database/user variables and mounts no SQL into PostgreSQL's automatic entrypoint directory. The service binds only to `127.0.0.1:55432` and stores data in container tmpfs. Each runner invocation creates a cryptographically random Compose project name and identity marker. Before executing runner-managed bootstrap SQL, it checks that the project has no pre-existing Docker resources, then verifies the container project/service/config labels, image, loopback port mapping, tmpfs storage, absence of Docker volume mounts, and a clean bootstrap connection to the built-in `postgres` database as `postgres`; it also verifies that the intended test database does not already exist. The runner then passes the per-run marker as a quoted psql variable, creates the test-only roles and database, and verifies through Prisma on the host port that the database name, login role, internal server port, and exact unpredictable marker match this invocation before applying the test-only baseline and checked-in migrations in timestamp order using a non-superuser session and a `NOLOGIN` owner role. A failed verification aborts before baseline or migration SQL. Cleanup is attempted only after startup was attempted and only after container/network labels and project resources are verified against this invocation; it does not request volume deletion. If partial startup resources cannot be conclusively attributed to this project, cleanup is skipped and the runner reports that limitation rather than broad cleanup. The runner executes migration SQL through `psql` under `SET ROLE` rather than `prisma migrate deploy`, because the platform foundation deliberately requires a non-login table-owner role; therefore this test does not validate Prisma's migration-history bookkeeping or production migration deployment procedure. The test app login and test grants exist only in the isolated container; they are not production role recommendations. The test-only baseline fixture supplies tables that this repository's proposed migrations assume already exist; it is not a production baseline migration and does not prove that production migration history is complete. The suite starts an actual NestJS HTTP application with Prisma connected to PostgreSQL and verifies transactional sales, rollback, stock contention, idempotency, authorization scope, price snapshots, and invoice uniqueness. The HTTP test module injects a fixed test principal and does not replace separate JWT/authentication-guard tests. Docker Engine and Compose are required; if unavailable, the runner fails closed before issuing migration SQL.
