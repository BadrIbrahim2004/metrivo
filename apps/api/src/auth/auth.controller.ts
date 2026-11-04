import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { Public, RequireAuthenticated } from '../authz.decorator'
import type { LoginResult } from './auth.service'
import { AuthService } from './auth.service'
import { ChangeOwnPasswordDto } from './change-own-password.dto'
import { LoginDto } from './login.dto'

interface AuthenticatedRequest {
  user?: { userId?: unknown }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login(@Body() credentials: LoginDto): Promise<LoginResult> {
    return this.auth.login(credentials)
  }

  @RequireAuthenticated()
  @Get('workspaces')
  workspaces(@Req() request: AuthenticatedRequest) {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return this.auth.getWorkspaceBranches(userId)
  }

  @RequireAuthenticated()
  @Get('permissions')
  permissions(
    @Req() request: AuthenticatedRequest,
    @Query('tenantId') tenantId: string,
  ) {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    if (!tenantId) throw new BadRequestException('A tenant is required')
    return this.auth.getUserPermissions(userId, tenantId)
  }

  @RequireAuthenticated()
  @Get('tenant-roles')
  tenantRoles(
    @Req() request: AuthenticatedRequest,
    @Query('tenantId') tenantId: string,
  ) {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    if (!tenantId) throw new BadRequestException('A tenant is required')
    return this.auth.getTenantRoles(userId, tenantId)
  }

  @RequireAuthenticated()
  @Post('change-password')
  changeOwnPassword(
    @Req() request: AuthenticatedRequest,
    @Body() input: ChangeOwnPasswordDto,
  ) {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return this.auth.changeOwnPassword(userId, input)
  }
}
