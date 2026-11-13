import 'reflect-metadata'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, verify as verifySignature } from 'node:crypto'
import { describe, it } from 'node:test'
import { ConfigService } from '@nestjs/config'
import {
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { LocalActivationService, LocalActivationMailer } from '../src/local-activation.service'
import { PrismaService } from '../src/prisma.service'

interface Challenge {
  id: string
  deviceId: string
  codeHash: string
  expiresAt: Date
  consumedAt: Date | null
  attempts: number
  createdAt: Date
}

function verifyOfflineLicense(code: string, deviceId: string, publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): boolean {
  const [prefix, payloadPart, signaturePart, extra] = code.split('.')
  if (prefix !== 'mtr2' || !payloadPart || !signaturePart || extra) return false
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
    app: string
    deviceId: string
    version: number
  }
  return payload.app === 'com.metrivo.desktop' &&
    payload.deviceId === deviceId &&
    payload.version === 2 &&
    verifySignature(
      null,
      Buffer.from(payloadPart, 'utf8'),
      publicKey,
      Buffer.from(signaturePart, 'base64url'),
    )
}

function createFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const settings: Record<string, string> = {
    ACTIVATION_OWNER_EMAIL: 'owner@example.test',
    ACTIVATION_OTP_PEPPER: 'test-activation-otp-pepper-value-32b',
    ACTIVATION_SIGNING_PRIVATE_KEY_PEM:
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  }
  const config = new ConfigService(settings)
  const challenges: Challenge[] = []
  const prisma = Object.create(PrismaService.prototype) as PrismaService
  const delegate = {
    create: async ({ data }: { data: Omit<Challenge, 'attempts' | 'consumedAt' | 'createdAt'> }) => {
      const challenge: Challenge = {
        ...data,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(),
      }
      challenges.push(challenge)
      return challenge
    },
    updateMany: async ({ where, data }: {
      where: Record<string, unknown>
      data: { consumedAt?: Date; attempts?: { increment: number } }
    }) => {
      const matches = challenges.filter((challenge) =>
        Object.entries(where).every(([key, value]) => {
          if (key === 'expiresAt' && value && typeof value === 'object' && 'gt' in value) {
            return value.gt instanceof Date && challenge.expiresAt > value.gt
          }
          if (key === 'attempts' && value && typeof value === 'object' && 'lt' in value) {
            return typeof value.lt === 'number' && challenge.attempts < value.lt
          }
          if (key === 'attempts' && value && typeof value === 'object' && 'gte' in value) {
            return typeof value.gte === 'number' && challenge.attempts >= value.gte
          }
          if (key === 'attempts' && typeof value === 'number') {
            return challenge.attempts === value
          }
          return challenge[key as keyof Challenge] === value
        }),
      )
      for (const challenge of matches) {
        if (data.consumedAt) challenge.consumedAt = data.consumedAt
        if (data.attempts) challenge.attempts += data.attempts.increment
      }
      return { count: matches.length }
    },
    deleteMany: async () => ({ count: 0 }),
    findFirst: async ({ where }: {
      where: {
        deviceId: string
        consumedAt?: null
        expiresAt?: { gt: Date }
        attempts?: { lt: number }
        createdAt?: { gt: Date }
      }
      orderBy?: { createdAt: 'desc' }
      select?: { id: true }
    }) => {
      if (where.createdAt) {
        return challenges.find((challenge) =>
          challenge.deviceId === where.deviceId &&
          challenge.createdAt > where.createdAt!.gt,
        ) ?? null
      }
      return challenges
        .filter((challenge) =>
          challenge.deviceId === where.deviceId &&
          challenge.consumedAt === null &&
          challenge.expiresAt > where.expiresAt!.gt &&
          challenge.attempts < where.attempts!.lt,
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
    },
  }
  Object.assign(prisma, {
    localActivationChallenge: delegate,
    $executeRaw: async () => 1,
    $transaction: async (operation: (transaction: PrismaService) => Promise<unknown>) =>
      operation(prisma),
  })

  let mailedCode = ''
  let mailedTo = ''
  const mailer = new LocalActivationMailer(config)
  mailer.sendActivationCode = async (to, code) => {
    mailedTo = to
    mailedCode = code
  }
  const service = new LocalActivationService(prisma, config, mailer)

  return {
    challenges,
    mailedCode: () => mailedCode,
    mailedTo: () => mailedTo,
    publicKey,
    service,
  }
}

