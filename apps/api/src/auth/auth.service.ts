import {
  ConflictException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { UserStatus } from '@prisma/client'
import { hash, verify } from 'argon2'
import { randomBytes } from 'node:crypto'
import { PrismaService } from '../prisma.service'
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants'
import { normalizeEmail } from './email-normalization'
import { PASSWORD_HASH_OPTIONS } from './password-hashing'
import type { ChangeOwnPasswordDto } from './change-own-password.dto'
import type { LoginDto } from './login.dto'

const INVALID_CREDENTIALS = 'Invalid email or password'

export interface LoginResult {
  accessToken: string
  tokenType: 'Bearer'
  expiresIn: typeof ACCESS_TOKEN_TTL_SECONDS
  user: {
    id: string
    email: string
    name: string | null
  }
}

export interface WorkspaceBranch {
  tenantId: string
  tenantName: string
  branchId: string
  branchName: string
}

export interface UserPermissions {
  permissions: string[]
  isPlatformOwner: boolean
  userName: string | null
}

export interface TenantRoleOption {
  id: string
  name: string
}

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyPasswordHash!: string

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyPasswordHash = await hash(
      randomBytes(32),
      { ...PASSWORD_HASH_OPTIONS, raw: false },
    )
  }

  async login(credentials: LoginDto): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: normalizeEmail(credentials.email) },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        status: true,
      },
    })

    const passwordHash =
      user?.status === UserStatus.ACTIVE &&
      typeof user.passwordHash === 'string' &&
      user.passwordHash.length > 0
        ? user.passwordHash
        : this.dummyPasswordHash
    const passwordMatches = await verify(
      passwordHash,
      credentials.password,
    )

    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      typeof user.passwordHash !== 'string' ||
      user.passwordHash.length === 0 ||
      !passwordMatches
    ) {
      throw new UnauthorizedException(INVALID_CREDENTIALS)
    }

    const accessToken = await this.jwt.signAsync({ sub: user.id })

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    }
  }

  async getWorkspaceBranches(userId: string): Promise<WorkspaceBranch[]> {
    return this.prisma.$queryRaw<WorkspaceBranch[]>`
      SELECT DISTINCT
        tm."tenantId",
        t.name AS "tenantName",
        b.id AS "branchId",
        b.name AS "branchName"
      FROM "TenantMembership" tm
      JOIN "Tenant" t ON t.id = tm."tenantId"
      JOIN "Branch" b ON b."tenantId" = tm."tenantId"
      WHERE tm."userId" = ${userId}
        AND tm.status = 'ACTIVE'
        AND (
          tm."branchAccessMode" = 'ALL_BRANCHES'
          OR EXISTS (
            SELECT 1
            FROM "BranchMembership" bm
            WHERE bm."membershipId" = tm.id
              AND bm."tenantId" = tm."tenantId"
              AND bm."branchId" = b.id
          )
        )
      ORDER BY t.name, b.name
    `
  }

  async getUserPermissions(
    userId: string,
    tenantId: string,
  ): Promise<UserPermissions> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, status: true },
    })
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Authenticated user is required')
    }

    const permissionRows = await this.prisma.$queryRaw<
      Array<{ permissionKey: string }>
    >`
      SELECT DISTINCT tp.key AS "permissionKey"
      FROM "TenantMembership" tm
      JOIN "User" u
        ON u.id = tm."userId"
       AND u.status = 'ACTIVE'
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
    `
    const ownerRows = await this.prisma.$queryRaw<
      Array<{ isPlatformOwner: boolean }>
    >`
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
      ) AS "isPlatformOwner"
    `

    return {
      permissions: permissionRows.map(({ permissionKey }) => permissionKey),
      isPlatformOwner: ownerRows[0]?.isPlatformOwner ?? false,
      userName: user.name,
    }
  }

  async getTenantRoles(
    userId: string,
    tenantId: string,
  ): Promise<TenantRoleOption[]> {
    return this.prisma.$queryRaw<TenantRoleOption[]>`
      SELECT DISTINCT r.id, r.name
      FROM "Role" r
      WHERE r."tenantId" = ${tenantId}
        AND r."isInviteAssignable" = TRUE
        AND r.name <> 'Owner'
        AND EXISTS (
          SELECT 1
          FROM "TenantMembership" tm
          JOIN "User" u
            ON u.id = tm."userId"
           AND u.status = 'ACTIVE'
          JOIN "MembershipRole" mr
            ON mr."membershipId" = tm.id
           AND mr."tenantId" = tm."tenantId"
          JOIN "Role" membershipRole
            ON membershipRole.id = mr."roleId"
           AND membershipRole."tenantId" = mr."tenantId"
          WHERE tm."userId" = ${userId}
            AND tm."tenantId" = ${tenantId}
            AND tm.status = 'ACTIVE'
            AND membershipRole.name = 'Owner'
        )
      ORDER BY r.name
    `
  }

  async changeOwnPassword(
    userId: string,
    input: ChangeOwnPasswordDto,
  ): Promise<{ changed: true }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, status: true },
    })
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      typeof user.passwordHash !== 'string' ||
      user.passwordHash.length === 0 ||
      !(await verify(user.passwordHash, input.currentPassword))
    ) {
      throw new ConflictException('Current password is incorrect')
    }
    if (input.currentPassword === input.newPassword) {
      throw new ConflictException('New password must be different')
    }

    const passwordHash = await hash(input.newPassword, PASSWORD_HASH_OPTIONS)
    const updated = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "User"
      SET "passwordHash" = ${passwordHash},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${userId}
        AND "passwordHash" = ${user.passwordHash}
        AND status = 'ACTIVE'
      RETURNING id
    `
    if (!updated[0]) {
      throw new ConflictException('Password changed by another request')
    }
    return { changed: true }
  }
}
