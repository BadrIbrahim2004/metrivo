import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { CashManagementService } from '../src/cash-management.service'
import { createPrismaMock } from './test-helpers'

describe('CashManagementService', () => {
  it('rejects invalid opening and movement amounts before database work', async () => {
    const mock = createPrismaMock()
    const service = new CashManagementService(mock.prisma)
    await assert.rejects(
      service.openShift('user-1', 'tenant-1', 'branch-1', { openingCash: '-1' }),
      BadRequestException,
    )
    await assert.rejects(
      service.recordMovement(
        'user-1',
        'tenant-1',
        'branch-1',
        'shift-1',
        'cash-idempotency-0001',
        { type: 'CASH_IN', amount: '0', reason: 'Float' },
      ),
      BadRequestException,
    )
    assert.equal(mock.transactionCount, 0)
  })

  it('fails closed when the caller lacks branch-scoped cash permission', async () => {
    const mock = createPrismaMock({ queryResults: [[{ allowed: false }]] })
    const service = new CashManagementService(mock.prisma)
    await assert.rejects(
      service.openShift('user-1', 'tenant-1', 'branch-1', { openingCash: '10.00' }),
      ForbiddenException,
    )
    assert.equal(mock.executeCalls.length, 0)
    assert.equal(mock.queryCalls.length, 1)
  })

  it('hashes normalized cash movement data only through parameterized SQL', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "TenantMembership" tm')) return [{ allowed: true }]
        if (call.text.includes('FROM "CashShift"')) {
          return [{ id: 'shift-1', status: 'OPEN', openingCash: '50.00' }]
        }
        if (call.text.includes('FROM "CashMovement"')) return []
        if (call.text.includes('INSERT INTO "CashMovement"')) {
          return [{
            id: 'movement-1',
            type: 'CASH_IN',
            amount: '5.00',
            reason: "safe ' reason",
            createdAt: new Date(),
          }]
        }
        if (call.text.includes('SELECT (')) return [{ expected: '50.00' }]
        return []
      },
    })
    const service = new CashManagementService(mock.prisma)
    const result = await service.recordMovement(
      'user-1',
      'tenant-1',
      'branch-1',
      'shift-1',
      'cash-idempotency-0001',
      { type: 'CASH_IN', amount: '5.00', reason: "safe ' reason" },
    )
    assert.equal(result.id, 'movement-1')
    const insert = mock.queryCalls.find((call) =>
      call.text.includes('INSERT INTO "CashMovement"'),
    )
    assert.ok(insert)
    assert.ok(insert?.values.includes("safe ' reason"))
    assert.equal(mock.executeCalls.length, 1)
    assert.match(mock.executeCalls[0].text, /INSERT INTO "CashAuditLog"/)
  })
})
