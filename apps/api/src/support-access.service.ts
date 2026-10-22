import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { PrismaService } from './prisma.service'

const MAX_GRANT_DURATION_MS = 60 * 60 * 1000
const MIN_REASON_LENGTH = 10
const MAX_REASON_LENGTH = 1000
const MAX_GRANT_PERMISSION_COUNT = 5

export interface CreateSupportAccessGrant {
  supportUserId: string
  tenantId: string
  reason: string
  expiresAt: Date
  permissionKeys: string[]
}

@Injectable()
export class SupportAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async createGrant(
    input: CreateSupportAccessGrant,
    approvedByUserId: string,
  ): Promise<string> {
    const reason = this.validateReason(input.reason)
    const now = new Date()
    if (
      !(input.expiresAt instanceof Date) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt <= now ||
      input.expiresAt.getTime() - now.getTime() > MAX_GRANT_DURATION_MS
    ) {
      throw new BadRequestException(
        'Support access must expire within one hour',
      )
    }
    if (!approvedByUserId || input.supportUserId === approvedByUserId) {
      throw new BadRequestException(
        'The support operator cannot approve their own access',
      )
    }

    const permissionKeys = [...new Set(input.permissionKeys)]
    if (
      permissionKeys.length === 0 ||
      permissionKeys.length > MAX_GRANT_PERMISSION_COUNT ||
      permissionKeys.some((key) => !key || key.length > 200)
    ) {
      throw new BadRequestException(
        `Grant between one and ${MAX_GRANT_PERMISSION_COUNT} specific permissions`,
      )
    }

    const grantId = randomUUID()
    await this.prisma.$transaction(async (tx) => {
      await this.assertPlatformPermission(
        tx,
        approvedByUserId,
        'support.approve_access',
      )
      await this.assertPlatformPermission(
        tx,
        input.supportUserId,
        'support.tenant_access',
      )

      const permissionIds: string[] = []
      for (const key of permissionKeys) {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM "TenantPermission"
          WHERE key = ${key} AND "supportEligible" = TRUE
        `
        if (!rows[0]) {
          throw new NotFoundException(
            `Tenant permission is unknown or not support-eligible: ${key}`,
          )
        }
        permissionIds.push(rows[0].id)
      }

      await tx.$executeRaw`
        INSERT INTO "SupportAccessGrant"
          (id, "supportUserId", "approvedByUserId", "tenantId", reason,
           "startsAt", "expiresAt", "createdAt", "updatedAt")
        VALUES
          (${grantId}, ${input.supportUserId}, ${approvedByUserId},
           ${input.tenantId}, ${reason}, ${now}, ${input.expiresAt}, ${now}, ${now})
      `

      for (const permissionId of permissionIds) {
        await tx.$executeRaw`
          INSERT INTO "SupportAccessGrantPermission"
            ("grantId", "permissionId", "createdAt")
          VALUES (${grantId}, ${permissionId}, ${now})
        `
      }

      await this.writeAudit(tx, {
        grantId,
        actorUserId: approvedByUserId,
        tenantId: input.tenantId,
        action: 'GRANT_CREATED',
        reason,
      })
    })

    return grantId
  }

  async revokeGrant(
    grantId: string,
    actorUserId: string,
    reasonInput: string,
  ): Promise<void> {
    const reason = this.validateReason(reasonInput)
    const now = new Date()

    await this.prisma.$transaction(async (tx) => {
      await this.assertPlatformPermission(
        tx,
        actorUserId,
        'support.approve_access',
      )
      const grants = await tx.$queryRaw<
        Array<{ tenantId: string }>
      >`
        UPDATE "SupportAccessGrant"
        SET "revokedAt" = ${now}, "updatedAt" = ${now}
        WHERE id = ${grantId} AND "revokedAt" IS NULL
        RETURNING "tenantId"
      `
      const grant = grants[0]
      if (!grant) {
        throw new NotFoundException('Active support access grant not found')
      }

      await this.writeAudit(tx, {
        grantId,
        actorUserId,
        tenantId: grant.tenantId,
        action: 'GRANT_REVOKED',
        reason,
      })
    })
  }

  private validateReason(input: string): string {
    const reason = input.trim()
    if (
      reason.length < MIN_REASON_LENGTH ||
      reason.length > MAX_REASON_LENGTH
    ) {
      throw new BadRequestException(
        `Reason must contain ${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} characters`,
      )
    }
    return reason
  }

  private async assertPlatformPermission(
    tx: Prisma.TransactionClient,
    userId: string,
    permissionKey: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "UserPlatformRole" upr
        JOIN "PlatformRolePermission" prp
          ON prp."platformRoleId" = upr."platformRoleId"
        JOIN "PlatformPermission" pp
          ON pp.id = prp."platformPermissionId"
        WHERE upr."userId" = ${userId}
          AND pp.key = ${permissionKey}
      ) AS allowed
    `
    if (!rows[0]?.allowed) {
      throw new ForbiddenException('Required platform permission is missing')
    }
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    event: {
      grantId: string
      actorUserId: string
      tenantId: string
      action: string
      reason: string
    },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "SupportAccessAuditLog"
        (id, "grantId", "actorUserId", "tenantId", action, reason)
      VALUES
        (${randomUUID()}, ${event.grantId}, ${event.actorUserId},
         ${event.tenantId}, ${event.action}, ${event.reason})
    `
  }
}
