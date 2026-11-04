import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common'
import { RequirePlatformPermission } from './authz.decorator'
import { IsBoolean, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator'
import {
  SUBSCRIPTIONS_MANAGE_PERMISSION,
  SUBSCRIPTIONS_READ_PERMISSION,
  SubscriptionAction,
  SubscriptionsService,
} from './subscriptions.service'

const MONEY_PATTERN = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/
const PERIODS = ['MONTHLY', 'ANNUAL'] as const
const ACTIONS = ['ACTIVATE', 'START_TRIAL', 'SUSPEND', 'RESUME', 'CANCEL', 'EXPIRE'] as const

export class CreatePlanDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string

  @IsString()
  @IsIn(PERIODS)
  period!: (typeof PERIODS)[number]

  @IsString()
  @Matches(MONEY_PATTERN)
  price!: string

  @IsInt()
  @Min(0)
  @Max(365)
  trialDays!: number
}

export class AssignSubscriptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  planId!: string

  @IsBoolean()
  startTrial!: boolean
}

export class SubscriptionActionDto {
  @IsString()
  @IsIn(ACTIONS)
  action!: (typeof ACTIONS)[number]
}

interface SubscriptionsRequest {
  user?: { userId?: unknown }
}

@Controller('platform/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) { }

  @RequirePlatformPermission(SUBSCRIPTIONS_READ_PERMISSION)
  @Get('plans')
  listPlans(@Req() request: SubscriptionsRequest) {
    return this.subscriptions.listPlans(this.requireActorId(request))
  }

  @RequirePlatformPermission(SUBSCRIPTIONS_MANAGE_PERMISSION)
  @Post('plans')
  createPlan(
    @Req() request: SubscriptionsRequest,
    @Body() input: CreatePlanDto,
  ) {
    return this.subscriptions.createPlan(this.requireActorId(request), {
      name: input.name,
      period: input.period,
      price: input.price,
      trialDays: input.trialDays,
    })
  }

  @RequirePlatformPermission(SUBSCRIPTIONS_READ_PERMISSION)
  @Get('tenants')
  listTenantSubscriptions(@Req() request: SubscriptionsRequest) {
    return this.subscriptions.listTenantSubscriptions(this.requireActorId(request))
  }

  @RequirePlatformPermission(SUBSCRIPTIONS_MANAGE_PERMISSION)
  @Post('tenants/:tenantId/assign')
  assignSubscription(
    @Req() request: SubscriptionsRequest,
    @Param('tenantId') tenantId: string,
    @Body() input: AssignSubscriptionDto,
  ) {
    return this.subscriptions.startOrChangeSubscription(
      this.requireActorId(request), tenantId,
      { planId: input.planId, startTrial: input.startTrial },
    )
  }

  @RequirePlatformPermission(SUBSCRIPTIONS_MANAGE_PERMISSION)
  @Post('tenants/:tenantId/action')
  changeState(
    @Req() request: SubscriptionsRequest,
    @Param('tenantId') tenantId: string,
    @Body() input: SubscriptionActionDto,
  ) {
    return this.subscriptions.changeSubscriptionState(
      this.requireActorId(request), tenantId, input.action as SubscriptionAction,
    )
  }

  private requireActorId(request: SubscriptionsRequest): string {
    const userId = request.user?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authenticated user is required')
    }
    return userId
  }
}
