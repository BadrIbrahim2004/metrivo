import {
  Injectable,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHmac, createPrivateKey, randomInt, randomUUID, sign, timingSafeEqual } from 'node:crypto'
import { isEmail } from 'class-validator'
import { PrismaService } from './prisma.service'

const CODE_TTL_MILLISECONDS = 5 * 60 * 1000
const MAX_CODE_ATTEMPTS = 5
const APP_ID = 'com.metrivo.desktop'

@Injectable()
export class LocalActivationMailer {
  constructor(private readonly config: ConfigService) {}

  async sendActivationCode(email: string, code: string, expiresAt: Date): Promise<void> {
    const rawUrl = this.getRequiredSetting('ACTIVATION_MAIL_WEBHOOK_URL')
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new ServiceUnavailableException('Activation email relay URL is invalid.')
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new ServiceUnavailableException('Activation email relay URL must use HTTPS.')
    }

    const secret = this.getRequiredSetting('ACTIVATION_MAILER_SHARED_SECRET')
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new ServiceUnavailableException('Activation email relay security is not configured.')
    }

    const timestamp = Date.now()
    const expiresAtIso = expiresAt.toISOString()
    const signedPayload = `${timestamp}\n${email}\n${code}\n${expiresAtIso}`
    const signature = createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex')

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timestamp,
        email,
        code,
        expiresAt: expiresAtIso,
        signature,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`Activation email relay returned HTTP ${response.status}.`)
    }

    const result: unknown = await response.json()
    if (
      result === null ||
      typeof result !== 'object' ||
      !('sent' in result) ||
      result.sent !== true
    ) {
      throw new Error('Activation email relay did not confirm delivery.')
    }
  }

  private getRequiredSetting(name: string): string {
    const value = this.config.get<string>(name)?.trim()
    if (!value) {
      throw new ServiceUnavailableException(`Activation service is not configured (${name}).`)
    }
    return value
  }
}

@Injectable()
export class LocalActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mailer: LocalActivationMailer,
  ) {}

  async requestCode(deviceId: string): Promise<{ sent: true; expiresInSeconds: number }> {
    const email = this.getRequiredSetting('ACTIVATION_OWNER_EMAIL')
    if (!isEmail(email)) {
      throw new ServiceUnavailableException('Activation owner email is not configured correctly.')
    }
    const pepper = this.getPepper()
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + CODE_TTL_MILLISECONDS)
    const challengeId = randomUUID()
    this.getSigningPrivateKey()

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(127987, hashtext(${deviceId}))`
      const recentRequest = await tx.localActivationChallenge.findFirst({
        where: {
          deviceId,
          createdAt: { gt: new Date(now.getTime() - 60_000) },
        },
        select: { id: true },
      })
      if (recentRequest) {
        throw new HttpException(
          'انتظر دقيقة قبل طلب رمز جديد لهذا الجهاز.',
          HttpStatus.TOO_MANY_REQUESTS,
        )
      }
      await tx.localActivationChallenge.updateMany({
        where: { deviceId, consumedAt: null },
        data: { consumedAt: now },
      })
      await tx.localActivationChallenge.deleteMany({
        where: { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      })
      await tx.localActivationChallenge.create({
        data: {
          id: challengeId,
          deviceId,
          codeHash: this.hashCode(pepper, deviceId, code),
          expiresAt,
        },
      })
    })

    try {
      await this.mailer.sendActivationCode(email, code, expiresAt)
    } catch (error) {
      await this.prisma.localActivationChallenge.updateMany({
        where: { id: challengeId, consumedAt: null },
        data: { consumedAt: new Date() },
      })
      const errorCode = error instanceof Error ? error.name : 'unknown'
      console.error('Local activation email delivery failed.', errorCode)
      throw new ServiceUnavailableException('تعذر إرسال رمز التفعيل. حاول مرة أخرى لاحقًا.')
    }

    return { sent: true, expiresInSeconds: CODE_TTL_MILLISECONDS / 1000 }
  }

  async verifyCode(
    deviceId: string,
    code: string,
  ): Promise<{ activationCode: string }> {
    const now = new Date()
    const challenge = await this.prisma.localActivationChallenge.findFirst({
      where: {
        deviceId,
        consumedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: MAX_CODE_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (!challenge) throw new UnauthorizedException('رمز التفعيل غير صالح أو انتهت صلاحيته.')

    const expectedHash = Buffer.from(challenge.codeHash, 'hex')
    const submittedHash = Buffer.from(
      this.hashCode(this.getPepper(), deviceId, code),
      'hex',
    )
    if (
      expectedHash.length !== submittedHash.length ||
      !timingSafeEqual(expectedHash, submittedHash)
    ) {
      const failedAttempt = await this.prisma.localActivationChallenge.updateMany({
        where: {
          id: challenge.id,
          consumedAt: null,
          expiresAt: { gt: now },
          attempts: { lt: MAX_CODE_ATTEMPTS },
        },
        data: {
          attempts: { increment: 1 },
        },
      })
      if (failedAttempt.count === 1) {
        await this.prisma.localActivationChallenge.updateMany({
          where: {
            id: challenge.id,
            consumedAt: null,
            attempts: { gte: MAX_CODE_ATTEMPTS },
          },
          data: { consumedAt: new Date() },
        })
      }
      throw new UnauthorizedException('رمز التفعيل غير صالح أو انتهت صلاحيته.')
    }

    const activationCode = this.createOfflineLicense(deviceId, randomUUID(), now)
    const consumedAt = new Date()
    const consumed = await this.prisma.localActivationChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        expiresAt: { gt: consumedAt },
        attempts: { lt: MAX_CODE_ATTEMPTS },
      },
      data: { consumedAt },
    })
    if (consumed.count !== 1) {
      throw new UnauthorizedException('رمز التفعيل غير صالح أو انتهت صلاحيته.')
    }

    return { activationCode }
  }

  private getRequiredSetting(name: string): string {
    const value = this.config.get<string>(name)?.trim()
    if (!value) {
      throw new ServiceUnavailableException(`Activation service is not configured (${name}).`)
    }
    return value
  }

  private getPepper(): string {
    const pepper = this.getRequiredSetting('ACTIVATION_OTP_PEPPER')
    if (Buffer.byteLength(pepper, 'utf8') < 32) {
      throw new ServiceUnavailableException('Activation service OTP security is not configured.')
    }
    return pepper
  }

  private hashCode(pepper: string, deviceId: string, code: string): string {
    return createHmac('sha256', pepper).update(`${deviceId}:${code}`, 'utf8').digest('hex')
  }

  private createOfflineLicense(deviceId: string, licenseId: string, issuedAt: Date): string {
    const privateKey = this.getSigningPrivateKey()
    const payload = Buffer.from(JSON.stringify({
      app: APP_ID,
      deviceId,
      issuedAt: issuedAt.toISOString(),
      licenseId,
      version: 2,
    }), 'utf8').toString('base64url')
    const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey)
      .toString('base64url')
    return `mtr2.${payload}.${signature}`
  }

  private getSigningPrivateKey(): ReturnType<typeof createPrivateKey> {
    let privateKey
    try {
      privateKey = createPrivateKey(
        this.getRequiredSetting('ACTIVATION_SIGNING_PRIVATE_KEY_PEM').replace(/\\n/g, '\n'),
      )
    } catch {
      throw new ServiceUnavailableException('Activation signing key is not configured correctly.')
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new ServiceUnavailableException('Activation signing key is not an Ed25519 key.')
    }
    return privateKey
  }
}
