import {
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { RequireTenantPermission } from './authz.decorator'
import {
  CreatePurchaseDto,
  CreateSupplierDto,
  CreateSupplierPaymentDto,
  UpdateSupplierDto,
} from './procurement.dto'
import {
  ProcurementService,
  PURCHASES_CANCEL_PERMISSION,
  PURCHASES_CREATE_PERMISSION,
  PURCHASES_PAY_PERMISSION,
  PURCHASES_READ_PERMISSION,
  PURCHASES_RECEIVE_PERMISSION,
  SUPPLIERS_MANAGE_PERMISSION,
  SUPPLIERS_READ_PERMISSION,
} from './procurement.service'

interface ProcurementRequest {
  user?: { userId?: unknown }
}

@Controller('tenants/:tenantId/branches/:branchId')
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  @RequireTenantPermission(SUPPLIERS_READ_PERMISSION)
  @Get('suppliers')
  listSuppliers(
    @Req() request: ProcurementRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.procurement.listSuppliers(
      this.requireActorId(request), tenantId, branchId,
    )
  }

  @RequireTenantPermission(SUPPLIERS_MANAGE_PERMISSION)
  @Post('suppliers')
  createSupplier(
    @Req() request: ProcurementRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Body() input: CreateSupplierDto,
  ) {
    return this.procurement.createSupplier(
      this.requireActorId(request), tenantId, branchId, input,
    )
  }

  @RequireTenantPermission(SUPPLIERS_MANAGE_PERMISSION)
  @Patch('suppliers/:supplierId')
  updateSupplier(
    @Req() request: ProcurementRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('supplierId') supplierId: string,
    @Body() input: UpdateSupplierDto,
  ) {
    return this.procurement.updateSupplier(
      this.requireActorId(request), tenantId, branchId, supplierId, input,
    )
  }

  @RequireTenantPermission(PURCHASES_READ_PERMISSION)
  @Get('purchases')
  listPurchases(
    @Req() request: ProcurementRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.procurement.listPurchases(
      this.requireActorId(request), tenantId, branchId,
    )
  }

  @RequireTenantPermission(PURCHASES_CREATE_PERMISSION)
  @Post('purchases')
  createPurchase(
    @Req() request: ProcurementRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreatePurchaseDto,
  ) {
    return this.procurement.createPurchase(
      this.requireActorId(request),
      tenantId,
      branchId,
      idempotencyKey ?? '',
      input,
    )
  }

  @RequireTenantPermission(PURCHASES_READ_PERMISSION)
  @Get('purchases/:purchaseId')
  getPurchase(
    @Req() request: ProcurementRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('purchaseId') purchaseId: string,
  ) {
    return this.procurement.getPurchase(
      this.requireActorId(request), tenantId, branchId, purchaseId,
    )
  }

  @RequireTenantPermission(PURCHASES_RECEIVE_PERMISSION)
  @Post('purchases/:purchaseId/receive')
  receivePurchase(
    @Req() request: ProcurementRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('purchaseId') purchaseId: string,
  ) {
    return this.procurement.receivePurchase(
      this.requireActorId(request), tenantId, branchId, purchaseId,
    )
  }

  @RequireTenantPermission(PURCHASES_CANCEL_PERMISSION)
  @Post('purchases/:purchaseId/cancel')
  cancelDraftPurchase(
    @Req() request: ProcurementRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('purchaseId') purchaseId: string,
  ) {
    return this.procurement.cancelDraftPurchase(
      this.requireActorId(request), tenantId, branchId, purchaseId,
    )
  }

  @RequireTenantPermission(PURCHASES_PAY_PERMISSION)
  @Post('purchases/:purchaseId/payments')
  recordSupplierPayment(
    @Req() request: ProcurementRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('purchaseId') purchaseId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateSupplierPaymentDto,
  ) {
    return this.procurement.recordSupplierPayment(
      this.requireActorId(request),
      tenantId,
      branchId,
      purchaseId,
      idempotencyKey ?? '',
      input,
    )
  }

  private requireActorId(request: ProcurementRequest): string {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return userId
  }
}
