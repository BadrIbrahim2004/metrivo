import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { PrismaService } from './prisma.service'
import { getExpectedDrawerCash } from './cash-drawer'
import {
  CloseCashShiftDto,
  CreateCashMovementDto,
  OpenCashShiftDto,
  SettleRefundDto,
} from './cash-management.dto'

export const CASH_READ_PERMISSION = 'cash.read'
export const CASH_MANAGE_PERMISSION = 'cash.manage'
export const REFUNDS_SETTLE_PERMISSION = 'refunds.settle'

export interface CashShiftRow {
  id: string
  tenantId: string
  branchId: string
  status: 'OPEN' | 'CLOSED'
  openingCash: string
  expectedCash: string | null
  countedCash: string | null
  discrepancy: string | null
  openedAt: Date
  closedAt: Date | null
}

export interface PendingRefundRow {
  id: string
  saleId: string
  invoiceNumber: string
  refundAmount: string
  reason: string
  createdAt: Date
}

const CASH_METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const

@Injectable()
export class CashManagementService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentShift(actorUserId: string, tenantId: string, branchId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, CASH_READ_PERMISSION,
      )
      const rows = await tx.$queryRaw<CashShiftRow[]>`
        SELECT id, "tenantId", "branchId", status::text AS status,
               "openingCash"::text AS "openingCash",
               "expectedCash"::text AS "expectedCash",
               "countedCash"::text AS "countedCash",
               discrepancy::text AS discrepancy, "openedAt", "closedAt"
        FROM "CashShift"
        WHERE "tenantId" = ${tenantId} AND "branchId" = ${branchId}
          AND status = 'OPEN'
      `
      if (!rows[0]) return { shift: null }
      return {
        shift: { ...rows[0], expectedCash: await this.getExpectedCash(tx, rows[0]) },
      }
    })
  }

  async listPendingRefunds(actorUserId: string, tenantId: string, branchId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, CASH_READ_PERMISSION,
      )
      return tx.$queryRaw<PendingRefundRow[]>`
        SELECT sr.id, sr."saleId", s."invoiceNumber",
               sr."refundAmount"::text AS "refundAmount",
               sr.reason, sr."createdAt"
        FROM "SaleReturn" sr
        JOIN "Sale" s
          ON s.id = sr."saleId" AND s."tenantId" = sr."tenantId"
        WHERE sr."tenantId" = ${tenantId}
          AND sr."branchId" = ${branchId}
          AND sr."refundStatus" = 'PENDING'
        ORDER BY sr."createdAt", sr.id
        LIMIT 100
      `
    })
  }

  async listMovements(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    cashShiftId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, CASH_READ_PERMISSION,
      )
      return tx.$queryRaw<Array<{
        id: string
        type: string
        amount: string
        reason: string
        actorUserId: string
        createdAt: Date
      }>>`
        SELECT id, type::text AS type, amount::text AS amount, reason,
               "actorUserId", "createdAt"
        FROM "CashMovement"
        WHERE "tenantId" = ${tenantId} AND "branchId" = ${branchId}
          AND "cashShiftId" = ${cashShiftId}
        ORDER BY "createdAt" DESC, id DESC
        LIMIT 100
      `
    })
  }

  async listShiftHistory(
    actorUserId: string,
    tenantId: string,
    branchId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, CASH_READ_PERMISSION,
      )
      return tx.$queryRaw<Array<{
        id: string
        status: string
        openingCash: string
        expectedCash: string | null
        countedCash: string | null
        discrepancy: string | null
        openedAt: Date
        closedAt: Date | null
        openedByUserId: string
        closedByUserId: string | null
      }>>`
        SELECT id, status::text AS status,
               "openingCash"::text AS "openingCash",
               "expectedCash"::text AS "expectedCash",
               "countedCash"::text AS "countedCash",
               discrepancy::text AS discrepancy,
               "openedAt", "closedAt",
               "openedByUserId", "closedByUserId"
        FROM "CashShift"
        WHERE "tenantId" = ${tenantId} AND "branchId" = ${branchId}
          AND status = 'CLOSED'
        ORDER BY "closedAt" DESC NULLS LAST, id DESC
        LIMIT 20
      `
    })
  }

  async openShift(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: OpenCashShiftDto,
  ) {
    const openingCents = this.parseMoney(input?.openingCash)
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, CASH_MANAGE_PERMISSION,
      )
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${tenantId}), hashtext(${'cash-shift:' + branchId})
        )::text
      `
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "CashShift"
        WHERE "tenantId" = ${tenantId} AND "branchId" = ${branchId}
          AND status = 'OPEN'
      `
      if (existing.length) {
        throw new ConflictException('A cash shift is already open for this branch')
      }
      const id = randomUUID()
      const shifts = await tx.$queryRaw<CashShiftRow[]>`
        INSERT INTO "CashShift"
          (id, "tenantId", "branchId", "openedByUserId", status,
           "openingCash", "openedAt")
        VALUES
          (${id}, ${tenantId}, ${branchId}, ${actorUserId}, 'OPEN',
           ${this.formatMoney(openingCents)}::numeric, CURRENT_TIMESTAMP)
        RETURNING id, "tenantId", "branchId", status::text AS status,
                  "openingCash"::text AS "openingCash", NULL::text AS "expectedCash",
                  NULL::text AS "countedCash", NULL::text AS discrepancy,
                  "openedAt", NULL::timestamptz AS "closedAt"
      `
      await this.writeAudit(tx, tenantId, branchId, id, actorUserId, 'CASH_SHIFT_OPENED', {
        openingCash: this.formatMoney(openingCents),
      })
      return { ...shifts[0], expectedCash: this.formatMoney(openingCents) }
    })
  }

  async recordMovement(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    cashShiftId: string,
    idempotencyKey: string,
    input: CreateCashMovementDto,
  ) {
    const amountCents = this.parseMoney(input?.amount)
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
    if (
      !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey) ||
      !['CASH_IN', 'CASH_OUT'].includes(input?.type) ||
      amountCents <= 0n ||
      reason.length < 1 ||
      reason.length > 500
    ) throw new BadRequestException('Invalid cash movement')
    const requestHash = this.hash(JSON.stringify({
      type: input.type, amountCents: amountCents.toString(), reason,
    }))

    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, CASH_MANAGE_PERMISSION,
      )
      const shifts = await tx.$queryRaw<Array<{
        id: string
        status: string
        openingCash: string
      }>>`
        SELECT id, status::text AS status, "openingCash"::text AS "openingCash"
        FROM "CashShift"
        WHERE id = ${cashShiftId} AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
        FOR UPDATE
      `
      const shift = shifts[0]
      if (!shift) throw new NotFoundException('Cash shift not found')
      const prior = await tx.$queryRaw<Array<{
        id: string
        requestHash: string
        type: string
        amount: string
        reason: string
        createdAt: Date
      }>>`
        SELECT id, "requestHash", type::text AS type,
               amount::text AS amount, reason, "createdAt"
        FROM "CashMovement"
        WHERE "tenantId" = ${tenantId} AND "cashShiftId" = ${cashShiftId}
          AND "actorUserId" = ${actorUserId} AND "idempotencyKey" = ${idempotencyKey}
      `
      if (prior[0]) {
        if (prior[0].requestHash.trim() !== requestHash) {
          throw new ConflictException('Idempotency key was used for a different cash movement')
        }
        return {
          id: prior[0].id,
          type: prior[0].type,
          amount: prior[0].amount,
          reason: prior[0].reason,
          createdAt: prior[0].createdAt,
        }
      }
      if (shift.status !== 'OPEN') {
        throw new ConflictException('Cash movement requires an open shift')
      }
      if (
        input.type === 'CASH_OUT' &&
        amountCents > this.parseMoney(await this.getExpectedCash(tx, {
          id: cashShiftId,
          tenantId,
          openingCash: shift.openingCash,
        }))
      ) {
        throw new BadRequestException('Cash-out exceeds the expected drawer balance')
      }
      const rows = await tx.$queryRaw<Array<{
        id: string
        type: string
        amount: string
        reason: string
        createdAt: Date
      }>>`
        INSERT INTO "CashMovement"
          (id, "tenantId", "branchId", "cashShiftId", "actorUserId",
           "idempotencyKey", "requestHash", type, amount, reason, "createdAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${cashShiftId}, ${actorUserId},
           ${idempotencyKey}, ${requestHash}, ${input.type}::"CashMovementType",
           ${this.formatMoney(amountCents)}::numeric, ${reason}, CURRENT_TIMESTAMP)
        RETURNING id, type::text AS type, amount::text AS amount, reason, "createdAt"
      `
      await this.writeAudit(tx, tenantId, branchId, cashShiftId, actorUserId, input.type, {
        amount: this.formatMoney(amountCents), reason,
      })
      return rows[0]
    })
  }

  async closeShift(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    cashShiftId: string,
    input: CloseCashShiftDto,
  ) {
    const countedCents = this.parseMoney(input?.countedCash)
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, CASH_MANAGE_PERMISSION,
      )
      const rows = await tx.$queryRaw<CashShiftRow[]>`
        SELECT id, "tenantId", "branchId", status::text AS status,
               "openingCash"::text AS "openingCash",
               "expectedCash"::text AS "expectedCash",
               "countedCash"::text AS "countedCash",
               discrepancy::text AS discrepancy, "openedAt", "closedAt"
        FROM "CashShift"
        WHERE id = ${cashShiftId} AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
        FOR UPDATE
      `
      const shift = rows[0]
      if (!shift) throw new NotFoundException('Cash shift not found')
      if (shift.status !== 'OPEN') throw new ConflictException('Cash shift is already closed')
      const expected = await this.getExpectedCash(tx, shift)
      const expectedCents = this.parseMoney(expected)
      const discrepancy = this.formatMoney(countedCents - expectedCents)
      const closed = await tx.$queryRaw<CashShiftRow[]>`
        UPDATE "CashShift"
        SET status = 'CLOSED', "closedByUserId" = ${actorUserId},
            "expectedCash" = ${expected}::numeric,
            "countedCash" = ${this.formatMoney(countedCents)}::numeric,
            discrepancy = ${discrepancy}::numeric,
            "closedAt" = CURRENT_TIMESTAMP
        WHERE id = ${cashShiftId} AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId} AND status = 'OPEN'
        RETURNING id, "tenantId", "branchId", status::text AS status,
                  "openingCash"::text AS "openingCash",
                  "expectedCash"::text AS "expectedCash",
                  "countedCash"::text AS "countedCash",
                  discrepancy::text AS discrepancy, "openedAt", "closedAt"
      `
      await this.writeAudit(tx, tenantId, branchId, cashShiftId, actorUserId, 'CASH_SHIFT_CLOSED', {
        expectedCash: expected,
        countedCash: this.formatMoney(countedCents),
        discrepancy,
      })
      return closed[0]
    })
  }

  async settleRefund(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    saleReturnId: string,
    cashShiftId: string,
    idempotencyKey: string,
    input: SettleRefundDto,
  ) {
    if (
      !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey) ||
      !CASH_METHODS.includes(input?.method) ||
      (input.reference != null && (
        typeof input.reference !== 'string' || input.reference.length > 200
      ))
    ) throw new BadRequestException('Invalid refund settlement')
    const reference = input.reference?.trim() || null
    const requestHash = this.hash(JSON.stringify({ saleReturnId, method: input.method, reference }))

    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, REFUNDS_SETTLE_PERMISSION,
      )
      const refunds = await tx.$queryRaw<Array<{
        id: string
        refundAmount: string
        refundStatus: string
      }>>`
        SELECT id, "refundAmount"::text AS "refundAmount", "refundStatus"
        FROM "SaleReturn"
        WHERE id = ${saleReturnId} AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
        FOR UPDATE
      `
      const refund = refunds[0]
      if (!refund) throw new NotFoundException('Pending refund not found')
      const prior = await tx.$queryRaw<Array<{
        id: string
        requestHash: string
        amount: string
        method: string
        reference: string | null
        settledAt: Date
      }>>`
        SELECT id, "requestHash", amount::text AS amount,
               method::text AS method, reference, "settledAt"
        FROM "SaleReturnSettlement"
        WHERE "tenantId" = ${tenantId} AND "saleReturnId" = ${saleReturnId}
          AND "actorUserId" = ${actorUserId} AND "idempotencyKey" = ${idempotencyKey}
      `
      if (prior[0]) {
        if (prior[0].requestHash.trim() !== requestHash) {
          throw new ConflictException('Idempotency key was used for a different settlement')
        }
        return {
          id: prior[0].id,
          amount: prior[0].amount,
          method: prior[0].method,
          reference: prior[0].reference,
          settledAt: prior[0].settledAt,
          saleReturnId,
        }
      }
      if (refund.refundStatus !== 'PENDING') {
        throw new ConflictException('Refund obligation is already settled')
      }
      const shifts = await tx.$queryRaw<Array<{
        id: string
        status: string
        openingCash: string
      }>>`
        SELECT id, status::text AS status, "openingCash"::text AS "openingCash"
        FROM "CashShift"
        WHERE id = ${cashShiftId} AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
        FOR UPDATE
      `
      if (!shifts[0]) throw new NotFoundException('Cash shift not found')
      if (shifts[0].status !== 'OPEN') {
        throw new ConflictException('Refund settlement requires an open shift')
      }
      if (
        input.method === 'CASH' &&
        this.parseMoney(refund.refundAmount) > this.parseMoney(
          await this.getExpectedCash(tx, {
            id: cashShiftId,
            tenantId,
            openingCash: shifts[0].openingCash,
          }),
        )
      ) {
        throw new ConflictException('Cash drawer balance is insufficient for this refund settlement')
      }
      const rows = await tx.$queryRaw<Array<{
        id: string
        amount: string
        method: string
        reference: string | null
        settledAt: Date
      }>>`
        INSERT INTO "SaleReturnSettlement"
          (id, "tenantId", "branchId", "saleReturnId", "cashShiftId",
           "actorUserId", "idempotencyKey", "requestHash", amount, method,
           reference, "settledAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${saleReturnId}, ${cashShiftId},
           ${actorUserId}, ${idempotencyKey}, ${requestHash},
           ${refund.refundAmount}::numeric, ${input.method}::"CashSettlementMethod",
           ${reference}, CURRENT_TIMESTAMP)
        RETURNING id, amount::text AS amount, method::text AS method, reference, "settledAt"
      `
      await tx.$executeRaw`
        UPDATE "SaleReturn"
        SET "refundStatus" = 'SETTLED'
        WHERE id = ${saleReturnId} AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId} AND "refundStatus" = 'PENDING'
      `
      await this.writeAudit(tx, tenantId, branchId, cashShiftId, actorUserId, 'REFUND_SETTLED', {
        saleReturnId,
        settlementId: rows[0].id,
        amount: rows[0].amount,
        method: rows[0].method,
        reference: reference ?? '',
      })
      return { ...rows[0], saleReturnId }
    })
  }

  private async getExpectedCash(
    tx: Prisma.TransactionClient,
    shift: Pick<CashShiftRow, 'id' | 'tenantId' | 'openingCash'>,
  ): Promise<string> {
    const value = await getExpectedDrawerCash(tx, shift)
    if (!value || this.parseMoney(value) < 0n) {
      throw new ConflictException('Expected cash cannot be negative or exceed the supported range')
    }
    return value
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    cashShiftId: string,
    actorUserId: string,
    action: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "CashAuditLog"
        (id, "tenantId", "branchId", "cashShiftId", "actorUserId",
         action, metadata, "occurredAt")
      VALUES
        (${randomUUID()}, ${tenantId}, ${branchId}, ${cashShiftId}, ${actorUserId},
         ${action}, ${JSON.stringify(metadata)}::jsonb, CURRENT_TIMESTAMP)
    `
  }

  private async assertBranchPermission(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    tenantId: string,
    branchId: string,
    permissionKey: string,
  ): Promise<void> {
    if (!actorUserId || !tenantId || !branchId) {
      throw new ForbiddenException('Tenant and branch access are required')
    }
    const rows = await tx.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "TenantMembership" tm
        JOIN "User" u ON u.id = tm."userId" AND u.status = 'ACTIVE'
        JOIN "Branch" b ON b."tenantId" = tm."tenantId" AND b.id = ${branchId}
        JOIN "MembershipRole" mr
          ON mr."membershipId" = tm.id AND mr."tenantId" = tm."tenantId"
        JOIN "Role" r ON r.id = mr."roleId" AND r."tenantId" = mr."tenantId"
        JOIN "TenantRolePermission" trp ON trp."roleId" = r.id
        JOIN "TenantPermission" tp ON tp.id = trp."permissionId"
        WHERE tm."userId" = ${actorUserId}
          AND tm."tenantId" = ${tenantId}
          AND tm.status = 'ACTIVE'
          AND tp.key = ${permissionKey}
          AND (
            tm."branchAccessMode" = 'ALL_BRANCHES'
            OR EXISTS (
              SELECT 1 FROM "BranchMembership" bm
              WHERE bm."membershipId" = tm.id AND bm."tenantId" = tm."tenantId"
                AND bm."branchId" = b.id
            )
          )
      ) AS allowed
    `
    if (!rows[0]?.allowed) throw new ForbiddenException('Branch permission required')
  }

  private parseMoney(value: unknown): bigint {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)) {
      throw new BadRequestException('Invalid monetary amount')
    }
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  }

  private formatMoney(cents: bigint): string {
    const absolute = cents < 0n ? -cents : cents
    return `${cents < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
  }
}
