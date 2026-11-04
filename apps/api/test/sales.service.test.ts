import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common'
import { SalesService } from '../src/sales.service'
import { createPrismaMock } from './test-helpers'

const INPUT = {
  lines: [{ productId: 'product-1', quantity: 2 }],
  discount: '1.00',
  paymentMethod: 'CASH' as const,
}
const KEY = 'pos-checkout-00000001'
const SALE = {
  id: 'sale-1',
  invoiceNumber: 'POS-123-abc12345',
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  actorUserId: 'user-1',
  status: 'COMPLETED',
  paymentMethod: 'CASH',
  subtotal: '21.00',
  discount: '1.00',
  surcharge: '0.00',
  customerName: null,
  adjustmentReason: null,
  total: '20.00',
  createdAt: new Date('2026-10-19T09:00:00.000Z'),
}
const ITEM = {
  id: 'item-1',
  productId: 'product-1',
  productName: 'Coffee',
  productSku: 'CF-1',
  quantity: 2,
  unitPrice: '10.50',
  lineTotal: '21.00',
}

function requestHash() {
  const normalized = JSON.stringify({
    lines: [{ productId: 'product-1', quantity: 2 }],
    discount: '100',
    paymentMethod: 'CASH',
  })
  return createHash('sha256').update(normalized).digest('hex')
}

function permittedMock(
  responder: (text: string) => unknown[] | undefined = () => undefined,
  executeResponder?: (text: string) => number | undefined,
) {
  return createPrismaMock({
    queryResponder(call) {
      if (call.text.includes('FROM "TenantMembership" tm')) {
        return [{ allowed: true }]
      }
      if (call.text.includes('FROM "CashShift"')) {
        return [{ id: 'cash-shift-1' }]
      }
      return responder(call.text)
    },
    executeResponder: executeResponder
      ? (call) => executeResponder(call.text)
      : undefined,
  })
}

function newSaleResponder(text: string) {
  if (text.includes('SELECT id, "requestHash"')) return []
  if (text.includes('FROM "Product"') && text.includes('FOR UPDATE')) {
    return [{ id: 'product-1', sku: 'CF-1', name: 'Coffee', price: '10.50' }]
  }
  if (text.includes('SUM("quantityDelta")')) return [{ quantity: '5' }]
  if (text.includes('SELECT id, "invoiceNumber"')) return [SALE]
  if (text.includes('FROM "SaleItem"')) return [ITEM]
  return []
}

