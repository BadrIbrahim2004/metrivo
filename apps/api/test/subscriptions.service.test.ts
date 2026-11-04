 import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { SubscriptionsService } from '../src/subscriptions.service'
import { createPrismaMock } from './test-helpers'

function platformAllowed(call: { text: string }) {
  return call.text.includes('FROM "UserPlatformRole" upr')
    ? [{ allowed: true }]
    : undefined
}

describe('SubscriptionsService', () => {
  it('rejects plan input before any database work', async () => {
    const mock = createPrismaMock()
    const service = new SubscriptionsService(mock.prisma)
    await assert.rejects(
      service.createPlan('owner-1', { name: '', period: 'MONTHLY', price: '10.00', trialDays: 0 }),
      BadRequestException,
    )
    await assert.rejects(
      service.createPlan('owner-1', { name: 'Basic', period: 'WEEKLY' as 'MONTHLY', price: '10.00', trialDays: 0 }),
      BadRequestException,
    )
    await assert.rejects(
      service.createPlan('owner-1', { name: 'Basic', period: 'MONTHLY', price: '0.00', trialDays: 0 }),
      BadRequestException,
    )
    await assert.rejects(
      service.createPlan('owner-1', { name: 'Basic', period: 'MONTHLY', price: '10.00', trialDays: 400 }),
      BadRequestException,
    )
    assert.equal(mock.transactionCount, 0)
  })

  it('fails closed without the platform subscription permission', async () => {
    const mock = createPrismaMock({ queryResults: [[{ allowed: false }]] })
    const service = new SubscriptionsService(mock.prisma)
    await assert.rejects(service.listPlans('shop-user-1'), ForbiddenException)
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects duplicate plan names for the same period', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = platformAllowed(call)
        if (allowed) return allowed
        if (call.text.includes('FROM "SubscriptionPlan"') && call.text.includes('WHERE name')) {
          return [{ id: 'plan-1' }]
        }
        return []
      },
    })
    const service = new SubscriptionsService(mock.prisma)
    await assert.rejects(
      service.createPlan('owner-1', { name: 'Basic', period: 'MONTHLY', price: '10.00', trialDays: 0 }),
      ConflictException,
    )
  })

  it('blocks business operations when no subscription exists', async () => {
    const mock = createPrismaMock({
      queryResponder() {
        return []
      },
    })
    const service = new SubscriptionsService(mock.prisma)
    await mock.prisma.$transaction(async (tx) => {
      await assert.rejects(
        service.assertTenantOperational(tx as never, 'tenant-1'),
        ForbiddenException,
      )
    })
  })

  it('rejects an invalid subscription action', async () => {
    const mock = createPrismaMock()
    const service = new SubscriptionsService(mock.prisma)
    await assert.rejects(
      service.changeSubscriptionState('owner-1', 'tenant-1', 'DELETE' as 'CANCEL'),
      BadRequestException,
    )
    assert.equal(mock.transactionCount, 0)
  })

  it('suspends only active or trial subscriptions', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = platformAllowed(call)
        if (allowed) return allowed
        if (call.text.includes('FOR UPDATE')) {
          return [{ id: 'sub-1', status: 'CANCELLED', trialEndsAt: null, currentPeriodEnd: new Date() }]
        }
        return []
      },
    })
    const service = new SubscriptionsService(mock.prisma)
    await assert.rejects(
      service.changeSubscriptionState('owner-1', 'tenant-1', 'SUSPEND'),
      ConflictException,
    )
  })

  it('rejects assignment for an unknown tenant', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = platformAllowed(call)
        if (allowed) return allowed
        if (call.text.includes('FROM "SubscriptionPlan"')) {
          return [{ id: 'plan-1', period: 'MONTHLY', trialDays: 14, isActive: true }]
        }
        if (call.text.includes('FROM "Tenant"')) return []
        return []
      },
    })
    const service = new SubscriptionsService(mock.prisma)
    await assert.rejects(
      service.startOrChangeSubscription('owner-1', 'foreign-tenant', { planId: 'plan-1', startTrial: true }),
      NotFoundException,
    )
  })
})
