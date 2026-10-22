import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { ProductService } from '../src/product.service'
import { createPrismaMock } from './test-helpers'

const PRODUCT = {
  id: 'product-1',
  sku: 'SKU-1',
  name: 'Coffee',
  category: 'Drinks',
  description: null,
  price: '12.50',
  isActive: true,
}

function authorizedMock(responder: (text: string) => unknown[] | undefined) {
  return createPrismaMock({
    queryResponder(call) {
      if (call.text.includes('FROM "TenantMembership" tm')) {
        return [{ allowed: true }]
      }
      return responder(call.text)
    },
  })
}

describe('ProductService', () => {
  it('scopes product and stock listing to an explicitly authorized tenant branch', async () => {
    const mock = authorizedMock((text) =>
      text.includes('FROM "Product" p')
        ? [{ ...PRODUCT, stock: '7' }]
        : undefined,
    )
    const service = new ProductService(mock.prisma)

    const products = await service.listProducts('user-1', 'tenant-1', 'branch-1')

    assert.equal(products[0].stock, '7')
    assert.equal(mock.queryCalls.length, 3)
    assert.ok(mock.queryCalls[0].values.includes('catalog.products.read'))
    assert.ok(mock.queryCalls[1].values.includes('inventory.read'))
    assert.match(mock.queryCalls[0].text, /"BranchMembership"/)
    assert.match(mock.queryCalls[2].text, /p\."tenantId" = \?/)
    assert.ok(mock.queryCalls[2].values.includes('tenant-1'))
    assert.ok(mock.queryCalls[2].values.includes('branch-1'))
  })

  it('denies a branch outside the authenticated membership scope before reading products', async () => {
    const mock = createPrismaMock({
      queryResults: [[{ allowed: false }]],
    })
    const service = new ProductService(mock.prisma)

    await assert.rejects(
      service.listProducts('user-1', 'tenant-1', 'other-branch'),
      ForbiddenException,
    )
    assert.equal(mock.queryCalls.length, 1)
  })

  it('creates products with the authorized tenant and authenticated actor', async () => {
    const mock = authorizedMock((text) =>
      text.includes('INSERT INTO "Product"') ? [PRODUCT] : undefined,
    )
    const service = new ProductService(mock.prisma)

    const created = await service.createProduct(
      'user-1',
      'tenant-1',
      'branch-1',
      { sku: ' SKU-1 ', name: ' Coffee ', price: '12.50' },
    )

    assert.equal(created.id, PRODUCT.id)
    const insert = mock.queryCalls.find((call) =>
      call.text.includes('INSERT INTO "Product"'),
    )
    assert.ok(insert)
    assert.ok(insert.values.includes('tenant-1'))
    assert.ok(insert.values.includes('user-1'))
    assert.ok(insert.values.includes('SKU-1'))
  })

  it('rejects product updates when the ID belongs to another tenant', async () => {
    const mock = authorizedMock((text) =>
      text.includes('FROM "Product"')
        ? []
        : undefined,
    )
    const service = new ProductService(mock.prisma)

    await assert.rejects(
      service.updateProduct('user-1', 'tenant-1', 'branch-1', 'foreign-product', {
        name: 'Changed',
      }),
      NotFoundException,
    )
    assert.equal(
      mock.queryCalls.some((call) => call.text.includes('UPDATE "Product"')),
      false,
    )
    assert.ok(mock.queryCalls[1].values.includes('tenant-1'))
  })

  it('records inventory movements and calculates branch stock transactionally', async () => {
    const mock = authorizedMock((text) => {
      if (text.includes('pg_advisory_xact_lock')) return []
      if (text.includes('FROM "Product"')) return [{ id: 'product-1' }]
      if (text.includes('SUM("quantityDelta")')) return [{ quantity: '4' }]
      return undefined
    })
    const service = new ProductService(mock.prisma)

    const result = await service.createMovement(
      'user-1',
      'tenant-1',
      'branch-1',
      'product-1',
      { quantityDelta: '3', reason: 'Received stock' },
    )

    assert.equal(result.quantity, '7')
    const insert = mock.executeCalls[0]
    assert.match(insert.text, /INSERT INTO "InventoryMovement"/)
    assert.ok(insert.values.includes('tenant-1'))
    assert.ok(insert.values.includes('branch-1'))
    assert.ok(insert.values.includes('product-1'))
    assert.ok(insert.values.includes('user-1'))
    assert.equal(mock.transactionOptions[0]?.isolationLevel, 'Serializable')
  })

  it('rejects a movement that would make branch stock negative', async () => {
    const mock = authorizedMock((text) => {
      if (text.includes('pg_advisory_xact_lock')) return []
      if (text.includes('FROM "Product"')) return [{ id: 'product-1' }]
      if (text.includes('SUM("quantityDelta")')) return [{ quantity: '2' }]
      return undefined
    })
    const service = new ProductService(mock.prisma)

    await assert.rejects(
      service.createMovement(
        'user-1',
        'tenant-1',
        'branch-1',
        'product-1',
        { quantityDelta: '-3', reason: 'Correct stock' },
      ),
      BadRequestException,
    )
    assert.equal(mock.executeCalls.length, 0)
  })
})
