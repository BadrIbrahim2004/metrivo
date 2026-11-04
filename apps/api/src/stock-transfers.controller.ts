import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { RequireTenantPermission } from './authz.decorator'
import { CreateStockTransferDto, ListTransfersDto } from './stock-transfers.dto'
import { INVENTORY_TRANSFER_PERMISSION, StockTransfersService } from './stock-transfers.service'

interface TransfersRequest {
  user?: { userId?: unknown }
}

@Controller('tenants/:tenantId/branches/:branchId/transfers')
export class StockTransfersController {
  constructor(private readonly transfers: StockTransfersService) { }

  @RequireTenantPermission(INVENTORY_TRANSFER_PERMISSION)
  @Get()
  listTransfers(
    @Req() request: TransfersRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Query() query: ListTransfersDto,
  ) {
    return this.transfers.listTransfers(
      this.requireActorId(request), tenantId, branchId, query,
    )
  }

  @RequireTenantPermission(INVENTORY_TRANSFER_PERMISSION)
  @Post()
  createTransfer(
    @Req() request: TransfersRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateStockTransferDto,
  ) {
    return this.transfers.createTransfer(
      this.requireActorId(request), tenantId, branchId, idempotencyKey ?? '', input,
    )
  }

  private requireActorId(request: TransfersRequest): string {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return userId
  }
}
