import 'reflect-metadata'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { UnauthorizedException } from '@nestjs/common'
import { TENANT_PERMISSION } from '../src/authz.decorator'
import {
  CASH_MANAGE_PERMISSION,
  CASH_READ_PERMISSION,
  REFUNDS_SETTLE_PERMISSION,
} from '../src/cash-management.service'
import {
  CloseCashShiftDto,
  CreateCashMovementDto,
  OpenCashShiftDto,
  SettleRefundDto,
} from '../src/cash-management.dto'
import { CashManagementController } from '../src/cash-management.controller'
import type { CashManagementService } from '../src/cash-management.service'

function makeController() {
  const calls: Array<{ method: string; values: unknown[] }> = []
  const service = new Proxy({}, {
    get: (_target, property: string) => (...values: unknown[]) => {
      calls.push({ method: property, values })
      return Promise.resolve({})
    },
  })
  return { controller: new CashManagementController(service as CashManagementService), calls }
}

describe('CashManagementController', () => {
  it('declares read, manage, and settlement permissions on each route', () => {
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, CashManagementController.prototype.getCurrentShift),
      CASH_READ_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, CashManagementController.prototype.openShift),
      CASH_MANAGE_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, CashManagementController.prototype.recordMovement),
      CASH_MANAGE_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, CashManagementController.prototype.closeShift),
      CASH_MANAGE_PERMISSION,
    )
    assert.equal(
      Reflect.getMetadata(TENANT_PERMISSION, CashManagementController.prototype.settleRefund),
      REFUNDS_SETTLE_PERMISSION,
    )
  })

  it('forwards the authenticated actor and idempotency key to refund settlement', async () => {
    const { controller, calls } = makeController()
    const input = Object.assign(new SettleRefundDto(), { method: 'CASH' })
    await controller.settleRefund(
      { user: { userId: 'actor-1' } },
      'tenant-1',
      'branch-1',
      'shift-1',
      'return-1',
      'settle-idempotency-001',
      input,
    )
    assert.deepEqual(calls[0], {
      method: 'settleRefund',
      values: [
        'actor-1', 'tenant-1', 'branch-1', 'return-1', 'shift-1',
        'settle-idempotency-001', input,
      ],
    })
  })

  it('rejects unauthenticated callers before reaching the service', () => {
    const { controller, calls } = makeController()
    assert.throws(() => controller.getCurrentShift({}, 'tenant-1', 'branch-1'), UnauthorizedException)
    assert.equal(calls.length, 0)
  })

  it('validates monetary values, movement reasons, and settlement methods', () => {
    const invalidOpen = plainToInstance(OpenCashShiftDto, { openingCash: '-1.00' })
    const invalidClose = plainToInstance(CloseCashShiftDto, { countedCash: '1.001' })
    const invalidMovement = plainToInstance(CreateCashMovementDto, {
      type: 'CASH_IN', amount: '0.00', reason: '',
    })
    const invalidSettlement = plainToInstance(SettleRefundDto, { method: 'WIRE' })
    for (const dto of [invalidOpen, invalidClose, invalidMovement, invalidSettlement]) {
      assert.ok(validateSync(dto).length > 0)
    }
  })
})
