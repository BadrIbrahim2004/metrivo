import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common'
import { ProcurementService } from '../src/procurement.service'
import { createPrismaMock } from './test-helpers'

describe('ProcurementService', () => {
  it('denies supplier reads when the caller lacks the tenant and branch permission', async () => {
    const mock = createPrismaMock({ queryResults: [[{ allowed: false }]] })
    const service = new ProcurementService(mock.prisma)

    await assert.rejects(
      service.listSuppliers('user-1', 'tenant-1', 'branch-outside-scope'),
      ForbiddenException,
    )
    assert.equal(mock.queryCalls.length, 1)
    assert.ok(mock.queryCalls[0]?.values.includes('suppliers.read'))
    assert.ok(mock.queryCalls[0]?.values.includes('tenant-1'))
    assert.ok(mock.queryCalls[0]?.values.includes('branch-outside-scope'))
  })

  it('rejects malformed purchase lines before opening a database transaction', async () => {
    const mock = createPrismaMock()
    const service = new ProcurementService(mock.prisma)

    await assert.rejects(
      service.createPurchase(
        'user-1',
        'tenant-1',
        'branch-1',
        'purchase-idempotency-0001',
        {
          supplierId: 'supplier-1',
          items: [
            { productId: 'product-1', quantity: 0, unitCost: '2.50' },
          ],
        },
      ),
      BadRequestException,
    )
    assert.equal(mock.transactionCount, 0)
  })

  it('rejects payment amounts outside the decimal contract', async () => {
    const mock = createPrismaMock()
    const service = new ProcurementService(mock.prisma)

    await assert.rejects(
      service.recordSupplierPayment(
        'user-1',
        'tenant-1',
        'branch-1',
        'purchase-1',
        'payment-idempotency-0001',
        { amount: '-1.00', method: 'CASH' },
      ),
      BadRequestException,
    )
    assert.equal(mock.transactionCount, 0)
  })
})
