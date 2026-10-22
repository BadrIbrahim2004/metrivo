import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { PrismaService } from './prisma.service'
import {
  INVENTORY_ADJUST_PERMISSION,
  INVENTORY_READ_PERMISSION,
  PRODUCT_MANAGE_PERMISSION,
  PRODUCT_READ_PERMISSION,
} from './product-permissions'
import type {
  CreateInventoryMovementDto,
  CreateProductDto,
  UpdateProductDto,
} from './product.dto'

const MAX_STOCK = 2_000_000_000

export interface ProductRow {
  id: string
  sku: string
  name: string
  category: string | null
  description: string | null
  price: string
  isActive: boolean
  stock?: string
}

export interface MovementRow {
  id: string
  quantityDelta: number
  reason: string
  createdAt: Date
  actorUserId: string
}

@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(
    actorUserId: string,
    tenantId: string,
    branchId: string,
  ): Promise<ProductRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, PRODUCT_READ_PERMISSION,
      )
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, INVENTORY_READ_PERMISSION,
      )

      return tx.$queryRaw<ProductRow[]>`
        SELECT p.id, p.sku, p.name, p.category, p.description,
               p.price::text AS price, p."isActive",
               COALESCE(SUM(m."quantityDelta"), 0)::text AS stock
        FROM "Product" p
        LEFT JOIN "InventoryMovement" m
          ON m."productId" = p.id
         AND m."tenantId" = p."tenantId"
         AND m."branchId" = ${branchId}
        WHERE p."tenantId" = ${tenantId}
        GROUP BY p.id
        ORDER BY p.name, p.id
        LIMIT 500
      `
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async createProduct(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: CreateProductDto,
  ): Promise<ProductRow> {
    this.validateProductInput(input)
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, PRODUCT_MANAGE_PERMISSION,
      )
      const rows = await tx.$queryRaw<ProductRow[]>`
        INSERT INTO "Product"
          (id, "tenantId", sku, name, category, description, price,
           "isActive", "createdByUserId", "createdAt", "updatedAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${input.sku.trim()}, ${input.name.trim()},
           ${input.category?.trim() || null}, ${input.description?.trim() || null},
           ${input.price}, TRUE, ${actorUserId}, CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP)
        RETURNING id, sku, name, category, description, price::text AS price,
                  "isActive"
      `
      return rows[0]
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async updateProduct(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    productId: string,
    input: UpdateProductDto,
  ): Promise<ProductRow> {
    this.validateProductInput(input)
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, PRODUCT_MANAGE_PERMISSION,
      )
      const existingRows = await tx.$queryRaw<ProductRow[]>`
        SELECT id, sku, name, category, description, price::text AS price,
               "isActive"
        FROM "Product"
        WHERE id = ${productId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `
      const existing = existingRows[0]
      if (!existing) {
        throw new NotFoundException('Product not found')
      }

      const rows = await tx.$queryRaw<ProductRow[]>`
        UPDATE "Product"
        SET sku = ${input.sku === undefined ? existing.sku : input.sku.trim()},
            name = ${input.name === undefined ? existing.name : input.name.trim()},
            category = ${input.category === undefined ? existing.category : input.category?.trim() || null},
            description = ${input.description === undefined ? existing.description : input.description?.trim() || null},
            price = ${input.price === undefined ? existing.price : input.price},
            "isActive" = ${input.isActive === undefined ? existing.isActive : input.isActive},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${productId} AND "tenantId" = ${tenantId}
        RETURNING id, sku, name, category, description, price::text AS price,
                  "isActive"
      `
      if (!rows[0]) {
        throw new NotFoundException('Product not found')
      }
      return rows[0]
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async getStock(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    productId: string,
  ): Promise<{ productId: string; branchId: string; quantity: string }> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, INVENTORY_READ_PERMISSION,
      )
      const rows = await tx.$queryRaw<Array<{ quantity: string }>>`
        SELECT COALESCE(SUM(m."quantityDelta"), 0)::text AS quantity
        FROM "Product" p
        LEFT JOIN "InventoryMovement" m
          ON m."productId" = p.id
         AND m."tenantId" = p."tenantId"
         AND m."branchId" = ${branchId}
        WHERE p.id = ${productId} AND p."tenantId" = ${tenantId}
        GROUP BY p.id
      `
      if (!rows[0]) {
        throw new NotFoundException('Product not found')
      }
      return { productId, branchId, quantity: rows[0].quantity }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async listMovements(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    productId: string,
  ): Promise<MovementRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, INVENTORY_READ_PERMISSION,
      )
      const products = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Product"
        WHERE id = ${productId} AND "tenantId" = ${tenantId}
      `
      if (!products[0]) {
        throw new NotFoundException('Product not found')
      }
      return tx.$queryRaw<MovementRow[]>`
        SELECT id, "quantityDelta", reason, "createdAt", "actorUserId"
        FROM "InventoryMovement"
        WHERE "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND "productId" = ${productId}
        ORDER BY "createdAt" DESC, id DESC
        LIMIT 100
      `
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  async createMovement(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    productId: string,
    input: CreateInventoryMovementDto,
  ): Promise<{ id: string; quantityDelta: number; quantity: string }> {
    const quantityDelta = Number(input.quantityDelta)
    const reason = input.reason.trim()
    if (
      !Number.isSafeInteger(quantityDelta) ||
      quantityDelta === 0 ||
      Math.abs(quantityDelta) > 1_000_000 ||
      reason.length < 3 ||
      reason.length > 500
    ) {
      throw new BadRequestException('Invalid inventory movement')
    }

    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, INVENTORY_ADJUST_PERMISSION,
      )
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${tenantId}),
          hashtext(${branchId + ':' + productId})
        )
      `
      const products = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Product"
        WHERE id = ${productId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `
      if (!products[0]) {
        throw new NotFoundException('Product not found')
      }
      const currentRows = await tx.$queryRaw<Array<{ quantity: string }>>`
        SELECT COALESCE(SUM("quantityDelta"), 0)::text AS quantity
        FROM "InventoryMovement"
        WHERE "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND "productId" = ${productId}
      `
      const currentQuantity = Number(currentRows[0]?.quantity ?? '0')
      const updatedQuantity = currentQuantity + quantityDelta
      if (
        !Number.isSafeInteger(currentQuantity) ||
        updatedQuantity < 0 ||
        updatedQuantity > MAX_STOCK
      ) {
        throw new BadRequestException('Inventory quantity would be out of range')
      }

      const movementId = randomUUID()
      await tx.$executeRaw`
        INSERT INTO "InventoryMovement"
          (id, "tenantId", "branchId", "productId", "actorUserId",
           "quantityDelta", reason, "createdAt")
        VALUES
          (${movementId}, ${tenantId}, ${branchId}, ${productId},
           ${actorUserId}, ${quantityDelta}, ${reason}, CURRENT_TIMESTAMP)
      `
      return {
        id: movementId,
        quantityDelta,
        quantity: String(updatedQuantity),
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  }

  private validateProductInput(
    input: CreateProductDto | UpdateProductDto,
  ): void {
    if (input.sku !== undefined && !input.sku.trim()) {
      throw new BadRequestException('Product SKU is required')
    }
    if (input.name !== undefined && !input.name.trim()) {
      throw new BadRequestException('Product name is required')
    }
    if (
      input.price !== undefined &&
      !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(input.price)
    ) {
      throw new BadRequestException('Product price must have at most two decimals')
    }
    if (Object.keys(input).length === 0) {
      throw new BadRequestException('At least one product field is required')
    }
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
