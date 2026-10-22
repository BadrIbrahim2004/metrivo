import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { RequireTenantPermission } from './authz.decorator'
import {
  CreateInventoryMovementDto,
  CreateProductDto,
  UpdateProductDto,
} from './product.dto'
import {
  INVENTORY_ADJUST_PERMISSION,
  INVENTORY_READ_PERMISSION,
  PRODUCT_MANAGE_PERMISSION,
  PRODUCT_READ_PERMISSION,
} from './product-permissions'
import { ProductService } from './product.service'

interface ProductRequest {
  user?: { userId?: unknown }
}

@Controller('tenants/:tenantId/branches/:branchId')
export class ProductController {
  constructor(private readonly products: ProductService) {}

  @RequireTenantPermission(PRODUCT_READ_PERMISSION)
  @Get('products')
  list(
    @Req() request: ProductRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.products.listProducts(
      this.requireActorId(request),
      tenantId,
      branchId,
    )
  }

  @RequireTenantPermission(PRODUCT_MANAGE_PERMISSION)
  @Post('products')
  create(
    @Req() request: ProductRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Body() input: CreateProductDto,
  ) {
    return this.products.createProduct(
      this.requireActorId(request),
      tenantId,
      branchId,
      input,
    )
  }

  @RequireTenantPermission(PRODUCT_MANAGE_PERMISSION)
  @Patch('products/:productId')
  update(
    @Req() request: ProductRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('productId') productId: string,
    @Body() input: UpdateProductDto,
  ) {
    return this.products.updateProduct(
      this.requireActorId(request),
      tenantId,
      branchId,
      productId,
      input,
    )
  }

  @RequireTenantPermission(INVENTORY_READ_PERMISSION)
  @Get('products/:productId/stock')
  stock(
    @Req() request: ProductRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('productId') productId: string,
  ) {
    return this.products.getStock(
      this.requireActorId(request),
      tenantId,
      branchId,
      productId,
    )
  }

  @RequireTenantPermission(INVENTORY_READ_PERMISSION)
  @Get('products/:productId/movements')
  movements(
    @Req() request: ProductRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('productId') productId: string,
  ) {
    return this.products.listMovements(
      this.requireActorId(request),
      tenantId,
      branchId,
      productId,
    )
  }

  @RequireTenantPermission(INVENTORY_ADJUST_PERMISSION)
  @Post('products/:productId/movements')
  adjustInventory(
    @Req() request: ProductRequest,
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Param('productId') productId: string,
    @Body() input: CreateInventoryMovementDto,
  ) {
    return this.products.createMovement(
      this.requireActorId(request),
      tenantId,
      branchId,
      productId,
      input,
    )
  }

  private requireActorId(request: ProductRequest): string {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return userId
  }
}
