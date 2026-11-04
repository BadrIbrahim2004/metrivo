import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { TenantOnboardingService } from '../src/tenant-onboarding.service'
import { createPrismaMock } from './test-helpers'

function baseInput() {
  return {
    tenantName: 'Cairo Market',
    branchName: 'Main Branch',
    ownerEmail: 'Owner@Example.COM',
  }
}

describe('TenantOnboardingService', () => {
  it('rejects invalid input before any database work', async () => {
    const mock = createPrismaMock()
    const service = new TenantOnboardingService(mock.prisma)
    await assert.rejects(
      service.createTenant('owner-1', { ...baseInput(), tenantName: '   ' }),
      BadRequestException,
    )
    await assert.rejects(
      service.createTenant('owner-1', { ...baseInput(), branchName: '' }),
      BadRequestException,
    )
    await assert.rejects(
      service.createTenant('owner-1', { ...baseInput(), ownerEmail: 'not-an-email' }),
      BadRequestException,
    )
    await assert.rejects(
      service.createTenant('owner-1', { ...baseInput(), trialDays: 91 }),
      BadRequestException,
    )
    await assert.rejects(
      service.createTenant('owner-1', { ...baseInput(), trialDays: -1 }),
      BadRequestException,
    )
    assert.equal(mock.transactionCount, 0)
    assert.equal(mock.queryCalls.length, 0)
  })

  it('rejects a duplicate tenant name inside the transaction', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "PlatformOwnerRegistry"')) return [{ allowed: true }]
        if (call.text.includes('FROM "Tenant"') && call.text.includes('WHERE name')) {
          return [{ id: 'existing-tenant' }]
        }
        return []
      },
    })
    const service = new TenantOnboardingService(mock.prisma)
    await assert.rejects(
      service.createTenant('owner-1', baseInput()),
      ConflictException,
    )
  })

  it('refuses to onboard over an existing account email (invitation would be unusable)', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "PlatformOwnerRegistry"')) return [{ allowed: true }]
        if (call.text.includes('FROM "Tenant"')) return []
        if (call.text.includes('FROM "User"')) return [{ id: 'existing-user' }]
        return []
      },
    })
    const service = new TenantOnboardingService(mock.prisma)
    await assert.rejects(
      service.createTenant('owner-1', baseInput()),
      ConflictException,
    )
  })

  it('creates tenant, branch, owner role, permissions, invitation, and a trial in one transaction', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "PlatformOwnerRegistry"')) return [{ allowed: true }]
        if (call.text.includes('FROM "Tenant"')) return []
        if (call.text.includes('FROM "User"')) return []
        if (call.text.includes('FROM "TenantRolePermission"')) {
          return [{ key: 'cash.read' }, { key: 'sales.create' }]
        }
        return []
      },
    })
    const service = new TenantOnboardingService(mock.prisma)
    const result = await service.createTenant('owner-1', {
      ...baseInput(),
      trialDays: 14,
    })
    // Writes executed: tenant, branch, role, role-permissions (mass insert),
    // invitation, plan, subscription, and audit log.
    const insertedTables = [...new Set(
      mock.executeCalls
        .map((call) => call.text.match(/INSERT INTO "(\w+)"/)?.[1] ?? 'unknown'),
    )]
    // Writes executed: tenant, branch, role, role-permissions (mass insert),
    // invitation, plan, subscription, and the platform audit log. The
    // 'unknown' entry is the mass-insert whose table name follows a column
    // list the regex does not capture.
    for (const table of ['Tenant', 'Branch', 'Role', 'TenantRolePermission',
      'TenantInvitation', 'SubscriptionPlan', 'TenantSubscription',
      'PlatformAuditLog']) {
      assert.ok(insertedTables.includes(table), `missing insert: ${table}`)
    }
    assert.equal(
      insertedTables.filter((table) => table !== 'unknown').length,
      8,
    )
    assert.ok(mock.executeCalls.length >= 8)
    // No membership is pre-created; the invitation acceptance flow creates it.
    assert.equal(insertedTables.includes('TenantMembership'), false)
    assert.equal(result.subscriptionStatus, 'TRIAL')
    assert.equal(result.trialDays, 14)
    // The invitation token is only returned once, never stored raw.
    assert.match(result.invitationToken, /^[A-Za-z0-9_-]{43}$/)
    // The audit log records the onboarding action (the action name is a bound
    // parameter, so assert on the PlatformAuditLog insert instead).
    const audit = mock.executeCalls.find((call) =>
      call.text.includes('INSERT INTO "PlatformAuditLog"'),
    )
    assert.ok(audit)
  })

  it('skips the subscription when trialDays is 0 and returns NONE', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "PlatformOwnerRegistry"')) return [{ allowed: true }]
        if (call.text.includes('FROM "Tenant"')) return []
        if (call.text.includes('FROM "User"')) return []
        if (call.text.includes('FROM "TenantRolePermission"')) return []
        return []
      },
      executeResponder() {
        return 1
      },
    })
    const service = new TenantOnboardingService(mock.prisma)
    const result = await service.createTenant('owner-1', {
      ...baseInput(),
      trialDays: 0,
    })
    assert.equal(result.subscriptionStatus, 'NONE')
    assert.equal(result.trialDays, null)
    const planInsert = mock.executeCalls.find((call) =>
      call.text.includes('INSERT INTO "SubscriptionPlan"'),
    )
    const subscriptionInsert = mock.executeCalls.find((call) =>
      call.text.includes('INSERT INTO "TenantSubscription"'),
    )
    assert.equal(planInsert, undefined)
    assert.equal(subscriptionInsert, undefined)
  })

  it('normalizes the owner email in the invitation and the returned payload', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "PlatformOwnerRegistry"')) return [{ allowed: true }]
        if (call.text.includes('FROM "Tenant"')) return []
        if (call.text.includes('FROM "User"')) return []
        if (call.text.includes('FROM "TenantRolePermission"')) return []
        return []
      },
      executeResponder() {
        return 1
      },
    })
    const service = new TenantOnboardingService(mock.prisma)
    const result = await service.createTenant('owner-1', baseInput())
    assert.equal(result.ownerEmail, 'owner@example.com')
    const invitationInsert = mock.executeCalls.find((call) =>
      call.text.includes('INSERT INTO "TenantInvitation"'),
    )
    assert.ok(invitationInsert)
    assert.ok(invitationInsert.values.includes('owner@example.com'))
  })
})
