import 'reflect-metadata'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { ExecutionContext } from '@nestjs/common'
import {
  RequireAuthenticated,
  Public,
  RequirePlatformOwner,
  RequirePlatformPermission,
  RequireTenantPermission,
} from '../src/authz.decorator'
import { AuthorizationGuard } from '../src/authorization.guard'
import { createPrismaMock } from './test-helpers'

class AuthorizationFixture {
  @Public()
  publicRoute() {}

  @RequirePlatformPermission('platform.permission')
  platformRoute() {}

  @RequirePlatformOwner()
  platformOwnerRoute() {}

  @RequireTenantPermission('tenant.permission')
  tenantRoute() {}

  @RequireAuthenticated()
  authenticatedRoute() {}

  unprotectedRoute() {}

  @RequirePlatformPermission('platform.permission')
  @RequireTenantPermission('tenant.permission')
  ambiguousRoute() {}
}

interface RequestShape {
  user?: { userId?: unknown }
  params?: Record<string, string | undefined>
  method?: string
  route?: { path?: string }
}

function makeContext(
  handler: object,
  request: RequestShape = {},
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => AuthorizationFixture,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext
}

function makeGuard(queryResults: unknown[][] = []) {
  const mock = createPrismaMock({ queryResults })
  return {
    guard: new AuthorizationGuard(new Reflector(), mock.prisma),
    ...mock,
  }
}

