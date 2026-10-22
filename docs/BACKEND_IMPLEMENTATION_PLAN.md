# Backend Implementation Plan for Metrivo

## 1) Current state of the project (verified)

### Frontend status

The current project is a Vite + React + TypeScript application with a dashboard-first SaaS mockup. The app is not yet a multi-tenant backend-backed product.

Verified current structure:

- `src/app/App.tsx` owns the root app state: language, active page, mobile menu, and search.
- `src/components/layout/Sidebar.tsx` and `src/components/layout/Topbar.tsx` render shell navigation and top-level controls.
- `src/features/dashboard/*` contains the dashboard UI and related cards.
- `src/data/demoData.ts` is a static mock data source.
- `src/i18n/*` contains Arabic/English dictionary objects and the current language switch logic.
- `src/types/index.ts` contains the front-end domain typing used by the dashboard.
- Build and lint checks currently pass for the frontend as it exists today.

### What exists now vs. what is proposed

Existing today:

- Front-end UI shell and dashboard layout
- Demo data for products, sales, inventory, and transactions
- Arabic/English language toggle
- Sidebar, header, cards, charts, and table UI
- No real API layer
- No persistence layer
- No authentication/authorization layer
- No tenant isolation model
- No database schema or migrations
- No backend deployment flow

Proposed for the future:

- API server for all business logic and persistence
- PostgreSQL database with a tenant-aware schema
- Authentication and authorization service
- Tenant memberships/roles and permission checks
- Real product, inventory, sales, purchases, suppliers, expenses, and reporting modules
- Background jobs, file handling, audit log, and backup strategy

### Important conclusion

The current codebase is a frontend prototype with no backend contract and no server-side tenant architecture. We should not assume that backend features exist; they are future work and need to be introduced deliberately.

---

## 2) Audit of the project planning document

The earlier project report in `docs/PROJECT_AUDIT_REPORT.md` is useful as a frontend audit artifact, but it is not a backend plan and does not define the server architecture or product/data model required for multi-tenant SaaS work.

Result:

- The existing report is compatible with the current frontend state.
- It is not sufficient as the backend implementation plan.
- A separate backend plan is required and should be created here, without changing the current app structure.

---

## 3) Recommended project organization

### Recommendation: use a monorepo only when the app is ready to grow beyond a single frontend

Best fit for Metrivo:

```text
metrivo/
├── apps/
│   ├── web/              # current React app migrated here later
│   └── api/              # backend server (NestJS / Fastify)
├── packages/
│   ├── shared/           # shared DTOs, enums, validation schemas, constants
│   └── ui/               # optional reusable UI components later
├── infra/
│   ├── docker/
│   ├── k8s/
│   └── scripts/
├── docs/
├── package.json
├── pnpm-lock.yaml / package-lock.json
├── .env.example
└── .gitignore
```

### Why this structure is appropriate

- Keeps frontend and backend independent while sharing domain contracts.
- Prevents frontend and backend teams from modifying the same code path.
- Makes tenant-sharing contracts explicit through `packages/shared`.
- Easier to configure CI/CD for app-level deployment.
- Reduces future coupling between UI and server logic.

### Important decision: should the frontend move to `apps/web` now?

As a default recommendation: no, not before the backend is planned and the project is ready for a monorepo migration.

Reason:

- The current frontend is already working and buildable.
- Moving it prematurely creates disruption and increases migration risk.
- The app’s code may still be small enough to keep at the root while the API is introduced incrementally.

Best-risk-reduction path:

1. Keep the current frontend where it is for now.
2. Create the backend in a parallel structure or in a new app folder only after the API contract is defined.
3. Once the backend is stable, move the frontend into `apps/web` in a single migration with aliases and build config adjustments.
4. Do not migrate the frontend and backend together without a freeze and smoke-test plan.

### Migration risks if moved too early

- Broken relative imports
- Broken CSS asset paths
- Misconfigured Vite/base paths
- Test/build scripts failing
- Duplicate translation or environment config
- Developer churn and loss of trust in the current working app

