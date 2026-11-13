import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ThrottlerModule } from '@nestjs/throttler'
import { HealthController } from './health.controller'
import { LocalActivationController } from './local-activation.controller'
import {
  LocalActivationMailer,
  LocalActivationService,
} from './local-activation.service'
import { PrismaModule } from './prisma.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 5 }]),
    PrismaModule,
  ],
  controllers: [HealthController, LocalActivationController],
  providers: [LocalActivationService, LocalActivationMailer],
})
export class ActivationAppModule {}
