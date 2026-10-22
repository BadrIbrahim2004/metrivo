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
import { SALES_CREATE_PERMISSION, SALES_READ_PERMISSION } from './product-permissions'
import { CreateSaleDto } from './sales.dto'
import { SalesService } from './sales.service'

interface SalesRequest {
  user?: { userId?: unknown }
}

@Controller('tenants/:tenantId/branches/:branchId/sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @RequireTenantPermission(SALES_CREATE_PERMISSION)
  @Get('catalog')
  catalog(
    @Req() request: SalesRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.sales.getCatalog(this.requireActorId(request), tenantId, branchId)
  }

  @RequireTenantPermission(SALES_CREATE_PERMISSION)
  @Post()
  create(
    @Req() request: SalesRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateSaleDto,
  ) {
    return this.sales.createSale(
      this.requireActorId(request),
      tenantId,
      branchId,
      idempotencyKey ?? '',
      input,
    )
  }

  @RequireTenantPermission(SALES_READ_PERMISSION)
  @Get()
  list(
    @Req() request: SalesRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.sales.listSales(
      this.requireActorId(request),
      tenantId,
      branchId,
    )
  }

  @RequireTenantPermission(SALES_READ_PERMISSION)
  @Get(':saleId')
  get(
    @Req() request: SalesRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('saleId') saleId: string,
  ) {
    return this.sales.getSale(
      this.requireActorId(request),
      tenantId,
      branchId,
      saleId,
    )
  }

  private requireActorId(request: SalesRequest): string {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return userId
  }
}
