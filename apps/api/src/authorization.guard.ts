import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { randomUUID } from 'node:crypto'
import { PrismaService } from './prisma.service'
import {
  IS_PUBLIC_ROUTE,
  AUTHENTICATED_ONLY,
  PLATFORM_OWNER_ONLY,
  PLATFORM_PERMISSION,
  TENANT_PERMISSION,
} from './authz.decorator'

interface AuthorizationRequest {
  user?: { userId?: unknown }
  params?: Record<string, string | undefined>
  method?: string
  route?: { path?: string }
}

@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, targets)) {
      return true
    }

    const platformPermission = this.reflector.getAllAndOverride<string>(
      PLATFORM_PERMISSION,
      targets,
    )
    const tenantPermission = this.reflector.getAllAndOverride<string>(
      TENANT_PERMISSION,
      targets,
    )
    const platformOwnerOnly =
      this.reflector.getAllAndOverride<boolean>(PLATFORM_OWNER_ONLY, targets)
    const authenticatedOnly =
      this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY, targets)

    const policyCount =
      Number(Boolean(platformPermission)) +
      Number(Boolean(tenantPermission)) +
      Number(Boolean(platformOwnerOnly)) +
      Number(Boolean(authenticatedOnly))
    if (policyCount !== 1) {
      throw new ForbiddenException('Route has no unambiguous authorization policy')
    }

    const request =
      context.switchToHttp().getRequest<AuthorizationRequest>()
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }

    if (authenticatedOnly) {
      return true
    }

    if (platformOwnerOnly) {
      const rows = await this.prisma.$queryRaw<Array<{ allowed: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM "PlatformOwnerRegistry" por
          JOIN "PlatformOwnershipState" state
            ON state.singleton = TRUE
          JOIN "User" u ON u.id = por."ownerUserId"
          JOIN "UserPlatformRole" upr
            ON upr."userId" = por."ownerUserId"
          JOIN "PlatformRole" role
            ON role.id = upr."platformRoleId"
          WHERE por.singleton = TRUE
            AND por."ownerUserId" = ${userId}
            AND state.initialized = TRUE
            AND u.status = 'ACTIVE'
            AND role.key = 'PLATFORM_OWNER'
        ) AS allowed
      `
      if (!rows[0]?.allowed) {
        throw new ForbiddenException('Registered active platform owner required')
      }
      return true
    }

    if (platformPermission) {
      const rows = await this.prisma.$queryRaw<Array<{ allowed: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM "UserPlatformRole" upr
          JOIN "PlatformRolePermission" prp
            ON prp."platformRoleId" = upr."platformRoleId"
          JOIN "PlatformPermission" pp
            ON pp.id = prp."platformPermissionId"
          WHERE upr."userId" = ${userId}
            AND pp.key = ${platformPermission}
        ) AS allowed
      `
      if (!rows[0]?.allowed) {
        throw new ForbiddenException('Platform permission required')
      }
      return true
    }

    const tenantId = request.params?.tenantId
    if (!tenantId) {
      throw new ForbiddenException('A tenant route parameter is required')
    }

    const membershipRows = await this.prisma.$queryRaw<
      Array<{ allowed: boolean }>
    >`
      SELECT EXISTS (
        SELECT 1
        FROM "TenantMembership" tm
        JOIN "MembershipRole" mr
          ON mr."membershipId" = tm.id
         AND mr."tenantId" = tm."tenantId"
        JOIN "Role" r
          ON r.id = mr."roleId"
         AND r."tenantId" = mr."tenantId"
        JOIN "TenantRolePermission" trp ON trp."roleId" = r.id
        JOIN "TenantPermission" tp ON tp.id = trp."permissionId"
        WHERE tm."userId" = ${userId}
          AND tm."tenantId" = ${tenantId}
          AND tm.status = 'ACTIVE'
          AND tp.key = ${tenantPermission}
      ) AS allowed
    `

    if (membershipRows[0]?.allowed) {
      return true
    }

    const grants = await this.prisma.$queryRaw<
      Array<{ id: string; reason: string }>
    >`
      SELECT g.id, g.reason
      FROM "SupportAccessGrant" g
      JOIN "SupportAccessGrantPermission" gap ON gap."grantId" = g.id
      JOIN "TenantPermission" tp ON tp.id = gap."permissionId"
      WHERE g."supportUserId" = ${userId}
        AND g."tenantId" = ${tenantId}
        AND g."startsAt" <= CURRENT_TIMESTAMP
        AND g."expiresAt" > CURRENT_TIMESTAMP
        AND g."revokedAt" IS NULL
        AND tp.key = ${tenantPermission}
        AND tp."supportEligible" = TRUE
        AND EXISTS (
          SELECT 1
          FROM "UserPlatformRole" upr
          JOIN "PlatformRolePermission" prp
            ON prp."platformRoleId" = upr."platformRoleId"
          JOIN "PlatformPermission" pp
            ON pp.id = prp."platformPermissionId"
          WHERE upr."userId" = g."supportUserId"
            AND pp.key = 'support.tenant_access'
        )
        AND EXISTS (
          SELECT 1
          FROM "UserPlatformRole" upr
          JOIN "PlatformRolePermission" prp
            ON prp."platformRoleId" = upr."platformRoleId"
          JOIN "PlatformPermission" pp
            ON pp.id = prp."platformPermissionId"
          WHERE upr."userId" = g."approvedByUserId"
            AND pp.key = 'support.approve_access'
        )
      ORDER BY g."expiresAt" ASC
      LIMIT 1
    `

    const grant = grants[0]
    if (!grant) {
      throw new ForbiddenException('Tenant permission required')
    }

    const resource = `${request.method ?? 'UNKNOWN'} ${request.route?.path ?? ''}`.slice(
      0,
      500,
    )
    await this.prisma.$executeRaw`
      INSERT INTO "SupportAccessAuditLog"
        (id, "grantId", "actorUserId", "tenantId", action, "permissionKey", reason, resource)
      VALUES
        (${randomUUID()}, ${grant.id}, ${userId}, ${tenantId}, 'ACCESS',
         ${tenantPermission}, ${grant.reason}, ${resource})
    `
    return true
  }
}
