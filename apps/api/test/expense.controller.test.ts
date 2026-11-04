import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { UnauthorizedException } from "@nestjs/common";
import { TENANT_PERMISSION } from "../src/authz.decorator";
import {
  EXPENSES_MANAGE_PERMISSION,
  EXPENSES_READ_PERMISSION,
} from "../src/expense.service";
import { CreateExpenseDto, ListExpensesDto } from "../src/expense.dto";
import { ExpenseController } from "../src/expense.controller";
import type { ExpenseService } from "../src/expense.service";

function makeController() {
  const calls: Array<{ method: string; values: unknown[] }> = [];
  const service = new Proxy(
    {},
    {
      get:
        (_target, property: string) =>
        (...values: unknown[]) => {
          calls.push({ method: property, values });
          return Promise.resolve({});
        },
    },
  );
  return {
    controller: new ExpenseController(service as ExpenseService),
    calls,
  };
}

describe("ExpenseController", () => {
  it("declares read and manage permissions on each route", () => {
    assert.equal(
      Reflect.getMetadata(
        TENANT_PERMISSION,
        ExpenseController.prototype.listExpenses,
      ),
      EXPENSES_READ_PERMISSION,
    );
    assert.equal(
      Reflect.getMetadata(
        TENANT_PERMISSION,
        ExpenseController.prototype.createExpense,
      ),
      EXPENSES_MANAGE_PERMISSION,
    );
    assert.equal(
      Reflect.getMetadata(
        TENANT_PERMISSION,
        ExpenseController.prototype.voidExpense,
      ),
      EXPENSES_MANAGE_PERMISSION,
    );
  });

  it("forwards the authenticated actor and idempotency key to expense creation", async () => {
    const { controller, calls } = makeController();
    const input = Object.assign(new CreateExpenseDto(), {
      category: "Rent",
      description: "Monthly rent",
      amount: "10.00",
      method: "CARD",
    });
    await controller.createExpense(
      { user: { userId: "actor-1" } },
      "tenant-1",
      "branch-1",
      "expense-idempotency-01",
      input,
    );
    assert.deepEqual(calls[0], {
      method: "createExpense",
      values: [
        "actor-1",
        "tenant-1",
        "branch-1",
        "expense-idempotency-01",
        input,
      ],
    });
  });

  it("rejects unauthenticated callers before reaching the service", () => {
    const { controller, calls } = makeController();
    assert.throws(
      () =>
        controller.listExpenses(
          {},
          "tenant-1",
          "branch-1",
          new ListExpensesDto(),
        ),
      UnauthorizedException,
    );
    assert.equal(calls.length, 0);
  });

  it("validates amounts, categories, descriptions, and filter dates", () => {
    const invalidAmount = plainToInstance(CreateExpenseDto, {
      category: "Rent",
      description: "Monthly rent",
      amount: "-5.00",
      method: "CASH",
    });
    const invalidMethod = plainToInstance(CreateExpenseDto, {
      category: "Rent",
      description: "Monthly rent",
      amount: "5.00",
      method: "BTC",
    });
    const invalidCategory = plainToInstance(CreateExpenseDto, {
      category: "",
      description: "Monthly rent",
      amount: "5.00",
      method: "CASH",
    });
    for (const dto of [invalidAmount, invalidMethod, invalidCategory]) {
      assert.ok(validateSync(dto).length > 0);
    }
    const invalidRange = plainToInstance(ListExpensesDto, {
      from: "not-a-date",
    });
    assert.ok(validateSync(invalidRange).length > 0);
  });
});
