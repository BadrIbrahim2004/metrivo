import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { RequireAuthenticated, RequireTenantOwner } from './authz.decorator'
import { ReceiptSettingsDto } from './receipt-settings.dto'
import { ReceiptSettingsService } from './receipt-settings.service'

interface ReceiptSettingsRequest {
  user?: { userId?: unknown }
}

@Controller('tenants/:tenantId/receipt-settings')
export class ReceiptSettingsController {
  constructor(private readonly settings: ReceiptSettingsService) {}

  @RequireAuthenticated()
  @Get()
  get(@Param('tenantId') tenantId: string, @Req() request: ReceiptSettingsRequest) {
    return this.settings.getForUser(
      this.requireActorId(request),
      tenantId,
    )
  }

  @RequireTenantOwner()
  @Put()
  update(
    @Param('tenantId') tenantId: string,
    @Body() input: ReceiptSettingsDto,
  ) {
    return this.settings.update(tenantId, input)
  }

  private requireActorId(request: ReceiptSettingsRequest): string {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return userId
  }
}