### Safer migration strategy

- Use a staged migration plan with one branch or isolated worktree.
- Keep the root app operational until the new structure is validated.
- Move only after frontend smoke tests pass in both states.

---

## 4) Recommended backend technology stack

### API framework: NestJS (recommended)

Why NestJS is a good fit:

- Strong TypeScript-first architecture
- Clean modular structure and dependency injection
- Mature validation and authentication patterns
- Excellent fit for enterprise SaaS apps
- Easy to implement RBAC, tenant scoping, and domain services
- Good long-term maintainability

Alternative: Fastify + TypeScript is leaner and faster, but it requires more custom project structure and discipline. For a multi-tenant SaaS product with many modules, NestJS is the stronger default.

### Database: PostgreSQL

Why PostgreSQL:

- Strong multi-tenant support
- Excellent transactional integrity
- Mature reporting and aggregation capabilities
- Good support for financial data and audit trails
- Reliable for SaaS operations and relational modeling

Recommended ORM/data layer:

- Prisma or Drizzle (choose one)
- Prisma is easier for rapid team onboarding and schema migrations
- Drizzle is more lightweight and SQL-first

Recommendation: choose Prisma for the first implementation because it is easier to manage in a growing SaaS domain and works well with TypeScript.

Important constraint for v1:

- The central PostgreSQL instance on the server is the system of record and the only trusted source for business transactions.
- The local copy for a shop is not treated as an independent authority for sales creation, stock deductions, or financial approvals in version 1.
- Local data must be treated as a synchronized, read-optimized, recoverable replica or backup layer, not as a parallel source of truth.

### Authentication and authorization

Recommended approach:

- JWT access token + refresh token
- HttpOnly secure cookies for refresh tokens if browser-based app is used
- Server-issued tenant claim plus user claim
- Role-based and permission-based authorization (RBAC + permissions)

Recommended identity model:

- Users
- Tenants
- Roles
- Permissions
- UserTenantMemberships

### Cache and performance

- Redis for caching session metadata, tenant settings, and rate limiting
- Optional queue workers for reporting and notifications

### File and document handling

- S3-compatible object storage for invoices, product images, and documents
- Local or storage-provider adapter for staging and production

### Logging and observability

- Structured logs with Pino
- Error tracking with Sentry or equivalent
- Request correlation IDs and tenant metadata in logs

### Validation and contracts

- Zod for runtime validation and server-side schemas
- Shared DTOs and schema package in `packages/shared`
- Validators at service boundaries to avoid invalid data entering the system

---

## 5) Local synchronized copy per shop: architecture and scope

### Purpose of the local data store

The local copy is not part of the transactional source of truth in v1. It exists to support local resilience, easier reporting for branch devices, reduced round-trip delay for specific read-heavy workflows, and a recovery layer for the shop environment.

This design must not enable a local device to create or approve sales, inventory movements, or payment operations without server confirmation.

### Recommended local data scope for v1

The local store should be a limited, encrypted subset of operational data. Recommended contents include:

- store metadata and tenant configuration
- product master data required for a local storefront or cashier workstation
- current stock snapshot for supervised read workflows
- recent sales summaries, invoice references, and local receipt metadata
- user/device registration information necessary to identify the local client
- sync metadata such as last successful sync timestamp, last checkpoint, and sync status
- basic audit log entries relevant to local sync events

The local store should exclude or minimize:

- full financial journal or raw payment gateway detail if not needed locally
- sensitive employee personal data beyond what is necessary for device/session validation
- unrestricted customer PII unless clearly required for local operations
- unrestricted inventory mutation logic beyond a controlled synchronization pattern

### Storage recommendation

Recommended default option for v1:

- encrypted local SQLite database on the shop device or branch gateway

Why this is a good default:

- low operational complexity
- good local query performance
- simple backup and export
- easy to encrypt at rest
- relatively simple support for local sync metadata and finite replication set

Alternative options:

1. Full local PostgreSQL instance
   - Pros: closest to production database behavior
   - Cons: significantly higher operational complexity, maintenance, patching, backup burden, and cost
   - Not recommended for v1 unless the business case is very strong

