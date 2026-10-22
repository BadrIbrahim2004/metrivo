import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { isEmail } from 'class-validator'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { hashPassword } from './auth/password-hashing'
import { normalizeEmail } from './auth/email-normalization'
import { PrismaService } from './prisma.service'
import { writePlatformAudit } from './platform-audit-log'
import {
  PLATFORM_ADMIN_ROLE_KEY,
  PLATFORM_OWNER_ROLE_KEY,
} from './platform-role.constants'

const INVITATION_TTL_MILLISECONDS = 72 * 60 * 60 * 1000
const INVALID_INVITATION_MESSAGE = 'Invitation is invalid or no longer available'
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ACCEPTANCE_RATE_LIMIT = 10
const ACCEPTANCE_RATE_WINDOW_SECONDS = 60

export interface CreateTenantInvitationInput {
  email: string
  tenantId: string
  roleId: string
}

export interface CreatedTenantInvitation {
  token: string
  expiresAt: Date
}

interface InvitationRecord {
  id: string
  email: string
  emailNormalized: string
  tenantId: string
  roleId: string
  rolePermissionsHash: string
}

interface InvitationRolePolicyRow {
  id: string
  name: string
  isInviteAssignable: boolean
  permissionKey: string | null
}

@Injectable()
export class InvitationService {
  constructor(private readonly prisma: PrismaService) {}

