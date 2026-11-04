import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { RequireTenantPermission } from "./authz.decorator";
import { CreateExpenseDto, ListExpensesDto } from "./expense.dto";
import {
  EXPENSES_MANAGE_PERMISSION,
  EXPENSES_READ_PERMISSION,
  ExpenseService,
} from "./expense.service";

interface ExpenseRequest {
  user?: { userId?: unknown };
}

@Controller("tenants/:tenantId/branches/:branchId/expenses")
export class ExpenseController {
  constructor(private readonly expenses: ExpenseService) {}

  @RequireTenantPermission(EXPENSES_READ_PERMISSION)
  @Get()
  listExpenses(
    @Req() request: ExpenseRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Query() query: ListExpensesDto,
  ) {
    return this.expenses.listExpenses(
      this.requireActorId(request),
      tenantId,
      branchId,
      query,
    );
  }

  @RequireTenantPermission(EXPENSES_MANAGE_PERMISSION)
  @Post()
  createExpense(
    @Req() request: ExpenseRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() input: CreateExpenseDto,
  ) {
    return this.expenses.createExpense(
      this.requireActorId(request),
      tenantId,
      branchId,
      idempotencyKey ?? "",
      input,
    );
  }

  @RequireTenantPermission(EXPENSES_MANAGE_PERMISSION)
  @Delete(":expenseId")
  voidExpense(
    @Req() request: ExpenseRequest,
    @Param("tenantId") tenantId: string,
    @Param("branchId") branchId: string,
    @Param("expenseId") expenseId: string,
  ) {
    return this.expenses.voidExpense(
      this.requireActorId(request),
      tenantId,
      branchId,
      expenseId,
    );
  }

  private requireActorId(request: ExpenseRequest): string {
    const userId = request.user?.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      throw new UnauthorizedException("Authenticated user is required");
    }
    return userId;
  }
}
