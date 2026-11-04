import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { ExpenseService } from "../src/expense.service";
import { ListExpensesDto } from "../src/expense.dto";
import { createPrismaMock } from "./test-helpers";

describe("ExpenseService", () => {
  it("rejects invalid expense input before opening a transaction", async () => {
    const mock = createPrismaMock();
    const service = new ExpenseService(mock.prisma);
    await assert.rejects(
      service.createExpense("user-1", "tenant-1", "branch-1", "short", {
        category: "Rent",
        description: "Monthly rent",
        amount: "10.00",
        method: "CASH",
      }),
      BadRequestException,
    );
    await assert.rejects(
      service.createExpense(
        "user-1",
        "tenant-1",
        "branch-1",
        "expense-idempotency-01",
        {
          category: "Rent",
          description: "Monthly rent",
          amount: "0.00",
          method: "CASH",
        },
      ),
      BadRequestException,
    );
    await assert.rejects(
      service.createExpense(
        "user-1",
        "tenant-1",
        "branch-1",
        "expense-idempotency-01",
        {
          category: "",
          description: "x",
          amount: "5.00",
          method: "CASH",
        },
      ),
      BadRequestException,
    );
    assert.equal(mock.transactionCount, 0);
  });

  it("fails closed when the caller lacks branch-scoped expense permission", async () => {
    const mock = createPrismaMock({ queryResults: [[{ allowed: false }]] });
    const service = new ExpenseService(mock.prisma);
    await assert.rejects(
      service.listExpenses(
        "user-1",
        "tenant-1",
        "branch-1",
        new ListExpensesDto(),
      ),
      ForbiddenException,
    );
    await assert.rejects(
      service.createExpense(
        "user-1",
        "tenant-1",
        "branch-1",
        "expense-idempotency-01",
        {
          category: "Rent",
          description: "Monthly rent",
          amount: "10.00",
          method: "CARD",
        },
      ),
      ForbiddenException,
    );
    assert.equal(mock.executeCalls.length, 0);
  });

  it("links cash expenses to the open shift and refuses without one", async () => {
    const noShift = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "TenantMembership" tm'))
          return [{ allowed: true }];
        if (call.text.includes('FROM "Expense"')) return [];
        if (call.text.includes('FROM "CashShift"')) return [];
        return [];
      },
    });
    const service = new ExpenseService(noShift.prisma);
    await assert.rejects(
      service.createExpense(
        "user-1",
        "tenant-1",
        "branch-1",
        "expense-idempotency-01",
        {
          category: "Supplies",
          description: "Cleaning supplies",
          amount: "4.50",
          method: "CASH",
        },
      ),
      ConflictException,
    );

    const withShift = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "TenantMembership" tm'))
          return [{ allowed: true }];
        if (
          call.text.includes('FROM "Expense"') &&
          call.text.includes("idempotencyKey")
        )
          return [];
        if (call.text.includes('FROM "CashShift"')) return [{ id: "shift-1" }];
        if (
          call.text.includes('INSERT INTO "Expense"') &&
          !call.text.includes("AuditLog")
        ) {
          return [
            {
              id: "expense-1",
              tenantId: "tenant-1",
              branchId: "branch-1",
              cashShiftId: "shift-1",
              actorUserId: "user-1",
              category: "Supplies",
              description: "Cleaning supplies",
              amount: "4.50",
              method: "CASH",
              expenseDate: new Date(),
              status: "ACTIVE",
              voidedByUserId: null,
              voidedAt: null,
              createdAt: new Date(),
              requestHash: "x".repeat(64),
            },
          ];
        }
        return [];
      },
    });
    const result = await new ExpenseService(withShift.prisma).createExpense(
      "user-1",
      "tenant-1",
      "branch-1",
      "expense-idempotency-01",
      {
        category: "Supplies",
        description: "Cleaning supplies",
        amount: "4.50",
        method: "CASH",
      },
    );
    assert.equal(result.cashShiftId, "shift-1");
    const insert = withShift.queryCalls.find(
      (call) =>
        call.text.includes('INSERT INTO "Expense"') &&
        !call.text.includes("AuditLog"),
    );
    assert.ok(insert?.values.includes("shift-1"));
  });

  it("rejects a repeated idempotency key with a different payload", async () => {
    const firstHash = "a".repeat(64);
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "TenantMembership" tm'))
          return [{ allowed: true }];
        if (
          call.text.includes('FROM "Expense"') &&
          call.text.includes("idempotencyKey")
        ) {
          return [
            {
              id: "expense-1",
              tenantId: "tenant-1",
              branchId: "branch-1",
              cashShiftId: null,
              actorUserId: "user-1",
              category: "Rent",
              description: "Monthly rent",
              amount: "10.00",
              method: "CARD",
              expenseDate: new Date(),
              status: "ACTIVE",
              voidedByUserId: null,
              voidedAt: null,
              createdAt: new Date(),
              requestHash: firstHash,
            },
          ];
        }
        return [];
      },
    });
    const service = new ExpenseService(mock.prisma);
    await assert.rejects(
      service.createExpense(
        "user-1",
        "tenant-1",
        "branch-1",
        "expense-idempotency-01",
        {
          category: "Rent",
          description: "Monthly rent",
          amount: "99.00",
          method: "CARD",
        },
      ),
      ConflictException,
    );
  });

  it("voids only active expenses once and writes an audit record", async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "TenantMembership" tm'))
          return [{ allowed: true }];
        if (call.text.includes("FOR UPDATE"))
          return [{ id: "expense-1", status: "ACTIVE" }];
        if (call.text.includes('UPDATE "Expense"')) {
          return [
            {
              id: "expense-1",
              status: "VOIDED",
              voidedByUserId: "user-1",
              voidedAt: new Date(),
            },
          ];
        }
        return [];
      },
    });
    const service = new ExpenseService(mock.prisma);
    const result = await service.voidExpense(
      "user-1",
      "tenant-1",
      "branch-1",
      "expense-1",
    );
    assert.equal(result.status, "VOIDED");
    assert.match(mock.executeCalls[0].text, /INSERT INTO "ExpenseAuditLog"/);

    const alreadyVoided = createPrismaMock({
      queryResponder(call) {
        if (call.text.includes('FROM "TenantMembership" tm'))
          return [{ allowed: true }];
        if (call.text.includes("FOR UPDATE"))
          return [{ id: "expense-1", status: "VOIDED" }];
        return [];
      },
    });
    await assert.rejects(
      new ExpenseService(alreadyVoided.prisma).voidExpense(
        "user-1",
        "tenant-1",
        "branch-1",
        "expense-1",
      ),
      ConflictException,
    );
  });

  it("rejects an inverted date range before reading expenses", async () => {
    const mock = createPrismaMock();
    const service = new ExpenseService(mock.prisma);
    await assert.rejects(
      service.listExpenses("user-1", "tenant-1", "branch-1", {
        from: "2026-02-01",
        to: "2026-01-01",
      }),
      BadRequestException,
    );
    assert.equal(mock.transactionCount, 0);
  });
});