2. Local encrypted document or key-value store
   - Pros: simple structure
   - Cons: weak fit for relational reporting and transactional integrity
   - Better for a constrained cache than for a business data store

3. Minimal encrypted local store with a strict subset of tables
   - Best compromise for v1
   - Recommended approach

### Binding local copy to the correct shop

The local device must be registered to exactly one tenant and, when applicable, one branch or location.

Required design:

- local client/device enrollment with a unique device ID
- store pairing token issued by the central server
- signed registration payload containing tenant_id and branch_id
- device certificate or derived key for encrypted local storage
- device authorization check before any local sync begins

Rules:

- The local data store must never accept a tenant identifier from the client without server verification.
- The local device must only sync data for the tenant and branch it was enrolled for.
- Each branch/device must have a unique local identity and a server-issued sync credential.

### Authentication, encryption, and access control for local copies

Minimum controls:

- encryption at rest using strong local encryption standards
- encryption in transit for all sync traffic
- device-level identity and authentication to the central server
- signed sync tokens with expiration and rotation
- access control scoped to the exact shop/branch and assigned permissions
- local storage should be readable only by approved application identity and OS-level access policies

The local copy must never bypass server-side permission checks. In other words, even if a local device is compromised, it cannot alter the central data model without server validation and permission enforcement.

### Recovery and rebuild strategy

If the local device is lost, damaged, or corrupted:

- the server must be able to reissue the local registration state
- the local store can be recreated from a trusted seed from the server
- device identity and keys must be revocable and replaceable
- a fresh local sync can restore the approved subset of data

Required recovery design:

- server must keep enough metadata to rebuild the local copy
- local rebuild should be a controlled synchronization, not a blind restore from untrusted local data
- local local copy deletion or corruption must never affect the source-of-truth on the server

---

## 6) Safe synchronization mechanism

### Synchronization model for v1

The local synchronized copy must work as a controlled replication layer, not as a secondary transactions engine.

Core principles:

- Central PostgreSQL is authoritative.
- Local data is derived from server state.
- Local changes are never accepted as final in v1 unless they are explicitly validated and accepted by the server.
- Sync must be resumable, idempotent, and auditable.

### Required synchronization behaviors

#### 1. Detect new and changed records

Each synchronized model should store:

- created_at
- updated_at
- last_synced_at
- sync_status
- sync_version or row version
- tenant_id
- branch_id
- device_id

The server should expose a delta API that returns only changed records since the last successful sync checkpoint.

#### 2. Safe retry on connection interruption

During sync interruption:

- do not apply partial updates without validation
- maintain an explicit sync batch state
- allow retry from the last successful checkpoint
- ensure server-side reconciliation is deterministic
- if a batch fails halfway, mark it as failed without leaving the local store in an inconsistent state

Recommended rule:

- use transactional batch application at the server boundary and per-device sync checkpoints at the client boundary

#### 3. Idempotency and duplicate prevention

Every sync request or mutation should carry an idempotency key, such as:

- request_id
- sync_batch_id
- event_id
- operation_hash

Rules:

- repeated sync attempts must not duplicate data
- repeated delivery of the same mutation should yield the same result
- server should reject or deduplicate duplicate entries based on the idempotency key

#### 4. Conflict detection and policy

Conflicts must be identified and classified.

Conflict types:

- local update vs server update on same record
- delete vs update race
- multiple devices writing same branch-scoped record
- stale local record after branch reassignment

Policy should be explicit:

- server wins for authoritative business fields in v1
- local modifications to business-critical data are not accepted without server approval
- conflict resolution should be logged and visible in audit records
- branch-level or device-level override must be restricted by permission

#### 5. Permission and tenant validation

Before accepting any synchronized payload:

- verify tenant ownership
- verify branch association
- verify device identity and active authorization
- verify the user or service account permissions on the receiving side
- reject any payload that attempts to bypass server rules

The local device cannot be allowed to perform operations that exceed its server-side authorization.

