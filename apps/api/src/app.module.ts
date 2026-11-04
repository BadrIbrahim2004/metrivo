import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AuthModule } from './auth/auth.module'
import { BranchAccessController } from './branch-access.controller'
import { BranchAccessService } from './branch-access.service'
import { CashManagementController } from './cash-management.controller'
import { CashManagementService } from './cash-management.service'
import { CustomersController } from './customers.controller'
import { CustomersService } from './customers.service'
import { ExpenseController } from './expense.controller'
import { ExpenseService } from './expense.service'
import { GLOBAL_AUTH_GUARD_PROVIDERS } from './global-auth-guards'
import { HealthController } from './health.controller'
import { InvitationController } from './invitation.controller'
import { InvitationService } from './invitation.service'
import { PlatformAdministrationService } from './platform-administration.service'
import { ProcurementController } from './procurement.controller'
import { ProcurementService } from './procurement.service'
import { ProductController } from './product.controller'
import { ProductService } from './product.service'
import { ReceiptSettingsController } from './receipt-settings.controller'
import { ReceiptSettingsService } from './receipt-settings.service'
import { RecipesController } from './recipes.controller'
import { RecipesService } from './recipes.service'
import { ReportsController } from './reports.controller'
import { ReportsService } from './reports.service'
import { SalesController } from './sales.controller'
import { SalesService } from './sales.service'
import { StockTransfersController } from './stock-transfers.controller'
import { StockTransfersService } from './stock-transfers.service'
import { SubscriptionsController } from './subscriptions.controller'
import { SubscriptionsService } from './subscriptions.service'
import { TenantOnboardingController } from './tenant-onboarding.controller'
import { TenantOnboardingService } from './tenant-onboarding.service'
import { PrismaModule } from './prisma.module'
import { SupportAccessService } from './support-access.service'

function validateEnvironment(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const port = Number(config.PORT ?? 3000)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }

  const nodeEnv = config.NODE_ENV ?? 'development'
  if (!['development', 'test', 'production'].includes(String(nodeEnv))) {
    throw new Error('NODE_ENV must be development, test, or production')
  }

  const tokenSecret = config.AUTH_ACCESS_TOKEN_SECRET
  if (
    typeof tokenSecret !== 'string' ||
    Buffer.byteLength(tokenSecret, 'utf8') < 32
  ) {
    throw new Error(
      'AUTH_ACCESS_TOKEN_SECRET must be configured with at least 32 bytes',
    )
  }

  for (const key of [
    'AUTH_ACCESS_TOKEN_ISSUER',
    'AUTH_ACCESS_TOKEN_AUDIENCE',
  ]) {
    if (
      typeof config[key] !== 'string' ||
      config[key].trim().length === 0
    ) {
      throw new Error(`${key} must be configured`)
    }
  }

  return { ...config, PORT: port, NODE_ENV: nodeEnv }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    AuthModule,
  ],
  controllers: [
    HealthController,
    InvitationController,
    ProductController,
    SalesController,
    BranchAccessController,
    ReceiptSettingsController,
    CashManagementController,
    CustomersController,
    ExpenseController,
    ProcurementController,
    RecipesController,
    ReportsController,
    StockTransfersController,
    SubscriptionsController,
    TenantOnboardingController,
  ],
  providers: [
    PlatformAdministrationService,
    InvitationService,
    SupportAccessService,
    ProductService,
    SalesService,
    BranchAccessService,
    ReceiptSettingsService,
    CashManagementService,
    CustomersService,
    ExpenseService,
    ProcurementService,
    RecipesService,
    ReportsService,
    StockTransfersService,
    SubscriptionsService,
    TenantOnboardingService,
    ...GLOBAL_AUTH_GUARD_PROVIDERS,
  ],
})
export class AppModule {}
