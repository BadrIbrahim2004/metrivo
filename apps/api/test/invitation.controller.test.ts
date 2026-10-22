import 'reflect-metadata'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { UnauthorizedException } from '@nestjs/common'
import {
  IS_PUBLIC_ROUTE,
  PLATFORM_OWNER_ONLY,
} from '../src/authz.decorator'
import {
  AcceptInvitationDto,
  CreateTenantInvitationDto,
} from '../src/invitation.dto'
import { InvitationController } from '../src/invitation.controller'
import type { InvitationService } from '../src/invitation.service'

function makeController() {
  const calls: Array<{ method: string; values: unknown[] }> = []
  const service = {
    async createTenantInvitation(...values: unknown[]) {
      calls.push({ method: 'create', values })
      return { token: 'only-returned-by-create', expiresAt: new Date() }
    },
    async revokeTenantInvitation(...values: unknown[]) {
      calls.push({ method: 'revoke', values })
    },
    async consumeAcceptanceRateLimit(...values: unknown[]) {
      calls.push({ method: 'limit', values })
    },
    async acceptInvitation(...values: unknown[]) {
      calls.push({ method: 'accept', values })
      return { accepted: true as const }
    },
  }

  return {
    controller: new InvitationController(
      service as unknown as InvitationService,
    ),
    calls,
  }
}

describe('InvitationController', () => {
  it('protects creation and revocation with the registered-owner policy', () => {
    assert.equal(
      Reflect.getMetadata(
        PLATFORM_OWNER_ONLY,
        InvitationController.prototype.create,
      ),
      true,
    )
    assert.equal(
      Reflect.getMetadata(
        PLATFORM_OWNER_ONLY,
        InvitationController.prototype.revoke,
      ),
      true,
    )
    assert.notEqual(
      Reflect.getMetadata(
        IS_PUBLIC_ROUTE,
        InvitationController.prototype.create,
      ),
      true,
    )
  })

  it('takes the invitation actor from the authenticated principal', async () => {
    const { controller, calls } = makeController()
    const body = Object.assign(new CreateTenantInvitationDto(), {
      email: 'user@example.com',
      tenantId: 'tenant-1',
      roleId: 'role-1',
      actorUserId: 'forged-admin',
    })

    const result = await controller.create(
      { user: { userId: 'verified-owner' } },
      body,
    )

    assert.equal(result.token, 'only-returned-by-create')
    assert.deepEqual(calls[0].values, [
      'verified-owner',
      body,
    ])
  })

  it('rejects missing principals on administrative operations', async () => {
    const { controller, calls } = makeController()

    await assert.rejects(
      async () =>
        controller.create(
          {},
          Object.assign(new CreateTenantInvitationDto(), {
            email: 'user@example.com',
            tenantId: 'tenant-1',
            roleId: 'role-1',
          }),
        ),
      UnauthorizedException,
    )
    await assert.rejects(
      async () => controller.revoke({}, 'invite-1'),
      UnauthorizedException,
    )
    assert.equal(calls.length, 0)
  })

  it('accepts only token and password and rate-limits using the direct peer address', async () => {
    const { controller, calls } = makeController()
    const dto = Object.assign(new AcceptInvitationDto(), {
      token: 'A'.repeat(43),
      password: 'correct horse battery staple',
    })
    const result = await controller.accept(
      {
        socket: { remoteAddress: '192.0.2.10' },
      },
      dto,
    )

    assert.deepEqual(result, { accepted: true })
    assert.deepEqual(calls, [
      { method: 'limit', values: ['192.0.2.10'] },
      {
        method: 'accept',
        values: [dto.token, dto.password],
      },
    ])
    assert.equal(
      Reflect.getMetadata(
        IS_PUBLIC_ROUTE,
        InvitationController.prototype.accept,
      ),
      true,
    )
  })

  it('rejects extra identity, role, or tenant fields on invitation acceptance', () => {
    const dto = plainToInstance(AcceptInvitationDto, {
      token: 'A'.repeat(43),
      password: 'correct horse battery staple',
      email: 'attacker@example.com',
      tenantId: 'attacker-tenant',
      roleId: 'platform-owner-role',
    })

    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    })

    assert.deepEqual(
      errors.flatMap((error) => Object.keys(error.constraints ?? {})).length,
      3,
    )
  })

  it('rejects extra identity fields on invitation creation under the global validation policy', () => {
    const dto = plainToInstance(CreateTenantInvitationDto, {
      email: 'user@example.com',
      tenantId: 'tenant-1',
      roleId: 'role-1',
      actorUserId: 'forged-owner',
      platformRole: 'PLATFORM_OWNER',
    })

    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    })

    assert.equal(
      errors.flatMap((error) => Object.keys(error.constraints ?? {})).length,
      2,
    )
  })

  it('does not attempt token acceptance after the distributed limiter denies the request', async () => {
    const calls: string[] = []
    const service = {
      async consumeAcceptanceRateLimit() {
        calls.push('rate-limit')
        throw new Error('rate limited')
      },
      async acceptInvitation() {
        calls.push('accept')
        return { accepted: true as const }
      },
    }
    const controller = new InvitationController(
      service as unknown as InvitationService,
    )

    await assert.rejects(
      controller.accept(
        { socket: { remoteAddress: '192.0.2.10' } },
        Object.assign(new AcceptInvitationDto(), {
          token: 'A'.repeat(43),
          password: 'correct horse battery staple',
        }),
      ),
      /rate limited/,
    )
    assert.deepEqual(calls, ['rate-limit'])
  })
})
