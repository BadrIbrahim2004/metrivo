import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { CustomersService } from "../src/customers.service";
import { createPrismaMock } from "./test-helpers";

function permissionAllowed(call: { text: string }) {
  return call.text.includes('FROM "TenantMembership" tm')
    ? [{ allowed: true }]
    : undefined;
}

describe("CustomersService", () => {
  it("rejects invalid customer input before opening a transaction", async () => {
    const mock = createPrismaMock();
    const service = new CustomersService(mock.prisma);
    await assert.rejects(
      service.createCustomer("user-1", "tenant-1", "branch-1", { name: "   " }),
      BadRequestException,
    );
    await assert.rejects(
      service.createCustomer("user-1", "tenant-1", "branch-1", {
        name: "x".repeat(201),
      }),
      BadRequestException,
    );
    assert.equal(mock.transactionCount, 0);
  });

  it("fails closed when the caller lacks branch-scoped customer permission", async () => {
    const mock = createPrismaMock({ queryResults: [[{ allowed: false }]] });
    const service = new CustomersService(mock.prisma);
    await assert.rejects(
      service.listCustomers("user-1", "tenant-1", "branch-1", {}),
      ForbiddenException,
    );
    await assert.rejects(
      service.createCustomer("user-1", "tenant-1", "branch-1", { name: "Ali" }),
      ForbiddenException,
    );
    assert.equal(mock.executeCalls.length, 0);
  });

  it("rejects duplicate phone numbers within the tenant", async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = permissionAllowed(call);
        if (allowed) return allowed;
        if (
          call.text.includes('FROM "Customer"') &&
          call.text.includes("phone =")
        ) {
          return [{ id: "existing-customer" }];
        }
        return [];
      },
    });
    const service = new CustomersService(mock.prisma);
    await assert.rejects(
      service.createCustomer("user-1", "tenant-1", "branch-1", {
        name: "Ali",
        phone: "01000000000",
      }),
      ConflictException,
    );
  });

  it("creates a customer without a phone using parameterized SQL", async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = permissionAllowed(call);
        if (allowed) return allowed;
        if (call.text.includes('INSERT INTO "Customer"')) {
          return [
            {
              id: "customer-1",
              tenantId: "tenant-1",
              name: "Ali",
              phone: null,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ];
        }
        return [];
      },
    });
    const service = new CustomersService(mock.prisma);
    const result = await service.createCustomer(
      "user-1",
      "tenant-1",
      "branch-1",
      { name: "Ali" },
    );
    assert.equal(result.name, "Ali");
    const insert = mock.queryCalls.find((call) =>
      call.text.includes('INSERT INTO "Customer"'),
    );
    assert.ok(insert);
    assert.ok(insert.values.includes("Ali"));
  });

  it("returns 404 for a customer from another tenant", async () => {
    const mock = createPrismaMock({
      queryResponder(call) {
        const allowed = permissionAllowed(call);
        if (allowed) return allowed;
        if (
          call.text.includes('FROM "Customer"') &&
          call.text.includes("FOR UPDATE")
        )
          return [];
        return [];
      },
    });
    const service = new CustomersService(mock.prisma);
    await assert.rejects(
      service.updateCustomer(
        "user-1",
        "tenant-1",
        "branch-1",
        "foreign-customer",
        { name: "X" },
      ),
      Error,
    );
  });

  it("rejects an empty update payload", async () => {
    const mock = createPrismaMock();
    const service = new CustomersService(mock.prisma);
    await assert.rejects(
      service.updateCustomer(
        "user-1",
        "tenant-1",
        "branch-1",
        "customer-1",
        {},
      ),
      BadRequestException,
    );
    assert.equal(mock.transactionCount, 0);
  });
});
