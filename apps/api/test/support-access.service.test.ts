import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { SupportAccessService } from '../src/support-access.service'
import { createPrismaMock } from './test-helpers'

function validInput(overrides: Partial<{
  supportUserId: string
  tenantId: string
  reason: string
  expiresAt: Date
  permissionKeys: string[]
}> = {}) {
  return {
    supportUserId: 'support-user',
    tenantId: 'tenant-1',
    reason: 'Investigate reported issue',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    permissionKeys: ['tenant.read'],
    ...overrides,
  }
}

describe('SupportAccessService', () => {
  it('creates a specific support grant after independent approval and operator permission checks', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ allowed: true }],
        [{ allowed: true }],
        [{ id: 'permission-1' }],
      ],
    })
    const service = new SupportAccessService(mock.prisma)
    const input = validInput({
      reason: '  Investigate reported issue  ',
      permissionKeys: ['tenant.read', 'tenant.read'],
    })

    const grantId = await service.createGrant(input, 'approver-user')

    assert.match(grantId, /^[0-9a-f-]{36}$/i)
    assert.equal(mock.transactionCount, 1)
    assert.equal(mock.queryCalls.length, 3)
    assert.ok(mock.queryCalls[0].values.includes('approver-user'))
    assert.ok(mock.queryCalls[0].values.includes('support.approve_access'))
    assert.ok(mock.queryCalls[1].values.includes('support-user'))
    assert.ok(mock.queryCalls[1].values.includes('support.tenant_access'))
    assert.match(mock.queryCalls[2].text, /"supportEligible" = TRUE/)
    assert.ok(mock.queryCalls[2].values.includes('tenant.read'))
    assert.equal(
      mock.executeCalls.filter((call) =>
        call.text.includes('"SupportAccessGrantPermission"'),
      ).length,
      1,
    )
    assert.equal(
      mock.executeCalls.filter((call) =>
        call.text.includes('"SupportAccessAuditLog"'),
      ).length,
      1,
    )
    assert.ok(mock.executeCalls.some((call) =>
      call.values.includes('Investigate reported issue'),
    ))
  })

  it('requires an approver with the platform approval permission', async () => {
    const mock = createPrismaMock({
      queryResults: [[{ allowed: false }]],
    })
    const service = new SupportAccessService(mock.prisma)

    await assert.rejects(
      service.createGrant(validInput(), 'approver-user'),
      ForbiddenException,
    )
    assert.equal(mock.queryCalls.length, 1)
    assert.equal(mock.executeCalls.length, 0)
  })

  it('requires the support operator to have the separate platform access permission', async () => {
    const mock = createPrismaMock({
      queryResults: [[{ allowed: true }], [{ allowed: false }]],
    })
    const service = new SupportAccessService(mock.prisma)

    await assert.rejects(
      service.createGrant(validInput(), 'approver-user'),
      ForbiddenException,
    )
    assert.ok(mock.queryCalls[1].values.includes('support.tenant_access'))
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects self-approval', async () => {
    const mock = createPrismaMock()
    const service = new SupportAccessService(mock.prisma)

    await assert.rejects(
      service.createGrant(
        validInput({ supportUserId: 'same-user' }),
        'same-user',
      ),
      BadRequestException,
    )
    assert.equal(mock.transactionCount, 0)
  })

  it('requires a meaningful, bounded reason', async () => {
    for (const reason of ['short', `x${'x'.repeat(1000)}`]) {
      const mock = createPrismaMock()
      const service = new SupportAccessService(mock.prisma)

      await assert.rejects(
        service.createGrant(validInput({ reason }), 'approver-user'),
        BadRequestException,
      )
      assert.equal(mock.transactionCount, 0)
    }
  })

  it('requires one to five distinct, specific support-eligible permissions', async () => {
    for (const permissionKeys of [
      [],
      ['one', 'two', 'three', 'four', 'five', 'six'],
      [''],
    ]) {
      const mock = createPrismaMock()
      const service = new SupportAccessService(mock.prisma)

      await assert.rejects(
        service.createGrant(
          validInput({ permissionKeys }),
          'approver-user',
        ),
        BadRequestException,
      )
      assert.equal(mock.transactionCount, 0)
    }
  })

  it('rejects permissions that are unknown or not support-eligible', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ allowed: true }],
        [{ allowed: true }],
        [],
      ],
    })
    const service = new SupportAccessService(mock.prisma)

    await assert.rejects(
      service.createGrant(validInput(), 'approver-user'),
      NotFoundException,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('limits a grant duration to at most one hour', async () => {
    const mock = createPrismaMock()
    const service = new SupportAccessService(mock.prisma)

    await assert.rejects(
      service.createGrant(
        validInput({
          expiresAt: new Date(Date.now() + 60 * 60 * 1000 + 5000),
        }),
        'approver-user',
      ),
      BadRequestException,
    )
    assert.equal(mock.transactionCount, 0)
  })

  it('rejects already-expired and invalid grant dates', async () => {
    for (const expiresAt of [
      new Date(Date.now() - 1000),
      new Date(Number.NaN),
    ]) {
      const mock = createPrismaMock()
      const service = new SupportAccessService(mock.prisma)

      await assert.rejects(
        service.createGrant(validInput({ expiresAt }), 'approver-user'),
        BadRequestException,
      )
    }
  })

  it('fails closed when grant-creation audit recording fails', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ allowed: true }],
        [{ allowed: true }],
        [{ id: 'permission-1' }],
      ],
      failAuditWrites: true,
    })
    const service = new SupportAccessService(mock.prisma)

    await assert.rejects(
      service.createGrant(validInput(), 'approver-user'),
      /audit storage unavailable/,
    )
    assert.equal(mock.transactionCount, 1)
    assert.ok(mock.executeCalls.some((call) =>
      call.text.includes('"SupportAccessAuditLog"'),
    ))
  })

  it('fails closed when revocation audit recording fails', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [{ allowed: true }],
        [{ tenantId: 'tenant-1' }],
      ],
      failAuditWrites: true,
    })
    const service = new SupportAccessService(mock.prisma)

    await assert.rejects(
      service.revokeGrant(
        'grant-1',
        'approver-user',
        '  Revoke after investigation  ',
      ),
      /audit storage unavailable/,
    )
    assert.equal(mock.transactionCount, 1)
    assert.ok(mock.executeCalls.some((call) =>
      call.text.includes('"SupportAccessAuditLog"'),
    ))
  })

  it('does not revoke a grant that is already missing or revoked', async () => {
    const mock = createPrismaMock({
      queryResults: [[{ allowed: true }], []],
    })
    const service = new SupportAccessService(mock.prisma)

    await assert.rejects(
      service.revokeGrant(
        'grant-1',
        'approver-user',
        'Grant no longer needed',
      ),
      NotFoundException,
    )
    assert.equal(mock.executeCalls.length, 0)
  })
})
