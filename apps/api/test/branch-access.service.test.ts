import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { BranchAccessService } from '../src/branch-access.service'
import { createPrismaMock } from './test-helpers'

function makeScopeMock(
  actorMode: string,
  actorBranches: string[] = ['branch-1'],
  existingBranches: string[] = ['branch-1'],
) {
  const mock = createPrismaMock({
    queryResponder(call) {
      if (call.text.includes('tm."userId"')) {
        return [{
          id: 'actor-membership',
          branchAccessMode: actorMode,
        }]
      }
      if (call.text.includes('"userId" <>')) {
        return [{ id: 'target-membership' }]
      }
      if (call.text.includes('FROM "BranchMembership"')) {
        return actorBranches.map((branchId) => ({ branchId }))
      }
      if (call.text.includes('FROM "Branch"')) {
        return existingBranches.map((id) => ({ id }))
      }
      return undefined
    },
  })
  return { ...mock, service: new BranchAccessService(mock.prisma) }
}

describe('BranchAccessService', () => {
  it('denies scope changes when the actor lacks explicit member-management permission', async () => {
    const mock = createPrismaMock({
      queryResults: [[]],
    })
    const service = new BranchAccessService(mock.prisma)

    await assert.rejects(
      service.updateMembershipAccess('manager-1', 'tenant-1', 'member-1', {
        mode: 'SELECTED_BRANCHES',
        branchIds: ['branch-1'],
      }),
      ForbiddenException,
    )
    assert.equal(mock.executeCalls.length, 0)
  })

  it('prevents a branch-scoped manager from granting all branches', async () => {
    const { service, executeCalls } = makeScopeMock('SELECTED_BRANCHES')

    await assert.rejects(
      service.updateMembershipAccess('manager-1', 'tenant-1', 'member-1', {
        mode: 'ALL_BRANCHES',
        branchIds: [],
      }),
      ForbiddenException,
    )
    assert.equal(executeCalls.length, 0)
  })

  it('prevents granting a selected branch outside the manager own scope', async () => {
    const { service, executeCalls } = makeScopeMock(
      'SELECTED_BRANCHES',
      [],
      ['branch-2'],
    )

    await assert.rejects(
      service.updateMembershipAccess('manager-1', 'tenant-1', 'member-1', {
        mode: 'SELECTED_BRANCHES',
        branchIds: ['branch-2'],
      }),
      ForbiddenException,
    )
    assert.equal(executeCalls.length, 0)
  })

  it('sets a selected branch scope and writes tenant audit in the same transaction', async () => {
    const { service, executeCalls, transactionOptions } =
      makeScopeMock('SELECTED_BRANCHES', ['branch-1'])

    const result = await service.updateMembershipAccess(
      'manager-1',
      'tenant-1',
      'member-1',
      { mode: 'SELECTED_BRANCHES', branchIds: ['branch-1'] },
    )

    assert.deepEqual(result, {
      membershipId: 'member-1',
      mode: 'SELECTED_BRANCHES',
      branchIds: ['branch-1'],
    })
    assert.equal(transactionOptions[0]?.isolationLevel, 'Serializable')
    assert.match(executeCalls[0].text, /UPDATE "TenantMembership"/)
    assert.match(executeCalls[1].text, /DELETE FROM "BranchMembership"/)
    assert.match(executeCalls[2].text, /INSERT INTO "BranchMembership"/)
    assert.match(executeCalls[3].text, /INSERT INTO "TenantAuditLog"/)
    assert.ok(executeCalls[3].values.includes('tenant-1'))
    assert.ok(executeCalls[3].values.includes('manager-1'))
  })

  it('rejects branches from other tenants and self-scope changes', async () => {
    const crossTenant = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('tm."userId"')) {
          return [{ id: 'actor-membership', branchAccessMode: 'ALL_BRANCHES' }]
        }
        if (call.text.includes('"userId" <>')) {
          return [{ id: 'target-membership' }]
        }
        if (call.text.includes('FROM "Branch"')) return []
        return undefined
      },
    })
    const service = new BranchAccessService(crossTenant.prisma)
    await assert.rejects(
      service.updateMembershipAccess('manager-1', 'tenant-1', 'member-1', {
        mode: 'SELECTED_BRANCHES',
        branchIds: ['foreign-branch'],
      }),
      NotFoundException,
    )
    assert.equal(crossTenant.executeCalls.length, 0)

    const selfMock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('tm."userId"')) {
          return [{ id: 'self-membership', branchAccessMode: 'ALL_BRANCHES' }]
        }
        if (call.text.includes('"userId" <>')) return []
        return undefined
      },
    })
    const selfService = new BranchAccessService(selfMock.prisma)
    await assert.rejects(
      selfService.updateMembershipAccess('manager-1', 'tenant-1', 'self-membership', {
        mode: 'SELECTED_BRANCHES',
        branchIds: [],
      }),
      NotFoundException,
    )
  })

  it('rejects duplicate branch identifiers from direct service callers', async () => {
    const { service } = makeScopeMock('ALL_BRANCHES')
    await assert.rejects(
      service.updateMembershipAccess('manager-1', 'tenant-1', 'member-1', {
        mode: 'SELECTED_BRANCHES',
        branchIds: ['branch-1', 'branch-1'],
      }),
      BadRequestException,
    )
  })
})