#### 6. Sync status visibility

The system should record and expose:

- last successful sync timestamp
- current sync status
- last sync error message
- pending queue count
- last applied checkpoint
- whether the device is in sync or degraded mode

This allows store staff and admins to know whether data is current and whether a manual reconciliation is required.

#### 7. Full resync support

A full resync should be possible without duplicating records.

Mechanisms:

- server-side stable record IDs
- revalidation of row hashes or versions
- built-in deduplication logic
- ability to reset local sync state by server-issued sync token

A full resync should be treated as a recovery operation, not a regular operation.

---

## 7) Minimum local data vs. full financial retention

### Do not assume that all financial data must be stored locally

A local copy is not a replacement for server-side auditing, accounting, and inventory compliance. In v1, the system should minimize the amount of sensitive or financial data kept on branch devices.

The minimum practical local subset should be limited to:

- last known valid product catalog snapshot
- current stock state needed for operational visibility
- recent sales summary for local cashier oversight
- receipt metadata and reference IDs
- primary branch configuration and device identity

Risks of keeping more financial or personal data locally:

- higher compliance and privacy burden
- greater exposure if the device is stolen or lost
- more complex device-side encryption and lifecycle management
- harder recovery, deletion, and audit control
- risk of data being used for unauthorized offline operations

For v1, the safer default is to retain only minimal operational state on local devices and rely on the central PostgreSQL system for authoritative records.

---

## 8) Difference between local sync, server backups, and disaster recovery

### 1. Local synchronized copy

Purpose:

- improve responsiveness for local storefront workflows
- provide a lightweight operational mirror for a specific shop/branch
- reduce dependence on a single network round-trip for low-risk read operations

Important limitation:

- it is not a substitute for the central system and not a complete backup strategy

### 2. Independent server backups

Purpose:

- protect the authoritative data on the central PostgreSQL system
- allow restoration to a prior point in time
- support backup retention policies and owner-level recovery plans

Required attributes:

- stored outside the primary server environment
- encrypted backups
- retention schedule and rotation plan
- backup validation and restoration test loops

### 3. Disaster recovery and system restore

Purpose:

- restore not only data, but the application, configuration, services, credentials, and access path to the system
- recover the platform after hardware failure, data corruption, cloud outage, or operational incident

This must include:

- infrastructure recovery steps
- configuration backup
- secrets management and key rotation
- infrastructure-as-code or deployment scripts for repeatable restore
- application restore validation

Important:

- local synced copies do not replace independent server backups or disaster recovery planning
- a local device failure should not require a production outage to recover

---

## 9) Backup and recovery policy

### Backup strategy

The system should define a backup strategy for the central database and operational configuration, including:

- full backups at scheduled intervals
- incremental or WAL-based backups if supported
- encrypted transfer to an external secure storage provider
- retention policy with a documented duration
- access restrictions for all backup data

Recommended starting policy:

- daily full backups
- frequent incremental or log backups
- test restore at least once per quarter for the first production rollout

### RPO and RTO targets

These must be defined and approved later, but the architecture should support the following decision framework:

- RPO (Recovery Point Objective): maximum acceptable amount of data loss
- RTO (Recovery Time Objective): maximum acceptable duration to restore service

For a SaaS business with sales and inventory operations, the initial targets should be conservative and reviewed with business stakeholders. The design must support both incremental and full restoration without requiring a local device copy.

### Recovery testing

The team must validate restore steps regularly:

- restore database to a test environment
- validate the API service boots correctly
- validate auth and permissions still work
- validate tenant isolation remains intact
- validate degraded-read and synced-copy behavior

---

## 10) Multi-branch and multi-device design

### Branch support

A tenant may have multiple branches or locations. The system must be designed to support this from the start.

Each branch should have:

- branch_id
- branch_name
- tenant_id
- branch_status
- address or location metadata
- allowed device list
- branch-level configuration

### Multiple devices per branch

The architecture must not assume that one shop has only one device. A branch may have:

- cashier workstations
- POS terminals
- local admin tablets
- local service devices
- a local branch gateway or sync manager

