import { Body, Controller, Post, Req, UnauthorizedException } from '@nestjs/common'
import { RequirePlatformOwner } from './authz.decorator'
import { CreateTenantOnboardingDto } from './tenant-onboarding.dto'
import {
  CreatedTenantOnboarding,
  TenantOnboardingService,
} from './tenant-onboarding.service'

interface OnboardingRequest {
  user?: { userId?: unknown }
}

@Controller('platform/tenants')
export class TenantOnboardingController {
  constructor(private readonly onboarding: TenantOnboardingService) { }

  @RequirePlatformOwner()
  @Post()
  createTenant(
    @Req() request: OnboardingRequest,
    @Body() input: CreateTenantOnboardingDto,
  ): Promise<CreatedTenantOnboarding> {
    return this.onboarding.createTenant(this.requireActorId(request), input)
  }

  private requireActorId(request: OnboardingRequest): string {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return userId
  }
}
