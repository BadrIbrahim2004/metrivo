import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, SupplierPaymentMethod } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { PrismaService } from './prisma.service'
import {
  CreatePurchaseDto,
  CreateSupplierDto,
  CreateSupplierPaymentDto,
  UpdateSupplierDto,
} from './procurement.dto'

export const SUPPLIERS_READ_PERMISSION = 'suppliers.read'
export const SUPPLIERS_MANAGE_PERMISSION = 'suppliers.manage'
export const PURCHASES_READ_PERMISSION = 'purchases.read'
export const PURCHASES_CREATE_PERMISSION = 'purchases.create'
export const PURCHASES_RECEIVE_PERMISSION = 'purchases.receive'
export const PURCHASES_CANCEL_PERMISSION = 'purchases.cancel'
export const PURCHASES_PAY_PERMISSION = 'purchases.pay'

const MAX_TOTAL_CENTS = 999_999_999_999n

interface PurchaseLineInput {
  productId: string
  quantity: number
  unitCost: string
}

interface ProductSnapshot {
  id: string
  sku: string
  name: string
}

export interface SupplierRow {
  id: string
  tenantId: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  isActive: boolean
}

export interface PurchaseItemRow {
  id: string
  productId: string
  productName: string
  productSku: string
  quantity: number
  unitCost: string
  lineTotal: string
}

export interface PurchaseRow {
  id: string
  receiptNumber: string
  supplierInvoiceNumber: string | null
  tenantId: string
  branchId: string
  supplierId: string
  supplierName: string
  createdByUserId: string
  receivedByUserId: string | null
  status: 'DRAFT' | 'RECEIVED' | 'CANCELLED'
  subtotal: string
  paid: string
  balance: string
  createdAt: Date
  receivedAt: Date | null
  items: PurchaseItemRow[]
}

export interface SupplierPaymentRow {
  id: string
  purchaseId: string
  amount: string
  method: SupplierPaymentMethod
  createdAt: Date
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

@Injectable()
export class ProcurementService {
  constructor(private readonly prisma: PrismaService) {}