describe('SalesService', () => {
  it('prices from the active product row and atomically writes invoice, snapshot, and stock movement', async () => {
    const mock = permittedMock(newSaleResponder)
    const service = new SalesService(mock.prisma)

    const result = await service.createSale(
      'user-1', 'tenant-1', 'branch-1', KEY, INPUT,
    )

    assert.equal(result.total, '20.00')
    assert.equal(result.items[0].unitPrice, '10.50')
    assert.equal(mock.transactionCount, 1)
    assert.equal(mock.executeCalls.length, 3)
    assert.match(mock.executeCalls[0].text, /INSERT INTO "Sale"/)
    assert.match(mock.executeCalls[0].text, /"cashShiftId"/)
    assert.ok(mock.executeCalls[0].values.includes('cash-shift-1'))
    assert.match(mock.executeCalls[1].text, /INSERT INTO "SaleItem"/)
    assert.match(mock.executeCalls[2].text, /INSERT INTO "InventoryMovement"/)
    assert.ok(mock.executeCalls[1].values.includes('Coffee'))
    assert.ok(mock.executeCalls[1].values.includes('10.50'))
    assert.ok(mock.executeCalls[2].values.includes(-2))
    assert.ok(
      mock.executeCalls[2].values.includes(mock.executeCalls[0].values[0]),
    )
    assert.equal(mock.transactionOptions[0], undefined)
    assert.ok(
      mock.queryCalls.some((call) =>
        call.text.includes('pg_advisory_xact_lock') &&
        call.values.includes('branch-1:product-1'),
      ),
    )
  })

  it('rejects an unauthorized branch before reading products or writing a sale', async () => {
    const mock = createPrismaMock({
      queryResults: [[{ allowed: false }]],
    })
    const service = new SalesService(mock.prisma)

    await assert.rejects(
      service.createSale('user-1', 'tenant-1', 'other-branch', KEY, INPUT),
      ForbiddenException,
    )
    assert.equal(mock.queryCalls.length, 1)
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects a sale when the locked branch stock is insufficient', async () => {
    const mock = permittedMock((text) => {
      if (text.includes('SELECT id, "requestHash"')) return []
      if (text.includes('FROM "Product"') && text.includes('FOR UPDATE')) {
        return [{ id: 'product-1', sku: 'CF-1', name: 'Coffee', price: '10.50' }]
      }
      if (text.includes('SUM("quantityDelta")')) return [{ quantity: '1' }]
      return []
    })
    const service = new SalesService(mock.prisma)

    await assert.rejects(
      service.createSale('user-1', 'tenant-1', 'branch-1', KEY, INPUT),
      BadRequestException,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('records a surcharge and invoice context without treating it as a discount', async () => {
    const mock = permittedMock(newSaleResponder)
    const service = new SalesService(mock.prisma)

    await service.createSale(
      'user-1',
      'tenant-1',
      'branch-1',
      KEY,
      {
        lines: [{ productId: 'product-1', quantity: 2 }],
        surcharge: '2.50',
        customerName: '  Nadia  ',
        adjustmentReason: '  Service fee  ',
        paymentMethod: 'CASH',
      },
    )

    const insert = mock.executeCalls[0]
    assert.match(insert.text, /surcharge/)
    assert.match(insert.text, /"customerName"/)
    assert.match(insert.text, /"adjustmentReason"/)
    assert.ok(insert.values.includes('2.50'))
    assert.ok(insert.values.includes('Nadia'))
    assert.ok(insert.values.includes('Service fee'))
    assert.ok(insert.values.includes('23.50'))
  })

  it('stores the cash tender and computes the customer change from the server total', async () => {
    const mock = permittedMock(newSaleResponder)
    const service = new SalesService(mock.prisma)

    await service.createSale(
      'user-1',
      'tenant-1',
      'branch-1',
      KEY,
      { ...INPUT, cashReceived: '25.00' },
    )

    const insert = mock.executeCalls[0]
    assert.match(insert.text, /"cashReceived"/)
    assert.match(insert.text, /"changeDue"/)
    assert.ok(insert.values.includes('25.00'))
    assert.ok(insert.values.includes('5.00'))
  })

  it('does not require or attach a cash shift to non-cash sales', async () => {
    const mock = permittedMock(newSaleResponder)
    const service = new SalesService(mock.prisma)

    await service.createSale(
      'user-1',
      'tenant-1',
      'branch-1',
      KEY,
      { ...INPUT, paymentMethod: 'CARD' },
    )

    const insert = mock.executeCalls[0]
    assert.ok(!mock.queryCalls.some((call) => call.text.includes('FROM "CashShift"')))
    assert.match(insert.text, /"cashShiftId"/)
    assert.ok(!insert.values.includes('cash-shift-1'))
  })

  it('rejects cash tender below the computed sale total', async () => {
    const mock = permittedMock(newSaleResponder)
    const service = new SalesService(mock.prisma)

    await assert.rejects(
      service.createSale(
        'user-1',
        'tenant-1',
        'branch-1',
        KEY,
        { ...INPUT, cashReceived: '19.99' },
      ),
      BadRequestException,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects cash sales when the branch has no open shift', async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "TenantMembership" tm')) {
          return [{ allowed: true }]
        }
        if (call.text.includes('FROM "CashShift"')) return []
        if (call.text.includes('SELECT id, "requestHash"')) return []
        return []
      },
    })
    const service = new SalesService(mock.prisma)

    await assert.rejects(
      service.createSale('user-1', 'tenant-1', 'branch-1', KEY, INPUT),
      ConflictException,
    )
    assert.equal(mock.executeCalls.length, 0)
    assert.ok(mock.queryCalls.some((call) =>
      call.text.includes('FROM "CashShift"') && call.text.includes('FOR UPDATE'),
    ))
  })

  it('rejects a sale containing both a discount and a surcharge', async () => {
    const mock = permittedMock()
    const service = new SalesService(mock.prisma)

    await assert.rejects(
      service.createSale(
        'user-1',
        'tenant-1',
        'branch-1',
        KEY,
        { ...INPUT, surcharge: '1.00' },
      ),
      BadRequestException,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('returns the prior invoice for a repeated key and rejects a changed payload', async () => {
    const mock = permittedMock((text) => {
      if (text.includes('SELECT id, "requestHash"')) {
        return [{ id: SALE.id, requestHash: requestHash() }]
      }
      if (text.includes('SELECT id, "invoiceNumber"')) return [SALE]
      if (text.includes('FROM "SaleItem"')) return [ITEM]
      return []
    })
    const service = new SalesService(mock.prisma)

    const repeated = await service.createSale(
      'user-1', 'tenant-1', 'branch-1', KEY, INPUT,
    )
    assert.equal(repeated.id, SALE.id)
    assert.equal(mock.executeCalls.length, 0)

    await assert.rejects(
      service.createSale(
        'user-1',
        'tenant-1',
        'branch-1',
        KEY,
        { ...INPUT, paymentMethod: 'CARD' },
      ),
      ConflictException,
    )
  })

  it('uses a shared database lock for simultaneous retries with the same idempotency key', async () => {
    const mock = permittedMock((text) => {
      if (text.includes('SELECT id, "requestHash"')) {
        return [{ id: SALE.id, requestHash: requestHash() }]
      }
      if (text.includes('SELECT id, "invoiceNumber"')) return [SALE]
      if (text.includes('FROM "SaleItem"')) return [ITEM]
      return []
    })
    const service = new SalesService(mock.prisma)

    const [first, second] = await Promise.all([
      service.createSale('user-1', 'tenant-1', 'branch-1', KEY, INPUT),
      service.createSale('user-1', 'tenant-1', 'branch-1', KEY, INPUT),
    ])

    assert.equal(first.id, second.id)
    const idempotencyLocks = mock.queryCalls.filter((call) =>
      call.text.includes('pg_advisory_xact_lock') &&
      call.values.some((value) =>
        typeof value === 'string' && value.startsWith('sale:user-1:'),
      ),
    )
    assert.equal(idempotencyLocks.length, 2)
  })

  it('does not oversell when distinct requests race for the last unit in the transaction mock', async () => {
    let available = 1
    const mock = createPrismaMock({
      serializeTransactions: true,
      queryResponder(call) {
        if (call.text.includes('FROM "TenantMembership" tm')) {
          return [{ allowed: true }]
        }
        if (call.text.includes('FROM "CashShift"')) {
          return [{ id: 'cash-shift-1' }]
        }
        if (call.text.includes('SELECT id, "requestHash"')) return []
        if (call.text.includes('FROM "Product"') && call.text.includes('FOR UPDATE')) {
          return [{ id: 'product-1', sku: 'CF-1', name: 'Coffee', price: '10.50' }]
        }
        if (call.text.includes('SUM("quantityDelta")')) {
          return [{ quantity: String(available) }]
        }
        if (call.text.includes('SELECT id, "invoiceNumber"')) return [SALE]
        if (call.text.includes('FROM "SaleItem"')) return [ITEM]
        return []
      },
      executeResponder(call) {
        if (call.text.includes('INSERT INTO "InventoryMovement"')) {
          available += Number(call.values[5])
        }
        return 1
      },
    })
    const service = new SalesService(mock.prisma)
    const oneUnit = {
      lines: [{ productId: 'product-1', quantity: 1 }],
      discount: '0',
      paymentMethod: 'CASH' as const,
    }

    const outcomes = await Promise.allSettled([
      service.createSale(
        'user-1', 'tenant-1', 'branch-1', 'pos-checkout-00000002', oneUnit,
      ),
      service.createSale(
        'user-1', 'tenant-1', 'branch-1', 'pos-checkout-00000003', oneUnit,
      ),
    ])

    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    assert.equal(rejected?.status, 'rejected')
    if (rejected?.status === 'rejected') {
      assert.ok(rejected.reason instanceof BadRequestException)
    }
  })

  it('propagates a write failure so the surrounding database transaction can roll back', async () => {
    const mock = permittedMock(
      newSaleResponder,
      (text) => {
        if (text.includes('INSERT INTO "InventoryMovement"')) {
          throw new Error('inventory movement write failed')
        }
        return undefined
      },
    )
    const service = new SalesService(mock.prisma)

    await assert.rejects(
      service.createSale('user-1', 'tenant-1', 'branch-1', KEY, INPUT),
      /inventory movement write failed/,
    )
    assert.equal(mock.transactionCount, 1)
    assert.equal(mock.executeCalls.length, 3)
  })

  it('rejects duplicate products and malformed idempotency keys', async () => {
    const mock = permittedMock()
    const service = new SalesService(mock.prisma)

    await assert.rejects(
      service.createSale(
        'user-1',
        'tenant-1',
        'branch-1',
        KEY,
        { ...INPUT, lines: [...INPUT.lines, ...INPUT.lines] },
      ),
      BadRequestException,
    )
    await assert.rejects(
      service.createSale('user-1', 'tenant-1', 'branch-1', 'short', INPUT),
      BadRequestException,
    )
  })
})
