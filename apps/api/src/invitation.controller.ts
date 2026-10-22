import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { Public, RequirePlatformOwner } from './authz.decorator'
import {
  AcceptInvitationDto,
  CreateTenantInvitationDto,
} from './invitation.dto'
import {
  CreatedTenantInvitation,
  InvitationService,
} from './invitation.service'

interface InvitationRequest {
  user?: { userId?: unknown }
  socket?: { remoteAddress?: string }
}

@Controller('invitations')
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  @RequirePlatformOwner()
  @Post()
  create(
    @Req() request: InvitationRequest,
    @Body() input: CreateTenantInvitationDto,
  ): Promise<CreatedTenantInvitation> {
    return this.invitations.createTenantInvitation(
      this.requireActorId(request),
      input,
    )
  }

  @RequirePlatformOwner()
  @Delete(':invitationId')
  async revoke(
    @Req() request: InvitationRequest,
    @Param('invitationId') invitationId: string,
  ): Promise<{ revoked: true }> {
    const actorUserId = this.requireActorId(request)
    await this.invitations.revokeTenantInvitation(actorUserId, invitationId)
    return { revoked: true }
  }

  @Public()
  @Post('accept')
  @HttpCode(200)
  async accept(
    @Req() request: InvitationRequest,
    @Body() input: AcceptInvitationDto,
  ): Promise<{ accepted: true }> {
    await this.invitations.consumeAcceptanceRateLimit(
      request.socket?.remoteAddress ?? 'unknown',
    )
    return this.invitations.acceptInvitation(input.token, input.password)
  }

  private requireActorId(request: InvitationRequest): string {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return userId
  }

}
