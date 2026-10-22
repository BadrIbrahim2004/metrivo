import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, SalePaymentMethod } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { PrismaService } from './prisma.service'
import { CreateSaleDto } from './sales.dto'
import { SALES_CREATE_PERMISSION, SALES_READ_PERMISSION } from './product-permissions'

const MAX_TOTAL_CENTS = 999_999_999_999n

function compareProductId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export interface CatalogProduct {
  id: string
  sku: string
  name: string
  price: string
  stock: string
}

interface LockedProduct {
  id: string
  sku: string
  name: string
  price: string
}

export interface SaleItemResult {
  id: string
  productId: string
  productName: string
  productSku: string
  quantity: number
  unitPrice: string
  lineTotal: string
}

export interface SaleDetail {
  id: string
  invoiceNumber: string
  tenantId: string
  branchId: string
  actorUserId: string
  status: string
  paymentMethod: SalePaymentMethod
  subtotal: string
  discount: string
  total: string
  createdAt: Date
  items: SaleItemResult[]
}

export interface SaleSummary extends Omit<SaleDetail, 'items'> {
  itemCount: number
}

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  async getCatalog(
    actorUserId: string,
    tenantId: string,
    branchId: string,
  ): Promise<CatalogProduct[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, SALES_CREATE_PERMISSION,
      )
      return tx.$queryRaw<CatalogProduct[]>`
        SELECT p.id, p.sku, p.name, p.price::text AS price,
               COALESCE(SUM(m."quantityDelta"), 0)::text AS stock
        FROM "Product" p
        LEFT JOIN "InventoryMovement" m
          ON m."productId" = p.id
         AND m."tenantId" = p."tenantId"
         AND m."branchId" = ${branchId}
        WHERE p."tenantId" = ${tenantId}
          AND p."isActive" = TRUE
        GROUP BY p.id
        ORDER BY p.name, p.id
        LIMIT 500
      `
    })
  }

  async createSale(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    idempotencyKey: string,
    input: CreateSaleDto,
  ): Promise<SaleDetail> {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('Invalid sale request')
    }
    const discountCents = this.parseMoney(input.discount ?? '0')
    const lines = this.validateLines(input)
    if (
      !actorUserId ||
      !tenantId ||
      !branchId ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)
    ) {
      throw new BadRequestException('Invalid sale request')
    }
    if (!Object.values(SalePaymentMethod).includes(input.paymentMethod)) {
      throw new BadRequestException('Invalid payment method')
    }

    const normalizedRequest = JSON.stringify({
      lines: [...lines].sort((a, b) => compareProductId(a.productId, b.productId)),
      discount: discountCents.toString(),
      paymentMethod: input.paymentMethod,
    })
    const requestHash = createHash('sha256')
      .update(normalizedRequest)
      .digest('hex')

    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, SALES_CREATE_PERMISSION,
      )

      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${tenantId}),
          hashtext(${'sale:' + actorUserId + ':' + idempotencyKey})
        )::text
      `
      const prior = await tx.$queryRaw<Array<{ id: string; requestHash: string }>>`
        SELECT id, "requestHash"
        FROM "Sale"
        WHERE "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND "actorUserId" = ${actorUserId}
          AND "idempotencyKey" = ${idempotencyKey}
      `
      if (prior[0]) {
        if (prior[0].requestHash.trim() !== requestHash) {
          throw new ConflictException('Idempotency key was used for a different sale')
        }
        return this.getSaleInTransaction(
          tx, tenantId, branchId, prior[0].id,
        )
      }

      const products = new Map<string, LockedProduct>()
      for (const line of [...lines].sort((a, b) => compareProductId(a.productId, b.productId))) {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${tenantId}),
            hashtext(${branchId + ':' + line.productId})
          )::text
        `
        const rows = await tx.$queryRaw<LockedProduct[]>`
          SELECT id, sku, name, price::text AS price
          FROM "Product"
          WHERE id = ${line.productId}
            AND "tenantId" = ${tenantId}
            AND "isActive" = TRUE
          FOR UPDATE
        `
        if (!rows[0]) {
          throw new NotFoundException('Product not found or inactive')
        }
        const stockRows = await tx.$queryRaw<Array<{ quantity: string }>>`
          SELECT COALESCE(SUM("quantityDelta"), 0)::text AS quantity
          FROM "InventoryMovement"
          WHERE "tenantId" = ${tenantId}
            AND "branchId" = ${branchId}
            AND "productId" = ${line.productId}
        `
        const available = BigInt(stockRows[0]?.quantity ?? '0')
        if (available < BigInt(line.quantity)) {
          throw new BadRequestException('Insufficient stock')
        }
        products.set(line.productId, rows[0])
      }

      let subtotalCents = 0n
      const pricedLines = lines.map((line) => {
        const product = products.get(line.productId)
        if (!product) {
          throw new NotFoundException('Product not found or inactive')
        }
        const unitPriceCents = this.parseMoney(product.price)
        const lineTotalCents = unitPriceCents * BigInt(line.quantity)
        subtotalCents += lineTotalCents
        return { ...line, product, unitPriceCents, lineTotalCents }
      })

      if (
        subtotalCents > MAX_TOTAL_CENTS ||
        discountCents > subtotalCents ||
        subtotalCents - discountCents > MAX_TOTAL_CENTS
      ) {
        throw new BadRequestException('Sale total is out of range')
      }

      const saleId = randomUUID()
      const invoiceNumber = `POS-${Date.now()}-${randomUUID().slice(0, 8)}`
      const subtotal = this.formatMoney(subtotalCents)
      const discount = this.formatMoney(discountCents)
      const total = this.formatMoney(subtotalCents - discountCents)

      await tx.$executeRaw`
        INSERT INTO "Sale"
          (id, "tenantId", "branchId", "actorUserId", "invoiceNumber",
           "idempotencyKey", "requestHash", status, "paymentMethod",
           subtotal, discount, total, "createdAt")
        VALUES
          (${saleId}, ${tenantId}, ${branchId}, ${actorUserId},
           ${invoiceNumber}, ${idempotencyKey}, ${requestHash}, 'COMPLETED',
           ${input.paymentMethod}::"SalePaymentMethod", ${subtotal}::numeric,
           ${discount}::numeric, ${total}::numeric, CURRENT_TIMESTAMP)
      `

      for (const line of pricedLines) {
        await tx.$executeRaw`
          INSERT INTO "SaleItem"
            (id, "tenantId", "saleId", "productId", "productName",
             "productSku", quantity, "unitPrice", "lineTotal")
          VALUES
            (${randomUUID()}, ${tenantId}, ${saleId}, ${line.product.id},
             ${line.product.name}, ${line.product.sku}, ${line.quantity},
             ${this.formatMoney(line.unitPriceCents)}::numeric,
             ${this.formatMoney(line.lineTotalCents)}::numeric)
        `
        await tx.$executeRaw`
          INSERT INTO "InventoryMovement"
            (id, "tenantId", "branchId", "productId", "actorUserId",
             "quantityDelta", reason, "saleId", "createdAt")
          VALUES
            (${randomUUID()}, ${tenantId}, ${branchId}, ${line.product.id},
             ${actorUserId}, ${-line.quantity},
             ${'Sale ' + invoiceNumber}, ${saleId}, CURRENT_TIMESTAMP)
        `
      }

      return this.getSaleInTransaction(
        tx, tenantId, branchId, saleId,
      )
    })
  }

  async listSales(
    actorUserId: string,
    tenantId: string,
    branchId: string,
  ): Promise<SaleSummary[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, SALES_READ_PERMISSION,
      )
      return tx.$queryRaw<SaleSummary[]>`
        SELECT s.id, s."invoiceNumber", s."tenantId", s."branchId",
               s."actorUserId", s.status::text AS status,
               s."paymentMethod"::text AS "paymentMethod",
               s.subtotal::text AS subtotal, s.discount::text AS discount,
               s.total::text AS total, s."createdAt",
               (SELECT COUNT(*)::int FROM "SaleItem" si
                WHERE si."saleId" = s.id AND si."tenantId" = s."tenantId")
                 AS "itemCount"
        FROM "Sale" s
        WHERE s."tenantId" = ${tenantId}
          AND s."branchId" = ${branchId}
        ORDER BY s."createdAt" DESC, s.id DESC
        LIMIT 100
      `
    })
  }

  async getSale(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    saleId: string,
  ): Promise<SaleDetail> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, SALES_READ_PERMISSION,
      )
      return this.getSaleInTransaction(
        tx, tenantId, branchId, saleId,
      )
    })
  }

  private async getSaleInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    saleId: string,
  ): Promise<SaleDetail> {
    const rows = await tx.$queryRaw<SaleDetail[]>`
      SELECT id, "invoiceNumber", "tenantId", "branchId", "actorUserId",
             status::text AS status, "paymentMethod"::text AS "paymentMethod",
             subtotal::text AS subtotal, discount::text AS discount,
             total::text AS total, "createdAt"
      FROM "Sale"
      WHERE id = ${saleId}
        AND "tenantId" = ${tenantId}
        AND "branchId" = ${branchId}
    `
    if (!rows[0]) {
      throw new NotFoundException('Sale not found')
    }
    const items = await tx.$queryRaw<SaleItemResult[]>`
      SELECT id, "productId", "productName", "productSku", quantity,
             "unitPrice"::text AS "unitPrice",
             "lineTotal"::text AS "lineTotal"
      FROM "SaleItem"
      WHERE "saleId" = ${saleId} AND "tenantId" = ${tenantId}
      ORDER BY id
    `
    return { ...rows[0], items }
  }

  private validateLines(input: CreateSaleDto): CreateSaleDto['lines'] {
    if (
      !Array.isArray(input.lines) ||
      input.lines.length === 0 ||
      input.lines.length > 100
    ) {
      throw new BadRequestException('At least one sale line is required')
    }
    const seen = new Set<string>()
    for (const line of input.lines) {
      if (
        !line ||
        typeof line.productId !== 'string' ||
        line.productId.length === 0 ||
        line.productId.length > 128 ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 1_000_000 ||
        seen.has(line.productId)
      ) {
        throw new BadRequestException('Invalid sale line')
      }
      seen.add(line.productId)
    }
    return input.lines
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
        JOIN "User" u
          ON u.id = tm."userId"
         AND u.status = 'ACTIVE'
        JOIN "Branch" b
          ON b."tenantId" = tm."tenantId"
         AND b.id = ${branchId}
        JOIN "MembershipRole" mr
          ON mr."membershipId" = tm.id
         AND mr."tenantId" = tm."tenantId"
        JOIN "Role" r
          ON r.id = mr."roleId"
         AND r."tenantId" = mr."tenantId"
        JOIN "TenantRolePermission" trp ON trp."roleId" = r.id
        JOIN "TenantPermission" tp ON tp.id = trp."permissionId"
        WHERE tm."userId" = ${actorUserId}
          AND tm."tenantId" = ${tenantId}
          AND tm.status = 'ACTIVE'
          AND tp.key = ${permissionKey}
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
      ) AS allowed
    `
    if (!rows[0]?.allowed) {
      throw new ForbiddenException('Branch permission required')
    }
  }
}
