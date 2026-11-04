import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isEmail } from 'class-validator'
import { normalizeEmail } from './auth/email-normalization'
import { PrismaService } from './prisma.service'
import { writePlatformAudit } from './platform-audit-log'
import { PLATFORM_OWNER_ROLE_KEY } from './platform-role.constants'

const NAME_MAX = 200
const DEFAULT_TRIAL_DAYS = 14
const MAX_TRIAL_DAYS = 90
// Matches the invitation system TTL so acceptance windows stay consistent.
const INVITATION_TTL_MILLISECONDS = 72 * 60 * 60 * 1000

export interface CreateTenantInput {
  tenantName: string
  branchName: string
  ownerEmail: string
  trialDays?: number
}

export interface CreatedTenantOnboarding {
  tenantId: string
  branchId: string
  ownerEmail: string
  invitationToken: string
  invitationExpiresAt: Date
  trialDays: number | null
  subscriptionStatus: 'TRIAL' | 'NONE'
}

@Injectable()
export class TenantOnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async createTenant(
    actorUserId: string,
    input: CreateTenantInput,
  ): Promise<CreatedTenantOnboarding> {
    const tenantName = input?.tenantName?.trim() ?? ''
    const branchName = input?.branchName?.trim() ?? ''
    const ownerEmailRaw = input?.ownerEmail?.trim() ?? ''
    if (!tenantName || tenantName.length > NAME_MAX) {
      throw new BadRequestException('A tenant name of at most 200 characters is required')
    }
    if (!branchName || branchName.length > NAME_MAX) {
      throw new BadRequestException('A branch name of at most 200 characters is required')
    }
    const emailNormalized = normalizeEmail(ownerEmailRaw)
    if (
      !ownerEmailRaw ||
      ownerEmailRaw.length > 254 ||
      emailNormalized.length > 254 ||
      !isEmail(emailNormalized)
    ) {
      throw new BadRequestException('A valid owner email address is required')
    }
    const trialDays =
      input.trialDays === undefined || input.trialDays === null
        ? DEFAULT_TRIAL_DAYS
        : input.trialDays
    if (!Number.isSafeInteger(trialDays) || trialDays < 0 || trialDays > MAX_TRIAL_DAYS) {
      throw new BadRequestException(
        `Trial days must be an integer between 0 and ${MAX_TRIAL_DAYS}`,
      )
    }

    const invitationToken = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(invitationToken, 'utf8').digest('hex')
    const invitationExpiresAt = new Date(Date.now() + INVITATION_TTL_MILLISECONDS)
    const trialEndsAt = trialDays > 0
      ? new Date(Date.now() + trialDays * 86_400_000)
      : null

    return this.prisma.$transaction(async (tx) => {
      // Defense-in-depth: re-verify registered platform ownership inside the
      // transaction; the route guard should already have enforced this.
      await this.assertRegisteredOwner(tx, actorUserId)
      // Explicit text cast keeps the lock result deserializable by Prisma.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(127987, 2)::text`

      const duplicateTenant = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Tenant" WHERE name = ${tenantName}
      `
      if (duplicateTenant[0]) {
        throw new ConflictException('A tenant with this name already exists')
      }
      // An existing account would make the invitation un-acceptable (the
      // acceptance flow only creates new accounts), so refuse early with a
      // clear conflict instead of an unusable invitation.
      const existingAccount = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "User" WHERE "emailNormalized" = ${emailNormalized}
      `
      if (existingAccount[0]) {
        throw new ConflictException(
          'An account already exists with this email; invitations require a new account',
        )
      }

      const tenantId = randomUUID()
      const branchId = randomUUID()
      const roleId = randomUUID()

      await tx.$executeRaw`
        INSERT INTO "Tenant" (id, name, "createdAt", "updatedAt")
        VALUES (${tenantId}, ${tenantName}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
      await tx.$executeRaw`
        INSERT INTO "Branch" (id, "tenantId", name, "createdAt", "updatedAt")
        VALUES (${branchId}, ${tenantId}, ${branchName}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
      // Tenant owner role: granted every currently-defined tenant permission so
      // the shop owner can administer the shop without platform-side role work.
      await tx.$executeRaw`
        INSERT INTO "Role" (id, "tenantId", name, "isInviteAssignable",
                            "createdAt", "updatedAt")
        VALUES (${roleId}, ${tenantId}, 'Owner', TRUE,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
      await tx.$executeRaw`
        INSERT INTO "TenantRolePermission" (id, "roleId", "permissionId",
                                            "createdAt", "updatedAt")
        SELECT 'trp-' || replace(gen_random_uuid()::text, '-', ''), ${roleId}, tp.id,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM "TenantPermission" tp
      `

      // permissionsHash must match the invitation acceptance flow exactly:
      // sha256 over the JSON of the sorted permission keys.
      const permissionKeyRows = await tx.$queryRaw<Array<{ key: string }>>`
        SELECT tp.key FROM "TenantRolePermission" trp
        JOIN "TenantPermission" tp ON tp.id = trp."permissionId"
        WHERE trp."roleId" = ${roleId}
      `
      const permissionKeys = permissionKeyRows
        .map((row) => row.key)
        .sort()
      const rolePermissionsHash = createHash('sha256')
        .update(JSON.stringify(permissionKeys), 'utf8')
        .digest('hex')

      // No membership is pre-created: the existing, hardened invitation
      // acceptance flow creates the user account and the ACTIVE membership
      // with the assigned role when the owner accepts with their own password.
      await tx.$executeRaw`
        INSERT INTO "TenantInvitation"
          ("id", "tokenHash", "email", "emailNormalized", "tenantId", "roleId",
           "rolePermissionsHash", "invitedByUserId", "branchId", "createdAt", "expiresAt")
        VALUES (
          ${randomUUID()}, ${tokenHash}, ${ownerEmailRaw}, ${emailNormalized},
          ${tenantId}, ${roleId}, ${rolePermissionsHash},
          ${actorUserId}, ${branchId}, CURRENT_TIMESTAMP, ${invitationExpiresAt}
        )
      `

      if (trialDays > 0) {
        // Trial subscription on a dedicated inactive plan row. The plan price
        // must satisfy the positive-price CHECK, so the placeholder uses the
        // minimum representable amount; it is never charged — the platform
        // owner assigns a real paid plan when the trial converts.
        const trialPlanId = randomUUID()
        await tx.$executeRaw`
          INSERT INTO "SubscriptionPlan"
            (id, name, period, price, "trialDays", "isActive", "createdAt")
          VALUES
            (${trialPlanId}, ${'Trial — ' + tenantName}, 'MONTHLY',
             '0.01'::numeric, 0, FALSE, CURRENT_TIMESTAMP)
        `
        await tx.$executeRaw`
          INSERT INTO "TenantSubscription"
            (id, "tenantId", "planId", status, "trialEndsAt",
             "createdAt", "updatedAt")
          VALUES (
            ${randomUUID()}, ${tenantId}, ${trialPlanId}, 'TRIAL',
            ${trialEndsAt}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `
      }

      await writePlatformAudit(tx, {
        actorUserId,
        action: 'TENANT_ONBOARDED',
        targetType: 'TENANT',
        targetId: tenantId,
        metadata: {
          tenantName,
          branchName,
          ownerEmail: emailNormalized,
          trialDays: trialDays > 0 ? String(trialDays) : '',
        },
        })

      return {
        tenantId,
        branchId,
        ownerEmail: emailNormalized,
        invitationToken,
        invitationExpiresAt,
        trialDays: trialDays > 0 ? trialDays : null,
        subscriptionStatus: trialDays > 0 ? 'TRIAL' : 'NONE',
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  private async assertRegisteredOwner(
    tx: Prisma.TransactionClient,
    actorUserId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "PlatformOwnerRegistry" por
        JOIN "PlatformOwnershipState" state ON state.singleton = TRUE
        JOIN "User" u ON u.id = por."ownerUserId"
        JOIN "UserPlatformRole" upr ON upr."userId" = por."ownerUserId"
        JOIN "PlatformRole" role ON role.id = upr."platformRoleId"
        WHERE por.singleton = TRUE
          AND por."ownerUserId" = ${actorUserId}
          AND state.initialized = TRUE
          AND u.status = 'ACTIVE'
          AND role.key = ${PLATFORM_OWNER_ROLE_KEY}
      ) AS allowed
    `
    if (!rows[0]?.allowed) {
      throw new ForbiddenException('Registered active platform owner required')
    }
  }
}
