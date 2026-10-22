import 'reflect-metadata'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { UnauthorizedException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { JwtModuleOptions } from '@nestjs/jwt'
import { UserStatus } from '@prisma/client'
import { AuthController } from '../../src/auth/auth.controller'
import { AuthenticationGuard } from '../../src/auth/authentication.guard'
import { AuthorizationGuard } from '../../src/authorization.guard'
import { GLOBAL_AUTH_GUARD_PROVIDERS } from '../../src/global-auth-guards'
import { HealthController } from '../../src/health.controller'
import {
  IS_PUBLIC_ROUTE,
  Public,
} from '../../src/authz.decorator'
import { createPrismaMock } from '../test-helpers'

class GuardFixture {
  @Public()
  publicRoute() {}

  protectedRoute() {}
}

interface RequestShape {
  headers: {
    authorization?: string | string[]
    'x-user-id'?: string
  }
  body?: { userId?: unknown }
  query?: { userId?: unknown }
  user?: { userId?: unknown }
}

function makeContext(
  handler: object,
  request: RequestShape,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => GuardFixture,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext
}

function makeGuard(
  verify: (token: string) => Promise<{ sub?: unknown }>,
  users: unknown[] = [{ status: UserStatus.ACTIVE }],
) {
  const mock = createPrismaMock({ userResults: users })
  const jwt = {
    verifyAsync: verify,
  } as unknown as JwtService
  return {
    guard: new AuthenticationGuard(new Reflector(), jwt, mock.prisma),
    mock,
  }
}

describe('AuthenticationGuard', () => {
  it('keeps public health and login routes public', async () => {
    const publicMetadata = Reflect.getMetadata(
      IS_PUBLIC_ROUTE,
      HealthController,
    )
    const loginMetadata = Reflect.getMetadata(
      IS_PUBLIC_ROUTE,
      AuthController.prototype.login,
    )
    assert.equal(publicMetadata, true)
    assert.equal(loginMetadata, true)

    const { guard, mock } = makeGuard(async () => {
      throw new Error('public route must not verify a token')
    })
    assert.equal(
      await guard.canActivate(
        makeContext(GuardFixture.prototype.publicRoute, {
          headers: {},
          user: { userId: 'untrusted-user' },
        }),
      ),
      true,
    )
    assert.equal(mock.userFindUniqueCalls.length, 0)
  })

  it('rejects absent, malformed, and duplicate authorization credentials', async () => {
    const requests: RequestShape[] = [
      { headers: {} },
      { headers: { authorization: 'Basic abc' } },
      { headers: { authorization: ['Bearer first', 'Bearer second'] } },
    ]

    for (const request of requests) {
      const { guard, mock } = makeGuard(async () => ({ sub: 'user-1' }))
      await assert.rejects(
        guard.canActivate(
          makeContext(GuardFixture.prototype.protectedRoute, request),
        ),
        UnauthorizedException,
      )
      assert.equal(mock.userFindUniqueCalls.length, 0)
    }
  })

  it('rejects malformed and expired tokens without accepting a forged request user', async () => {
    const failures = [
      new Error('jwt malformed'),
      Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' }),
    ]

    for (const failure of failures) {
      const request: RequestShape = {
        headers: { authorization: 'Bearer invalid-token' },
        user: { userId: 'forged-user' },
      }
      const { guard, mock } = makeGuard(async () => {
        throw failure
      })

      await assert.rejects(
        guard.canActivate(
          makeContext(GuardFixture.prototype.protectedRoute, request),
        ),
        UnauthorizedException,
      )
      assert.equal(request.user?.userId, 'forged-user')
      assert.equal(mock.userFindUniqueCalls.length, 0)
    }
  })

  it('rejects validly signed tokens with a missing or empty subject', async () => {
    for (const payload of [{}, { sub: '' }]) {
      const { guard, mock } = makeGuard(async () => payload)
      await assert.rejects(
        guard.canActivate(
          makeContext(GuardFixture.prototype.protectedRoute, {
            headers: { authorization: 'Bearer signed-token' },
          }),
        ),
        UnauthorizedException,
      )
      assert.equal(mock.userFindUniqueCalls.length, 0)
    }
  })

  it('sets request.user only from the verified subject, replacing any forged user id', async () => {
    const request: RequestShape = {
      headers: {
        authorization: 'Bearer valid-token',
        'x-user-id': 'forged-header-user',
      },
      body: { userId: 'forged-body-user' },
      query: { userId: 'forged-query-user' },
      user: { userId: 'forged-user' },
    }
    let verifiedToken = ''
    const { guard, mock } = makeGuard(async (token) => {
      verifiedToken = token
      return { sub: 'verified-user' }
    })

    assert.equal(
      await guard.canActivate(
        makeContext(GuardFixture.prototype.protectedRoute, request),
      ),
      true,
    )
    assert.equal(verifiedToken, 'valid-token')
    assert.equal(request.user?.userId, 'verified-user')
    assert.deepEqual(
      mock.userFindUniqueCalls[0],
      {
        where: { id: 'verified-user' },
        select: { status: true },
      },
    )
  })

  it('verifies real signed JWT claims and rejects expired or wrong-audience tokens', async () => {
    const secret = 'unit-test-only-signing-secret-with-more-than-32-bytes'
    const expectedOptions: JwtModuleOptions = {
      secret,
      signOptions: {
        algorithm: 'HS256',
        issuer: 'metrivo-api-test',
        audience: 'metrivo-web-test',
        expiresIn: 600,
      },
      verifyOptions: {
        algorithms: ['HS256'],
        issuer: 'metrivo-api-test',
        audience: 'metrivo-web-test',
      },
    }
    const jwt = new JwtService(expectedOptions)
    const mock = createPrismaMock({
      userResults: [{ status: UserStatus.ACTIVE }],
    })
    const guard = new AuthenticationGuard(
      new Reflector(),
      jwt,
      mock.prisma,
    )
    const token = await jwt.signAsync({ sub: 'verified-user' })
    const request: RequestShape = {
      headers: { authorization: `Bearer ${token}` },
    }

    assert.equal(
      await guard.canActivate(
        makeContext(GuardFixture.prototype.protectedRoute, request),
      ),
      true,
    )
    assert.equal(request.user?.userId, 'verified-user')

    const expiredToken = await jwt.signAsync(
      { sub: 'verified-user' },
      { expiresIn: -1 },
    )
    const { guard: expiredGuard } = makeGuard(
      (candidate) => jwt.verifyAsync(candidate),
    )
    await assert.rejects(
      expiredGuard.canActivate(
        makeContext(GuardFixture.prototype.protectedRoute, {
          headers: { authorization: `Bearer ${expiredToken}` },
        }),
      ),
      UnauthorizedException,
    )

    const otherAudienceJwt = new JwtService({
      ...expectedOptions,
      signOptions: {
        ...expectedOptions.signOptions,
        audience: 'another-client',
      },
    })
    const wrongAudienceToken = await otherAudienceJwt.signAsync({
      sub: 'verified-user',
    })
    const { guard: wrongAudienceGuard } = makeGuard(
      (candidate) => jwt.verifyAsync(candidate),
    )
    await assert.rejects(
      wrongAudienceGuard.canActivate(
        makeContext(GuardFixture.prototype.protectedRoute, {
          headers: { authorization: `Bearer ${wrongAudienceToken}` },
        }),
      ),
      UnauthorizedException,
    )

    const [tokenHeader, tokenPayload] = token.split('.')
    const tamperedToken = `${tokenHeader}.${tokenPayload}.invalidsignature`
    const { guard: tamperedGuard } = makeGuard(
      (candidate) => jwt.verifyAsync(candidate),
    )
    await assert.rejects(
      tamperedGuard.canActivate(
        makeContext(GuardFixture.prototype.protectedRoute, {
          headers: { authorization: `Bearer ${tamperedToken}` },
        }),
      ),
      UnauthorizedException,
    )
  })

  it('rejects access tokens when the database account is missing or disabled', async () => {
    for (const user of [null, { status: UserStatus.DISABLED }]) {
      const { guard, mock } = makeGuard(
        async () => ({ sub: 'verified-user' }),
        [user],
      )
      const request: RequestShape = {
        headers: { authorization: 'Bearer valid-token' },
        user: { userId: 'forged-user' },
      }

      await assert.rejects(
        guard.canActivate(
          makeContext(GuardFixture.prototype.protectedRoute, request),
        ),
        UnauthorizedException,
      )
      assert.equal(request.user?.userId, 'forged-user')
      assert.equal(mock.userFindUniqueCalls.length, 1)
    }
  })

  it('registers authentication before authorization as global guards', () => {
    assert.equal(GLOBAL_AUTH_GUARD_PROVIDERS[0].provide, APP_GUARD)
    assert.equal(GLOBAL_AUTH_GUARD_PROVIDERS[1].provide, APP_GUARD)
    assert.deepEqual(
      GLOBAL_AUTH_GUARD_PROVIDERS.map(
        (provider) => provider.useExisting ?? provider.useClass,
      ),
      [AuthenticationGuard, AuthorizationGuard],
    )
  })
})
