import {
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
}