describe('AuthorizationGuard', () => {
  it('allows public routes without reading authentication or database state', async () => {
    const { guard, queryCalls } = makeGuard()

    assert.equal(
      await guard.canActivate(
        makeContext(AuthorizationFixture.prototype.publicRoute),
      ),
      true,
    )
    assert.equal(queryCalls.length, 0)
  })

  it('denies a protected route when the authenticated principal is missing', async () => {
    const { guard, queryCalls } = makeGuard()

    await assert.rejects(
      guard.canActivate(
        makeContext(AuthorizationFixture.prototype.tenantRoute, {
          params: { tenantId: 'tenant-1' },
        }),
      ),
      UnauthorizedException,
    )
    assert.equal(queryCalls.length, 0)
  })

  it('allows authenticated-only routes only after an authenticated principal exists', async () => {
    const missing = makeGuard()
    await assert.rejects(
      missing.guard.canActivate(
        makeContext(AuthorizationFixture.prototype.authenticatedRoute),
      ),
      UnauthorizedException,
    )

    const authenticated = makeGuard()
    assert.equal(
      await authenticated.guard.canActivate(
        makeContext(AuthorizationFixture.prototype.authenticatedRoute, {
          user: { userId: 'user-1' },
        }),
      ),
      true,
    )
    assert.equal(authenticated.queryCalls.length, 0)
  })

  it('denies routes without exactly one valid permission policy', async () => {
    for (const route of [
      AuthorizationFixture.prototype.unprotectedRoute,
      AuthorizationFixture.prototype.ambiguousRoute,
    ]) {
      const { guard, queryCalls } = makeGuard()
      await assert.rejects(
        guard.canActivate(makeContext(route, { user: { userId: 'user-1' } })),
        ForbiddenException,
      )
      assert.equal(queryCalls.length, 0)
    }
  })

  it('requires a tenant route parameter for tenant permissions', async () => {
    const { guard, queryCalls } = makeGuard()

    await assert.rejects(
      guard.canActivate(
        makeContext(AuthorizationFixture.prototype.tenantRoute, {
          user: { userId: 'user-1' },
        }),
      ),
      ForbiddenException,
    )
    assert.equal(queryCalls.length, 0)
  })

  it('checks platform permissions only against the platform permission tables', async () => {
    const { guard, queryCalls } = makeGuard([[{ allowed: true }]])

    assert.equal(
      await guard.canActivate(
        makeContext(AuthorizationFixture.prototype.platformRoute, {
          user: { userId: 'user-1' },
        }),
      ),
      true,
    )
    assert.equal(queryCalls.length, 1)
    assert.match(queryCalls[0].text, /"PlatformPermission"/)
    assert.doesNotMatch(queryCalls[0].text, /"TenantPermission"/)
    assert.ok(queryCalls[0].values.includes('platform.permission'))
  })

  it('allows only the active registered owner on owner-only routes', async () => {
    const owner = makeGuard([[{ allowed: true }]])
    const admin = makeGuard([[{ allowed: false }]])

    assert.equal(
      await owner.guard.canActivate(
        makeContext(AuthorizationFixture.prototype.platformOwnerRoute, {
          user: { userId: 'owner-1' },
        }),
      ),
      true,
    )
    await assert.rejects(
      admin.guard.canActivate(
        makeContext(AuthorizationFixture.prototype.platformOwnerRoute, {
          user: { userId: 'admin-1' },
        }),
      ),
      ForbiddenException,
    )
    assert.match(owner.queryCalls[0].text, /PlatformOwnerRegistry/)
    assert.ok(owner.queryCalls[0].values.includes('owner-1'))
    assert.equal(admin.queryCalls.length, 1)
  })

  it('checks active tenant membership and tenant permissions separately from platform permissions', async () => {
    const { guard, queryCalls } = makeGuard([[{ allowed: true }]])

    assert.equal(
      await guard.canActivate(
        makeContext(AuthorizationFixture.prototype.tenantRoute, {
          user: { userId: 'user-1' },
          params: { tenantId: 'tenant-1' },
        }),
      ),
      true,
    )
    assert.equal(queryCalls.length, 1)
    assert.match(queryCalls[0].text, /tm\.status = 'ACTIVE'/)
    assert.match(queryCalls[0].text, /"TenantPermission"/)
    assert.doesNotMatch(queryCalls[0].text, /"PlatformPermission"/)
    assert.ok(queryCalls[0].values.includes('tenant.permission'))
    assert.ok(queryCalls[0].values.includes('tenant-1'))
  })

  it('denies access when membership is missing or inactive', async () => {
    for (const membership of ['missing', 'inactive']) {
      const { guard, queryCalls } = makeGuard([[{ allowed: false }], []])

      await assert.rejects(
        guard.canActivate(
          makeContext(AuthorizationFixture.prototype.tenantRoute, {
            user: { userId: 'user-1' },
            params: { tenantId: 'tenant-1' },
          }),
        ),
        ForbiddenException,
        `${membership} membership must not authorize the request`,
      )
      assert.equal(queryCalls.length, 2)
      assert.match(queryCalls[0].text, /tm\.status = 'ACTIVE'/)
      assert.match(queryCalls[1].text, /"SupportAccessGrant"/)
    }
  })

  it('denies expired support grants using the server clock', async () => {
    const { guard, queryCalls } = makeGuard([[{ allowed: false }], []])

    await assert.rejects(
      guard.canActivate(
        makeContext(AuthorizationFixture.prototype.tenantRoute, {
          user: { userId: 'support-user' },
          params: { tenantId: 'tenant-1' },
        }),
      ),
      ForbiddenException,
    )
    assert.match(queryCalls[1].text, /g\."startsAt" <= CURRENT_TIMESTAMP/)
    assert.match(queryCalls[1].text, /g\."expiresAt" > CURRENT_TIMESTAMP/)
  })

  it('denies revoked support grants', async () => {
    const { guard, queryCalls } = makeGuard([[{ allowed: false }], []])

    await assert.rejects(
      guard.canActivate(
        makeContext(AuthorizationFixture.prototype.tenantRoute, {
          user: { userId: 'support-user' },
          params: { tenantId: 'tenant-1' },
        }),
      ),
      ForbiddenException,
    )
    assert.match(queryCalls[1].text, /g\."revokedAt" IS NULL/)
  })

  it('allows an eligible support grant only when the access audit write succeeds', async () => {
    const { guard, queryCalls, executeCalls } = makeGuard([
      [{ allowed: false }],
      [{ id: 'grant-1', reason: 'approved support investigation' }],
    ])

    assert.equal(
      await guard.canActivate(
        makeContext(AuthorizationFixture.prototype.tenantRoute, {
          user: { userId: 'support-user' },
          params: { tenantId: 'tenant-1' },
          method: 'GET',
          route: { path: '/tenants/:tenantId/private' },
        }),
      ),
      true,
    )
    assert.equal(queryCalls.length, 2)
    assert.equal(executeCalls.length, 1)
    assert.match(executeCalls[0].text, /"SupportAccessAuditLog"/)
  })

  it('fails closed when the support-access audit write fails', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ allowed: false }],
        [{ id: 'grant-1', reason: 'approved support investigation' }],
      ],
      failAuditWrites: true,
    })
    const guard = new AuthorizationGuard(new Reflector(), mock.prisma)

    await assert.rejects(
      guard.canActivate(
        makeContext(AuthorizationFixture.prototype.tenantRoute, {
          user: { userId: 'support-user' },
          params: { tenantId: 'tenant-1' },
        }),
      ),
      /audit storage unavailable/,
    )
    assert.equal(mock.executeCalls.length, 1)
  })
})
