import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import {
  CreateCustomerDto,
  ListCustomersDto,
  UpdateCustomerDto,
} from "./customers.dto";

export const CUSTOMERS_READ_PERMISSION = "customers.read";
export const CUSTOMERS_MANAGE_PERMISSION = "customers.manage";

export interface CustomerRow {
  id: string;
  tenantId: string;
  name: string;
  phone: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerHistoryRow {
  id: string;
  invoiceNumber: string;
  total: string;
  paymentMethod: string;
  createdAt: Date;
  returned: boolean;
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async createCustomer(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: CreateCustomerDto,
  ): Promise<CustomerRow> {
    const name = input?.name?.trim();
    if (!name || name.length > 200) {
      throw new BadRequestException("Invalid customer name");
    }
    const phone = input.phone?.trim() || null;
    if (phone && phone.length > 40) {
      throw new BadRequestException("Invalid customer phone");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        CUSTOMERS_MANAGE_PERMISSION,
      );
      if (phone) {
        const duplicate = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Customer"
          WHERE "tenantId" = ${tenantId} AND phone = ${phone}
        `;
        if (duplicate[0]) {
          throw new ConflictException(
            "A customer with this phone number already exists",
          );
        }
      }
      const rows = await tx.$queryRaw<CustomerRow[]>`
        INSERT INTO "Customer"
          (id, "tenantId", name, phone, "isActive", "createdByUserId",
           "createdAt", "updatedAt")
        VALUES
          (${randomUUID()}, ${tenantId}, ${name}, ${phone}, TRUE,
           ${actorUserId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id, "tenantId", name, phone, "isActive", "createdAt", "updatedAt"
      `;
      return rows[0];
    });
  }

  async listCustomers(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    input: ListCustomersDto,
  ): Promise<CustomerRow[]> {
    const search = input?.search?.trim() || null;
    if (search && search.length > 200) {
      throw new BadRequestException("Invalid search term");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        CUSTOMERS_READ_PERMISSION,
      );
      return tx.$queryRaw<CustomerRow[]>`
        SELECT id, "tenantId", name, phone, "isActive", "createdAt", "updatedAt"
        FROM "Customer"
        WHERE "tenantId" = ${tenantId}
          AND (${input?.includeInactive === true} OR "isActive" = TRUE)
          AND (${search}::text IS NULL
               OR name ILIKE '%' || ${search}::text || '%'
               OR phone ILIKE '%' || ${search}::text || '%')
        ORDER BY name, id
        LIMIT 200
      `;
    });
  }

  async getCustomerHistory(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    customerId: string,
  ): Promise<{ customer: CustomerRow; sales: CustomerHistoryRow[] }> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        CUSTOMERS_READ_PERMISSION,
      );
      const customers = await tx.$queryRaw<CustomerRow[]>`
        SELECT id, "tenantId", name, phone, "isActive", "createdAt", "updatedAt"
        FROM "Customer"
        WHERE id = ${customerId} AND "tenantId" = ${tenantId}
      `;
      if (!customers[0]) throw new NotFoundException("Customer not found");
      const sales = await tx.$queryRaw<CustomerHistoryRow[]>`
        SELECT s.id, s."invoiceNumber", s.total::text AS total,
               s."paymentMethod"::text AS "paymentMethod", s."createdAt",
               EXISTS (SELECT 1 FROM "SaleReturn" sr
                       WHERE sr."saleId" = s.id AND sr."tenantId" = s."tenantId") AS "returned"
        FROM "Sale" s
        WHERE s."tenantId" = ${tenantId} AND s."customerId" = ${customerId}
        ORDER BY s."createdAt" DESC, s.id DESC
        LIMIT 50
      `;
      return { customer: customers[0], sales };
    });
  }

  async updateCustomer(
    actorUserId: string,
    tenantId: string,
    branchId: string,
    customerId: string,
    input: UpdateCustomerDto,
  ): Promise<CustomerRow> {
    if (!input || Object.keys(input).length === 0) {
      throw new BadRequestException("At least one customer field is required");
    }
    if (input.name !== undefined && !input.name.trim()) {
      throw new BadRequestException("Customer name cannot be empty");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertBranchPermission(
        tx,
        actorUserId,
        tenantId,
        branchId,
        CUSTOMERS_MANAGE_PERMISSION,
      );
      const current = await tx.$queryRaw<CustomerRow[]>`
        SELECT id, "tenantId", name, phone, "isActive", "createdAt", "updatedAt"
        FROM "Customer"
        WHERE id = ${customerId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      if (!current[0]) throw new NotFoundException("Customer not found");
      const customer = current[0];
      const nextPhone =
        input.phone === undefined
          ? customer.phone
          : input.phone?.trim() || null;
      if (nextPhone && nextPhone !== customer.phone) {
        const duplicate = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Customer"
          WHERE "tenantId" = ${tenantId} AND phone = ${nextPhone} AND id <> ${customerId}
        `;
        if (duplicate[0]) {
          throw new ConflictException(
            "A customer with this phone number already exists",
          );
        }
      }
      const rows = await tx.$queryRaw<CustomerRow[]>`
        UPDATE "Customer"
        SET name = ${input.name === undefined ? customer.name : input.name.trim()},
            phone = ${nextPhone},
            "isActive" = ${input.isActive === undefined ? customer.isActive : input.isActive},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${customerId} AND "tenantId" = ${tenantId}
        RETURNING id, "tenantId", name, phone, "isActive", "createdAt", "updatedAt"
      `;
      return rows[0];
    });
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