Recommended approach:

- treat each device as a client identity under the same branch
- allow branch-scoped device registration
- keep device-specific sync state and credentials
- assign permissions according to role and device purpose
- allow full sync or partial sync depending on the device trust level

### Branch conflict handling

If multiple devices in the same branch issue writes that touch the same data, the server must resolve them deterministically. This means:

- requests must be validated at the server
- timestamps and versions must be tracked per branch and tenant
- only server-authoritative operations can finalize the business state
- local devices should use a queue that can replay or reject outdated operations

---

## 11) Offline mode and future extensibility

Offline mode is explicitly not required in v1. The architecture must, however, be designed so that it can be added later without reworking the core data model.

Important: offline-first sales or offline inventory mutations require additional design work for:

- conflict resolution rules
- transaction durability on the device
- queued operations
- reconciliation at re-sync time
- operator and admin visibility of pending offline actions
- explicit approval models before offline transactions become final

The v1 architecture should not assume that offline writes are safe or permitted. Instead, it should deliberately reserve the right to add them in a later phase with a proper synchronization contract and security review.

---

## 12) Recommended implementation phases

### Phase 0 — Data model and tenant boundaries

Goal: lock the system boundaries before backend code is built.

Tasks:

- define tenant and branch model
- define local-device and sync metadata model
- define roles and permissions
- define device registration and authentication flows
- define v1 local data boundaries

### Phase 1 — API foundation and security

Goal: build a secure, maintainable core API.

Tasks:

- NestJS project foundation
- Prisma schema and migration pipeline
- auth, JWT, refresh tokens, and tenant-aware middleware
- repository and service boundaries
- health checks and environment configuration

### Phase 2 — Local copy design and implementation

Goal: introduce the local synchronized subset safely.

Tasks:

- select local storage technology
- implement device registration and encryption
- define sync checkpoint model
- define local data subset and token lifecycle
- implement a safe data relay mechanism between local and central systems

### Phase 3 — Synchronization and conflict handling

Goal: prove the local copy can safely sync with the server.

Tasks:

- delta-based sync logic
- idempotency keys
- retries and checkpoint logic
- conflict detection policies
- branch/device-specific validation
- dashboard for sync status

### Phase 4 — Backup and recovery

Goal: protect central data and validate restore capability.

Tasks:

- server backup pipeline
- restore scripts
- external backup storage
- periodic restore tests
- RPO and RTO finalization

### Phase 5 — Security, resilience, and failure recovery tests

Goal: ensure the system is production-ready from a risk perspective.

Tasks:

- authorization tests for tenant boundaries
- escalation testing for invalid local sync payloads
- device recovery and re-enrollment tests
- network-loss recovery validation
- compromise and key rotation testing

---

## 13) Local copy complexity and recommendation

### Cost and complexity

A local synchronized copy is not cheap to design and operate correctly. It adds complexity in several areas:

- local encryption and key management
- authentication and registration of devices
- sync checkpoints and recovery logic
- idempotency and conflict handling
- periodic validation and support burden
- extra operational monitoring and user support

### Option comparison

#### Option A: Full local PostgreSQL

Pros:

- closest to central database semantics
- good reporting capabilities
- easier if the local app eventually grows into a full offline-first application

Cons:

- high operational burden
- more patching and maintenance
- more backup and restore complexity
- more risk if security is not managed carefully

Recommended only if local business needs become strong enough to justify a larger operational cost.

#### Option B: Minimal encrypted SQLite local store

Pros:

- simple and reliable for a controlled subset
- lower aside complexity and easier recovery
- easy to encrypt and back up
- sufficient for a read-heavy and synchronization-based local mirror

Cons:

- not a full replacement for central storage
- limited for complex reporting or multi-session write logic

Recommended for v1.

#### Option C: Local encrypted cache / structured store

Pros:

- easiest to manage
- minimal attack surface

Cons:

- poor fit for local reporting or any significant operational logic
- not enough for branch-level resilience beyond simple reads

Best used as a temporary or secondary option, not as the primary local sync model.

