import 'reflect-metadata'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { UnauthorizedException } from '@nestjs/common'
import { RequireTenantPermission, TENANT_PERMISSION } from '../src/authz.decorator'
import { SALES_CREATE_PERMISSION, SALES_READ_PERMISSION } from '../src/product-permissions'
import { CreateSaleDto } from '../src/sales.dto'
import { SalesController } from '../src/sales.controller'
import type { SalesService } from '../src/sales.service'

function makeController() {
  const calls: Array<{ method: string; values: unknown[] }> = []
  const service = new Proxy({}, {
    get: (_target, property: string) => (...values: unknown[]) => {
      calls.push({ method: property, values })
      return Promise.resolve([])
    },
  })
  return {
    controller: new SalesController(service as SalesService),
    calls,
  }
}

describe('SalesController', () => {
  it('declares separate create and read permissions for sales endpoints', () => {
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, SalesController.prototype.create),
      SALES_CREATE_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, SalesController.prototype.catalog),
      SALES_CREATE_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, SalesController.prototype.list),
      SALES_READ_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, SalesController.prototype.get),
      SALES_READ_PERMISSION,
    )
    assert.equal(typeof RequireTenantPermission, 'function')
  })

  it('takes the actor from the verified principal and forwards the idempotency header', async () => {
    const { controller, calls } = makeController()
    const dto = Object.assign(new CreateSaleDto(), {
      lines: [{ productId: 'product-1', quantity: 2 }],
      discount: '1.00',
      paymentMethod: 'CASH',
    })
    await controller.create(
      { user: { userId: 'verified-user' } },
      'tenant-1',
      'branch-1',
      'pos-checkout-00000001',
      dto,
    )
    assert.deepEqual(calls[0], {
      method: 'createSale',
      values: [
        'verified-user',
        'tenant-1',
        'branch-1',
        'pos-checkout-00000001',
        dto,
      ],
    })
  })

  it('rejects requests without an authenticated principal', async () => {
    const { controller, calls } = makeController()
    assert.throws(
      () => controller.list({}, 'tenant-1', 'branch-1'),
      UnauthorizedException,
    )
    assert.equal(calls.length, 0)
  })

  it('validates line shape and rejects client-supplied prices and totals', () => {
    const input = plainToInstance(CreateSaleDto, {
      lines: [{ productId: 'product-1', quantity: 1, unitPrice: '0.01' }],
      paymentMethod: 'CASH',
      subtotal: '0.01',
      total: '0.01',
    })
    const errors = validateSync(input, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    })
    assert.ok(errors.length > 0)
  })
})
