import {
  Body,
  Controller,
  Param,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { RequireTenantPermission } from './authz.decorator'
import { UpdateBranchAccessDto } from './branch-access.dto'
import { BranchAccessService } from './branch-access.service'
import { TENANT_MEMBERS_MANAGE_PERMISSION } from './product-permissions'

interface BranchAccessRequest {
  user?: { userId?: unknown }
}

@Controller('tenants/:tenantId/memberships')
export class BranchAccessController {
  constructor(private readonly branchAccess: BranchAccessService) {}

  @RequireTenantPermission(TENANT_MEMBERS_MANAGE_PERMISSION)
  @Put(':membershipId/branch-access')
  update(
    @Req() request: BranchAccessRequest,
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
    @Body() input: UpdateBranchAccessDto,
  ) {
    const actorUserId = request.user?.userId
    if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return this.branchAccess.updateMembershipAccess(
      actorUserId,
      tenantId,
      membershipId,
      input,
    )
  }
}
