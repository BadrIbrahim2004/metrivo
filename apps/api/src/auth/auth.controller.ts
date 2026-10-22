import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { Public, RequireAuthenticated } from '../authz.decorator'
import type { LoginResult } from './auth.service'
import { AuthService } from './auth.service'
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
}