### Recommendation

For the first release, prefer a limited, encrypted local SQLite or equivalent compact database for the specific shop branch, synchronized by the central server using tracked deltas and strict validation. Do not treat it as a second transactional system or as a substitute for central PostgreSQL and backup operations.

---

## 14) Decisions still requiring approval from the project owner

The following items are architecture decisions that should be confirmed before implementation begins:

1. Is the local synchronized copy required only for read-heavy local visibility and emergency recovery, or is there a business requirement for local branch workflows beyond that?
2. Should each branch/device have its own local encrypted store, or should the local store be managed centrally per shop with a defined device trust model?
3. Are local devices allowed to retain only recent sales summaries and product snapshots, or should a wider subset be allowed for branch operations?
4. Do we require a full branch-level device registry in v1, or do we start with a smaller number of approved devices per tenant?
5. What is the acceptable RPO and RTO for the central service before production launch?
6. Does the business want a future offline capability from the start, or should it be reserved for a later phase?
7. Should the local sync layer support all business modules from the start, or should it initially focus only on product and stock visibility plus sales summary metadata?

These decisions affect security, complexity, and operational cost, and should be approved with the architecture before any backend work begins.

---

## 15) Final assessment

Metrivo’s architecture should be built around a central PostgreSQL-based SaaS system as the trusted source of truth, with a carefully bounded local synchronized copy for each shop or branch where it provides clear value. The local copy must never become a parallel authority for sales, stock changes, or financial approvals in version 1.

This keeps the product aligned with multi-tenant SaaS requirements while still allowing a realistic path toward future offline capability without locking the project into an unsafe architecture.

The recommended model is: central authoritative data, limited encrypted local store, secure delta-based synchronization, explicit device identity and permissions, and robust server-side backups and disaster recovery planning.

This is the critical architecture decision for Metrivo.

### Core requirement

Each tenant must be fully isolated from the others. No tenant may access another tenant's data or settings by accident or via a crafted request.

### Recommended design

#### Tenant entity

- `tenants`
  - id
  - slug
  - name
  - status
  - created_at
  - owner_user_id

#### Users and membership

- `users`
- `roles`
- `permissions`
- `tenant_memberships`

A user can belong to multiple tenants, and each relationship has a role and permissions.

#### Transactional tables

Every business table must include a `tenant_id` field and use it as the primary isolation boundary, for example:

- products
- inventory_transactions
- sales
- invoices
- purchases
- suppliers
- expenses
- cash_register_sessions
- shifts
- recipes
- recipe_items
- reports_cache
- audit_logs

### Isolation rules

- Every query must include `tenant_id = currentTenantId`.
- Every write must enforce tenant ownership.
- Service layer must validate `tenant_membership` for the current user.
- Never trust the client to send the tenant identifier as the source of truth.
- Use server-side context resolved from a validated JWT and route context.

### Authorization model

Recommended model for server access:

- Authentication: verify user identity
- Authorization: verify user has a valid membership to the tenant
- Policy: verify the requested action is permitted for that role and tenant

Example rule:

- Request comes with tenant slug, or a subdomain, or a tenantId in the route
- Server resolves tenant and validates user membership
- Server checks permission `products.create`
- Server enforces `tenant_id = ctx.tenantId` on all DB actions

### Security recommendation

Use either:

- tenant slug in URL (`/tenants/:tenantSlug/...`) with server-side resolution, or
- subdomain-based routing for a production SaaS deployment

But do not use a raw client-supplied tenantId without server validation.

### Data access rule

All repositories should be tenant-scoped by default, for example:

- `findManyByTenant(tenantId)`
- `findOneByTenantAndId(tenantId, id)`
- `updateByTenant(tenantId, id, data)`

This avoids accidental cross-tenant leakage.

---

## 6) Functional requirements to support

The system requirements are broad and should be treated as a phased SaaS product plan. The following domains are the minimum business scope to support:

### 1. Users and auth

- User sign-up and login
- Password reset and email verification
- Multi-tenant membership
- Roles and permissions
- Session management
- Audit log of privileged actions

