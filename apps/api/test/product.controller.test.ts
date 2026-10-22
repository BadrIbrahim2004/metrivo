import 'reflect-metadata'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { UnauthorizedException } from '@nestjs/common'
import { RequireTenantPermission, TENANT_PERMISSION } from '../src/authz.decorator'
import {
  CreateInventoryMovementDto,
  CreateProductDto,
} from '../src/product.dto'
import { ProductController } from '../src/product.controller'
import type { ProductService } from '../src/product.service'

function makeController() {
  const calls: Array<{ method: string; values: unknown[] }> = []
  const service = new Proxy({}, {
    get: (_target, property: string) => async (...values: unknown[]) => {
      calls.push({ method: property, values })
      return []
    },
  })
  return {
    controller: new ProductController(service as ProductService),
    calls,
  }
}

describe('ProductController', () => {
  it('applies tenant permissions to product and inventory operations', () => {
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProductController.prototype.list),
      'catalog.products.read',
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProductController.prototype.create),
      'catalog.products.manage',
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProductController.prototype.adjustInventory),
      'inventory.adjust',
    )
    assert.equal(typeof RequireTenantPermission, 'function')
  })

  it('passes authenticated actor and route tenant/branch identifiers to service', async () => {
    const { controller, calls } = makeController()
    await controller.create(
      { user: { userId: 'verified-user' } },
      'tenant-1',
      'branch-1',
      Object.assign(new CreateProductDto(), {
        sku: 'SKU-1',
        name: 'Coffee',
        price: '1.25',
      }),
    )

    assert.deepEqual(calls[0].values.slice(0, 3), [
      'verified-user',
      'tenant-1',
      'branch-1',
    ])
  })

  it('rejects calls without an authenticated principal', async () => {
    const { controller, calls } = makeController()
    assert.throws(
      () => controller.list({}, 'tenant-1', 'branch-1'),
      UnauthorizedException,
    )
    assert.equal(calls.length, 0)
  })

  it('validates product price and non-zero inventory movement input', () => {
    const invalidProduct = plainToInstance(CreateProductDto, {
      sku: 'SKU-1',
      name: 'Coffee',
      price: '1.239',
    })
    const invalidMovement = plainToInstance(CreateInventoryMovementDto, {
      quantityDelta: '0',
      reason: 'No change',
    })
    assert.ok(validateSync(invalidProduct).length > 0)
    assert.ok(validateSync(invalidMovement).length > 0)
  })
})
