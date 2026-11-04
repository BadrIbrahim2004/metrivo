import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { PrismaService } from './prisma.service'

export const SUBSCRIPTIONS_READ_PERMISSION = 'platform.subscriptions.read'
export const SUBSCRIPTIONS_MANAGE_PERMISSION = 'platform.subscriptions.manage'

export interface SubscriptionPlanRow {
  id: string
  name: string
  period: 'MONTHLY' | 'ANNUAL'
  price: string
  trialDays: number
  isActive: boolean
}

export interface TenantSubscriptionRow {
  tenantId: string
  tenantName: string
  planId: string
  planName: string
  period: 'MONTHLY' | 'ANNUAL'
  status: 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'CANCELLED'
  trialEndsAt: Date | null
  currentPeriodEnd: Date | null
}

export type SubscriptionAction =
  | 'ACTIVATE'
  | 'START_TRIAL'
  | 'SUSPEND'
  | 'RESUME'
  | 'CANCEL'
  | 'EXPIRE'

const PLAN_PERIODS = ['MONTHLY', 'ANNUAL'] as const

function addPeriod(from: Date, period: 'MONTHLY' | 'ANNUAL'): Date {
  const next = new Date(from)
  if (period === 'MONTHLY') next.setMonth(next.getMonth() + 1)
  else next.setFullYear(next.getFullYear() + 1)
  return next
}

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) { }

  /** A tenant may operate only with TRIAL (not ended) or ACTIVE status. */
  private static isOperational(
    status: TenantSubscriptionRow['status'],
    trialEndsAt: Date | null,
    currentPeriodEnd: Date | null,
    now = new Date(),
  ): boolean {
    if (status === 'ACTIVE') {
      return currentPeriodEnd !== null && currentPeriodEnd.getTime() >= now.getTime()
    }
    if (status === 'TRIAL') {
      return trialEndsAt !== null && trialEndsAt.getTime() >= now.getTime()
    }
    return false
  }

  async assertTenantOperational(
    tx: Prisma.TransactionClient,
    tenantId: string,
    now = new Date(),
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{
      status: string
      trialEndsAt: Date | null
      currentPeriodEnd: Date | null
    }>>`
      SELECT ts.status::text AS status, ts."trialEndsAt", ts."currentPeriodEnd"
      FROM "TenantSubscription" ts
      WHERE ts."tenantId" = ${tenantId}
    `
    const subscription = rows[0]
    // No subscription record at all = blocked (strict default).
    if (!subscription) {
      throw new ForbiddenException('This shop has no active subscription')
    }
    if (
      !SubscriptionsService.isOperational(
        subscription.status as TenantSubscriptionRow['status'],
        subscription.trialEndsAt,
        subscription.currentPeriodEnd,
        now,
      )
    ) {
      throw new ForbiddenException(
        `This shop's subscription is ${subscription.status.toLowerCase()}`,
      )
    }
  }

  async listPlans(actorUserId: string): Promise<SubscriptionPlanRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertPlatformPermission(tx, actorUserId, SUBSCRIPTIONS_READ_PERMISSION)
      return tx.$queryRaw<SubscriptionPlanRow[]>`
      SELECT id, name, period::text AS period, price::text AS price,
             "trialDays", "isActive"
      FROM "SubscriptionPlan"
      ORDER BY period, price, name
    `
    })
  }

  async createPlan(
    actorUserId: string,
    input: { name: string; period: 'MONTHLY' | 'ANNUAL'; price: string; trialDays: number },
  ): Promise<SubscriptionPlanRow> {
    const name = input?.name?.trim()
    if (!name || name.length > 100) {
      throw new BadRequestException('Invalid plan name')
    }
    if (!PLAN_PERIODS.includes(input?.period)) {
      throw new BadRequestException('Invalid plan period')
    }
    const price = this.parseMoney(input?.price)
    if (price <= 0n) throw new BadRequestException('Plan price must be positive')
    if (!Number.isSafeInteger(input?.trialDays) || input.trialDays < 0 || input.trialDays > 365) {
      throw new BadRequestException('Invalid trial days')
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertPlatformPermission(tx, actorUserId, SUBSCRIPTIONS_MANAGE_PERMISSION)
      const duplicate = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "SubscriptionPlan"
        WHERE name = ${name} AND period = ${input.period}::"PlanPeriod"
      `
      if (duplicate[0]) {
        throw new ConflictException('A plan with this name and period already exists')
      }
      const rows = await tx.$queryRaw<SubscriptionPlanRow[]>`
        INSERT INTO "SubscriptionPlan"
          (id, name, period, price, "trialDays", "isActive", "createdAt")
        VALUES
          (${randomUUID()}, ${name}, ${input.period}::"PlanPeriod",
           ${this.formatMoney(price)}::numeric, ${input.trialDays}, TRUE, CURRENT_TIMESTAMP)
        RETURNING id, name, period::text AS period, price::text AS price,
                  "trialDays", "isActive"
      `
      await this.writeAudit(tx, actorUserId, null, 'PLAN_CREATED', {
        planId: rows[0].id, name, period: input.period,
      })
      return rows[0]
    })
  }

  async listTenantSubscriptions(actorUserId: string): Promise<TenantSubscriptionRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertPlatformPermission(tx, actorUserId, SUBSCRIPTIONS_READ_PERMISSION)
      return tx.$queryRaw<TenantSubscriptionRow[]>`
      SELECT ts."tenantId", t.name AS "tenantName", ts."planId",
             p.name AS "planName", p.period::text AS period,
             ts.status::text AS status, ts."trialEndsAt", ts."currentPeriodEnd"
      FROM "TenantSubscription" ts
      JOIN "Tenant" t ON t.id = ts."tenantId"
      JOIN "SubscriptionPlan" p ON p.id = ts."planId"
      ORDER BY t.name, ts."tenantId"
      LIMIT 500
    `
    })
  }

  async startOrChangeSubscription(
    actorUserId: string,
    tenantId: string,
    input: { planId: string; startTrial: boolean },
  ): Promise<TenantSubscriptionRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertPlatformPermission(tx, actorUserId, SUBSCRIPTIONS_MANAGE_PERMISSION)
      const plans = await tx.$queryRaw<Array<{
        id: string
        period: 'MONTHLY' | 'ANNUAL'
        trialDays: number
        isActive: boolean
      }>>`
        SELECT id, period::text AS period, "trialDays", "isActive"
        FROM "SubscriptionPlan"
        WHERE id = ${input.planId} AND "isActive" = TRUE
        FOR UPDATE
      `
      const plan = plans[0]
      if (!plan) throw new NotFoundException('Active plan not found')
      const tenants = await tx.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT id, name FROM "Tenant" WHERE id = ${tenantId}
      `
      if (!tenants[0]) throw new NotFoundException('Tenant not found')
      const now = new Date()
      const trialEndsAt = input.startTrial && plan.trialDays > 0
        ? new Date(now.getTime() + plan.trialDays * 86_400_000)
        : null
      const currentPeriodEnd = input.startTrial && plan.trialDays > 0
        ? null
        : addPeriod(now, plan.period)
      const status: TenantSubscriptionRow['status'] = input.startTrial && plan.trialDays > 0
        ? 'TRIAL'
        : 'ACTIVE'

      const existing = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status::text AS status FROM "TenantSubscription"
        WHERE "tenantId" = ${tenantId} FOR UPDATE
      `
      if (existing[0]) {
        if (existing[0].status === 'ACTIVE') {
          throw new ConflictException('Tenant already has an active subscription; suspend or cancel it first')
        }
        await tx.$executeRaw`
          UPDATE "TenantSubscription"
          SET "planId" = ${plan.id}, status = ${status}::"SubscriptionStatus",
              "trialEndsAt" = ${trialEndsAt}, "currentPeriodEnd" = ${currentPeriodEnd},
              "suspendedAt" = NULL, "cancelledAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ${existing[0].id}
        `
      } else {
        await tx.$executeRaw`
          INSERT INTO "TenantSubscription"
            (id, "tenantId", "planId", status, "trialEndsAt", "currentPeriodEnd",
             "createdAt", "updatedAt")
          VALUES
            (${randomUUID()}, ${tenantId}, ${plan.id}, ${status}::"SubscriptionStatus",
             ${trialEndsAt}, ${currentPeriodEnd}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `
      }
      await this.writeAudit(tx, actorUserId, tenantId, 'SUBSCRIPTION_ASSIGNED', {
        planId: plan.id, startTrial: input.startTrial,
      })
      return {
        tenantId,
        tenantName: tenants[0].name,
        planId: plan.id,
        planName: '',
        period: plan.period,
        status,
        trialEndsAt,
        currentPeriodEnd,
      }
    })
  }

  async changeSubscriptionState(
    actorUserId: string,
    tenantId: string,
    action: SubscriptionAction,
  ): Promise<TenantSubscriptionRow> {
    if (
      !['ACTIVATE', 'START_TRIAL', 'SUSPEND', 'RESUME', 'CANCEL', 'EXPIRE'].includes(action)
    ) {
      throw new BadRequestException('Invalid subscription action')
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertPlatformPermission(tx, actorUserId, SUBSCRIPTIONS_MANAGE_PERMISSION)
      const rows = await tx.$queryRaw<Array<{
        id: string
        status: string
        trialEndsAt: Date | null
        currentPeriodEnd: Date | null
      }>>`
        SELECT ts.id, ts.status::text AS status, ts."trialEndsAt", ts."currentPeriodEnd"
        FROM "TenantSubscription" ts
        WHERE ts."tenantId" = ${tenantId} FOR UPDATE
      `
      const subscription = rows[0]
      if (!subscription) throw new NotFoundException('Tenant subscription not found')
      const current = subscription.status as TenantSubscriptionRow['status']
      let status: TenantSubscriptionRow['status']
      let suspendedAt: Date | null = null
      let cancelledAt: Date | null = null
      switch (action) {
        case 'SUSPEND':
          if (current !== 'ACTIVE' && current !== 'TRIAL') {
            throw new ConflictException('Only active or trial subscriptions can be suspended')
          }
          status = 'SUSPENDED'
          suspendedAt = new Date()
          break
        case 'RESUME':
          if (current !== 'SUSPENDED') {
            throw new ConflictException('Only suspended subscriptions can be resumed')
          }
          status = subscription.currentPeriodEnd &&
            subscription.currentPeriodEnd.getTime() >= Date.now() ? 'ACTIVE' : 'EXPIRED'
          break
        case 'CANCEL':
          if (current === 'CANCELLED') {
            throw new ConflictException('Subscription is already cancelled')
          }
          status = 'CANCELLED'
          cancelledAt = new Date()
          break
        case 'EXPIRE':
          if (current !== 'ACTIVE' && current !== 'TRIAL') {
            throw new ConflictException('Only active or trial subscriptions can be expired')
          }
          status = 'EXPIRED'
          break
        default:
          throw new BadRequestException('Use startOrChangeSubscription to activate or start a trial')
      }
      await tx.$executeRaw`
        UPDATE "TenantSubscription"
        SET status = ${status}::"SubscriptionStatus",
            "suspendedAt" = ${suspendedAt},
            "cancelledAt" = ${cancelledAt},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${subscription.id}
      `
      await this.writeAudit(tx, actorUserId, tenantId, `SUBSCRIPTION_${action}`, {
        from: current, to: status,
      })
      return this.getSubscriptionRow(tx, tenantId)
    })
  }

  private async getSubscriptionRow(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<TenantSubscriptionRow> {
    const rows = await tx.$queryRaw<TenantSubscriptionRow[]>`
      SELECT ts."tenantId", t.name AS "tenantName", ts."planId",
             p.name AS "planName", p.period::text AS period,
             ts.status::text AS status, ts."trialEndsAt", ts."currentPeriodEnd"
      FROM "TenantSubscription" ts
      JOIN "Tenant" t ON t.id = ts."tenantId"
      JOIN "SubscriptionPlan" p ON p.id = ts."planId"
      WHERE ts."tenantId" = ${tenantId}
    `
    if (!rows[0]) throw new NotFoundException('Tenant subscription not found')
    return rows[0]
  }

  private async assertPlatformPermission(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    permissionKey: string,
  ): Promise<void> {
    if (!actorUserId) throw new ForbiddenException('Authenticated user is required')
    const rows = await tx.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "UserPlatformRole" upr
        JOIN "PlatformRolePermission" prp ON prp."platformRoleId" = upr."platformRoleId"
        JOIN "PlatformPermission" pp ON pp.id = prp."platformPermissionId"
        WHERE upr."userId" = ${actorUserId} AND pp.key = ${permissionKey}
      ) AS allowed
    `
    if (!rows[0]?.allowed) {
      throw new ForbiddenException('Platform permission required')
    }
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    tenantId: string | null,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "SubscriptionAuditLog"
        (id, "tenantId", "actorUserId", action, metadata, "occurredAt")
      VALUES
        (${randomUUID()}, ${tenantId}, ${actorUserId}, ${action},
         ${JSON.stringify(metadata)}::jsonb, CURRENT_TIMESTAMP)
    `
  }

  private parseMoney(value: string): bigint {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)) {
      throw new BadRequestException('Invalid monetary amount')
    }
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  }

  private formatMoney(cents: bigint): string {
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
  }
}
