import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { StockTransfersService } from '../src/stock-transfers.service'
import { createPrismaMock } from './test-helpers'

function permissionAllowed(call: { text: string }) {
  return call.text.includes('FROM "TenantMembership" tm')
    ? [{ allowed: true }]
    : undefined
}

const BASE = {
  sourceBranchId: 'branch-a',
  destinationBranchId: 'branch-b',
  productId: 'prod-1',
  quantity: 5,
  unitCost: '10.00',
}

describe('StockTransfersService', () => {
  it('rejects invalid transfer input before opening a transaction', async () => {
    const mock = createPrismaMock()
    const service = new StockTransfersService(mock.prisma)

    await assert.rejects(
      service.createTransfer('user-1', 'tenant-1', 'branch-a', 'transfer-idem-001', {
        ...BASE,
        destinationBranchId: 'branch-a',
      }),
      BadRequestException,
    )
    await assert.rejects(
      service.createTransfer('user-1', 'tenant-1', 'branch-a', 'transfer-idem-001', {
        ...BASE,
        quantity: 0,
      }),
      BadRequestException,
    )
    await assert.rejects(
      service.createTransfer('user-1', 'tenant-1', 'branch-a', '', BASE),
      BadRequestException,
    )
    assert.equal(mock.transactionCount, 0)
  })

  it('fails closed when the caller lacks transfer permission on both branches', async () => {
    const mock = createPrismaMock({ queryResults: [[{ allowed: false }]] })
    const service = new StockTransfersService(mock.prisma)
    await assert.rejects(
      service.createTransfer('user-1', 'tenant-1', 'branch-a', 'transfer-idem-001', BASE),
      ForbiddenException,
    )
    await assert.rejects(
      service.listTransfers('user-1', 'tenant-1', 'branch-a', {}),
      ForbiddenException,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects transfers referencing branches outside the caller tenant', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = permissionAllowed(call)
        if (allowed) return allowed
        if (call.text.includes('pg_advisory_xact_lock')) return []
        if (call.text.includes('FROM "StockTransfer"') && call.text.includes('idempotencyKey')) {
          return []
        }
        // Branch lookup returns only the source (foreign destination is not
        // part of this tenant) -> the service must refuse.
        if (call.text.includes('FROM "Branch"')) {
          return [{ id: 'branch-a', role: 'SOURCE' }]
        }
        return []
      },
    })
    const service = new StockTransfersService(mock.prisma)
    await assert.rejects(
      service.createTransfer('user-1', 'tenant-1', 'branch-a', 'transfer-idem-001', BASE),
      NotFoundException,
    )
  })

  it('rejects a duplicate idempotency key with a different payload', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = permissionAllowed(call)
        if (allowed) return allowed
        if (call.text.includes('pg_advisory_xact_lock')) return []
        if (call.text.includes('FROM "StockTransfer"') && call.text.includes('idempotencyKey')) {
          return [{ id: 'st-1', requestHash: 'a'.repeat(64), createdAt: new Date() }]
        }
        return []
      },
    })
    const service = new StockTransfersService(mock.prisma)
    await assert.rejects(
      service.createTransfer('user-1', 'tenant-1', 'branch-a', 'transfer-idem-001', BASE),
      ConflictException,
    )
  })

  it('rejects transfers exceeding the available source stock', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = permissionAllowed(call)
        if (allowed) return allowed
        if (call.text.includes('pg_advisory_xact_lock')) return []
        if (call.text.includes('FROM "StockTransfer"') && call.text.includes('idempotencyKey')) {
          return []
        }
        if (call.text.includes('FROM "Branch"')) {
          return [
            { id: 'branch-a', role: 'SOURCE' },
            { id: 'branch-b', role: 'DEST' },
          ]
        }
        if (call.text.includes('FROM "Product"')) {
          return [{ id: 'prod-1', name: 'Widget' }]
        }
        if (call.text.includes('FROM "InventoryMovement"')) return [{ balance: 2 }]
        return []
      },
    })
    const service = new StockTransfersService(mock.prisma)
    await assert.rejects(
      service.createTransfer('user-1', 'tenant-1', 'branch-a', 'transfer-idem-001', BASE),
      ConflictException,
    )
  })

  it('rejects an unknown product', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = permissionAllowed(call)
        if (allowed) return allowed
        if (call.text.includes('pg_advisory_xact_lock')) return []
        if (call.text.includes('FROM "StockTransfer"') && call.text.includes('idempotencyKey')) {
          return []
        }
        // The real branch lookup is a UNION ALL over two single-row selects;
        // return both rows so the service passes the branch check and reaches
        // the product validation path.
        if (call.text.includes('FROM "Branch"')) {
          return [
            { id: 'branch-a', role: 'SOURCE' },
            { id: 'branch-b', role: 'DEST' },
          ]
        }
        // The product lookup returns no rows for the unknown product.
        return []
      },
    })
    const service = new StockTransfersService(mock.prisma)
    await assert.rejects(
      service.createTransfer('user-1', 'tenant-1', 'branch-a', 'transfer-idem-001', BASE),
      NotFoundException,
    )
  })
})