  async listSuppliers(
    actorUserId: string,
    tenantId: string,
    branchId: string,
  ): Promise<SupplierRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, SUPPLIERS_READ_PERMISSION,
      )
      return tx.$queryRaw<SupplierRow[]>`
        SELECT id, "tenantId", name, phone, email, address, "isActive"
        FROM "Supplier"
        WHERE "tenantId" = ${tenantId}
        ORDER BY name, id
        LIMIT 500
      `
    })
  }

  async createSupplier(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: CreateSupplierDto,
  ): Promise<SupplierRow> {
    const name = input?.name?.trim()
    if (!name || name.length > 200) {
      throw new BadRequestException('Invalid supplier name')
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, SUPPLIERS_MANAGE_PERMISSION,
      )
      const rows = await tx.$queryRaw<SupplierRow[]>`
        INSERT INTO "Supplier"
          (id, "tenantId", name, phone, email, address, "isActive",
           "createdAt", "updatedAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${name},
           ${input.phone?.trim() || null}, ${input.email?.trim().toLowerCase() || null},
           ${input.address?.trim() || null}, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id, "tenantId", name, phone, email, address, "isActive"
      `
      return rows[0]
    })
  }

  async updateSupplier(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    supplierId: string,
    input: UpdateSupplierDto,
  ): Promise<SupplierRow> {
    if (!input || Object.keys(input).length === 0) {
      throw new BadRequestException('At least one supplier field is required')
    }
    if (input.name !== undefined && !input.name.trim()) {
      throw new BadRequestException('Supplier name cannot be empty')
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, SUPPLIERS_MANAGE_PERMISSION,
      )
      const current = await tx.$queryRaw<SupplierRow[]>`
        SELECT id, "tenantId", name, phone, email, address, "isActive"
        FROM "Supplier"
        WHERE id = ${supplierId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `
      if (!current[0]) throw new NotFoundException('Supplier not found')
      const supplier = current[0]
      const rows = await tx.$queryRaw<SupplierRow[]>`
        UPDATE "Supplier"
        SET name = ${input.name === undefined ? supplier.name : input.name.trim()},
            phone = ${input.phone === undefined ? supplier.phone : input.phone?.trim() || null},
            email = ${input.email === undefined ? supplier.email : input.email?.trim().toLowerCase() || null},
            address = ${input.address === undefined ? supplier.address : input.address?.trim() || null},
            "isActive" = ${input.isActive === undefined ? supplier.isActive : input.isActive},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${supplierId} AND "tenantId" = ${tenantId}
        RETURNING id, "tenantId", name, phone, email, address, "isActive"
      `
      return rows[0]
    })
  }

  async createPurchase(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    idempotencyKey: string,
    input: CreatePurchaseDto,
  ): Promise<PurchaseRow> {
    this.validatePurchaseInput(input, idempotencyKey)
    const lines = [...input.items]
      .map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitCostCents: this.parseMoney(line.unitCost),
      }))
      .sort((a, b) => compareText(a.productId, b.productId))
    const normalizedRequest = JSON.stringify({
      supplierId: input.supplierId,
      supplierInvoiceNumber: input.supplierInvoiceNumber?.trim() || null,
      lines: lines.map(({ productId, quantity, unitCostCents }) => ({
        productId,
        quantity,
        unitCostCents: unitCostCents.toString(),
      })),
    })
    const requestHash = this.hash(normalizedRequest)
    const subtotalCents = lines.reduce(
      (sum, line) => sum + line.unitCostCents * BigInt(line.quantity),
      0n,
    )
    if (subtotalCents > MAX_TOTAL_CENTS) {
      throw new BadRequestException('Purchase total is out of range')
    }

    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, PURCHASES_CREATE_PERMISSION,
      )
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${tenantId}),
          hashtext(${'purchase:' + actorUserId + ':' + idempotencyKey})
        )::text
      `
      const prior = await tx.$queryRaw<Array<{ id: string; requestHash: string }>>`
        SELECT id, "requestHash"
        FROM "Purchase"
        WHERE "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND "createdByUserId" = ${actorUserId}
          AND "idempotencyKey" = ${idempotencyKey}
      `
      if (prior[0]) {
        if (prior[0].requestHash.trim() !== requestHash) {
          throw new ConflictException('Idempotency key was used for a different purchase')
        }
        return this.getPurchaseInTransaction(tx, tenantId, branchId, prior[0].id)
      }

      const suppliers = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Supplier"
        WHERE id = ${input.supplierId}
          AND "tenantId" = ${tenantId}
          AND "isActive" = TRUE
        FOR SHARE
      `
      if (!suppliers[0]) {
        throw new NotFoundException('Supplier not found or inactive')
      }

      const products = new Map<string, ProductSnapshot>()
      for (const line of lines) {
        const rows = await tx.$queryRaw<ProductSnapshot[]>`
          SELECT id, sku, name
          FROM "Product"
          WHERE id = ${line.productId}
            AND "tenantId" = ${tenantId}
            AND "isActive" = TRUE
          FOR SHARE
        `
        if (!rows[0]) {
          throw new NotFoundException('Product not found or inactive')
        }
        products.set(line.productId, rows[0])
      }

      if (input.supplierInvoiceNumber?.trim()) {
        const duplicate = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Purchase"
          WHERE "tenantId" = ${tenantId}
            AND "supplierId" = ${input.supplierId}
            AND "supplierInvoiceNumber" = ${input.supplierInvoiceNumber.trim()}
        `
        if (duplicate[0]) {
          throw new ConflictException('Supplier invoice number already exists')
        }
      }

      const purchaseId = randomUUID()
      const receiptNumber = `PUR-${Date.now()}-${randomUUID().slice(0, 8)}`
      await tx.$executeRaw`
        INSERT INTO "Purchase"
          (id, "tenantId", "branchId", "supplierId", "createdByUserId",
           "receiptNumber", "supplierInvoiceNumber", "idempotencyKey",
           "requestHash", status, subtotal, "createdAt")
        VALUES
          (${purchaseId}, ${tenantId}, ${branchId}, ${input.supplierId},
           ${actorUserId}, ${receiptNumber},
           ${input.supplierInvoiceNumber?.trim() || null}, ${idempotencyKey},
           ${requestHash}, 'DRAFT', ${this.formatMoney(subtotalCents)}::numeric,
           CURRENT_TIMESTAMP)
      `
      for (const line of lines) {
        const product = products.get(line.productId)
        if (!product) throw new NotFoundException('Product not found or inactive')
        const lineTotal = line.unitCostCents * BigInt(line.quantity)
        await tx.$executeRaw`
          INSERT INTO "PurchaseItem"
            (id, "tenantId", "purchaseId", "productId", "productName",
             "productSku", quantity, "unitCost", "lineTotal")
          VALUES
            (${randomUUID()}, ${tenantId}, ${purchaseId}, ${product.id},
             ${product.name}, ${product.sku}, ${line.quantity},
             ${this.formatMoney(line.unitCostCents)}::numeric,
             ${this.formatMoney(lineTotal)}::numeric)
        `
      }
      await tx.$executeRaw`
        INSERT INTO "PurchaseAuditLog"
          (id, "tenantId", "branchId", "purchaseId", "actorUserId",
           action, metadata, "occurredAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${purchaseId},
           ${actorUserId}, 'PURCHASE_DRAFT_CREATED',
           ${JSON.stringify({
             receiptNumber,
             supplierInvoiceNumber: input.supplierInvoiceNumber?.trim() || null,
             subtotal: this.formatMoney(subtotalCents),
           })}::jsonb,
           CURRENT_TIMESTAMP)
      `
      return this.getPurchaseInTransaction(tx, tenantId, branchId, purchaseId)
    })
  }

  async listPurchases(
    actorUserId: string,
    tenantId: string,
    branchId: string,
  ): Promise<PurchaseRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, PURCHASES_READ_PERMISSION,
      )
      const rows = await tx.$queryRaw<PurchaseRow[]>`
        SELECT p.id, p."receiptNumber", p."supplierInvoiceNumber",
               p."tenantId", p."branchId", p."supplierId", s.name AS "supplierName",
               p."createdByUserId", p."receivedByUserId",
               p.status::text AS status, p.subtotal::text AS subtotal,
               COALESCE((SELECT SUM(sp.amount) FROM "SupplierPayment" sp
                         WHERE sp."tenantId" = p."tenantId"
                           AND sp."purchaseId" = p.id), 0)::text AS paid,
               (p.subtotal - COALESCE((SELECT SUM(sp.amount)
                         FROM "SupplierPayment" sp
                         WHERE sp."tenantId" = p."tenantId"
                           AND sp."purchaseId" = p.id), 0))::text AS balance,
               p."createdAt", p."receivedAt"
        FROM "Purchase" p
        JOIN "Supplier" s
          ON s.id = p."supplierId" AND s."tenantId" = p."tenantId"
        WHERE p."tenantId" = ${tenantId} AND p."branchId" = ${branchId}
        ORDER BY p."createdAt" DESC, p.id DESC
        LIMIT 100
      `
      return Promise.all(rows.map(async (row) => ({
        ...row,
        items: await this.getPurchaseItems(tx, tenantId, row.id),
      })))
    })
  }

  async getPurchase(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    purchaseId: string,
  ): Promise<PurchaseRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, PURCHASES_READ_PERMISSION,
      )
      return this.getPurchaseInTransaction(tx, tenantId, branchId, purchaseId)
    })
  }

  async receivePurchase(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    purchaseId: string,
  ): Promise<PurchaseRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, PURCHASES_RECEIVE_PERMISSION,
      )
      const rows = await tx.$queryRaw<Array<{
        id: string
        status: 'DRAFT' | 'RECEIVED' | 'CANCELLED'
        supplierName: string
      }>>`
        SELECT p.id, p.status::text AS status, s.name AS "supplierName"
        FROM "Purchase" p
        JOIN "Supplier" s
          ON s.id = p."supplierId" AND s."tenantId" = p."tenantId"
        WHERE p.id = ${purchaseId}
          AND p."tenantId" = ${tenantId}
          AND p."branchId" = ${branchId}
        FOR UPDATE OF p
      `
      const purchase = rows[0]
      if (!purchase) throw new NotFoundException('Purchase not found')
      if (purchase.status !== 'DRAFT') {
        throw new ConflictException('Only draft purchases can be received')
      }
      const items = await this.getPurchaseItems(tx, tenantId, purchaseId)
      if (!items.length) throw new ConflictException('Purchase has no items')

      await tx.$executeRaw`
        UPDATE "Purchase"
        SET status = 'RECEIVED',
            "receivedByUserId" = ${actorUserId},
            "receivedAt" = CURRENT_TIMESTAMP
        WHERE id = ${purchaseId}
          AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND status = 'DRAFT'
      `
      for (const item of [...items].sort((a, b) => compareText(a.productId, b.productId))) {
        await tx.$executeRaw`
          INSERT INTO "InventoryMovement"
            (id, "tenantId", "branchId", "productId", "actorUserId",
             "quantityDelta", reason, "purchaseItemId", "createdAt")
          VALUES
            (${randomUUID()}, ${tenantId}, ${branchId}, ${item.productId},
             ${actorUserId}, ${item.quantity},
             ${'Purchase ' + purchaseId + ' received from ' + purchase.supplierName},
             ${item.id}, CURRENT_TIMESTAMP)
        `
      }
      await tx.$executeRaw`
        INSERT INTO "PurchaseAuditLog"
          (id, "tenantId", "branchId", "purchaseId", "actorUserId",
           action, metadata, "occurredAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${purchaseId},
           ${actorUserId}, 'PURCHASE_RECEIVED',
           ${JSON.stringify({ itemCount: items.length })}::jsonb,
           CURRENT_TIMESTAMP)
      `
      return this.getPurchaseInTransaction(tx, tenantId, branchId, purchaseId)
    })
  }

  async cancelDraftPurchase(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    purchaseId: string,
  ): Promise<PurchaseRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, PURCHASES_CANCEL_PERMISSION,
      )
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status::text AS status
        FROM "Purchase"
        WHERE id = ${purchaseId}
          AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
        FOR UPDATE
      `
      if (!rows[0]) throw new NotFoundException('Purchase not found')
      if (rows[0].status !== 'DRAFT') {
        throw new ConflictException('Only draft purchases can be cancelled')
      }
      await tx.$executeRaw`
        UPDATE "Purchase"
        SET status = 'CANCELLED'
        WHERE id = ${purchaseId}
          AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND status = 'DRAFT'
      `
      await tx.$executeRaw`
        INSERT INTO "PurchaseAuditLog"
          (id, "tenantId", "branchId", "purchaseId", "actorUserId",
           action, metadata, "occurredAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${purchaseId},
           ${actorUserId}, 'DRAFT_PURCHASE_CANCELLED', '{}'::jsonb,
           CURRENT_TIMESTAMP)
      `
      return this.getPurchaseInTransaction(tx, tenantId, branchId, purchaseId)
    })
  }

  async recordSupplierPayment(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    purchaseId: string,
    idempotencyKey: string,
    input: CreateSupplierPaymentDto,
  ): Promise<{ payment: SupplierPaymentRow; paid: string; balance: string }> {
    if (
      !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey) ||
      !Object.values(SupplierPaymentMethod).includes(input?.method as SupplierPaymentMethod)
    ) {
      throw new BadRequestException('Invalid supplier payment')
    }
    const amountCents = this.parseMoney(input.amount)
    if (amountCents <= 0n) {
      throw new BadRequestException('Payment amount must be positive')
    }
    const requestHash = this.hash(JSON.stringify({
      amountCents: amountCents.toString(),
      method: input.method,
    }))

    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, PURCHASES_PAY_PERMISSION,
      )
      const purchases = await tx.$queryRaw<Array<{
        id: string
        status: 'DRAFT' | 'RECEIVED' | 'CANCELLED'
        subtotal: string
      }>>`
        SELECT id, status::text AS status, subtotal::text AS subtotal
        FROM "Purchase"
        WHERE id = ${purchaseId}
          AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
        FOR UPDATE
      `
      const purchase = purchases[0]
      if (!purchase) throw new NotFoundException('Purchase not found')

      const prior = await tx.$queryRaw<Array<{
        id: string
        purchaseId: string
        amount: string
        method: SupplierPaymentMethod
        createdAt: Date
        requestHash: string
      }>>`
        SELECT id, "purchaseId", amount::text AS amount,
               method::text AS method, "createdAt", "requestHash"
        FROM "SupplierPayment"
        WHERE "tenantId" = ${tenantId}
          AND "purchaseId" = ${purchaseId}
          AND "idempotencyKey" = ${idempotencyKey}
      `
      if (prior[0]) {
        if (prior[0].requestHash.trim() !== requestHash) {
          throw new ConflictException('Idempotency key was used for a different payment')
        }
        const balance = await this.getPurchaseBalance(tx, tenantId, purchaseId)
        return {
          payment: {
            id: prior[0].id,
            purchaseId: prior[0].purchaseId,
            amount: prior[0].amount,
            method: prior[0].method,
            createdAt: prior[0].createdAt,
          },
          paid: balance.paid,
          balance: balance.balance,
        }
      }
      if (purchase.status !== 'RECEIVED') {
        throw new ConflictException('Supplier payments require a received purchase')
      }
      const paidRows = await tx.$queryRaw<Array<{ paid: string }>>`
        SELECT COALESCE(SUM(amount), 0)::text AS paid
        FROM "SupplierPayment"
        WHERE "tenantId" = ${tenantId} AND "purchaseId" = ${purchaseId}
      `
      const paidCents = this.parseMoney(paidRows[0]?.paid ?? '0')
      const totalCents = this.parseMoney(purchase.subtotal)
      if (paidCents + amountCents > totalCents) {
        throw new BadRequestException('Payment exceeds the purchase balance')
      }
      const paymentId = randomUUID()
      const rows = await tx.$queryRaw<SupplierPaymentRow[]>`
        INSERT INTO "SupplierPayment"
          (id, "tenantId", "branchId", "purchaseId", "actorUserId",
           "idempotencyKey", "requestHash", amount, method, "createdAt")
        VALUES
          (${paymentId}, ${tenantId}, ${branchId}, ${purchaseId}, ${actorUserId},
           ${idempotencyKey}, ${requestHash}, ${this.formatMoney(amountCents)}::numeric,
           ${input.method}::"SupplierPaymentMethod", CURRENT_TIMESTAMP)
        RETURNING id, "purchaseId", amount::text AS amount,
                  method::text AS method, "createdAt"
      `
      await tx.$executeRaw`
        INSERT INTO "PurchaseAuditLog"
          (id, "tenantId", "branchId", "purchaseId", "actorUserId",
           action, metadata, "occurredAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${purchaseId},
           ${actorUserId}, 'SUPPLIER_PAYMENT_RECORDED',
           ${JSON.stringify({
             paymentId,
             amount: this.formatMoney(amountCents),
             method: input.method,
           })}::jsonb,
           CURRENT_TIMESTAMP)
      `
      const nextPaid = paidCents + amountCents
      return {
        payment: rows[0],
        paid: this.formatMoney(nextPaid),
        balance: this.formatMoney(totalCents - nextPaid),
      }
    })
  }

  private async getPurchaseInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    purchaseId: string,
  ): Promise<PurchaseRow> {
    const rows = await tx.$queryRaw<PurchaseRow[]>`
      SELECT p.id, p."receiptNumber", p."supplierInvoiceNumber",
             p."tenantId", p."branchId", p."supplierId", s.name AS "supplierName",
             p."createdByUserId", p."receivedByUserId",
             p.status::text AS status, p.subtotal::text AS subtotal,
             COALESCE((SELECT SUM(sp.amount) FROM "SupplierPayment" sp
                       WHERE sp."tenantId" = p."tenantId"
                         AND sp."purchaseId" = p.id), 0)::text AS paid,
             (p.subtotal - COALESCE((SELECT SUM(sp.amount)
                       FROM "SupplierPayment" sp
                       WHERE sp."tenantId" = p."tenantId"
                         AND sp."purchaseId" = p.id), 0))::text AS balance,
             p."createdAt", p."receivedAt"
      FROM "Purchase" p
      JOIN "Supplier" s
        ON s.id = p."supplierId" AND s."tenantId" = p."tenantId"
      WHERE p.id = ${purchaseId}
        AND p."tenantId" = ${tenantId}
        AND p."branchId" = ${branchId}
    `
    if (!rows[0]) throw new NotFoundException('Purchase not found')
    return { ...rows[0], items: await this.getPurchaseItems(tx, tenantId, purchaseId) }
  }

  private getPurchaseItems(
    tx: Prisma.TransactionClient,
    tenantId: string,
    purchaseId: string,
  ): Promise<PurchaseItemRow[]> {
    return tx.$queryRaw<PurchaseItemRow[]>`
      SELECT id, "productId", "productName", "productSku", quantity,
             "unitCost"::text AS "unitCost", "lineTotal"::text AS "lineTotal"
      FROM "PurchaseItem"
      WHERE "tenantId" = ${tenantId} AND "purchaseId" = ${purchaseId}
      ORDER BY id
    `
  }

  private async getPurchaseBalance(
    tx: Prisma.TransactionClient,
    tenantId: string,
    purchaseId: string,
  ): Promise<{ paid: string; balance: string }> {
    const rows = await tx.$queryRaw<Array<{ subtotal: string; paid: string }>>`
      SELECT p.subtotal::text AS subtotal,
             COALESCE(SUM(sp.amount), 0)::text AS paid
      FROM "Purchase" p
      LEFT JOIN "SupplierPayment" sp
        ON sp."purchaseId" = p.id AND sp."tenantId" = p."tenantId"
      WHERE p.id = ${purchaseId} AND p."tenantId" = ${tenantId}
      GROUP BY p.id
    `
    const subtotal = this.parseMoney(rows[0]?.subtotal ?? '0')
    const paid = this.parseMoney(rows[0]?.paid ?? '0')
    return {
      paid: this.formatMoney(paid),
      balance: this.formatMoney(subtotal - paid),
    }
  }

  private validatePurchaseInput(
    input: CreatePurchaseDto,
    idempotencyKey: string,
  ): asserts input is CreatePurchaseDto & { items: PurchaseLineInput[] } {
    if (
      !input ||
      typeof input.supplierId !== 'string' ||
      input.supplierId.length === 0 ||
      !Array.isArray(input.items) ||
      input.items.length < 1 ||
      input.items.length > 100 ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)
    ) {
      throw new BadRequestException('Invalid purchase request')
    }
    const seen = new Set<string>()
    for (const line of input.items) {
      if (
        !line ||
        typeof line.productId !== 'string' ||
        !line.productId ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 1_000_000 ||
        seen.has(line.productId)
      ) {
        throw new BadRequestException('Invalid purchase line')
      }
      this.parseMoney(line.unitCost)
      seen.add(line.productId)
    }
    if (
      input.supplierInvoiceNumber !== undefined &&
      input.supplierInvoiceNumber !== null &&
      (typeof input.supplierInvoiceNumber !== 'string' ||
        input.supplierInvoiceNumber.length > 100)
    ) {
      throw new BadRequestException('Invalid supplier invoice number')
    }
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

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex')
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
          ON u.id = tm."userId" AND u.status = 'ACTIVE'
        JOIN "Branch" b
          ON b."tenantId" = tm."tenantId" AND b.id = ${branchId}
        JOIN "MembershipRole" mr
          ON mr."membershipId" = tm.id AND mr."tenantId" = tm."tenantId"
        JOIN "Role" r
          ON r.id = mr."roleId" AND r."tenantId" = mr."tenantId"
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
