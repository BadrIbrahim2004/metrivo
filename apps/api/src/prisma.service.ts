import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async checkConnection(): Promise<void> {
    await this.$queryRaw`SELECT 1`
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
