import 'reflect-metadata'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { UnauthorizedException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { RequireTenantPermission, TENANT_PERMISSION } from '../src/authz.decorator'
import { BranchAccessController } from '../src/branch-access.controller'
import { UpdateBranchAccessDto } from '../src/branch-access.dto'
import type { BranchAccessService } from '../src/branch-access.service'

describe('BranchAccessController', () => {
  it('requires the explicit tenant member-management permission', () => {
    assert.equal(
      Reflect.getMetadata(
        TENANT_PERMISSION,
        BranchAccessController.prototype.update,
      ),
      'tenant.members.manage',
    )
    assert.equal(typeof RequireTenantPermission, 'function')
  })

  it('takes the actor from the verified principal, not the DTO', async () => {
    const calls: unknown[][] = []
    const service = {
      async updateMembershipAccess(...values: unknown[]) {
        calls.push(values)
        return { membershipId: 'member-1', mode: 'ALL_BRANCHES', branchIds: [] }
      },
    }
    const controller = new BranchAccessController(
      service as unknown as BranchAccessService,
    )
    const result = await controller.update(
      { user: { userId: 'verified-manager' } },
      'tenant-1',
      'member-1',
      Object.assign(new UpdateBranchAccessDto(), {
        mode: 'SELECTED_BRANCHES',
        branchIds: ['branch-1'],
        actorUserId: 'forged-user',
      }),
    )

    assert.equal(result.membershipId, 'member-1')
    assert.equal(calls[0][0], 'verified-manager')
    assert.deepEqual(calls[0].slice(1, 3), ['tenant-1', 'member-1'])
  })

  it('rejects unauthenticated callers and invalid scope input', async () => {
    const service = {
      async updateMembershipAccess() {
        assert.fail('service must not be called')
      },
    }
    const controller = new BranchAccessController(
      service as unknown as BranchAccessService,
    )
    assert.throws(
      () => controller.update({}, 'tenant-1', 'member-1', {
        mode: 'ALL_BRANCHES',
        branchIds: [],
      } as UpdateBranchAccessDto),
      UnauthorizedException,
    )

    const dto = plainToInstance(UpdateBranchAccessDto, {
      mode: 'UNRECOGNIZED',
      branchIds: ['branch-1', 'branch-1'],
    })
    assert.ok(validateSync(dto).length > 0)
  })
})