  async consumeAcceptanceRateLimit(sourceAddress: string): Promise<void> {
    const keyHash = createHash('sha256')
      .update(sourceAddress.slice(0, 128), 'utf8')
      .digest('hex')
    const rows = await this.prisma.$queryRaw<Array<{ allowed: boolean }>>`
      INSERT INTO "InvitationAcceptanceRateLimit"
        ("keyHash", "windowStartedAt", "requestCount", "updatedAt")
      VALUES (${keyHash}, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)
      ON CONFLICT ("keyHash") DO UPDATE
      SET
        "requestCount" = CASE
          WHEN "InvitationAcceptanceRateLimit"."windowStartedAt"
            <= CURRENT_TIMESTAMP -
              make_interval(secs => ${ACCEPTANCE_RATE_WINDOW_SECONDS})
          THEN 1
          ELSE "InvitationAcceptanceRateLimit"."requestCount" + 1
        END,
        "windowStartedAt" = CASE
          WHEN "InvitationAcceptanceRateLimit"."windowStartedAt"
            <= CURRENT_TIMESTAMP -
              make_interval(secs => ${ACCEPTANCE_RATE_WINDOW_SECONDS})
          THEN CURRENT_TIMESTAMP
          ELSE "InvitationAcceptanceRateLimit"."windowStartedAt"
        END,
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "requestCount" <= ${ACCEPTANCE_RATE_LIMIT} AS allowed
    `

    await this.prisma.$executeRaw`
      DELETE FROM "InvitationAcceptanceRateLimit"
      WHERE "updatedAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'
    `

    if (!rows[0]?.allowed) {
      throw new HttpException(
        'Too many invitation attempts; try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }

  async createTenantInvitation(
    actorUserId: string,
    input: CreateTenantInvitationInput,
  ): Promise<CreatedTenantInvitation> {
    const email = this.validateEmail(input.email)
    if (!input.tenantId || !input.roleId) {
      throw new BadRequestException('A tenant and tenant role are required')
    }

    const emailNormalized = normalizeEmail(email)
    const token = randomBytes(32).toString('base64url')
    const tokenHash = this.hashToken(token)
    const invitationId = randomUUID()
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MILLISECONDS)

    await this.prisma.$transaction(async (tx) => {
      await this.lockOwnership(tx)
      await this.assertRegisteredOwner(tx, actorUserId)

      const rolePolicy = await this.getInvitationRolePolicy(
        tx,
        input.roleId,
        input.tenantId,
      )
      if (!rolePolicy) {
        throw new NotFoundException('Tenant role not found')
      }
      if (!this.isRoleInviteAssignable(rolePolicy)) {
        throw new ForbiddenException('Tenant role is not approved for invitations')
      }

      await tx.$executeRaw`
        INSERT INTO "TenantInvitation"
          ("id", "tokenHash", "email", "emailNormalized", "tenantId", "roleId",
           "rolePermissionsHash", "invitedByUserId", "createdAt", "expiresAt")
        VALUES (
          ${invitationId},
          ${tokenHash},
          ${email},
          ${emailNormalized},
          ${input.tenantId},
          ${input.roleId},
          ${rolePolicy.permissionsHash},
          ${actorUserId},
          CURRENT_TIMESTAMP,
          ${expiresAt}
        )
      `

      await writePlatformAudit(tx, {
        actorUserId,
        action: 'TENANT_INVITATION_CREATED',
        targetType: 'TENANT_INVITATION',
        targetId: invitationId,
        metadata: {
          tenantId: input.tenantId,
          roleId: input.roleId,
        },
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    return { token, expiresAt }
  }

  async revokeTenantInvitation(
    actorUserId: string,
    invitationId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOwnership(tx)
      await this.assertRegisteredOwner(tx, actorUserId)

      const rows = await tx.$queryRaw<
        Array<{ tenantId: string; roleId: string }>
      >`
        UPDATE "TenantInvitation"
        SET "revokedAt" = CURRENT_TIMESTAMP
        WHERE id = ${invitationId}
          AND "acceptedAt" IS NULL
          AND "revokedAt" IS NULL
          AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING "tenantId", "roleId"
      `
      const invitation = rows[0]
      if (!invitation) {
        throw new BadRequestException(INVALID_INVITATION_MESSAGE)
      }

      await writePlatformAudit(tx, {
        actorUserId,
        action: 'TENANT_INVITATION_REVOKED',
        targetType: 'TENANT_INVITATION',
        targetId: invitationId,
        metadata: {
          tenantId: invitation.tenantId,
          roleId: invitation.roleId,
        },
      })
    })
  }

  async acceptInvitation(
    token: string,
    password: string,
  ): Promise<{ accepted: true }> {
    if (typeof token !== 'string' || !INVITATION_TOKEN_PATTERN.test(token)) {
      throw new BadRequestException(INVALID_INVITATION_MESSAGE)
    }
    if (
      typeof password !== 'string' ||
      password.length < 12 ||
      password.length > 128
    ) {
      throw new BadRequestException(
        'Password must contain between 12 and 128 characters',
      )
    }

    const tokenHash = this.hashToken(token)
    const available = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "TenantInvitation"
      WHERE "tokenHash" = ${tokenHash}
        AND "acceptedAt" IS NULL
        AND "revokedAt" IS NULL
        AND "expiresAt" > CURRENT_TIMESTAMP
    `
    if (!available[0]) {
      throw new BadRequestException(INVALID_INVITATION_MESSAGE)
    }

    const passwordHash = await hashPassword(password)

    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<InvitationRecord[]>`
        UPDATE "TenantInvitation"
        SET "acceptedAt" = CURRENT_TIMESTAMP
        WHERE "tokenHash" = ${tokenHash}
          AND "acceptedAt" IS NULL
          AND "revokedAt" IS NULL
          AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING id, email, "emailNormalized", "tenantId", "roleId",
                  "rolePermissionsHash"
      `
      const invitation = rows[0]
      if (!invitation) {
        throw new BadRequestException(INVALID_INVITATION_MESSAGE)
      }

      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(127987, hashtext(${invitation.emailNormalized}))
      `

      const rolePolicy = await this.getInvitationRolePolicy(
        tx,
        invitation.roleId,
        invitation.tenantId,
      )
      if (
        !rolePolicy ||
        !this.isRoleInviteAssignable(rolePolicy) ||
        rolePolicy.permissionsHash !== invitation.rolePermissionsHash
      ) {
        throw new BadRequestException(INVALID_INVITATION_MESSAGE)
      }

      const userId = randomUUID()
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "User"
          (id, email, "emailNormalized", "passwordHash", status, "createdAt", "updatedAt")
        VALUES (
          ${userId},
          ${invitation.email},
          ${invitation.emailNormalized},
          ${passwordHash},
          'ACTIVE',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT ("emailNormalized") DO NOTHING
        RETURNING id
      `
      if (!users[0]) {
        throw new BadRequestException(INVALID_INVITATION_MESSAGE)
      }

      const membershipId = randomUUID()
      await tx.$executeRaw`
        INSERT INTO "TenantMembership"
          (id, "userId", "tenantId", status, "createdAt", "updatedAt")
        VALUES (
          ${membershipId},
          ${userId},
          ${invitation.tenantId},
          'ACTIVE',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `
      await tx.$executeRaw`
        INSERT INTO "MembershipRole"
          (id, "membershipId", "tenantId", "roleId", "createdAt", "updatedAt")
        VALUES (
          ${randomUUID()},
          ${membershipId},
          ${invitation.tenantId},
          ${invitation.roleId},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `

      await writePlatformAudit(tx, {
        actorUserId: userId,
        action: 'TENANT_INVITATION_ACCEPTED',
        targetType: 'TENANT_INVITATION',
        targetId: invitation.id,
        metadata: {
          tenantId: invitation.tenantId,
          roleId: invitation.roleId,
        },
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    return { accepted: true }
  }

  private validateEmail(email: string): string {
    if (typeof email !== 'string') {
      throw new BadRequestException('A valid email address is required')
    }
    const normalized = normalizeEmail(email)
    if (
      email.length > 254 ||
      normalized.length > 254 ||
      !isEmail(normalized)
    ) {
      throw new BadRequestException('A valid email address is required')
    }
    return email.trim()
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex')
  }

  private async getInvitationRolePolicy(
    tx: Prisma.TransactionClient,
    roleId: string,
    tenantId: string,
  ): Promise<{
    id: string
    name: string
    isInviteAssignable: boolean
    permissionsHash: string
  } | null> {
    const rows = await tx.$queryRaw<InvitationRolePolicyRow[]>`
      SELECT r.id, r.name, r."isInviteAssignable",
             tp.key AS "permissionKey"
      FROM "Role" r
      LEFT JOIN "TenantRolePermission" trp ON trp."roleId" = r.id
      LEFT JOIN "TenantPermission" tp ON tp.id = trp."permissionId"
      WHERE r.id = ${roleId}
        AND r."tenantId" = ${tenantId}
    `
    if (rows.length === 0) {
      return null
    }

    const permissionKeys = rows
      .map(({ permissionKey }) => permissionKey)
      .filter((permissionKey): permissionKey is string => permissionKey !== null)
      .sort()
    const permissionsHash = createHash('sha256')
      .update(JSON.stringify(permissionKeys), 'utf8')
      .digest('hex')
    const { id, name, isInviteAssignable } = rows[0]

    return { id, name, isInviteAssignable, permissionsHash }
  }

  private isRoleInviteAssignable(
    role: Pick<InvitationRolePolicyRow, 'name' | 'isInviteAssignable'>,
  ): boolean {
    return (
      role.isInviteAssignable &&
      role.name !== PLATFORM_OWNER_ROLE_KEY &&
      role.name !== PLATFORM_ADMIN_ROLE_KEY
    )
  }

  private async assertRegisteredOwner(
    tx: Prisma.TransactionClient,
    actorUserId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "PlatformOwnerRegistry" por
        JOIN "PlatformOwnershipState" state
          ON state.singleton = TRUE
        JOIN "User" u ON u.id = por."ownerUserId"
        JOIN "UserPlatformRole" upr ON upr."userId" = u.id
        JOIN "PlatformRole" pr ON pr.id = upr."platformRoleId"
        WHERE por.singleton = TRUE
          AND state.initialized = TRUE
          AND por."ownerUserId" = ${actorUserId}
          AND u.status = 'ACTIVE'
          AND pr.key = ${PLATFORM_OWNER_ROLE_KEY}
      ) AS allowed
    `
    if (!rows[0]?.allowed) {
      throw new ForbiddenException('Registered active platform owner required')
    }
  }

  private async lockOwnership(
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(127987, 1)
    `
  }
}
