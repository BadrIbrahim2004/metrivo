import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { createRequire } from 'node:module'
import { ActivationAppModule } from './activation-app.module'

async function bootstrap() {
  const app = await NestFactory.create(ActivationAppModule, { bodyParser: false })
  const config = app.get(ConfigService)

  const jsonBodyParser = createRequire(__filename)('express').json({
    limit: '800kb',
  })
  app.use(jsonBodyParser)
  app.setGlobalPrefix('api')
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )

  const port = Number(config.get<string>('PORT') ?? '3000')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }

  await app.listen(port, config.get<string>('HOST', '0.0.0.0'))
}

void bootstrap()
