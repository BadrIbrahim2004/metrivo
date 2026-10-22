import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Public } from './authz.decorator'
import { PrismaService } from './prisma.service'

@Controller()
@Public()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  async getHealth() {
    try {
      await this.prisma.checkConnection()
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'metrivo-api',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      })
    }

    return {
      status: 'ok',
      service: 'metrivo-api',
      database: 'connected',
      timestamp: new Date().toISOString(),
    }
  }
}
