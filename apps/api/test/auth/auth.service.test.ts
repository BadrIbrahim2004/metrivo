import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { UserStatus } from '@prisma/client'
import { argon2id, hash, verify } from 'argon2'
import type { HashOptions } from 'argon2'
import type { LoginDto } from '../../src/auth/login.dto'
import { AuthService } from '../../src/auth/auth.service'
import { createPrismaMock } from '../test-helpers'

const TEST_PASSWORD = 'correct horse battery staple'
const ARGON_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
}

function credentials(email = 'user@example.com', password = TEST_PASSWORD): LoginDto {
  return { email, password }
}

async function makeService(userResults: unknown[]) {
  const mock = createPrismaMock({ userResults })
  const signedPayloads: Array<{ sub: string }> = []
  const jwt = {
    async signAsync(payload: { sub: string }) {
      signedPayloads.push(payload)
      return 'signed-access-token'
    },
  } as unknown as JwtService

  const service = new AuthService(mock.prisma, jwt)
  await service.onModuleInit()

  return {
    service,
    mock,
    signedPayloads,
  }
}

describe('AuthService', () => {
  it('returns only the authenticated user tenant branches explicitly in scope', async () => {
    const mock = createPrismaMock({
      queryResults: [[{
        tenantId: 'tenant-1',
        tenantName: 'Store One',
        branchId: 'branch-1',
        branchName: 'Main branch',
      }]],
    })
    const jwt = { async signAsync() { return 'token' } } as unknown as JwtService
    const service = new AuthService(mock.prisma, jwt)

    assert.deepEqual(await service.getWorkspaceBranches('user-1'), [{
      tenantId: 'tenant-1',
      tenantName: 'Store One',
      branchId: 'branch-1',
      branchName: 'Main branch',
    }])
    assert.match(mock.queryCalls[0].text, /tm\."userId" = \?/)
    assert.match(mock.queryCalls[0].text, /"BranchMembership"/)
    assert.match(mock.queryCalls[0].text, /tm\."branchAccessMode" = 'ALL_BRANCHES'/)
    assert.deepEqual(mock.queryCalls[0].values, ['user-1'])
  })

  it('returns effective tenant permissions and registered platform owner status', async () => {
    const mock = createPrismaMock({
      userResults: [{
        name: 'Metrivo User',
        status: UserStatus.ACTIVE,
      }],
      queryResults: [
        [{ permissionKey: 'sales.create' }, { permissionKey: 'reports.read' }],
        [{ isPlatformOwner: true }],
      ],
    })
    const jwt = { async signAsync() { return 'token' } } as unknown as JwtService
    const service = new AuthService(mock.prisma, jwt)

    assert.deepEqual(await service.getUserPermissions('user-1', 'tenant-1'), {
      permissions: ['sales.create', 'reports.read'],
      isPlatformOwner: true,
      userName: 'Metrivo User',
    })
    assert.match(mock.queryCalls[0].text, /"TenantMembership"/)
    assert.match(mock.queryCalls[0].text, /tm\."tenantId" = \?/)
    assert.deepEqual(mock.queryCalls[0].values, ['user-1', 'tenant-1'])
    assert.deepEqual(mock.queryCalls[1].values, ['user-1'])
  })

  it('returns inviteable roles only from the requested active tenant', async () => {
    const mock = createPrismaMock({
      queryResults: [[{ id: 'role-1', name: 'Cashier' }]],
    })
    const service = new AuthService(
      mock.prisma,
      {} as JwtService,
    )

    assert.deepEqual(
      await service.getTenantRoles('user-1', 'tenant-1'),
      [{ id: 'role-1', name: 'Cashier' }],
    )
    assert.match(mock.queryCalls[0].text, /r\."isInviteAssignable" = TRUE/)
    assert.match(mock.queryCalls[0].text, /r\.name <> 'Owner'/)
    assert.deepEqual(mock.queryCalls[0].values, ['tenant-1', 'user-1', 'tenant-1'])
  })

  it('changes the authenticated user password after verifying the current password', async () => {
    const currentHash = await hash(TEST_PASSWORD, ARGON_OPTIONS)
    const mock = createPrismaMock({
      userResults: [{
        passwordHash: currentHash,
        status: UserStatus.ACTIVE,
      }],
      queryResults: [[{ id: 'user-1' }]],
    })
    const service = new AuthService(mock.prisma, {} as JwtService)

    assert.deepEqual(
      await service.changeOwnPassword('user-1', {
        currentPassword: TEST_PASSWORD,
        newPassword: 'a different safe password',
      }),
      { changed: true },
    )
    assert.match(mock.queryCalls[0].text, /UPDATE "User"/)
    assert.equal(
      await verify(
        String(mock.queryCalls[0].values[0]),
        'a different safe password',
      ),
      true,
    )
  })

  it('does not change a password when the current password is incorrect', async () => {
    const currentHash = await hash(TEST_PASSWORD, ARGON_OPTIONS)
    const mock = createPrismaMock({
      userResults: [{
        passwordHash: currentHash,
        status: UserStatus.ACTIVE,
      }],
    })
    const service = new AuthService(mock.prisma, {} as JwtService)

    await assert.rejects(
      service.changeOwnPassword('user-1', {
        currentPassword: 'incorrect password',
        newPassword: 'a different safe password',
      }),
      /Current password is incorrect/,
    )
    assert.equal(mock.queryCalls.length, 0)
  })

  it('normalizes the email lookup and returns a 12-hour token with safe user fields', async () => {
    const passwordHash = await hash(TEST_PASSWORD, ARGON_OPTIONS)
    const user = {
      id: 'user-1',
      email: 'user@example.com',
      name: 'Metrivo User',
      passwordHash,
      status: UserStatus.ACTIVE,
    }
    const { service, mock, signedPayloads } = await makeService([user])

    const result = await service.login(
      credentials('  User@Example.COM  '),
    )

    assert.equal(
      (
        mock.userFindUniqueCalls[0] as {
          where: { emailNormalized: string }
        }
      ).where.emailNormalized,
      'user@example.com',
    )
    assert.deepEqual(signedPayloads, [{ sub: 'user-1' }])
    assert.deepEqual(result, {
      accessToken: 'signed-access-token',
      tokenType: 'Bearer',
      expiresIn: 43_200,
      user: {
        id: 'user-1',
        email: 'user@example.com',
        name: 'Metrivo User',
      },
    })
    assert.equal('passwordHash' in result.user, false)
  })

  it('returns the same generic response for unknown accounts and incorrect passwords', async () => {
    const passwordHash = await hash(TEST_PASSWORD, ARGON_OPTIONS)
    const unknown = await makeService([null])
    const incorrectPassword = await makeService([
      {
        id: 'user-1',
        email: 'user@example.com',
        name: null,
        passwordHash,
        status: UserStatus.ACTIVE,
      },
    ])

    await assert.rejects(
      unknown.service.login(credentials()),
      (error: unknown) =>
        error instanceof UnauthorizedException &&
        error.message === 'Invalid email or password',
    )
    await assert.rejects(
      incorrectPassword.service.login(
        credentials('user@example.com', 'incorrect password'),
      ),
      (error: unknown) =>
        error instanceof UnauthorizedException &&
        error.message === 'Invalid email or password',
    )
    assert.deepEqual(unknown.signedPayloads, [])
    assert.deepEqual(incorrectPassword.signedPayloads, [])
  })

  it('returns the generic invalid-credentials response for disabled or uninitialized accounts', async () => {
    for (const user of [
      {
        id: 'disabled-user',
        email: 'user@example.com',
        name: null,
        passwordHash: await hash(TEST_PASSWORD, ARGON_OPTIONS),
        status: UserStatus.DISABLED,
      },
      {
        id: 'invited-user',
        email: 'user@example.com',
        name: null,
        passwordHash: null,
        status: UserStatus.ACTIVE,
      },
      {
        id: 'uninitialized-user',
        email: 'user@example.com',
        name: null,
        passwordHash: '',
        status: UserStatus.ACTIVE,
      },
    ]) {
      const { service, signedPayloads } = await makeService([user])

      await assert.rejects(
        service.login(credentials()),
        (error: unknown) =>
          error instanceof UnauthorizedException &&
          error.message === 'Invalid email or password',
      )
      assert.deepEqual(signedPayloads, [])
    }
  })
})
