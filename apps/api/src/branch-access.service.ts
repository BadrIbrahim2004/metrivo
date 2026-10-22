import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { PrismaService } from './prisma.service'
import { TENANT_MEMBERS_MANAGE_PERMISSION } from './product-permissions'
import type { UpdateBranchAccessDto } from './branch-access.dto'

interface ActorMembership {
  id: string
  branchAccessMode: 'ALL_BRANCHES' | 'SELECTED_BRANCHES'
}

@Injectable()
export class BranchAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async updateMembershipAccess(
    actorUserId: string,
    tenantId: string,
    targetMembershipId: string,
    input: UpdateBranchAccessDto,
  ): Promise<{ membershipId: string; mode: string; branchIds: string[] }> {
    if (
      typeof actorUserId !== 'string' ||
      !actorUserId ||
      typeof tenantId !== 'string' ||
      !tenantId ||
      typeof targetMembershipId !== 'string' ||
      !targetMembershipId ||
      !input ||
      !['ALL_BRANCHES', 'SELECTED_BRANCHES'].includes(input.mode) ||
      !Array.isArray(input.branchIds) ||
      input.branchIds.some((branchId) => typeof branchId !== 'string' || !branchId)
    ) {
      throw new BadRequestException('Invalid branch access request')
    }
    const branchIds = [...new Set(input.branchIds)]
    if (
      (input.mode === 'ALL_BRANCHES' && branchIds.length !== 0) ||
      (input.mode === 'SELECTED_BRANCHES' && branchIds.length !== input.branchIds.length)
    ) {
      throw new BadRequestException('Branch assignments do not match access mode')
    }

    return this.prisma.$transaction(async (tx) => {
      const actorRows = await tx.$queryRaw<ActorMembership[]>`
        SELECT tm.id, tm."branchAccessMode"::text AS "branchAccessMode"
        FROM "TenantMembership" tm
        WHERE tm."userId" = ${actorUserId}
          AND tm."tenantId" = ${tenantId}
          AND tm.status = 'ACTIVE'
          AND EXISTS (
            SELECT 1
            FROM "MembershipRole" mr
            JOIN "Role" r
              ON r.id = mr."roleId"
             AND r."tenantId" = mr."tenantId"
            JOIN "TenantRolePermission" trp ON trp."roleId" = r.id
            JOIN "TenantPermission" tp ON tp.id = trp."permissionId"
            WHERE mr."membershipId" = tm.id
              AND mr."tenantId" = tm."tenantId"
              AND tp.key = ${TENANT_MEMBERS_MANAGE_PERMISSION}
          )
        FOR UPDATE
      `
      const actor = actorRows[0]
      if (!actor) {
        throw new ForbiddenException('Tenant member-management permission required')
      }
      if (input.mode === 'ALL_BRANCHES' && actor.branchAccessMode !== 'ALL_BRANCHES') {
        throw new ForbiddenException('Cannot grant branch access beyond your own scope')
      }

      const targetRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "TenantMembership"
        WHERE id = ${targetMembershipId}
          AND "tenantId" = ${tenantId}
          AND status = 'ACTIVE'
          AND "userId" <> ${actorUserId}
        FOR UPDATE
      `
      if (!targetRows[0]) {
        throw new NotFoundException('Active tenant membership not found')
      }

      if (branchIds.length > 0) {
        const branches = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Branch"
          WHERE "tenantId" = ${tenantId}
            AND id IN (${Prisma.join(branchIds)})
        `
        if (branches.length !== branchIds.length) {
          throw new NotFoundException('One or more branches were not found')
        }

        if (actor.branchAccessMode !== 'ALL_BRANCHES') {
          const actorBranches = await tx.$queryRaw<Array<{ branchId: string }>>`
            SELECT "branchId"
            FROM "BranchMembership"
            WHERE "membershipId" = ${actor.id}
              AND "tenantId" = ${tenantId}
              AND "branchId" IN (${Prisma.join(branchIds)})
          `
          if (actorBranches.length !== branchIds.length) {
            throw new ForbiddenException(
              'Cannot grant access to a branch outside your own scope',
            )
          }
        }
      }

      await tx.$executeRaw`
        UPDATE "TenantMembership"
        SET "branchAccessMode" = ${input.mode}::"BranchAccessMode",
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${targetMembershipId}
          AND "tenantId" = ${tenantId}
      `
      await tx.$executeRaw`
        DELETE FROM "BranchMembership"
        WHERE "membershipId" = ${targetMembershipId}
          AND "tenantId" = ${tenantId}
      `
      for (const branchId of branchIds) {
        await tx.$executeRaw`
          INSERT INTO "BranchMembership"
            (id, "membershipId", "tenantId", "branchId", "createdAt")
          VALUES
            (${randomUUID()}, ${targetMembershipId}, ${tenantId},
             ${branchId}, CURRENT_TIMESTAMP)
        `
      }
      await tx.$executeRaw`
        INSERT INTO "TenantAuditLog"
          (id, "tenantId", "actorUserId", "targetMembershipId",
           action, metadata, "occurredAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${actorUserId},
           ${targetMembershipId}, 'MEMBERSHIP_BRANCH_ACCESS_CHANGED',
           ${JSON.stringify({ mode: input.mode, branchIds })}::jsonb,
           CURRENT_TIMESTAMP)
      `

      return { membershipId: targetMembershipId, mode: input.mode, branchIds }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }
}
