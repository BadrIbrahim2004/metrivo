import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { CreateExpenseDto, ListExpensesDto } from "./expense.dto";

export const EXPENSES_READ_PERMISSION = "expenses.read";
export const EXPENSES_MANAGE_PERMISSION = "expenses.manage";

const PAYMENT_METHODS = ["CASH", "CARD", "BANK_TRANSFER", "OTHER"] as const;

export interface ExpenseRow {
  id: string;
  tenantId: string;
  branchId: string;
  cashShiftId: string | null;
  actorUserId: string;
  category: string;
  description: string;
  amount: string;
  method: string;
  expenseDate: Date;
  status: "ACTIVE" | "VOIDED";
  voidedByUserId: string | null;
  voidedAt: Date | null;
  createdAt: Date;
  requestHash?: string;
}

@Injectable()
export class ExpenseService {
  constructor(private readonly prisma: PrismaService) {}

  async createExpense(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    idempotencyKey: string,
    input: CreateExpenseDto,
  ): Promise<ExpenseRow> {
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new BadRequestException("Invalid idempotency key");
    }
    if (
      !PAYMENT_METHODS.includes(input?.method) ||
      !input?.category?.trim() ||
      input.category.trim().length > 100 ||
      !input?.description?.trim() ||
      input.description.trim().length > 500
    ) {
      throw new BadRequestException("Invalid expense");
    }
    const amountCents = this.parseMoney(input?.amount);
    if (amountCents <= 0n) {
      throw new BadRequestException("Expense amount must be positive");
    }
    if (
      input.expenseDate !== undefined &&
      !/^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate)
    ) {
      throw new BadRequestException("Invalid expense date");
    }
    if (
      input.expenseDate !== undefined &&
      input.expenseDate > new Date().toISOString().slice(0, 10)
    ) {
      throw new BadRequestException("Expense date cannot be in the future");
    }
    const expenseDate =
      input.expenseDate ?? new Date().toISOString().slice(0, 10);
    const requestHash = this.hash(
      JSON.stringify({
        category: input.category.trim(),
        description: input.description.trim(),
        amountCents: amountCents.toString(),
        method: input.method,
        expenseDate,
      }),
    );

    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        EXPENSES_MANAGE_PERMISSION,
      );
      const prior = await tx.$queryRaw<ExpenseRow[]>`
        SELECT id, "tenantId", "branchId", "cashShiftId", "actorUserId",
               category, description, amount::text AS amount,
               method::text AS method, "expenseDate", status::text AS status,
               "voidedByUserId", "voidedAt", "createdAt"
        FROM "Expense"
        WHERE "tenantId" = ${tenantId}
          AND "actorUserId" = ${actorUserId}
          AND "idempotencyKey" = ${idempotencyKey}
      `;
      if (prior[0]) {
        if (prior[0].requestHash?.trim() !== requestHash) {
          throw new ConflictException(
            "Idempotency key was used for a different expense",
          );
        }
        return prior[0];
      }

      let cashShiftId: string | null = null;
      if (input.method === "CASH") {
        const shifts = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM "CashShift"
          WHERE "tenantId" = ${tenantId}
            AND "branchId" = ${branchId}
            AND status = 'OPEN'
          FOR UPDATE
        `;
        if (!shifts[0]) {
          throw new ConflictException(
            "Cash expenses require an open cash shift",
          );
        }
        cashShiftId = shifts[0].id;
      }

      const rows = await tx.$queryRaw<ExpenseRow[]>`
        INSERT INTO "Expense"
          (id, "tenantId", "branchId", "cashShiftId", "actorUserId",
           "idempotencyKey", "requestHash", category, description, amount,
           method, "expenseDate", status, "createdAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${cashShiftId}, ${actorUserId},
           ${idempotencyKey}, ${requestHash}, ${input.category.trim()},
           ${input.description.trim()}, ${this.formatMoney(amountCents)}::numeric,
           ${input.method}::"ExpensePaymentMethod", ${expenseDate}::date,
           'ACTIVE', CURRENT_TIMESTAMP)
        RETURNING id, "tenantId", "branchId", "cashShiftId", "actorUserId",
                  category, description, amount::text AS amount,
                  method::text AS method, "expenseDate", status::text AS status,
                  "voidedByUserId", "voidedAt", "createdAt"
      `;
      await tx.$executeRaw`
        INSERT INTO "ExpenseAuditLog"
          (id, "tenantId", "branchId", "expenseId", "actorUserId",
           action, metadata, "occurredAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${rows[0].id},
           ${actorUserId}, 'EXPENSE_RECORDED', ${JSON.stringify({
             category: input.category.trim(),
             amount: this.formatMoney(amountCents),
             method: input.method,
             cashShiftId,
           })}::jsonb, CURRENT_TIMESTAMP)
      `;
      return rows[0];
    });
  }

  async listExpenses(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: ListExpensesDto,
  ): Promise<ExpenseRow[]> {
    if (input?.from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.from)) {
      throw new BadRequestException("Invalid from date");
    }
    if (input?.to !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) {
      throw new BadRequestException("Invalid to date");
    }
    if (input?.from && input?.to && input.from > input.to) {
      throw new BadRequestException("Date range is invalid");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        EXPENSES_READ_PERMISSION,
      );
      return tx.$queryRaw<ExpenseRow[]>`
        SELECT id, "tenantId", "branchId", "cashShiftId", "actorUserId",
               category, description, amount::text AS amount,
               method::text AS method, "expenseDate", status::text AS status,
               "voidedByUserId", "voidedAt", "createdAt"
        FROM "Expense"
        WHERE "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND (${input?.from ?? null}::date IS NULL OR "expenseDate" >= ${input?.from ?? null}::date)
          AND (${input?.to ?? null}::date IS NULL OR "expenseDate" <= ${input?.to ?? null}::date)
          AND (${input?.category?.trim() || null}::text IS NULL
               OR category = ${input?.category?.trim() || null}::text)
        ORDER BY "expenseDate" DESC, "createdAt" DESC, id DESC
        LIMIT 200
      `;
    });
  }

  async voidExpense(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    expenseId: string,
  ): Promise<ExpenseRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        EXPENSES_MANAGE_PERMISSION,
      );
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status::text AS status
        FROM "Expense"
        WHERE id = ${expenseId}
          AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
        FOR UPDATE
      `;
      if (!rows[0]) throw new NotFoundException("Expense not found");
      if (rows[0].status !== "ACTIVE") {
        throw new ConflictException("Expense is already voided");
      }
      const updated = await tx.$queryRaw<ExpenseRow[]>`
        UPDATE "Expense"
        SET status = 'VOIDED',
            "voidedByUserId" = ${actorUserId},
            "voidedAt" = CURRENT_TIMESTAMP
        WHERE id = ${expenseId}
          AND "tenantId" = ${tenantId}
          AND "branchId" = ${branchId}
          AND status = 'ACTIVE'
        RETURNING id, "tenantId", "branchId", "cashShiftId", "actorUserId",
                  category, description, amount::text AS amount,
                  method::text AS method, "expenseDate", status::text AS status,
                  "voidedByUserId", "voidedAt", "createdAt"
      `;
      await tx.$executeRaw`
        INSERT INTO "ExpenseAuditLog"
          (id, "tenantId", "branchId", "expenseId", "actorUserId",
           action, metadata, "occurredAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${branchId}, ${expenseId},
           ${actorUserId}, 'EXPENSE_VOIDED', ${JSON.stringify({
             expenseId,
           })}::jsonb, CURRENT_TIMESTAMP)
      `;
      return updated[0];
    });
  }

  private parseMoney(value: string): bigint {
    if (
      typeof value !== "string" ||
      !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)
    ) {
      throw new BadRequestException("Invalid monetary amount");
    }
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  }

  private formatMoney(cents: bigint): string {
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
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

export { UnauthorizedException };
