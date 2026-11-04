import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import { InvitationService } from '../src/invitation.service'
import { createPrismaMock } from './test-helpers'

const ROLE_POLICY = [{
  id: 'tenant-role-1',
  name: 'Approved tenant role',
  isInviteAssignable: true,
  permissionKey: 'tenant.read',
}]
const ROLE_PERMISSIONS_HASH = createHash('sha256')
  .update(JSON.stringify(['tenant.read']))
  .digest('hex')
const INVITATION = {
  id: 'invitation-1',
  email: 'new.user@example.com',
  emailNormalized: 'new.user@example.com',
  tenantId: 'tenant-1',
  roleId: 'tenant-role-1',
  rolePermissionsHash: ROLE_PERMISSIONS_HASH,
}

describe('InvitationService', () => {
  it('creates a tenant-scoped invitation and stores only its SHA-256 hash', async () => {
    const mock = createPrismaMock({
      queryResults: [[], [{ allowed: true }], ROLE_POLICY],
    })
    const service = new InvitationService(mock.prisma)

    const invitation = await service.createTenantInvitation('owner-1', {
      email: ' New.User@Example.com ',
      tenantId: 'tenant-1',
      roleId: 'tenant-role-1',
    })

    assert.equal(invitation.token.length, 43)
    assert.ok(invitation.expiresAt.getTime() > Date.now())
    assert.equal(mock.transactionCount, 1)
    assert.equal(mock.transactionOptions[0]?.isolationLevel, 'Serializable')
    assert.match(mock.executeCalls[0].text, /INSERT INTO "TenantInvitation"/)
    assert.ok(mock.executeCalls[0].values.includes(ROLE_PERMISSIONS_HASH))
    assert.ok(
      mock.executeCalls[0].values.includes(
        createHash('sha256').update(invitation.token).digest('hex'),
      ),
    )
    assert.ok(
      mock.executeCalls[0].values.includes('new.user@example.com'),
    )
    assert.ok(
      mock.executeCalls[0].values.every(
        (value) => value !== invitation.token,
      ),
    )
    assert.match(mock.executeCalls[1].text, /INSERT INTO "PlatformAuditLog"/)
    assert.ok(
      mock.executeCalls[1].values.every(
        (value) => value !== invitation.token,
      ),
    )
  })

  it('does not allow a non-owner to create an invitation', async () => {
    const mock = createPrismaMock({ queryResults: [[{ allowed: false }]] })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.createTenantInvitation('admin-1', {
        email: 'invitee@example.com',
        tenantId: 'tenant-1',
        roleId: 'tenant-role-1',
      }),
      ForbiddenException,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects invalid email input before opening a transaction', async () => {
    const mock = createPrismaMock()
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.createTenantInvitation('owner-1', {
        email: 'not-an-email',
        tenantId: 'tenant-1',
        roleId: 'tenant-role-1',
      }),
      /A valid email address is required/,
    )
    assert.equal(mock.transactionCount, 0)
  })

  it('fails invitation creation if the audit record cannot be written', async () => {
    const mock = createPrismaMock({
      queryResults: [[], [{ allowed: true }], ROLE_POLICY],
      failAuditWrites: true,
    })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.createTenantInvitation('owner-1', {
        email: 'invitee@example.com',
        tenantId: 'tenant-1',
        roleId: 'tenant-role-1',
      }),
      /audit storage unavailable/,
    )
    assert.equal(mock.transactionCount, 1)
    assert.equal(mock.transactionOptions[0]?.isolationLevel, 'Serializable')
    assert.match(mock.executeCalls[0].text, /INSERT INTO "TenantInvitation"/)
    assert.match(mock.executeCalls[1].text, /INSERT INTO "PlatformAuditLog"/)
  })

  it('rejects a role that is not part of the selected tenant', async () => {
    const mock = createPrismaMock({
      queryResults: [[], [{ allowed: true }], []],
    })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.createTenantInvitation('owner-1', {
        email: 'invitee@example.com',
        tenantId: 'tenant-1',
        roleId: 'other-tenant-role',
      }),
      /Tenant role not found/,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects tenant roles unless they are explicitly approved for invitations', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [],
        [{ allowed: true }],
        [{ ...ROLE_POLICY[0], isInviteAssignable: false }],
      ],
    })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.createTenantInvitation('owner-1', {
        email: 'invitee@example.com',
        tenantId: 'tenant-1',
        roleId: 'tenant-role-1',
      }),
      /Tenant role is not approved for invitations/,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects platform-role names even if a tenant role is marked invite-assignable', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [],
        [{ allowed: true }],
        [{ ...ROLE_POLICY[0], name: 'PLATFORM_ADMIN' }],
      ],
    })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.createTenantInvitation('owner-1', {
        email: 'invitee@example.com',
        tenantId: 'tenant-1',
        roleId: 'tenant-role-1',
      }),
      /Tenant role is not approved for invitations/,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects replayed, expired, or revoked invitation tokens uniformly', async () => {
    const mock = createPrismaMock({ queryResults: [[], [], []] })
    const service = new InvitationService(mock.prisma)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        service.acceptInvitation('A'.repeat(43), 'correct horse battery staple'),
        (error: unknown) =>
          error instanceof BadRequestException &&
          error.message === 'Invitation is invalid or no longer available',
      )
    }
    assert.equal(mock.transactionCount, 0)
    for (const query of mock.queryCalls) {
      assert.match(query.text, /"acceptedAt" IS NULL/)
      assert.match(query.text, /"revokedAt" IS NULL/)
      assert.match(query.text, /"expiresAt" > CURRENT_TIMESTAMP/)
    }
  })

  it('rejects an invitation revoked or expired after initial lookup without creating an account', async () => {
    const mock = createPrismaMock({
      queryResults: [[{ id: INVITATION.id }], []],
    })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.acceptInvitation('F'.repeat(43), 'correct horse battery staple'),
      (error: unknown) =>
        error instanceof BadRequestException &&
        error.message === 'Invitation is invalid or no longer available',
    )
    assert.equal(mock.transactionCount, 1)
    assert.equal(mock.queryCalls.length, 2)
    assert.match(mock.queryCalls[1].text, /"acceptedAt" IS NULL/)
    assert.match(mock.queryCalls[1].text, /"revokedAt" IS NULL/)
    assert.match(mock.queryCalls[1].text, /"expiresAt" > CURRENT_TIMESTAMP/)
    assert.equal(mock.executeCalls.length, 0)
  })

  it('consumes the stored invitation data and creates the user and membership atomically', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ id: INVITATION.id }],
        [INVITATION],
        [],
        ROLE_POLICY,
        [{ id: 'new-user-id' }],
      ],
    })
    const service = new InvitationService(mock.prisma)
    const token = 'B'.repeat(43)

    assert.deepEqual(
      await service.acceptInvitation(token, 'correct horse battery staple'),
      { accepted: true },
    )

    assert.equal(mock.transactionCount, 1)
    assert.match(mock.queryCalls[1].text, /UPDATE "TenantInvitation"/)
    assert.match(mock.queryCalls[1].text, /"acceptedAt" IS NULL/)
    assert.match(mock.queryCalls[1].text, /"revokedAt" IS NULL/)
    assert.match(mock.queryCalls[1].text, /"expiresAt" > CURRENT_TIMESTAMP/)
    assert.match(mock.queryCalls[4].text, /INSERT INTO "User"/)
    assert.match(mock.queryCalls[4].text, /ON CONFLICT \("emailNormalized"\) DO NOTHING/)
    assert.ok(mock.queryCalls[4].values.includes(INVITATION.email))
    assert.ok(mock.queryCalls[4].values.includes(INVITATION.emailNormalized))
    assert.ok(mock.executeCalls[0].text.includes('"TenantMembership"'))
    assert.ok(mock.executeCalls[1].text.includes('"MembershipRole"'))
    assert.match(mock.executeCalls[2].text, /INSERT INTO "PlatformAuditLog"/)
    assert.ok(
      [...mock.queryCalls, ...mock.executeCalls].every(
        (call) => !call.text.includes('"UserPlatformRole"'),
      ),
    )
    assert.ok(
      mock.queryCalls.every((call) => !call.values.includes(token)),
    )
  })

  it('grants the selected branch when the invitation is accepted', async () => {
    const invitation = { ...INVITATION, branchId: 'branch-1' }
    const mock = createPrismaMock({
      queryResults: [
        [{ id: invitation.id }],
        [invitation],
        [],
        ROLE_POLICY,
        [{ id: 'new-user-id' }],
      ],
    })
    const service = new InvitationService(mock.prisma)

    await service.acceptInvitation('C'.repeat(43), 'correct horse battery staple')

    const branchMembership = mock.executeCalls.find((call) =>
      call.text.includes('INSERT INTO "BranchMembership"'),
    )
    assert.ok(branchMembership)
    assert.ok(branchMembership.values.includes('branch-1'))
  })

  it('does not create a second account when the normalized email already exists', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ id: INVITATION.id }],
        [INVITATION],
        [],
        ROLE_POLICY,
        [],
      ],
    })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.acceptInvitation('C'.repeat(43), 'correct horse battery staple'),
      (error: unknown) =>
        error instanceof BadRequestException &&
        error.message === 'Invitation is invalid or no longer available',
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects acceptance if the role permission set changed after issuance', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ id: INVITATION.id }],
        [INVITATION],
        [],
        [{ ...ROLE_POLICY[0], permissionKey: 'tenant.manage_users' }],
      ],
    })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.acceptInvitation('G'.repeat(43), 'correct horse battery staple'),
      (error: unknown) =>
        error instanceof BadRequestException &&
        error.message === 'Invitation is invalid or no longer available',
    )
    assert.equal(mock.transactionCount, 1)
    assert.equal(mock.queryCalls.length, 4)
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects acceptance if the role is no longer approved', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ id: INVITATION.id }],
        [INVITATION],
        [],
        [{ ...ROLE_POLICY[0], isInviteAssignable: false }],
      ],
    })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.acceptInvitation('H'.repeat(43), 'correct horse battery staple'),
      (error: unknown) =>
        error instanceof BadRequestException &&
        error.message === 'Invitation is invalid or no longer available',
    )
    assert.equal(mock.queryCalls.length, 4)
    assert.equal(mock.executeCalls.length, 0)
  })

  it('fails acceptance if the audit record cannot be written', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ id: INVITATION.id }],
        [INVITATION],
        [],
        ROLE_POLICY,
        [{ id: 'new-user-id' }],
      ],
      failAuditWrites: true,
    })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.acceptInvitation('E'.repeat(43), 'correct horse battery staple'),
      /audit storage unavailable/,
    )
    assert.equal(mock.transactionCount, 1)
    assert.equal(mock.executeCalls.length, 3)
    assert.match(mock.executeCalls[2].text, /INSERT INTO "PlatformAuditLog"/)
  })

  it('revokes an outstanding invitation and audits the result transactionally', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [],
        [{ allowed: true }],
        [{ tenantId: 'tenant-1', roleId: 'tenant-role-1' }],
      ],
    })
    const service = new InvitationService(mock.prisma)

    await service.revokeTenantInvitation('owner-1', 'invitation-1')

    assert.equal(mock.transactionCount, 1)
    assert.match(mock.queryCalls[2].text, /UPDATE "TenantInvitation"/)
    assert.match(mock.executeCalls[0].text, /INSERT INTO "PlatformAuditLog"/)
    assert.ok(
      mock.executeCalls[0].values.includes('TENANT_INVITATION_REVOKED'),
    )
  })

  it('allows only one concurrent acceptance to consume a token', async () => {
    let consumeAttempts = 0
    const mock = createPrismaMock({
      queryResponder(call) {
        if (
          call.text.includes('FROM "TenantInvitation"') &&
          !call.text.includes('UPDATE "TenantInvitation"')
        ) {
          return [{ id: INVITATION.id }]
        }
        if (call.text.includes('UPDATE "TenantInvitation"')) {
          consumeAttempts += 1
          return consumeAttempts === 1 ? [INVITATION] : []
        }
        if (call.text.includes('INSERT INTO "User"')) {
          return [{ id: 'one-winner' }]
        }
        if (call.text.includes('FROM "Role" r')) {
          return ROLE_POLICY
        }
        if (call.text.includes('hashtext(')) {
          return []
        }
        return undefined
      },
    })
    const service = new InvitationService(mock.prisma)

    const results = await Promise.allSettled([
      service.acceptInvitation('D'.repeat(43), 'correct horse battery staple'),
      service.acceptInvitation('D'.repeat(43), 'correct horse battery staple'),
    ])

    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1)
    assert.equal(consumeAttempts, 2)
  })

  it('enforces a shared-database acceptance rate limit and hashes the peer address', async () => {
    let rateAttempts = 0
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('"InvitationAcceptanceRateLimit"')) {
          rateAttempts += 1
          return [{ allowed: rateAttempts <= 10 }]
        }
        return undefined
      },
    })
    const service = new InvitationService(mock.prisma)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await service.consumeAcceptanceRateLimit('192.0.2.10')
    }
    await assert.rejects(
      service.consumeAcceptanceRateLimit('192.0.2.10'),
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === HttpStatus.TOO_MANY_REQUESTS,
    )

    assert.equal(rateAttempts, 11)
    assert.match(mock.queryCalls[0].text, /ON CONFLICT \("keyHash"\) DO UPDATE/)
    assert.match(mock.queryCalls[0].text, /"requestCount" <= \? AS allowed/)
    assert.notEqual(mock.queryCalls[0].values[0], '192.0.2.10')
    assert.equal(mock.executeCalls.length, 11)
    assert.match(mock.executeCalls[0].text, /updatedAt.*INTERVAL '1 day'/s)
  })

  it('fails closed when shared rate-limit storage is unavailable', async () => {
    const mock = createPrismaMock({ failRateLimitWrites: true })
    const service = new InvitationService(mock.prisma)

    await assert.rejects(
      service.consumeAcceptanceRateLimit('192.0.2.10'),
      /rate limit storage unavailable/,
    )
  })
})
