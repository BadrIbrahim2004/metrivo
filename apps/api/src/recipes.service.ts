import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import {
  ListWasteDto,
  ProduceBatchDto,
  RecordWasteDto,
  SaveRecipeDto,
} from "./recipes.dto";

export const RECIPES_READ_PERMISSION = "recipes.read";
export const RECIPES_MANAGE_PERMISSION = "recipes.manage";
export const INVENTORY_WASTE_PERMISSION = "inventory.waste";

export interface RecipeRow {
  id: string;
  tenantId: string;
  productId: string;
  productName: string;
  productSku: string;
  yieldQuantity: number;
  estimatedCost: string;
  items: Array<{
    id: string;
    ingredientId: string;
    ingredientName: string;
    quantity: string;
    wastePercent: string;
    unitCost: string;
    lineCost: string;
  }>;
}

export interface ProductionBatchRow {
  id: string;
  recipeId: string;
  productName: string;
  batchQuantity: number;
  createdAt: Date;
}

export interface WasteRow {
  id: string;
  tenantId: string;
  branchId: string;
  productId: string;
  productName: string;
  actorUserId: string;
  quantity: string;
  reason: string;
  costImpact: string;
  status: "ACTIVE" | "VOIDED";
  voidedByUserId: string | null;
  voidedAt: Date | null;
  createdAt: Date;
}

interface RecipeItemRow {
  id: string;
  ingredientId: string;
  ingredientName: string;
  quantity: string;
  wastePercent: string;
  unitCost: string;
  lineCost: string;
}

const MAX_TOTAL_CENTS = 999_999_999_999n;
const MICRO = 1_000_000n;