### 2. Shops / tenants

- Tenant onboarding
- Tenant profile and branding
- Branch/location support
- Currency and localization settings
- Business hours and settings

### 3. Products and catalog

- Product definitions
- SKU and barcode support
- Categories and subcategories
- Unit prices and cost prices
- Inventory status and sales tracking

### 4. Inventory

- Stock counts
- Inventory adjustments
- Stock movement history
- Low stock alerts
- Product expiration handling (if needed)

### 5. Sales and invoices

- Sales transactions
- Receipt/invoice generation
- Payment methods
- Return/sale reversal logic
- Sales reports by period and product

### 6. Purchases and suppliers

- Purchase orders
- Supplier management
- Price comparisons
- Purchase returns
- Payment tracking

### 7. Expenses and cash management

- Expense categories
- Daily cash entries
- Cash register / drawer management
- Petty cash logic
- Shift-based cash reconciliation

### 8. Recipes and cost structure

- Recipe definitions
- Ingredients and cost calculations
- Cost-per-serving logic
- Production and materials traceability

### 9. Reports and analytics

- Daily sales reports
- Inventory aging
- Profit margin and real-time dashboard
- Cash flow
- Branch comparison
- Top-selling products

---

## 7) Suggested phased implementation roadmap

### Phase 0 — Decision freeze and project alignment

Goal: lock the architecture before any backend code is built.

Activities:

- Confirm monorepo vs single repo
- Confirm NestJS vs alternative framework
- Confirm PostgreSQL + Prisma strategy
- Confirm tenancy routing model
- Confirm scope for MVP vs future modules

Required decision points:

- Do we keep the current frontend at root or move to `apps/web` before backend work?
- Do we support a single branch first or multi-branch tenant model from day one?
- Which roles are required in MVP: admin, manager, cashier, inventory officer?
- Which modules are required for the first version?

### Phase 1 — Foundation and shared contracts

Goal: establish the core system without full product features.

Create:

- API project skeleton
- Database schema skeleton
- Shared package for DTOs and common enums
- Auth foundation
- Tenant membership model
- Basic health and readiness endpoints
- Environment and config management

Deliverable:

- A working backend shell ready for feature modules

### Phase 2 — Identity, tenants, and permissions

Goal: secure all future work behind a proper auth model.

Implement:

- User signup/login
- Refresh token lifecycle
- Role and permission definitions
- Tenant membership and access enforcement
- Logging and audit hooks for auth actions

Deliverable:

- Secure user/tenant boundary with protected API endpoints

### Phase 3 — Catalog, inventory, and stock movement

Goal: support the core operational data model.

Implement:

- Products
- Suppliers
- Inventory records
- Stock movement logs
- Adjustments and low-stock rules

Deliverable:

- Operational product and inventory foundation for the shop

### Phase 4 — Sales, payments, and invoices

Goal: support the daily business flow.

Implement:

- Sales creation flow
- Invoice records
- Payment methods
- Sales status lifecycle
- Return/reversal support

Deliverable:

- Real sales processing and accounting trail

### Phase 5 — Purchases, expenses, and cash

Goal: increase operational completeness.

Implement:

- Purchases and purchase items
- Supplier payments
- Expenses and categories
- Cash drawers and shifts
- Reconciliation logic

Deliverable:

- Store operation and finance primitives

### Phase 6 — Recipes, costs, and reports

Goal: enable margin, cost, and operational analytics.

Implement:

- Recipes and ingredients
- Cost estimation
- Profit reports
- Inventory and margin analytics
- Exported reporting endpoints

Deliverable:

- Business intelligence and operational insight layer

### Phase 7 — Hardening, scale, and production readiness

Goal: readiness for real-world deployment.

Add:

- Rate limiting
- Request throttling
- Audit controls
- Observability
- Backup automation
- Deployment pipelines
- Disaster recovery and rollback plan

---

## 8) Required quality and security checks

### Quality gates

Every phase should have:

