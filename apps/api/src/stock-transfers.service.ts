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
import { CreateStockTransferDto, ListTransfersDto } from './stock-transfers.dto'

export const INVENTORY_TRANSFER_PERMISSION = 'inventory.transfer'

export interface StockTransferRow {
  id: string
  tenantId: string
  sourceBranchId: string
  destinationBranchId: string
  productId: string
  productName: string
  actorUserId: string
  quantity: number
  status: 'COMPLETED'
  note: string | null
  createdAt: Date
}

@Injectable()
export class StockTransfersService {
  constructor(private readonly prisma: PrismaService) { }

  async createTransfer(
    actorUserId: string,
    tenantId: string,
    sourceBranchId: string,
    idempotencyKey: string,
    input: CreateStockTransferDto,
  ): Promise<StockTransferRow> {
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Invalid idempotency key')
    }
    const quantity = input?.quantity
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
      throw new BadRequestException('Invalid transfer quantity')
    }
    const destinationBranchId = input?.destinationBranchId?.trim() ?? ''
    const productId = input?.productId?.trim() ?? ''
    const note = input?.note?.trim() ?? null
    if (!destinationBranchId || destinationBranchId.length > 128) {
      throw new BadRequestException('Invalid destination branch')
    }
    if (!productId || productId.length > 128) {
      throw new BadRequestException('Invalid product')
    }
    if (note !== null && (note.length < 1 || note.length > 500)) {
      throw new BadRequestException('Invalid transfer note')
    }
    if (destinationBranchId === sourceBranchId) {
      throw new BadRequestException('Source and destination branches must differ')
    }
    const requestHash = createHash('sha256').update(JSON.stringify({
      destinationBranchId,
      productId,
      quantity,
      note,
    }), 'utf8').digest('hex')

    return this.prisma.$transaction(async (tx) => {
      // The actor needs the transfer permission on BOTH branches: moving stock
      // affects two branches' ledgers, so single-branch access is insufficient.
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, sourceBranchId, INVENTORY_TRANSFER_PERMISSION,
      )
      if (input.destinationBranchId !== sourceBranchId) {
        await this.assertBranchPermission(
          tx, actorUserId, tenantId, input.destinationBranchId,
          INVENTORY_TRANSFER_PERMISSION,
        )
      }

      const prior = await tx.$queryRaw<Array<{ id: string; requestHash: string; createdAt: Date }>>`
        SELECT id, "requestHash", "createdAt" FROM "StockTransfer"
        WHERE "tenantId" = ${tenantId} AND "actorUserId" = ${actorUserId}
          AND "idempotencyKey" = ${idempotencyKey}
      `
      if (prior[0]) {
        if (prior[0].requestHash.trim() !== requestHash) {
          throw new ConflictException('Idempotency key was used for a different transfer')
        }
        return this.getTransferById(tx, tenantId, prior[0].id)
      }

      // Both branches must belong to this tenant. (Branch has no active-status
      // column in the current schema, so no status filter is applied here.)
      const branches = await tx.$queryRaw<Array<{ id: string; role: string }>>`
        SELECT id, 'SOURCE' AS role FROM "Branch"
        WHERE id = ${sourceBranchId} AND "tenantId" = ${tenantId}
        UNION ALL
        SELECT id, 'DEST' AS role FROM "Branch"
        WHERE id = ${destinationBranchId} AND "tenantId" = ${tenantId}
      `
      if (branches.length < 2) {
        throw new NotFoundException('Source or destination branch not found in this tenant')
      }

      const products = await tx.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT id, name FROM "Product"
        WHERE id = ${productId} AND "tenantId" = ${tenantId} AND "isActive" = TRUE
        FOR SHARE
      `
      if (!products[0]) {
        throw new NotFoundException('Product not found or inactive')
      }

      // Serialize stock math for this (tenant, source branch, product).
      // The ::text cast gives Prisma a deserializable result column; without
      // it, PostgreSQL returns a void and $queryRaw fails.
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${tenantId}),
          hashtext(${sourceBranchId + ':' + productId})
        )::text
      `
      const stockRows = await tx.$queryRaw<Array<{ balance: string }>>`
        SELECT COALESCE(SUM("quantityDelta"), 0)::text AS balance
        FROM "InventoryMovement"
        WHERE "tenantId" = ${tenantId} AND "branchId" = ${sourceBranchId}
          AND "productId" = ${productId}
      `
      const balance = Number(stockRows[0]?.balance ?? '0')
      if (balance < quantity) {
        throw new ConflictException(
          `Insufficient stock in the source branch (available: ${balance})`,
        )
      }

      const transferId = randomUUID()
      await tx.$executeRaw`
        INSERT INTO "StockTransfer"
          (id, "tenantId", "sourceBranchId", "destinationBranchId", "productId",
           "actorUserId", "idempotencyKey", "requestHash", quantity, status, note,
           "createdAt")
        VALUES
          (${transferId}, ${tenantId}, ${sourceBranchId}, ${destinationBranchId},
           ${productId}, ${actorUserId}, ${idempotencyKey}, ${requestHash},
           ${quantity}, 'COMPLETED', ${note}, CURRENT_TIMESTAMP)
      `
      // Exactly two ledger movements, tied to the transfer; the composite
      // unique index guarantees one movement per (transfer, branch, product).
      const reasonBase = `Stock transfer ${transferId}`
      await tx.$executeRaw`
        INSERT INTO "InventoryMovement"
          (id, "tenantId", "branchId", "productId", "actorUserId",
           "quantityDelta", reason, "stockTransferId", "createdAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${sourceBranchId}, ${productId},
           ${actorUserId}, ${-quantity}, ${reasonBase + ' (out)'}, ${transferId},
           CURRENT_TIMESTAMP)
      `
      await tx.$executeRaw`
        INSERT INTO "InventoryMovement"
          (id, "tenantId", "branchId", "productId", "actorUserId",
           "quantityDelta", reason, "stockTransferId", "createdAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${destinationBranchId}, ${productId},
           ${actorUserId}, ${quantity}, ${reasonBase + ' (in)'}, ${transferId},
           CURRENT_TIMESTAMP)
      `
      return this.getTransferById(tx, tenantId, transferId)
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async listTransfers(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: ListTransfersDto,
  ): Promise<StockTransferRow[]> {
    if (input?.productId !== undefined && (!input.productId || input.productId.length > 128)) {
      throw new BadRequestException('Invalid product filter')
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, INVENTORY_TRANSFER_PERMISSION,
      )
      return tx.$queryRaw<StockTransferRow[]>`
        SELECT st.id, st."tenantId", st."sourceBranchId", st."destinationBranchId",
               st."productId", p.name AS "productName", st."actorUserId",
               st.quantity, st.status::text AS status, st.note, st."createdAt"
        FROM "StockTransfer" st
        JOIN "Product" p ON p.id = st."productId" AND p."tenantId" = st."tenantId"
        WHERE st."tenantId" = ${tenantId}
          AND (st."sourceBranchId" = ${branchId} OR st."destinationBranchId" = ${branchId})
          AND (${input?.productId ?? null}::text IS NULL
               OR st."productId" = ${input?.productId ?? null}::text)
        ORDER BY st."createdAt" DESC, st.id DESC
        LIMIT 100
      `
    })
  }

  private async getTransferById(
    tx: Prisma.TransactionClient,
    tenantId: string,
    transferId: string,
  ): Promise<StockTransferRow> {
    const rows = await tx.$queryRaw<StockTransferRow[]>`
      SELECT st.id, st."tenantId", st."sourceBranchId", st."destinationBranchId",
             st."productId", p.name AS "productName", st."actorUserId",
             st.quantity, st.status::text AS status, st.note, st."createdAt"
      FROM "StockTransfer" st
      JOIN "Product" p ON p.id = st."productId" AND p."tenantId" = st."tenantId"
      WHERE st.id = ${transferId} AND st."tenantId" = ${tenantId}
    `
    if (!rows[0]) throw new NotFoundException('Stock transfer not found')
    return rows[0]
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
              WHERE bm."membershipId" = tm.id
                AND bm."tenantId" = tm."tenantId"
                AND bm."branchId" = b.id
            )
          )
      ) AS allowed
    `
    if (!rows[0]?.allowed) throw new ForbiddenException('Branch permission required')
  }
}
