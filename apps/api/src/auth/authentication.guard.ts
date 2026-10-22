import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { UserStatus } from '@prisma/client'
import { IS_PUBLIC_ROUTE } from '../authz.decorator'
import { PrismaService } from '../prisma.service'

interface AuthenticationRequest {
  headers: {
    authorization?: string | string[]
  }
  user?: { userId?: unknown }
}

interface AccessTokenPayload {
  sub?: unknown
}

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, targets)) {
      return true
    }

    const request =
      context.switchToHttp().getRequest<AuthenticationRequest>()
    const authorization = request.headers.authorization
    if (
      typeof authorization !== 'string' ||
      !/^Bearer [^\s]+$/i.test(authorization)
    ) {
      throw new UnauthorizedException('Bearer access token is required')
    }

    let payload: AccessTokenPayload
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(
        authorization.slice('Bearer '.length),
      )
    } catch {
      throw new UnauthorizedException('Invalid or expired access token')
    }

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedException('Invalid or expired access token')
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true },
    })
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid or expired access token')
    }

    request.user = { userId: payload.sub }
    return true
  }
}
