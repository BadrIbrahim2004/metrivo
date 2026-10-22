import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AuthModule } from './auth/auth.module'
import { BranchAccessController } from './branch-access.controller'
import { BranchAccessService } from './branch-access.service'
import { GLOBAL_AUTH_GUARD_PROVIDERS } from './global-auth-guards'
import { HealthController } from './health.controller'
import { InvitationController } from './invitation.controller'
import { InvitationService } from './invitation.service'
import { PlatformAdministrationService } from './platform-administration.service'
import { ProductController } from './product.controller'
import { ProductService } from './product.service'
import { SalesController } from './sales.controller'
import { SalesService } from './sales.service'
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
  ],
  providers: [
    PlatformAdministrationService,
    InvitationService,
    SupportAccessService,
    ProductService,
    SalesService,
    BranchAccessService,
    ...GLOBAL_AUTH_GUARD_PROVIDERS,
  ],
})
export class AppModule {}
