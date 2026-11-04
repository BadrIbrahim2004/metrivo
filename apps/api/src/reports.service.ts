import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { ProductPerformanceQueryDto, ReportQueryDto } from "./reports.dto";

export const REPORTS_READ_PERMISSION = "reports.read";

export interface DashboardSummary {
  revenue: string;
  orderCount: number;
  averageOrderValue: string;
  activeCustomers: number;
  netProfit: string | null;
  cogs: string | null;
  expenses: string;
  refundsSettledCash: string;
  lowStockCount: number;
}

export interface ProductPerformanceRow {
  productId: string;
  productName: string;
  productSku: string;
  quantitySold: string;
  revenue: string;
  estimatedCost: string;
  grossMargin: string;
}

export interface InventoryStatusRow {
  productId: string;
  productName: string;
  productSku: string;
  type: string;
  stock: string;
  isLow: boolean;
}

export interface ExpenseSummaryRow {
  category: string;
  activeTotal: string;
  voidedTotal: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboardSummary(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: ReportQueryDto,
  ): Promise<DashboardSummary> {
    const range = this.resolveRange(input);
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        REPORTS_READ_PERMISSION,
      );
      const sales = await tx.$queryRaw<
        Array<{
          revenue: string;
          orderCount: bigint;
        }>
      >`
        SELECT COALESCE(SUM(total), 0)::text AS revenue,
               COUNT(*)::bigint AS "orderCount"
        FROM "Sale"
        WHERE "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND "createdAt" >= ${range.from}::timestamptz
          AND "createdAt" < ${range.to}::timestamptz
      `;
      const refundRows = await tx.$queryRaw<Array<{ total: string | null }>>`
        SELECT SUM(sr."refundAmount")::text AS total
        FROM "SaleReturn" sr
        JOIN "Sale" s ON s.id = sr."saleId" AND s."tenantId" = sr."tenantId"
          AND s."branchId" = sr."branchId"
        WHERE sr."tenantId" = ${tenantId}
          AND sr."branchId" = ${branchId}
          AND sr."createdAt" >= ${range.from}::timestamptz
          AND sr."createdAt" < ${range.to}::timestamptz
      `;
      const expenseRows = await tx.$queryRaw<Array<{ total: string | null }>>`
        SELECT SUM(amount)::text AS total
        FROM "Expense"
        WHERE "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND status = 'ACTIVE'
          AND "expenseDate" >= ${range.from}::date
          AND "expenseDate" <= ${range.to}::date
      `;
      // Cost of goods per sold product, in priority order:
      // 1. Recipe estimated cost (sum of ingredient costs incl. waste allowance)
      //    for products made from a recipe.
      // 2. Latest received purchase unit cost.
      // 3. Product sale price — a documented ESTIMATE, not a true cost basis;
      //    reports relying on this fallback overstate profit for those items.
      const cogsBySale = await tx.$queryRaw<Array<{ total: string | null }>>`
        SELECT SUM("costValue")::text AS total
        FROM (
          SELECT si."saleId",
                 SUM(si.quantity * COALESCE(
                   recipe_cost."estimatedCost",
                   pi2."unitCost",
                   p.price
                 )) AS "costValue"
          FROM "SaleItem" si
          JOIN "Sale" s ON s.id = si."saleId" AND s."tenantId" = si."tenantId"
            AND s."branchId" = ${branchId}
            AND s."createdAt" >= ${range.from}::timestamptz
            AND s."createdAt" < ${range.to}::timestamptz
          JOIN "Product" p ON p.id = si."productId" AND p."tenantId" = si."tenantId"
          LEFT JOIN LATERAL (
            SELECT pi."unitCost"
            FROM "PurchaseItem" pi
            JOIN "Purchase" pu ON pu.id = pi."purchaseId" AND pu."tenantId" = pi."tenantId"
            WHERE pi."tenantId" = si."tenantId" AND pi."productId" = si."productId"
              AND pu.status = 'RECEIVED'
            ORDER BY pu."receivedAt" DESC NULLS LAST
            LIMIT 1
          ) pi2 ON TRUE
          LEFT JOIN LATERAL (
            SELECT SUM(ri.quantity * (1 + ri."wastePercent" / 100.0)
              * COALESCE(ing_cost."unitCost", ing.price))::numeric(12, 2) AS "estimatedCost"
            FROM "Recipe" r
            JOIN "RecipeItem" ri ON ri."recipeId" = r.id AND ri."tenantId" = r."tenantId"
            JOIN "Product" ing ON ing.id = ri."ingredientId" AND ing."tenantId" = ri."tenantId"
            LEFT JOIN LATERAL (
              SELECT pi."unitCost"
              FROM "PurchaseItem" pi
              JOIN "Purchase" pu ON pu.id = pi."purchaseId" AND pu."tenantId" = pi."tenantId"
              WHERE pi."tenantId" = ing."tenantId" AND pi."productId" = ing.id
                AND pu.status = 'RECEIVED'
              ORDER BY pu."receivedAt" DESC NULLS LAST
              LIMIT 1
            ) ing_cost ON TRUE
            WHERE r."productId" = p.id AND r."tenantId" = p."tenantId"
            GROUP BY r.id
          ) recipe_cost ON TRUE
          GROUP BY si."saleId", si."productId"
        ) ci
      `;
      const settledCash = await tx.$queryRaw<Array<{ total: string | null }>>`
        SELECT SUM(rs.amount)::text AS total
        FROM "SaleReturnSettlement" rs
        WHERE rs."tenantId" = ${tenantId}
          AND rs."branchId" = ${branchId}
          AND rs.method = 'CASH'
          AND rs."settledAt" >= ${range.from}::timestamptz
          AND rs."settledAt" < ${range.to}::timestamptz
      `;
      const lowStock = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "Product" p
        WHERE p."tenantId" = ${tenantId}
          AND p."isActive" = TRUE
          AND COALESCE((
            SELECT SUM(m."quantityDelta") FROM "InventoryMovement" m
            WHERE m."productId" = p.id AND m."tenantId" = p."tenantId"
              AND m."branchId" = ${branchId}
          ), 0) <= 0
      `;
      const customers = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "Customer"
        WHERE "tenantId" = ${tenantId} AND "isActive" = TRUE
      `;
      const revenueCents = this.parseMoney(sales[0]?.revenue ?? "0");
      const refunds = refundRows[0]?.total
        ? this.parseMoney(refundRows[0].total)
        : 0n;
      const expenses = expenseRows[0]?.total
        ? this.parseMoney(expenseRows[0].total)
        : 0n;
      const cogs = cogsBySale[0]?.total
        ? this.parseMoney(cogsBySale[0].total)
        : 0n;
      const netProfit = revenueCents - refunds - cogs - expenses;
      return {
        revenue: this.formatMoney(revenueCents),
        orderCount: Number(sales[0]?.orderCount ?? 0n),
        averageOrderValue: this.formatMoney(
          sales[0] && sales[0].orderCount > 0n
            ? revenueCents / sales[0].orderCount
            : 0n,
        ),
        activeCustomers: Number(customers[0]?.count ?? 0n),
        cogs: this.formatMoney(cogs),
        netProfit: this.formatMoney(netProfit),
        expenses: this.formatMoney(expenses),
        refundsSettledCash: this.formatMoney(
          settledCash[0]?.total ? this.parseMoney(settledCash[0].total) : 0n,
        ),
        lowStockCount: Number(lowStock[0]?.count ?? 0n),
      };
    });
  }

  async productPerformance(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: ProductPerformanceQueryDto,
  ): Promise<ProductPerformanceRow[]> {
    const range = this.resolveRange(input);
    if (
      input?.orderBy !== undefined &&
      input.orderBy !== "revenue" &&
      input.orderBy !== "quantity"
    ) {
      throw new BadRequestException("Invalid performance ordering");
    }
    const order = input?.orderBy === "quantity" ? "quantity" : "revenue";
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        REPORTS_READ_PERMISSION,
      );
      const rows = await tx.$queryRaw<
        Array<{
          productId: string;
          productName: string;
          productSku: string;
          quantitySold: string;
          revenue: string;
          estimatedCost: string | null;
        }>
      >`
        SELECT p.id AS "productId", p.name AS "productName", p.sku AS "productSku",
               SUM(si.quantity)::text AS "quantitySold",
               SUM(si."lineTotal")::text AS revenue,
               SUM(si.quantity * COALESCE(latest."unitCost", p.price))::text AS "estimatedCost"
        FROM "SaleItem" si
        JOIN "Sale" s ON s.id = si."saleId" AND s."tenantId" = si."tenantId"
          AND s."branchId" = ${branchId}
          AND s."createdAt" >= ${range.from}::timestamptz
          AND s."createdAt" < ${range.to}::timestamptz
        JOIN "Product" p ON p.id = si."productId" AND p."tenantId" = si."tenantId"
        LEFT JOIN LATERAL (
          SELECT pi."unitCost"
          FROM "PurchaseItem" pi
          JOIN "Purchase" pu ON pu.id = pi."purchaseId" AND pu."tenantId" = pi."tenantId"
          WHERE pi."tenantId" = si."tenantId" AND pi."productId" = si."productId"
            AND pu.status = 'RECEIVED'
          ORDER BY pu."receivedAt" DESC NULLS LAST
          LIMIT 1
        ) latest ON TRUE
        GROUP BY p.id, p.name, p.sku
        ORDER BY ${
          order === "quantity"
            ? Prisma.sql`SUM(si.quantity) DESC`
            : Prisma.sql`SUM(si."lineTotal") DESC`
        }
        LIMIT 50
      `;
      return rows.map((row) => ({
        ...row,
        estimatedCost: row.estimatedCost ?? "0.00",
        grossMargin: this.formatMoney(
          this.parseMoney(row.revenue) -
            (row.estimatedCost ? this.parseMoney(row.estimatedCost) : 0n),
        ),
      }));
    });
  }

  async inventoryStatus(
    actorUserId: string,
    tenantId: string,
    branchId: string,
  ): Promise<InventoryStatusRow[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        REPORTS_READ_PERMISSION,
      );
      return tx.$queryRaw<InventoryStatusRow[]>`
        SELECT p.id AS "productId", p.name AS "productName", p.sku AS "productSku",
               p.type::text AS type,
               COALESCE(SUM(m."quantityDelta"), 0)::text AS stock,
               (COALESCE(SUM(m."quantityDelta"), 0) <= 0) AS "isLow"
        FROM "Product" p
        LEFT JOIN "InventoryMovement" m
          ON m."productId" = p.id
         AND m."tenantId" = p."tenantId"
         AND m."branchId" = ${branchId}
        WHERE p."tenantId" = ${tenantId} AND p."isActive" = TRUE
        GROUP BY p.id, p.name, p.sku, p.type
        ORDER BY p.name, p.id
        LIMIT 500
      `;
    });
  }

  async expenseSummary(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: ReportQueryDto,
  ): Promise<ExpenseSummaryRow[]> {
    const range = this.resolveRange(input);
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        REPORTS_READ_PERMISSION,
      );
      return tx.$queryRaw<ExpenseSummaryRow[]>`
        SELECT category,
               SUM(CASE WHEN status = 'ACTIVE' THEN amount ELSE 0 END)::text AS "activeTotal",
               SUM(CASE WHEN status = 'VOIDED' THEN amount ELSE 0 END)::text AS "voidedTotal"
        FROM "Expense"
        WHERE "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND "expenseDate" >= ${range.from}::date
          AND "expenseDate" <= ${range.to}::date
        GROUP BY category
        ORDER BY 2 DESC
        LIMIT 100
      `;
    });
  }

  private resolveRange(input?: ReportQueryDto): { from: string; to: string } {
    const today = new Date();
    const toLocal = today.toISOString().slice(0, 10);
    const fromDefault = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const from = input?.from ?? fromDefault;
    const to = input?.to ?? toLocal;
    for (const value of [from, to]) {
      if (!DATE_PATTERN.test(value))
        throw new BadRequestException("Invalid report date");
    }
    if (from > to)
      throw new BadRequestException("Report date range is inverted");
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    if ((toMs - fromMs) / 86_400_000 > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        "Report range exceeds the supported maximum",
      );
    }
    // exclusive upper bound: day after `to`, local-date based
    const toExclusive = new Date(toMs + 86_400_000).toISOString().slice(0, 10);
    return { from, to: toExclusive };
  }

  private parseMoney(value: string): bigint {
    if (typeof value !== "string" || !/^-?\d+(\.\d{1,2})?$/.test(value))
      return 0n;
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