@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  async saveRecipe(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: SaveRecipeDto,
  ): Promise<RecipeRow> {
    const itemMap = this.validateRecipeInput(input);
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        RECIPES_MANAGE_PERMISSION,
      );
      await this.getRecipeProduct(tx, tenantId, input.productId);

      const ingredients = new Map<string, { unitCostCents: bigint }>();
      for (const ingredientId of itemMap.keys()) {
        const rows = await tx.$queryRaw<Array<{ unitCost: string | null }>>`
          SELECT COALESCE(
                   (SELECT pi."unitCost" FROM "PurchaseItem" pi
                    JOIN "Purchase" pu ON pu.id = pi."purchaseId" AND pu."tenantId" = pi."tenantId"
                    WHERE pi."tenantId" = p."tenantId" AND pi."productId" = p.id
                      AND pu.status = 'RECEIVED'
                    ORDER BY pu."receivedAt" DESC NULLS LAST
                    LIMIT 1),
                   p.price
                 )::text AS "unitCost"
          FROM "Product" p
          WHERE p.id = ${ingredientId} AND p."tenantId" = ${tenantId}
            AND p."isActive" = true AND p.type = 'INGREDIENT'
          FOR SHARE
        `;
        if (!rows[0]) {
          throw new NotFoundException(
            "Ingredient not found or not an active ingredient",
          );
        }
        ingredients.set(ingredientId, {
          unitCostCents: this.parseMoney(rows[0].unitCost ?? "0"),
        });
      }

      const recipeId = await this.upsertRecipe(
        tx,
        actorUserId,
        tenantId,
        input,
      );
      await tx.$executeRaw`
        DELETE FROM "RecipeItem" WHERE "recipeId" = ${recipeId} AND "tenantId" = ${tenantId}
      `;
      let estimatedCents = 0n;
      for (const [ingredientId, item] of itemMap) {
        await tx.$executeRaw`
          INSERT INTO "RecipeItem"
            (id, "tenantId", "recipeId", "ingredientId", quantity, "wastePercent")
          VALUES
            (${randomUUID()}, ${tenantId}, ${recipeId}, ${ingredientId},
             ${this.formatMicros(item.quantityMicro)}::numeric,
             ${this.formatMicros(item.wastePercentMicro)}::numeric)
        `;
        const effective =
          item.quantityMicro +
          (item.quantityMicro * item.wastePercentMicro) / 100n;
        estimatedCents +=
          (ingredients.get(ingredientId)!.unitCostCents * effective) / MICRO;
      }
      if (estimatedCents < 0n || estimatedCents > MAX_TOTAL_CENTS) {
        throw new BadRequestException("Recipe cost is out of range");
      }

      await this.writeAudit(
        tx,
        tenantId,
        branchId,
        actorUserId,
        "RECIPE_SAVED",
        {
          recipeId,
          productId: input.productId,
          yieldQuantity: input.yieldQuantity,
          estimatedCost: this.formatMoney(estimatedCents),
        },
      );
      return this.getRecipeInTransaction(tx, tenantId, recipeId);
    });
  }

  async listRecipes(
    actorUserId: string,
    tenantId: string,
    branchId: string,
  ): Promise<RecipeRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        RECIPES_READ_PERMISSION,
      );
      const recipes = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Recipe"
        WHERE "tenantId" = ${tenantId}
        ORDER BY id
        LIMIT 200
      `;
      const rows: RecipeRow[] = [];
      for (const recipe of recipes) {
        rows.push(await this.getRecipeInTransaction(tx, tenantId, recipe.id));
      }
      return rows;
    });
  }

  async produceBatch(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    idempotencyKey: string,
    input: ProduceBatchDto,
  ): Promise<ProductionBatchRow> {
    this.validateBatchInput(input, idempotencyKey);
    const requestHash = this.hash(
      JSON.stringify({
        recipeId: input.recipeId,
        batchQuantity: input.batchQuantity,
      }),
    );

    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        RECIPES_MANAGE_PERMISSION,
      );
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${tenantId}), hashtext(${"production:" + actorUserId + ":" + idempotencyKey})
        )::text
      `;
      const prior = await tx.$queryRaw<
        Array<{ id: string; requestHash: string; createdAt: Date }>
      >`
        SELECT id, "requestHash", "createdAt" FROM "ProductionBatch"
        WHERE "tenantId" = ${tenantId} AND "actorUserId" = ${actorUserId}
          AND "idempotencyKey" = ${idempotencyKey}
      `;
      if (prior[0]) {
        if (prior[0].requestHash.trim() !== requestHash) {
          throw new ConflictException(
            "Idempotency key was used for a different production batch",
          );
        }
        return {
          id: prior[0].id,
          recipeId: input.recipeId,
          productName: '',
          batchQuantity: input.batchQuantity,
          createdAt: prior[0].createdAt,
        };
      }

      const recipes = await tx.$queryRaw<
        Array<{ id: string; productId: string; yieldQuantity: number; productName: string }>
      >`
        SELECT r.id, r."productId", r."yieldQuantity", p.name AS "productName"
        FROM "Recipe" r
        JOIN "Product" p ON p.id = r."productId" AND p."tenantId" = r."tenantId"
        WHERE r.id = ${input.recipeId} AND r."tenantId" = ${tenantId}
        FOR UPDATE
      `;
      const recipe = recipes[0];
      if (!recipe) throw new NotFoundException("Recipe not found");
      const recipeProductName = recipe.productName;

      const items = await tx.$queryRaw<
        Array<{
          ingredientId: string;
          ingredientName: string;
          quantity: string;
          wastePercent: string;
        }>
      >`
        SELECT ri."ingredientId", p.name AS "ingredientName",
               ri.quantity::text AS quantity, ri."wastePercent"::text AS "wastePercent"
        FROM "RecipeItem" ri
        JOIN "Product" p ON p.id = ri."ingredientId" AND p."tenantId" = ri."tenantId"
        WHERE ri."recipeId" = ${recipe.id} AND ri."tenantId" = ${tenantId}
        ORDER BY ri."ingredientId"
      `;
      if (!items.length)
        throw new ConflictException("Recipe has no ingredients");

      const neededMicro = new Map<string, bigint>();
      for (const item of items) {
        const quantityMicro = this.parseMicros(item.quantity);
        const wasteMicro = this.parseMicros(item.wastePercent);
        const effective = quantityMicro + (quantityMicro * wasteMicro) / 100n;
        neededMicro.set(
          item.ingredientId,
          effective * BigInt(input.batchQuantity),
        );
      }
      for (const [ingredientId, needed] of neededMicro) {
        if (needed % MICRO !== 0n) {
          throw new BadRequestException(
            "Ingredient quantities must resolve to whole units for production",
          );
        }
        const stock = await tx.$queryRaw<Array<{ balance: string }>>`
          SELECT COALESCE(SUM("quantityDelta"), 0)::text AS balance
          FROM "InventoryMovement"
          WHERE "tenantId" = ${tenantId} AND "branchId" = ${branchId}
            AND "productId" = ${ingredientId}
        `;
        const balanceUnits = BigInt(stock[0]?.balance ?? "0");
        if (balanceUnits < needed / MICRO) {
          const item = items.find(
            (candidate) => candidate.ingredientId === ingredientId,
          );
          throw new ConflictException(
            `Insufficient ingredient stock for ${item?.ingredientName ?? ingredientId}`,
          );
        }
      }

      const batchId = randomUUID();
      await tx.$executeRaw`
        INSERT INTO "ProductionBatch"
          (id, "tenantId", "branchId", "recipeId", "actorUserId",
           "idempotencyKey", "requestHash", "batchQuantity", status, "createdAt")
        VALUES
          (${batchId}, ${tenantId}, ${branchId}, ${recipe.id}, ${actorUserId},
           ${idempotencyKey}, ${requestHash}, ${input.batchQuantity},
           'COMPLETED', CURRENT_TIMESTAMP)
      `;

      for (const [ingredientId, needed] of neededMicro) {
        await tx.$executeRaw`
          INSERT INTO "InventoryMovement"
            (id, "tenantId", "branchId", "productId", "actorUserId",
             "quantityDelta", reason, "createdAt")
          VALUES
            (${randomUUID()}, ${tenantId}, ${branchId}, ${ingredientId}, ${actorUserId},
             ${-Number(needed / MICRO)}, ${"Production batch " + batchId}, CURRENT_TIMESTAMP)
        `;
      }
      const producedUnits =
        BigInt(input.batchQuantity) * BigInt(recipe.yieldQuantity);
      await tx.$executeRaw`
        INSERT INTO "InventoryMovement"
          (id, "tenantId", "branchId", "productId", "actorUserId",
           "quantityDelta", reason, "createdAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${recipe.productId}, ${actorUserId},
           ${Number(producedUnits)}, ${"Production batch " + batchId}, CURRENT_TIMESTAMP)
      `;

      await this.writeAudit(
        tx,
        tenantId,
        branchId,
        actorUserId,
        "PRODUCTION_BATCH",
        {
          batchId,
          recipeId: recipe.id,
          batchQuantity: input.batchQuantity,
          producedUnits: producedUnits.toString(),
        },
      );
      const created = await tx.$queryRaw<Array<{ createdAt: Date }>>`
        SELECT "createdAt" FROM "ProductionBatch" WHERE id = ${batchId}
      `;
      return {
        id: batchId,
        recipeId: recipe.id,
        productName: recipeProductName,
        batchQuantity: input.batchQuantity,
        createdAt: created[0].createdAt,
      };
    });
  }

  async recordWaste(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    idempotencyKey: string,
    input: RecordWasteDto,
  ): Promise<WasteRow> {
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException("Invalid idempotency key");
    }
    const quantityMicro = this.parseMicros(input?.quantity);
    if (quantityMicro <= 0n)
      throw new BadRequestException("Waste quantity must be positive");
    const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
    if (!reason || reason.length > 500) {
      throw new BadRequestException("Invalid waste reason");
    }
    const requestHash = this.hash(
      JSON.stringify({
        productId: input?.productId ?? "",
        quantityMicro: quantityMicro.toString(),
        reason,
      }),
    );

    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        INVENTORY_WASTE_PERMISSION,
      );
      const prior = await tx.$queryRaw<
        Array<{ id: string; requestHash: string }>
      >`
        SELECT id, "requestHash" FROM "WasteRecord"
        WHERE "tenantId" = ${tenantId} AND "actorUserId" = ${actorUserId}
          AND "idempotencyKey" = ${idempotencyKey}
      `;
      if (prior[0]) {
        if (prior[0].requestHash.trim() !== requestHash) {
          throw new ConflictException(
            "Idempotency key was used for a different waste record",
          );
        }
        return this.getWasteById(tx, tenantId, prior[0].id);
      }

      const products = await tx.$queryRaw<
        Array<{ name: string; unitCost: string }>
      >`
        SELECT p.name,
               COALESCE(
                 (SELECT pi."unitCost" FROM "PurchaseItem" pi
                  JOIN "Purchase" pu ON pu.id = pi."purchaseId" AND pu."tenantId" = pi."tenantId"
                  WHERE pi."tenantId" = p."tenantId" AND pi."productId" = p.id
                    AND pu.status = 'RECEIVED'
                  ORDER BY pu."receivedAt" DESC NULLS LAST
                  LIMIT 1),
                 p.price
               )::text AS "unitCost"
        FROM "Product" p
        WHERE p.id = ${input.productId} AND p."tenantId" = ${tenantId}
          AND p."isActive" = true
        FOR UPDATE
      `;
      if (!products[0]) throw new NotFoundException("Product not found");

      const stock = await tx.$queryRaw<Array<{ balance: string }>>`
        SELECT COALESCE(SUM("quantityDelta"), 0)::text AS balance
        FROM "InventoryMovement"
        WHERE "tenantId" = ${tenantId} AND "branchId" = ${branchId}
          AND "productId" = ${input.productId}
      `;
      const balanceUnits = BigInt(stock[0]?.balance ?? "0");
      if (quantityMicro % MICRO !== 0n) {
        throw new BadRequestException(
          "Waste quantity must resolve to whole units",
        );
      }
      const units = quantityMicro / MICRO;
      if (balanceUnits < units) {
        throw new ConflictException(
          "Waste quantity exceeds the available stock",
        );
      }

      const costImpactCents =
        (this.parseMoney(products[0].unitCost) * quantityMicro) / MICRO;
      if (costImpactCents < 0n || costImpactCents > MAX_TOTAL_CENTS) {
        throw new BadRequestException("Waste cost is out of range");
      }

      const wasteId = randomUUID();
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          tenantId: string;
          branchId: string;
          productId: string;
          actorUserId: string;
          quantity: string;
          reason: string;
          costImpact: string;
          status: string;
          voidedByUserId: string | null;
          voidedAt: Date | null;
          createdAt: Date;
        }>
      >`
        INSERT INTO "WasteRecord"
          (id, "tenantId", "branchId", "productId", "actorUserId",
           "idempotencyKey", "requestHash", quantity, reason, "costImpact",
           status, "createdAt")
        VALUES
          (${wasteId}, ${tenantId}, ${branchId}, ${input.productId}, ${actorUserId},
           ${idempotencyKey}, ${requestHash},
           ${this.formatMicros(quantityMicro)}::numeric, ${reason},
           ${this.formatMoney(costImpactCents)}::numeric, 'ACTIVE', CURRENT_TIMESTAMP)
        RETURNING id, "tenantId", "branchId", "productId", "actorUserId",
                  quantity::text AS quantity, reason,
                  "costImpact"::text AS "costImpact",
                  status::text AS status, "voidedByUserId", "voidedAt", "createdAt"
      `;
      await tx.$executeRaw`
        INSERT INTO "InventoryMovement"
          (id, "tenantId", "branchId", "productId", "actorUserId",
           "quantityDelta", reason, "createdAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${input.productId}, ${actorUserId},
           ${-Number(units)}, ${"Waste: " + reason}, CURRENT_TIMESTAMP)
      `;
      await this.writeAudit(
        tx,
        tenantId,
        branchId,
        actorUserId,
        "WASTE_RECORDED",
        {
          wasteId,
          productId: input.productId,
          quantity: this.formatMicros(quantityMicro),
          costImpact: this.formatMoney(costImpactCents),
        },
      );
      return {
        ...rows[0],
        productName: products[0].name,
        status: "ACTIVE" as const,
      } as WasteRow;
    });
  }

  async listBatches(
    actorUserId: string,
    tenantId: string,
    branchId: string,
  ): Promise<ProductionBatchRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx, actorUserId, tenantId, branchId, RECIPES_READ_PERMISSION,
      )
      return tx.$queryRaw<ProductionBatchRow[]>`
        SELECT pb.id, pb."recipeId", pb."batchQuantity", pb."createdAt",
               p.name AS "productName"
        FROM "ProductionBatch" pb
        JOIN "Recipe" r ON r.id = pb."recipeId" AND r."tenantId" = pb."tenantId"
        JOIN "Product" p ON p.id = r."productId" AND p."tenantId" = r."tenantId"
        WHERE pb."tenantId" = ${tenantId} AND pb."branchId" = ${branchId}
        ORDER BY pb."createdAt" DESC, pb.id DESC
        LIMIT 50
      `
    })
  }

  async listWaste(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: ListWasteDto,
  ): Promise<WasteRow[]> {
    if (
      input?.status !== undefined &&
      !["ACTIVE", "VOIDED"].includes(input.status)
    ) {
      throw new BadRequestException("Invalid waste status filter");
    }
    if (
      input?.productId !== undefined &&
      (!input.productId || input.productId.length > 128)
    ) {
      throw new BadRequestException("Invalid product filter");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        RECIPES_READ_PERMISSION,
      );
      return tx.$queryRaw<WasteRow[]>`
        SELECT w.id, w."tenantId", w."branchId", w."productId", p.name AS "productName",
               w."actorUserId", w.quantity::text AS quantity, w.reason,
               w."costImpact"::text AS "costImpact",
               w.status::text AS status, w."voidedByUserId", w."voidedAt", w."createdAt"
        FROM "WasteRecord" w
        JOIN "Product" p ON p.id = w."productId" AND p."tenantId" = w."tenantId"
        WHERE w."tenantId" = ${tenantId} AND w."branchId" = ${branchId}
          AND (${input?.status ?? null}::text IS NULL OR w.status::text = ${input?.status ?? null})
          AND (${input?.productId ?? null}::text IS NULL OR w."productId" = ${input?.productId ?? null})
        ORDER BY w."createdAt" DESC, w.id DESC
        LIMIT 200
      `;
    });
  }

  async voidWaste(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    wasteId: string,
  ): Promise<WasteRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        INVENTORY_WASTE_PERMISSION,
      );
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status::text AS status
        FROM "WasteRecord"
        WHERE id = ${wasteId} AND "tenantId" = ${tenantId} AND "branchId" = ${branchId}
        FOR UPDATE
      `;
      if (!rows[0]) throw new NotFoundException("Waste record not found");
      if (rows[0].status !== "ACTIVE") {
        throw new ConflictException("Waste record is already voided");
      }
      const updated = await tx.$queryRaw<
        Array<{
          id: string;
          tenantId: string;
          branchId: string;
          productId: string;
          productName: string;
          actorUserId: string;
          quantity: string;
          reason: string;
          costImpact: string;
          status: string;
          voidedByUserId: string | null;
          voidedAt: Date | null;
          createdAt: Date;
        }>
      >`
        UPDATE "WasteRecord" w
        SET status = 'VOIDED',
            "voidedByUserId" = ${actorUserId},
            "voidedAt" = CURRENT_TIMESTAMP
        FROM "Product" p
        WHERE p.id = w."productId" AND p."tenantId" = w."tenantId"
          AND w.id = ${wasteId} AND w."tenantId" = ${tenantId} AND w."branchId" = ${branchId}
          AND w.status = 'ACTIVE'
        RETURNING w.id, w."tenantId", w."branchId", w."productId",
                  p.name AS "productName", w."actorUserId",
                  w.quantity::text AS quantity, w.reason,
                  w."costImpact"::text AS "costImpact",
                  w.status::text AS status, w."voidedByUserId", w."voidedAt", w."createdAt"
      `;
      const units = this.parseMicros(updated[0].quantity) / MICRO;
      await tx.$executeRaw`
        INSERT INTO "InventoryMovement"
          (id, "tenantId", "branchId", "productId", "actorUserId",
           "quantityDelta", reason, "createdAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${updated[0].productId}, ${actorUserId},
           ${Number(units)}, ${"Waste voided"}, CURRENT_TIMESTAMP)
      `;
      await this.writeAudit(
        tx,
        tenantId,
        branchId,
        actorUserId,
        "WASTE_VOIDED",
        { wasteId },
      );
      return { ...updated[0], status: "VOIDED" as const };
    });
  }

  private async getRecipeInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    recipeId: string,
  ): Promise<RecipeRow> {
    const recipes = await tx.$queryRaw<
      Array<{
        id: string;
        productId: string;
        productName: string;
        productSku: string;
        yieldQuantity: number;
      }>
    >`
      SELECT r.id, r."productId", p.name AS "productName", p.sku AS "productSku",
             r."yieldQuantity"
      FROM "Recipe" r
      JOIN "Product" p ON p.id = r."productId" AND p."tenantId" = r."tenantId"
      WHERE r.id = ${recipeId} AND r."tenantId" = ${tenantId}
    `;
    const recipe = recipes[0];
    if (!recipe) throw new NotFoundException("Recipe not found");
    const items = await tx.$queryRaw<RecipeItemRow[]>`
      SELECT ri.id, ri."ingredientId", p.name AS "ingredientName",
             ri.quantity::text AS quantity, ri."wastePercent"::text AS "wastePercent",
             COALESCE(
               (SELECT pi."unitCost" FROM "PurchaseItem" pi
                JOIN "Purchase" pu ON pu.id = pi."purchaseId" AND pu."tenantId" = pi."tenantId"
                WHERE pi."tenantId" = p."tenantId" AND pi."productId" = p.id
                  AND pu.status = 'RECEIVED'
                ORDER BY pu."receivedAt" DESC NULLS LAST
                LIMIT 1),
               p.price
             )::text AS "unitCost",
             '0.00' AS "lineCost"
      FROM "RecipeItem" ri
      JOIN "Product" p ON p.id = ri."ingredientId" AND p."tenantId" = ri."tenantId"
      WHERE ri."recipeId" = ${recipeId} AND ri."tenantId" = ${tenantId}
      ORDER BY p.name
    `;
    let estimatedCents = 0n;
    for (const item of items) {
      const quantityMicro = this.parseMicros(item.quantity);
      const wasteMicro = this.parseMicros(item.wastePercent);
      const effective = quantityMicro + (quantityMicro * wasteMicro) / 100n;
      const lineCents = (this.parseMoney(item.unitCost) * effective) / MICRO;
      item.lineCost = this.formatMoney(lineCents);
      estimatedCents += lineCents;
    }
    return {
      ...recipe,
      tenantId,
      estimatedCost: this.formatMoney(estimatedCents),
      items,
    };
  }

  private async getWasteById(
    tx: Prisma.TransactionClient,
    tenantId: string,
    wasteId: string,
  ): Promise<WasteRow> {
    const rows = await tx.$queryRaw<WasteRow[]>`
      SELECT w.id, w."tenantId", w."branchId", w."productId", p.name AS "productName",
             w."actorUserId", w.quantity::text AS quantity, w.reason,
             w."costImpact"::text AS "costImpact",
             w.status::text AS status, w."voidedByUserId", w."voidedAt", w."createdAt"
      FROM "WasteRecord" w
      JOIN "Product" p ON p.id = w."productId" AND p."tenantId" = w."tenantId"
      WHERE w.id = ${wasteId} AND w."tenantId" = ${tenantId}
    `;
    if (!rows[0]) throw new NotFoundException("Waste record not found");
    return rows[0];
  }

  private async getRecipeProduct(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Product"
      WHERE id = ${productId} AND "tenantId" = ${tenantId}
        AND "isActive" = true AND type = 'RETAIL'
      FOR SHARE
    `;
    if (!rows[0]) {
      throw new NotFoundException(
        "Finished product not found or not a retail product",
      );
    }
  }

  private async upsertRecipe(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    tenantId: string,
    input: SaveRecipeDto,
  ): Promise<string> {
    const existing = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Recipe"
      WHERE "productId" = ${input.productId} AND "tenantId" = ${tenantId}
      FOR UPDATE
    `;
    if (existing[0]) {
      await tx.$executeRaw`
        UPDATE "Recipe"
        SET "yieldQuantity" = ${input.yieldQuantity},
            "createdByUserId" = ${actorUserId},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${existing[0].id} AND "tenantId" = ${tenantId}
      `;
      return existing[0].id;
    }
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO "Recipe"
        (id, "tenantId", "productId", "yieldQuantity", "createdByUserId",
         "createdAt", "updatedAt")
      VALUES
        (${id}, ${tenantId}, ${input.productId}, ${input.yieldQuantity},
         ${actorUserId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    return id;
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    actorUserId: string,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "RecipeAuditLog"
        (id, "tenantId", "branchId", action, "actorUserId", metadata, "occurredAt")
      VALUES
        (${randomUUID()}, ${tenantId}, ${branchId}, ${action}, ${actorUserId},
         ${JSON.stringify(metadata)}::jsonb, CURRENT_TIMESTAMP)
    `;
  }

  private validateRecipeInput(
    input: SaveRecipeDto,
  ): Map<string, { quantityMicro: bigint; wastePercentMicro: bigint }> {
    if (
      !input ||
      typeof input.productId !== "string" ||
      !input.productId ||
      !Number.isSafeInteger(input.yieldQuantity) ||
      input.yieldQuantity < 1 ||
      input.yieldQuantity > 1_000_000 ||
      !Array.isArray(input.items) ||
      input.items.length < 1 ||
      input.items.length > 50
    ) {
      throw new BadRequestException("Invalid recipe");
    }
    const map = new Map<
      string,
      { quantityMicro: bigint; wastePercentMicro: bigint }
    >();
    for (const item of input.items) {
      if (
        !item ||
        typeof item.ingredientId !== "string" ||
        !item.ingredientId ||
        map.has(item.ingredientId)
      ) {
        throw new BadRequestException("Invalid recipe item");
      }
      const quantityMicro = this.parseMicros(item.quantity);
      if (quantityMicro <= 0n)
        throw new BadRequestException("Invalid recipe quantity");
      const wastePercentMicro = item.wastePercent
        ? this.parseMicros(item.wastePercent)
        : 0n;
      if (wastePercentMicro < 0n || wastePercentMicro > 100n * MICRO) {
        throw new BadRequestException("Invalid waste percent");
      }
      map.set(item.ingredientId, { quantityMicro, wastePercentMicro });
    }
    return map;
  }

  private validateBatchInput(
    input: ProduceBatchDto,
    idempotencyKey: string,
  ): void {
    if (
      !input ||
      typeof input.recipeId !== "string" ||
      !input.recipeId ||
      !Number.isSafeInteger(input.batchQuantity) ||
      input.batchQuantity < 1 ||
      input.batchQuantity > 100_000 ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)
    ) {
      throw new BadRequestException("Invalid production batch");
    }
  }

  private parseMicros(value: unknown): bigint {
    if (
      typeof value !== "string" ||
      !/^(0|[1-9]\d{0,5})(\.\d{1,3})?$/.test(value)
    ) {
      throw new BadRequestException("Invalid quantity");
    }
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * MICRO + BigInt(fraction.padEnd(3, "0"));
  }

  private formatMicros(micros: bigint): string {
    return `${micros / MICRO}.${(micros % MICRO).toString().padStart(3, "0")}`;
  }

  private parseMoney(value: string): bigint {
    if (
      typeof value !== "string" ||
      !/^-?(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)
    ) {
      throw new BadRequestException("Invalid monetary amount");
    }
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ""] = unsigned.split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    return negative ? -cents : cents;
  }

  private formatMoney(cents: bigint): string {
    const absolute = cents < 0n ? -cents : cents;
    return `${cents < 0n ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  private async assertBranchPermission(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    tenantId: string,
    branchId: string,
    permissionKey: string,
  ): Promise<void> {
    if (!actorUserId || !tenantId || !branchId) {
      throw new ForbiddenException("Tenant and branch access are required");
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
    `;
    if (!rows[0]?.allowed)
      throw new ForbiddenException("Branch permission required");
  }
}