describe('LocalActivationService', () => {
  const deviceId = 'A'.repeat(43)

  it('emails a five-minute code only to the configured owner and redeems it once', async () => {
    const fixture = createFixture()
    const result = await fixture.service.requestCode(deviceId)
    assert.deepEqual(result, { sent: true, expiresInSeconds: 300 })
    assert.equal(fixture.mailedTo(), 'owner@example.test')
    assert.match(fixture.mailedCode(), /^\d{6}$/)
    assert.equal(fixture.challenges[0].codeHash.length, 64)
    assert.notEqual(fixture.challenges[0].codeHash, fixture.mailedCode())

    const redemption = await fixture.service.verifyCode(deviceId, fixture.mailedCode())
    assert.equal(
      verifyOfflineLicense(redemption.activationCode, deviceId, fixture.publicKey),
      true,
    )
    await assert.rejects(
      fixture.service.verifyCode(deviceId, fixture.mailedCode()),
      UnauthorizedException,
    )
  })

  it('expires codes after five minutes', async () => {
    const fixture = createFixture()
    await fixture.service.requestCode(deviceId)
    fixture.challenges[0].expiresAt = new Date(Date.now() - 1)

    await assert.rejects(
      fixture.service.verifyCode(deviceId, fixture.mailedCode()),
      UnauthorizedException,
    )
  })

  it('limits repeated code requests for the same device', async () => {
    const fixture = createFixture()
    await fixture.service.requestCode(deviceId)
    await assert.rejects(
      fixture.service.requestCode(deviceId),
      (error) => error instanceof HttpException && error.getStatus() === 429,
    )
    assert.equal(fixture.challenges.length, 1)
  })

  it('consumes a code after five incorrect attempts', async () => {
    const fixture = createFixture()
    await fixture.service.requestCode(deviceId)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(
        fixture.service.verifyCode(deviceId, '000000'),
        UnauthorizedException,
      )
    }
    assert.equal(fixture.challenges[0].consumedAt instanceof Date, true)
    await assert.rejects(
      fixture.service.verifyCode(deviceId, fixture.mailedCode()),
      UnauthorizedException,
    )
  })

  it('rejects licenses for a different device', async () => {
    const fixture = createFixture()
    await fixture.service.requestCode(deviceId)
    const redemption = await fixture.service.verifyCode(deviceId, fixture.mailedCode())

    assert.equal(
      verifyOfflineLicense(
        redemption.activationCode,
        'different-device-identifier-1234567890123456789',
        fixture.publicKey,
      ),
      false,
    )
  })
})

describe('LocalActivationMailer', () => {
  it('sends an HMAC-signed request to the configured HTTPS relay', async () => {
    const secret = 'test-activation-mailer-shared-secret-at-least-32-bytes'
    const url = 'https://script.google.com/macros/s/test/exec'
    const mailer = new LocalActivationMailer(new ConfigService({
      ACTIVATION_MAIL_WEBHOOK_URL: url,
      ACTIVATION_MAILER_SHARED_SECRET: secret,
    }))
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> | undefined

    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), url)
      assert.equal(init?.method, 'POST')
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ sent: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    try {
      const expiresAt = new Date(Date.now() + 5 * 60_000)
      await mailer.sendActivationCode('owner@example.test', '012345', expiresAt)

      assert.equal(requestBody?.email, 'owner@example.test')
      assert.equal(requestBody?.code, '012345')
      assert.equal(requestBody?.expiresAt, expiresAt.toISOString())
      assert.equal(typeof requestBody?.timestamp, 'number')
      const signedPayload = `${requestBody?.timestamp}\nowner@example.test\n012345\n${expiresAt.toISOString()}`
      assert.equal(
        requestBody?.signature,
        createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex'),
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a relay URL that is not HTTPS', async () => {
    const mailer = new LocalActivationMailer(new ConfigService({
      ACTIVATION_MAIL_WEBHOOK_URL: 'http://example.test/exec',
      ACTIVATION_MAILER_SHARED_SECRET: 'test-activation-mailer-shared-secret-at-least-32-bytes',
    }))

    await assert.rejects(
      mailer.sendActivationCode('owner@example.test', '012345', new Date()),
      ServiceUnavailableException,
    )
  })
})
