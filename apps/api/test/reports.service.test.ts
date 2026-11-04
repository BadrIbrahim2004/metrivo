import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ReportsService } from "../src/reports.service";
import { createPrismaMock } from "./test-helpers";

function permissionAllowed(call: { text: string }) {
  return call.text.includes('FROM "TenantMembership" tm')
    ? [{ allowed: true }]
    : undefined;
}

describe("ReportsService", () => {
  it("fails closed without branch-scoped report permission", async () => {
    const mock = createPrismaMock({ queryResults: [[{ allowed: false }]] });
    const service = new ReportsService(mock.prisma);
    await assert.rejects(
      service.dashboardSummary("user-1", "tenant-1", "branch-1", {}),
      ForbiddenException,
    );
    await assert.rejects(
      service.inventoryStatus("user-1", "tenant-1", "branch-1"),
      ForbiddenException,
    );
    assert.equal(mock.executeCalls.length, 0);
  });

  it("rejects inverted date ranges before any database work", async () => {
    const mock = createPrismaMock();
    const service = new ReportsService(mock.prisma);
    await assert.rejects(
      service.dashboardSummary("user-1", "tenant-1", "branch-1", {
        from: "2026-02-10",
        to: "2026-02-01",
      }),
      BadRequestException,
    );
    await assert.rejects(
      service.productPerformance("user-1", "tenant-1", "branch-1", {
        from: "2026-02-10",
        to: "2026-02-01",
      }),
      BadRequestException,
    );
    assert.equal(mock.transactionCount, 0);
  });

  it("rejects malformed and excessively long date ranges", async () => {
    const mock = createPrismaMock();
    const service = new ReportsService(mock.prisma);
    await assert.rejects(
      service.dashboardSummary("user-1", "tenant-1", "branch-1", {
        from: "02/01/2026",
        to: "2026-02-10",
      }),
      BadRequestException,
    );
    await assert.rejects(
      service.dashboardSummary("user-1", "tenant-1", "branch-1", {
        from: "2020-01-01",
        to: "2026-12-31",
      }),
      BadRequestException,
    );
    assert.equal(mock.transactionCount, 0);
  });

  it("computes dashboard figures from sale, expense, and refund aggregates", async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = permissionAllowed(call);
        if (allowed) return allowed;
        if (call.text.includes('FROM "Sale"\n        WHERE')) {
          return [{ revenue: "1000.00", orderCount: 4n }];
        }
        if (call.text.includes('FROM "SaleReturn" sr')) {
          return [{ total: "50.00" }];
        }
        if (
          call.text.includes('FROM "Expense"') &&
          call.text.includes("GROUP BY") === false
        ) {
          return [{ total: "120.00" }];
        }
        if (call.text.includes("costValue")) return [{ total: "400.00" }];
        if (call.text.includes('FROM "SaleReturnSettlement" rs')) {
          return [{ total: "50.00" }];
        }
        if (call.text.includes("lowStock") || call.text.includes("<= 0")) {
          return [{ count: 2n }];
        }
        if (call.text.includes('FROM "Customer"')) return [{ count: 7n }];
        return [];
      },
    });
    const service = new ReportsService(mock.prisma);
    const summary = await service.dashboardSummary(
      "user-1",
      "tenant-1",
      "branch-1",
      {},
    );
    assert.equal(summary.revenue, "1000.00");
    assert.equal(summary.orderCount, 4);
    assert.equal(summary.averageOrderValue, "250.00");
    assert.equal(summary.expenses, "120.00");
    assert.equal(summary.netProfit, "430.00");
    assert.equal(summary.activeCustomers, 7);
    assert.equal(summary.lowStockCount, 2);
  });

  it("includes voided expenses separately in the category summary", async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = permissionAllowed(call);
        if (allowed) return allowed;
        if (call.text.includes("GROUP BY category")) {
          return [
            { category: "Rent", activeTotal: "500.00", voidedTotal: "100.00" },
            {
              category: "Utilities",
              activeTotal: "80.00",
              voidedTotal: "0.00",
            },
          ];
        }
        return [];
      },
    });
    const service = new ReportsService(mock.prisma);
    const rows = await service.expenseSummary(
      "user-1",
      "tenant-1",
      "branch-1",
      {},
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].activeTotal, "500.00");
    assert.equal(rows[1].category, "Utilities");
  });

  it("rejects an invalid order-by filter", async () => {
    const mock = createPrismaMock();
    const service = new ReportsService(mock.prisma);
    await assert.rejects(
      service.productPerformance("user-1", "tenant-1", "branch-1", {
        orderBy: "profit" as unknown as "revenue" | "quantity",
      }),
      BadRequestException,
    );
    assert.equal(mock.transactionCount, 0);
  });
});
