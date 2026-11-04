import 'reflect-metadata'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { UnauthorizedException } from '@nestjs/common'
import { TENANT_PERMISSION } from '../src/authz.decorator'
import { ProcurementController } from '../src/procurement.controller'
import {
  PURCHASES_CANCEL_PERMISSION,
  PURCHASES_CREATE_PERMISSION,
  PURCHASES_PAY_PERMISSION,
  PURCHASES_READ_PERMISSION,
  PURCHASES_RECEIVE_PERMISSION,
  SUPPLIERS_MANAGE_PERMISSION,
  SUPPLIERS_READ_PERMISSION,
} from '../src/procurement.service'
import type { ProcurementService } from '../src/procurement.service'

function makeController() {
  const calls: Array<{ method: string; values: unknown[] }> = []
  const service = new Proxy({}, {
    get: (_target, property: string) => (...values: unknown[]) => {
      calls.push({ method: property, values })
      return Promise.resolve([])
    },
  })
  return {
    controller: new ProcurementController(service as ProcurementService),
    calls,
  }
}

describe('ProcurementController', () => {
  it('declares explicit supplier and purchase permissions', () => {
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProcurementController.prototype.listSuppliers),
      SUPPLIERS_READ_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProcurementController.prototype.createSupplier),
      SUPPLIERS_MANAGE_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProcurementController.prototype.updateSupplier),
      SUPPLIERS_MANAGE_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProcurementController.prototype.listPurchases),
      PURCHASES_READ_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProcurementController.prototype.createPurchase),
      PURCHASES_CREATE_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProcurementController.prototype.receivePurchase),
      PURCHASES_RECEIVE_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProcurementController.prototype.cancelDraftPurchase),
      PURCHASES_CANCEL_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, ProcurementController.prototype.recordSupplierPayment),
      PURCHASES_PAY_PERMISSION,
    )
  })

  it('uses the authenticated actor and forwards purchase idempotency keys', async () => {
    const { controller, calls } = makeController()
    const input = {
      supplierId: 'supplier-1',
      items: [{ productId: 'product-1', quantity: 2, unitCost: '4.25' }],
    }
    await controller.createPurchase(
      { user: { userId: 'verified-user' } },
      'tenant-1',
      'branch-1',
      'purchase-idempotency-0001',
      input,
    )
    assert.deepEqual(calls[0], {
      method: 'createPurchase',
      values: [
        'verified-user',
        'tenant-1',
        'branch-1',
        'purchase-idempotency-0001',
        input,
      ],
    })
  })

  it('rejects requests without a verified actor', () => {
    const { controller, calls } = makeController()
    assert.throws(
      () => controller.listPurchases({}, 'tenant-1', 'branch-1'),
      UnauthorizedException,
    )
    assert.equal(calls.length, 0)
  })
})
