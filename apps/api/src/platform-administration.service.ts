import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from './prisma.service'
import { writePlatformAudit } from './platform-audit-log'
import {
  PLATFORM_ADMIN_PERMISSION_ALLOWLIST,
  PLATFORM_ADMIN_ROLE_KEY,
  PLATFORM_OWNER_ROLE_KEY,
} from './platform-role.constants'

@Injectable()
export class PlatformAdministrationService {
  constructor(private readonly prisma: PrismaService) {}

  async assignPlatformAdmin(
    actorUserId: string,
    targetUserId: string,
  ): Promise<void> {
    if (actorUserId === targetUserId) {
      throw new ForbiddenException('A platform administrator cannot promote themselves')
    }

    await this.prisma.$transaction(async (tx) => {
      await this.lockOwnership(tx)
      await this.assertRegisteredOwner(tx, actorUserId)

      const targets = await tx.$queryRaw<
        Array<{ id: string; status: string; isOwner: boolean }>
      >`
        SELECT
          u.id,
          u.status::text AS status,
          EXISTS (
            SELECT 1
            FROM "PlatformOwnerRegistry" por
            WHERE por.singleton = TRUE
              AND por."ownerUserId" = u.id
          ) OR EXISTS (
            SELECT 1
            FROM "UserPlatformRole" owner_assignment
            JOIN "PlatformRole" owner_role
              ON owner_role.id = owner_assignment."platformRoleId"
            WHERE owner_assignment."userId" = u.id
              AND owner_role.key = ${PLATFORM_OWNER_ROLE_KEY}
          ) AS "isOwner"
        FROM "User" u
        WHERE u.id = ${targetUserId}
      `
      const target = targets[0]
      if (!target || target.status !== 'ACTIVE' || target.isOwner) {
        throw new NotFoundException('Eligible platform administrator target not found')
      }

      const roles = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "PlatformRole"
        WHERE key = ${PLATFORM_ADMIN_ROLE_KEY}
      `
      const role = roles[0]
      if (!role) {
        throw new NotFoundException('Platform roles have not been provisioned')
      }

      const inserted = await tx.$executeRaw`
        INSERT INTO "UserPlatformRole" ("userId", "platformRoleId", "createdAt")
        VALUES (${targetUserId}, ${role.id}, CURRENT_TIMESTAMP)
        ON CONFLICT ("userId", "platformRoleId") DO NOTHING
      `

      if (inserted > 0) {
        await writePlatformAudit(tx, {
          actorUserId,
          action: 'PLATFORM_ADMIN_ASSIGNED',
          targetType: 'USER',
          targetId: targetUserId,
          metadata: { roleKey: PLATFORM_ADMIN_ROLE_KEY },
        })
      }
    })
  }

  async revokePlatformAdmin(
    actorUserId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOwnership(tx)
      await this.assertRegisteredOwner(tx, actorUserId)

      const roleRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "PlatformRole"
        WHERE key = ${PLATFORM_ADMIN_ROLE_KEY}
      `
      const role = roleRows[0]
      if (!role) {
        throw new NotFoundException('Platform roles have not been provisioned')
      }

      const revoked = await tx.$executeRaw`
        DELETE FROM "UserPlatformRole"
        WHERE "userId" = ${targetUserId}
          AND "platformRoleId" = ${role.id}
      `

      if (revoked > 0) {
        await writePlatformAudit(tx, {
          actorUserId,
          action: 'PLATFORM_ADMIN_REVOKED',
          targetType: 'USER',
          targetId: targetUserId,
          metadata: { roleKey: PLATFORM_ADMIN_ROLE_KEY },
        })
      }
    })
  }

  async setPlatformAdminPermissions(
    actorUserId: string,
    permissionKeys: readonly string[],
  ): Promise<void> {
    const uniqueKeys = [...new Set(permissionKeys)]
    const allowedPermissions = new Set<string>(
      PLATFORM_ADMIN_PERMISSION_ALLOWLIST,
    )
    if (
      uniqueKeys.length !== permissionKeys.length ||
      uniqueKeys.some((key) => !allowedPermissions.has(key))
    ) {
      throw new ForbiddenException(
        'Permission is not approved for platform administrators',
      )
    }

    await this.prisma.$transaction(async (tx) => {
      await this.lockOwnership(tx)
      await this.assertRegisteredOwner(tx, actorUserId)

      const roles = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "PlatformRole"
        WHERE key = ${PLATFORM_ADMIN_ROLE_KEY}
      `
      const role = roles[0]
      if (!role) {
        throw new NotFoundException('Platform roles have not been provisioned')
      }

      const currentPermissions = await tx.$queryRaw<
        Array<{ key: string }>
      >`
        SELECT permission.key
        FROM "PlatformRolePermission" role_permission
        JOIN "PlatformPermission" permission
          ON permission.id = role_permission."platformPermissionId"
        WHERE role_permission."platformRoleId" = ${role.id}
      `
      const currentKeys = new Set(currentPermissions.map(({ key }) => key))
      const requestedKeys = new Set(uniqueKeys)
      const grantedPermissionKeys = uniqueKeys.filter(
        (key) => !currentKeys.has(key),
      )
      const revokedPermissionKeys = [...currentKeys].filter(
        (key) => !requestedKeys.has(key),
      )

      if (grantedPermissionKeys.length === 0 && revokedPermissionKeys.length === 0) {
        return
      }

      await tx.$executeRaw`
        DELETE FROM "PlatformRolePermission"
        WHERE "platformRoleId" = ${role.id}
      `

      for (const permissionKey of uniqueKeys) {
        const permissions = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM "PlatformPermission"
          WHERE key = ${permissionKey}
        `
        const permission = permissions[0]
        if (!permission) {
          throw new NotFoundException(
            `Platform permission has not been provisioned: ${permissionKey}`,
          )
        }

        await tx.$executeRaw`
          INSERT INTO "PlatformRolePermission"
            ("platformRoleId", "platformPermissionId", "createdAt")
          VALUES (${role.id}, ${permission.id}, CURRENT_TIMESTAMP)
          ON CONFLICT ("platformRoleId", "platformPermissionId") DO NOTHING
        `
      }

      await writePlatformAudit(tx, {
        actorUserId,
        action: 'PLATFORM_ADMIN_PERMISSIONS_CHANGED',
        targetType: 'PLATFORM_ROLE',
        targetId: PLATFORM_ADMIN_ROLE_KEY,
        metadata: { grantedPermissionKeys, revokedPermissionKeys },
      })
    })
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