- Build verification
- Type-checking
- Linting
- Unit tests for business logic
- Integration tests for API endpoints
- Schema validation tests
- Permission tests for tenant boundaries

### Security requirements

- Protect all endpoints behind authentication and authorization
- Validate every user input with schemas
- Use parameterized queries or ORM layer only
- Never trust client-provided tenant identifiers
- Enforce tenant scope in repositories and services
- Use secure password hashing
- Use refresh token rotation
- Log audit events for critical changes
- Minimize privileged operations to a small set of roles

### Environment variables

Use a `.env.example` and a stricter production environment strategy:

- `DATABASE_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `REDIS_URL`
- `S3_ENDPOINT`
- `S3_BUCKET`
- `APP_ENV`
- `PORT`
- `CORS_ORIGINS`
- `SMTP_*`
- `LOG_LEVEL`

Never hardcode secrets in source files.

### Database migrations

- Use a migration-based workflow from day one
- Create migration per feature group or bounded domain change
- Include index creation for tenant, status, date, and relationship queries
- Make all migration files reviewable

### Backups and disaster recovery

- Automated daily logical backups for PostgreSQL
- Point-in-time recovery strategy if supported by hosting
- Restore procedures documented before production deployment
- Separate tenant data from config and metadata storage

---

## 9) Risks and decisions requiring explicit approval

These are the most important decisions that should be confirmed before actual implementation starts:

1. Monorepo structure: do we keep the existing frontend at root for the first phase or migrate it to `apps/web` immediately?
2. Backend stack: NestJS + PostgreSQL + Prisma is recommended, but this should be explicitly approved before coding.
3. Tenant routing model: prefer route-based tenant context vs subdomain-based tenant context.
4. MVP scope: which modules are mandatory for the first release (inventory, sales, purchases, expenses, recipes, or reports)?
5. Auth model: are we supporting only internal admin-managed users in MVP, or do we need public/self-service tenant onboarding from day one?
6. Branch support: do we support one branch per tenant immediately, or start with a single branch per tenant and add multi-branch later?
7. Billing and subscription model: should subscription logic be included in MVP or deferred to a later SaaS layer?

These decisions affect architecture, timeline, and deployment strategy, and should be confirmed before code implementation begins.

---

## 10) Draft recommendation for the first implementation

If we keep the plan practical and low-risk, the first successful phase should be:

- API foundation
- PostgreSQL schema
- Tenant model and auth
- User + role + permission system
- Product and inventory domain
- Sales domain
- Invoice and payment skeleton
- Reporting endpoints

This gives the team a working operational SaaS core before tackling advanced modules like recipes, cash register reconciliations, or deep finance automation.

---

## 11) Final assessment

The project is currently a frontend-only demo and is not ready for backend implementation without a product and architecture decision process.

The best path is:

- Keep the frontend stable.
- Define the backend architecture explicitly.
- Use a tenant-first design from the beginning.
- Start with a secure API shell and data model before adding more business modules.

The system should be treated as a multi-tenant SaaS product by design, not as a single-shop dashboard with future assumptions.

---

## 12) Summary of the proposed system

### Proposed high-level architecture

- Frontend: React + TypeScript + Vite
- Backend: NestJS + TypeScript
- Database: PostgreSQL
- ORM: Prisma
- Auth: JWT + refresh tokens + RBAC/permissions
- Cache: Redis
- Storage: S3-compatible object storage
- Observability: structured logging + error tracking
- Shared contracts: `packages/shared`

### Proposed project layout

```text
metrivo/
├── apps/
│   ├── web/
│   └── api/
├── packages/
│   └── shared/
├── infra/
├── docs/
└── ...
```

### Proposed execution order

1. Decide architecture and approval points
2. Create API foundation and shared contracts
3. Add tenant + auth + RBAC
4. Build product/inventory domains
5. Add sales and invoices
6. Add purchases, expenses, and cash flows
7. Add recipe/cost/reporting capabilities
8. Add security hardening and production readiness

This is the safest and most maintainable path to build Metrivo into a multi-tenant SaaS product without destabilizing the current frontend.
