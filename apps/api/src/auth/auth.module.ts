import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { ThrottlerModule } from '@nestjs/throttler'
import { PrismaModule } from '../prisma.module'
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants'
import { AuthController } from './auth.controller'
import { AuthenticationGuard } from './authentication.guard'
import { AuthService } from './auth.service'

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('AUTH_ACCESS_TOKEN_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          audience: config.getOrThrow<string>(
            'AUTH_ACCESS_TOKEN_AUDIENCE',
          ),
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
          issuer: config.getOrThrow<string>('AUTH_ACCESS_TOKEN_ISSUER'),
        },
        verifyOptions: {
          algorithms: ['HS256'],
          audience: config.getOrThrow<string>(
            'AUTH_ACCESS_TOKEN_AUDIENCE',
          ),
          issuer: config.getOrThrow<string>('AUTH_ACCESS_TOKEN_ISSUER'),
        },
      }),
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 5,
      },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthenticationGuard],
  exports: [AuthenticationGuard],
})
export class AuthModule {}
