import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { RequireTenantPermission } from './authz.decorator'
import {
  CASH_MANAGE_PERMISSION,
  CASH_READ_PERMISSION,
  CashManagementService,
  REFUNDS_SETTLE_PERMISSION,
} from './cash-management.service'
import {
  CloseCashShiftDto,
  CreateCashMovementDto,
  OpenCashShiftDto,
  SettleRefundDto,
} from './cash-management.dto'

interface CashRequest {
  user?: { userId?: unknown }
}

@Controller('tenants/:tenantId/branches/:branchId/cash')
export class CashManagementController {
  constructor(private readonly cash: CashManagementService) {}

  @RequireTenantPermission(CASH_READ_PERMISSION)
  @Get('shift')
  getCurrentShift(
    @Req() request: CashRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.cash.getCurrentShift(this.requireActorId(request), tenantId, branchId)
  }

  @RequireTenantPermission(CASH_READ_PERMISSION)
  @Get('shifts')
  listShiftHistory(
    @Req() request: CashRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.cash.listShiftHistory(this.requireActorId(request), tenantId, branchId)
  }

  @RequireTenantPermission(CASH_MANAGE_PERMISSION)
  @Post('shifts')
  openShift(
    @Req() request: CashRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Body() input: OpenCashShiftDto,
  ) {
    return this.cash.openShift(this.requireActorId(request), tenantId, branchId, input)
  }

  @RequireTenantPermission(CASH_MANAGE_PERMISSION)
  @Post('shifts/:cashShiftId/movements')
  recordMovement(
    @Req() request: CashRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('cashShiftId') cashShiftId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateCashMovementDto,
  ) {
    return this.cash.recordMovement(
      this.requireActorId(request), tenantId, branchId, cashShiftId,
      idempotencyKey ?? '', input,
    )
  }

  @RequireTenantPermission(CASH_MANAGE_PERMISSION)
  @Post('shifts/:cashShiftId/close')
  closeShift(
    @Req() request: CashRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('cashShiftId') cashShiftId: string,
    @Body() input: CloseCashShiftDto,
  ) {
    return this.cash.closeShift(
      this.requireActorId(request), tenantId, branchId, cashShiftId, input,
    )
  }

  @RequireTenantPermission(CASH_READ_PERMISSION)
  @Get('shifts/:cashShiftId/movements')
  listMovements(
    @Req() request: CashRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('cashShiftId') cashShiftId: string,
  ) {
    return this.cash.listMovements(
      this.requireActorId(request), tenantId, branchId, cashShiftId,
    )
  }

  @RequireTenantPermission(CASH_READ_PERMISSION)
  @Get('refunds')
  listPendingRefunds(
    @Req() request: CashRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.cash.listPendingRefunds(
      this.requireActorId(request), tenantId, branchId,
    )
  }

  @RequireTenantPermission(REFUNDS_SETTLE_PERMISSION)
  @Post('shifts/:cashShiftId/refunds/:saleReturnId/settle')
  settleRefund(
    @Req() request: CashRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('cashShiftId') cashShiftId: string,
    @Param('saleReturnId') saleReturnId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SettleRefundDto,
  ) {
    return this.cash.settleRefund(
      this.requireActorId(request), tenantId, branchId, saleReturnId,
      cashShiftId, idempotencyKey ?? '', input,
    )
  }

  private requireActorId(request: CashRequest): string {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return userId
  }
}
