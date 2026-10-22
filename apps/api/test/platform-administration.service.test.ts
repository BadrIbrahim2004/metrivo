import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { PlatformAdministrationService } from '../src/platform-administration.service'
import { createPrismaMock } from './test-helpers'

describe('PlatformAdministrationService', () => {
  it('keeps proposed database guards fail-closed for non-owner writes', () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20261018230000_platform_owner_admin_foundation/migration.sql',
      ),
      'utf8',
    )

    assert.match(migration, /current_user IS DISTINCT FROM relation_owner/)
    assert.match(migration, /platform_owner_assignment_guard[\s\S]*?require_protected_table_owner/)
    assert.match(migration, /platform_owner_permission_guard[\s\S]*?require_protected_table_owner/)
    assert.match(migration, /guard_platform_admin_permission_allowlist/)
    assert.match(migration, /support\.tenant_access[\s\S]*?support\.approve_access/)
    assert.match(migration, /support_access_audit_no_update_delete/)
    assert.match(migration, /support_access_audit_no_truncate/)
    assert.match(migration, /CREATE TABLE public\."PlatformAuditLog"/)
    assert.match(migration, /platform_audit_no_update_delete/)
    assert.match(migration, /platform_audit_no_truncate/)
    assert.doesNotMatch(migration, /session_user\s*(?:<>|=)/)
    assert.doesNotMatch(migration, /VERIFIED_OFFLINE_MAINTENANCE_LOGIN/)
  })

  it('allows the registered owner to assign the admin role without granting permissions', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [],
        [{ allowed: true }],
        [{ id: 'admin-user', status: 'ACTIVE', isOwner: false }],
        [{ id: 'admin-role' }],
      ],
    })
    const service = new PlatformAdministrationService(mock.prisma)

    await service.assignPlatformAdmin('owner-user', 'admin-user')

    assert.equal(mock.transactionCount, 1)
    assert.match(mock.queryCalls[0].text, /pg_advisory_xact_lock/)
    assert.equal(mock.executeCalls.length, 2)
    assert.match(mock.executeCalls[0].text, /INSERT INTO "UserPlatformRole"/)
    assert.match(mock.executeCalls[1].text, /INSERT INTO "PlatformAuditLog"/)
    assert.ok(mock.executeCalls[1].values.includes('owner-user'))
    assert.ok(mock.executeCalls[1].values.includes('PLATFORM_ADMIN_ASSIGNED'))
    assert.doesNotMatch(mock.executeCalls[0].text, /PlatformRolePermission/)
    assert.ok(mock.queryCalls[1].values.includes('owner-user'))
    assert.match(mock.queryCalls[1].text, /state\.initialized = TRUE/)
    assert.ok(mock.queryCalls[3].values.includes('PLATFORM_ADMIN'))
  })

  it('rejects a non-owner attempting to promote themselves', async () => {
    const mock = createPrismaMock()
    const service = new PlatformAdministrationService(mock.prisma)

    await assert.rejects(
      service.assignPlatformAdmin('admin-user', 'admin-user'),
      ForbiddenException,
    )

    assert.equal(mock.transactionCount, 0)
    assert.equal(mock.executeCalls.length, 0)
  })

  it('rejects a non-owner attempting to promote another user', async () => {
    const mock = createPrismaMock({
      queryResults: [[], [{ allowed: false }]],
    })
    const service = new PlatformAdministrationService(mock.prisma)

    await assert.rejects(
      service.assignPlatformAdmin('admin-user', 'target-user'),
      ForbiddenException,
    )

    assert.equal(mock.transactionCount, 1)
    assert.equal(mock.executeCalls.length, 0)
  })

  it('records administrator revocation in the same transaction', async () => {
    const mock = createPrismaMock({
      queryResults: [[], [{ allowed: true }], [{ id: 'admin-role' }]],
    })
    const service = new PlatformAdministrationService(mock.prisma)

    await service.revokePlatformAdmin('owner-user', 'admin-user')

    assert.equal(mock.transactionCount, 1)
    assert.match(mock.executeCalls[0].text, /DELETE FROM "UserPlatformRole"/)
    assert.match(mock.executeCalls[1].text, /INSERT INTO "PlatformAuditLog"/)
    assert.ok(mock.executeCalls[1].values.includes('PLATFORM_ADMIN_REVOKED'))
    assert.ok(mock.executeCalls[1].values.includes('admin-user'))
  })

  it('rejects missing, disabled, or registered-owner admin targets', async () => {
    for (const target of [
      [],
      [{ id: 'target-user', status: 'DISABLED', isOwner: false }],
      [{ id: 'owner-user', status: 'ACTIVE', isOwner: true }],
    ]) {
      const mock = createPrismaMock({
        queryResults: [[], [{ allowed: true }], target],
      })
      const service = new PlatformAdministrationService(mock.prisma)

      await assert.rejects(
        service.assignPlatformAdmin('owner-user', 'target-user'),
        NotFoundException,
      )
      assert.equal(mock.executeCalls.length, 0)
    }
  })

  it('allows the owner to set only explicitly approved operational permissions', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [],
        [{ allowed: true }],
        [{ id: 'admin-role' }],
        [],
        [{ id: 'support-access-permission' }],
      ],
    })
    const service = new PlatformAdministrationService(mock.prisma)

    await service.setPlatformAdminPermissions('owner-user', [
      'support.tenant_access',
    ])

    assert.equal(mock.transactionCount, 1)
    assert.match(mock.queryCalls[0].text, /pg_advisory_xact_lock/)
    assert.equal(mock.executeCalls.length, 3)
    assert.match(mock.executeCalls[0].text, /DELETE FROM "PlatformRolePermission"/)
    assert.match(mock.executeCalls[1].text, /INSERT INTO "PlatformRolePermission"/)
    assert.match(mock.executeCalls[2].text, /INSERT INTO "PlatformAuditLog"/)
    assert.ok(
      mock.executeCalls[2].values.includes(
        'PLATFORM_ADMIN_PERMISSIONS_CHANGED',
      ),
    )
    assert.ok(mock.queryCalls[1].values.includes('owner-user'))
    assert.ok(mock.queryCalls[4].values.includes('support.tenant_access'))
  })

  it('rejects unapproved permissions without writing', async () => {
    const mock = createPrismaMock()
    const service = new PlatformAdministrationService(mock.prisma)

    await assert.rejects(
      service.setPlatformAdminPermissions('owner-user', [
        'platform.owner.transfer',
      ]),
      ForbiddenException,
    )

    assert.equal(mock.transactionCount, 0)
    assert.equal(mock.executeCalls.length, 0)
  })

  it('does not let an administrator change its permissions', async () => {
    const mock = createPrismaMock({
      queryResults: [[], [{ allowed: false }]],
    })
    const service = new PlatformAdministrationService(mock.prisma)

    await assert.rejects(
      service.setPlatformAdminPermissions('admin-user', [
        'support.approve_access',
      ]),
      ForbiddenException,
    )

    assert.equal(mock.executeCalls.length, 0)
  })

  it('propagates an unprovisioned permission failure within the replacement transaction', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [],
        [{ allowed: true }],
        [{ id: 'admin-role' }],
        [],
        [],
      ],
    })
    const service = new PlatformAdministrationService(mock.prisma)

    await assert.rejects(
      service.setPlatformAdminPermissions('owner-user', [
        'support.approve_access',
      ]),
      NotFoundException,
    )

    assert.equal(mock.transactionCount, 1)
    assert.match(mock.executeCalls[0].text, /DELETE FROM "PlatformRolePermission"/)
    assert.equal(mock.executeCalls.length, 1)
  })

  it('fails the permission change when its audit insert fails', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [],
        [{ allowed: true }],
        [{ id: 'admin-role' }],
        [],
        [{ id: 'support-access-permission' }],
      ],
      failAuditWrites: true,
    })
    const service = new PlatformAdministrationService(mock.prisma)

    await assert.rejects(
      service.setPlatformAdminPermissions('owner-user', [
        'support.tenant_access',
      ]),
      /audit storage unavailable/,
    )

    assert.equal(mock.transactionCount, 1)
    assert.match(mock.executeCalls[0].text, /DELETE FROM "PlatformRolePermission"/)
    assert.match(mock.executeCalls[1].text, /INSERT INTO "PlatformRolePermission"/)
    assert.match(mock.executeCalls[2].text, /INSERT INTO "PlatformAuditLog"/)
  })

  it('does not write an audit entry for an unchanged permission set', async () => {
    const mock = createPrismaMock({
      queryResults: [
        [],
        [{ allowed: true }],
        [{ id: 'admin-role' }],
        [{ key: 'support.tenant_access' }],
      ],
    })
    const service = new PlatformAdministrationService(mock.prisma)

    await service.setPlatformAdminPermissions('owner-user', [
      'support.tenant_access',
    ])

    assert.equal(mock.executeCalls.length, 0)
  })
})
