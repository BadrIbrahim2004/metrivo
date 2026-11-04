import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { RequireTenantPermission } from "./authz.decorator";
import {
  CreateCustomerDto,
  ListCustomersDto,
  UpdateCustomerDto,
} from "./customers.dto";
import {
  CUSTOMERS_MANAGE_PERMISSION,
  CUSTOMERS_READ_PERMISSION,
  CustomersService,
} from "./customers.service";

interface CustomersRequest {
  user?: { userId?: unknown };
}

@Controller("tenants/:tenantId/branches/:branchId/customers")
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequireTenantPermission(CUSTOMERS_READ_PERMISSION)
  @Get()
  listCustomers(
    @Req() request: CustomersRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Query() query: ListCustomersDto,
  ) {
    return this.customers.listCustomers(
      this.requireActorId(request),
      tenantId,
      branchId,
      query,
    );
  }

  @RequireTenantPermission(CUSTOMERS_MANAGE_PERMISSION)
  @Post()
  createCustomer(
    @Req() request: CustomersRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Body() input: CreateCustomerDto,
  ) {
    return this.customers.createCustomer(
      this.requireActorId(request),
      tenantId,
      branchId,
      input,
    );
  }

  @RequireTenantPermission(CUSTOMERS_READ_PERMISSION)
  @Get(":customerId/history")
  getCustomerHistory(
    @Req() request: CustomersRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Param("customerId") customerId: string,
  ) {
    return this.customers.getCustomerHistory(
      this.requireActorId(request),
      tenantId,
      branchId,
      customerId,
    );
  }

  @RequireTenantPermission(CUSTOMERS_MANAGE_PERMISSION)
  @Patch(":customerId")
  updateCustomer(
    @Req() request: CustomersRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Param("customerId") customerId: string,
    @Body() input: UpdateCustomerDto,
  ) {
    return this.customers.updateCustomer(
      this.requireActorId(request),
      tenantId,
      branchId,
      customerId,
      input,
    );
  }

  private requireActorId(request: CustomersRequest): string {
    const userId = request.user?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      throw new UnauthorizedException("Authenticated user is required");
    }
    return userId;
  }
}
