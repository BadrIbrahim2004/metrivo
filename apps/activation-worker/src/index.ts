import { Client } from 'pg'

const CODE_TTL_MILLISECONDS = 5 * 60 * 1000
const RATE_LIMIT_WINDOW_MILLISECONDS = 60 * 1000
const MAX_CODE_ATTEMPTS = 5
const APP_ID = 'com.metrivo.desktop'
const encoder = new TextEncoder()

interface Env {
  HYPERDRIVE: {
    connectionString: string
  }
  ACTIVATION_OWNER_EMAIL: string
  ACTIVATION_OTP_PEPPER: string
  ACTIVATION_SIGNING_PRIVATE_KEY_PEM: string
  ACTIVATION_MAIL_WEBHOOK_URL: string
  ACTIVATION_MAILER_SHARED_SECRET: string
}

interface ActivationChallenge {
  id: string
  codeHash: string
  expiresAt: Date
  attempts: number
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

function getRequiredSetting(value: string | undefined, name: string): string {
  const setting = value?.trim()
  if (!setting) {
    throw new Error(`Missing required setting: ${name}`)
  }
  return setting
}

function getPepper(env: Env): string {
  const pepper = getRequiredSetting(env.ACTIVATION_OTP_PEPPER, 'ACTIVATION_OTP_PEPPER')
  if (encoder.encode(pepper).byteLength < 32) {
    throw new Error('ACTIVATION_OTP_PEPPER must contain at least 32 bytes.')
  }
  return pepper
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

function isValidCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value)
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return bytesToHex(new Uint8Array(signature))
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

function generateOtp(): string {
  const range = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  const random = new Uint32Array(1)
  do {
    crypto.getRandomValues(random)
  } while (random[0] >= range)
  return (random[0] % 1_000_000).toString().padStart(6, '0')
}

async function importSigningKey(pemValue: string): Promise<CryptoKey> {
  const pem = getRequiredSetting(pemValue, 'ACTIVATION_SIGNING_PRIVATE_KEY_PEM')
    .replace(/\\n/g, '\n')
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      base64ToArrayBuffer(base64),
      { name: 'Ed25519' },
      false,
      ['sign'],
    )
  } catch {
    throw new Error('ACTIVATION_SIGNING_PRIVATE_KEY_PEM is not a valid Ed25519 PKCS#8 key.')
  }
}

export async function createOfflineLicense(
  deviceId: string,
  licenseId: string,
  issuedAt: Date,
  privateKeyPem: string,
): Promise<string> {
  const privateKey = await importSigningKey(privateKeyPem)
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
    app: APP_ID,
    deviceId,
    issuedAt: issuedAt.toISOString(),
    licenseId,
    version: 2,
  })))
  const signature = await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    encoder.encode(payload),
  )
  return `mtr2.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`
}

async function createClient(env: Env): Promise<Client> {
  const client = new Client({
    connectionString: getRequiredSetting(
      env.HYPERDRIVE?.connectionString,
      'HYPERDRIVE.connectionString',
    ),
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  })
  await client.connect()
  return client
}

async function withClient<T>(env: Env, operation: (client: Client) => Promise<T>): Promise<T> {
  const client = await createClient(env)
  try {
    return await operation(client)
  } finally {
    await client.end()
  }
}

async function enforceIpRateLimit(
  client: Client,
  request: Request,
  scope: 'request' | 'verify',
  limit: number,
  pepper: string,
  now: Date,
): Promise<void> {
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const keyHash = await hmacHex(pepper, `${scope}:${address}`)
  const windowStartedAt = new Date(
    Math.floor(now.getTime() / RATE_LIMIT_WINDOW_MILLISECONDS) *
    RATE_LIMIT_WINDOW_MILLISECONDS,
  )
  const expiresAt = new Date(windowStartedAt.getTime() + 24 * 60 * 60 * 1000)
  const result = await client.query<{ requestCount: number }>(
    `INSERT INTO "LocalActivationRateLimit"
      ("scope", "keyHash", "windowStartedAt", "requestCount", "expiresAt")
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT ("scope", "keyHash", "windowStartedAt")
     DO UPDATE SET "requestCount" = "LocalActivationRateLimit"."requestCount" + 1
     RETURNING "requestCount"`,
    [scope, keyHash, windowStartedAt, expiresAt],
  )
  const requestCount = Number(result.rows[0]?.requestCount)
  if (requestCount > limit) {
    throw new HttpError(429, 'عدد المحاولات كبير. حاول مرة أخرى بعد دقيقة.')
  }
  if (now.getTime() % (60 * 60 * 1000) < RATE_LIMIT_WINDOW_MILLISECONDS) {
    await client.query(
      'DELETE FROM "LocalActivationRateLimit" WHERE "expiresAt" < $1',
      [now],
    )
  }
}

function getDeviceId(body: unknown): string {
  if (!body || typeof body !== 'object' || !('deviceId' in body) ||
      !isValidDeviceId(body.deviceId)) {
    throw new HttpError(400, 'معرّف الجهاز غير صالح.')
  }
  return body.deviceId
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'يجب إرسال البيانات بصيغة JSON.')
  }
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    throw new HttpError(413, 'حجم الطلب أكبر من المسموح.')
  }
  const text = await request.text()
  if (encoder.encode(text).byteLength > 4096) {
    throw new HttpError(413, 'حجم الطلب أكبر من المسموح.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpError(400, 'بيانات الطلب غير صالحة.')
  }
}

async function requestActivationCode(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request)
  const deviceId = getDeviceId(body)
  const email = getRequiredSetting(env.ACTIVATION_OWNER_EMAIL, 'ACTIVATION_OWNER_EMAIL')
  if (!isValidEmail(email)) {
    throw new Error('ACTIVATION_OWNER_EMAIL is invalid.')
  }
  const pepper = getPepper(env)
  const signingKey = getRequiredSetting(
    env.ACTIVATION_SIGNING_PRIVATE_KEY_PEM,
    'ACTIVATION_SIGNING_PRIVATE_KEY_PEM',
  )
  await importSigningKey(signingKey)
  const mailUrl = new URL(getRequiredSetting(
    env.ACTIVATION_MAIL_WEBHOOK_URL,
    'ACTIVATION_MAIL_WEBHOOK_URL',
  ))
  const mailSecret = getRequiredSetting(
    env.ACTIVATION_MAILER_SHARED_SECRET,
    'ACTIVATION_MAILER_SHARED_SECRET',
  )
  if (mailUrl.protocol !== 'https:' || mailUrl.username || mailUrl.password) {
    throw new Error('ACTIVATION_MAIL_WEBHOOK_URL must be an HTTPS URL.')
  }
  if (encoder.encode(mailSecret).byteLength < 32) {
    throw new Error('ACTIVATION_MAILER_SHARED_SECRET must contain at least 32 bytes.')
  }

  const now = new Date()
  const code = generateOtp()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MILLISECONDS)
  const challengeId = crypto.randomUUID()

  await withClient(env, async (client) => {
    await enforceIpRateLimit(client, request, 'request', 3, pepper, now)
    await client.query('BEGIN')
    try {
      await client.query('SELECT pg_advisory_xact_lock(127987, hashtext($1))', [deviceId])
      const recentRequest = await client.query(
        `SELECT "id" FROM "LocalActivationChallenge"
         WHERE "deviceId" = $1 AND "createdAt" > $2
         LIMIT 1`,
        [deviceId, new Date(now.getTime() - RATE_LIMIT_WINDOW_MILLISECONDS)],
      )
      if (recentRequest.rowCount) {
        throw new HttpError(429, 'انتظر دقيقة قبل طلب رمز جديد لهذا الجهاز.')
      }

      await client.query(
        `UPDATE "LocalActivationChallenge"
         SET "consumedAt" = $2
         WHERE "deviceId" = $1 AND "consumedAt" IS NULL`,
        [deviceId, now],
      )
      await client.query(
        `DELETE FROM "LocalActivationChallenge"
         WHERE "expiresAt" < $1`,
        [new Date(now.getTime() - 24 * 60 * 60 * 1000)],
      )
      await client.query(
        `INSERT INTO "LocalActivationChallenge"
          ("id", "deviceId", "codeHash", "expiresAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5)`,
        [challengeId, deviceId, await hmacHex(pepper, `${deviceId}:${code}`), expiresAt, now],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })

  try {
    const timestamp = Date.now()
    const expiresAtIso = expiresAt.toISOString()
    const signedPayload = `${timestamp}\n${email}\n${code}\n${expiresAtIso}`
    const signature = await hmacHex(mailSecret, signedPayload)
    const response = await fetch(mailUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp, email, code, expiresAt: expiresAtIso, signature }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`Activation mail relay returned HTTP ${response.status}.`)
    }
    const result: unknown = await response.json()
    if (!result || typeof result !== 'object' || !('sent' in result) || result.sent !== true) {
      throw new Error('Activation mail relay did not confirm sending.')
    }
  } catch (error) {
    await withClient(env, async (client) => {
      await client.query(
        `UPDATE "LocalActivationChallenge"
         SET "consumedAt" = $2
         WHERE "id" = $1 AND "consumedAt" IS NULL`,
        [challengeId, new Date()],
      )
    })
    console.error(
      'Local activation email delivery failed.',
      error instanceof Error ? error.name : 'unknown',
    )
    throw new HttpError(503, 'تعذر إرسال رمز التفعيل. حاول مرة أخرى لاحقًا.')
  }

  return jsonResponse({ sent: true, expiresInSeconds: CODE_TTL_MILLISECONDS / 1000 })
}

async function verifyActivationCode(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request)
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'بيانات الطلب غير صالحة.')
  }
  const deviceId = getDeviceId(body)
  const submittedCode = 'code' in body ? body.code : undefined
  if (!isValidCode(submittedCode)) {
    throw new HttpError(400, 'رمز التفعيل غير صالح.')
  }
  const pepper = getPepper(env)
  const privateKeyPem = getRequiredSetting(
    env.ACTIVATION_SIGNING_PRIVATE_KEY_PEM,
    'ACTIVATION_SIGNING_PRIVATE_KEY_PEM',
  )
  await importSigningKey(privateKeyPem)
  const now = new Date()

  const activationCode = await withClient(env, async (client) => {
    await enforceIpRateLimit(client, request, 'verify', 10, pepper, now)
    await client.query('BEGIN')
    try {
      const result = await client.query<ActivationChallenge>(
        `SELECT "id", "codeHash", "expiresAt", "attempts"
         FROM "LocalActivationChallenge"
         WHERE "deviceId" = $1 AND "consumedAt" IS NULL
           AND "expiresAt" > $2 AND "attempts" < $3
         ORDER BY "createdAt" DESC
         LIMIT 1
         FOR UPDATE`,
        [deviceId, now, MAX_CODE_ATTEMPTS],
      )
      const challenge = result.rows[0]
      if (!challenge) {
        throw new HttpError(401, 'رمز التفعيل غير صالح أو انتهت صلاحيته.')
      }

      const submittedHash = await hmacHex(pepper, `${deviceId}:${submittedCode}`)
      if (!constantTimeHexEqual(challenge.codeHash.trim(), submittedHash)) {
        const nextAttempts = Number(challenge.attempts) + 1
        await client.query(
          `UPDATE "LocalActivationChallenge"
           SET "attempts" = $2, "consumedAt" = $3
           WHERE "id" = $1`,
          [
            challenge.id,
            nextAttempts,
            nextAttempts >= MAX_CODE_ATTEMPTS ? new Date() : null,
          ],
        )
        await client.query('COMMIT')
        return null
      }

      const consumedAt = new Date()
      if (new Date(challenge.expiresAt).getTime() <= consumedAt.getTime()) {
        throw new HttpError(401, 'رمز التفعيل غير صالح أو انتهت صلاحيته.')
      }
      const activation = await createOfflineLicense(
        deviceId,
        crypto.randomUUID(),
        consumedAt,
        privateKeyPem,
      )
      await client.query(
        `UPDATE "LocalActivationChallenge"
         SET "consumedAt" = $2
         WHERE "id" = $1`,
        [challenge.id, consumedAt],
      )
      await client.query('COMMIT')
      return activation
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })

  if (!activationCode) {
    throw new HttpError(401, 'رمز التفعيل غير صالح أو انتهت صلاحيته.')
  }
  return jsonResponse({ activationCode })
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/health') {
    try {
      await withClient(env, async (client) => {
        await client.query('SELECT 1')
      })
      return jsonResponse({
        status: 'ok',
        service: 'metrivo-activation',
        database: 'connected',
        timestamp: new Date().toISOString(),
      })
    } catch {
      return jsonResponse({
        status: 'error',
        service: 'metrivo-activation',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      }, 503)
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/activation/request') {
    return requestActivationCode(request, env)
  }
  if (request.method === 'POST' && url.pathname === '/api/activation/verify') {
    return verifyActivationCode(request, env)
  }
  return jsonResponse({ status: 'not_found' }, 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env)
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ statusCode: error.status, message: error.message }, error.status)
      }
      console.error(
        'Activation worker request failed.',
        error instanceof Error ? error.name : 'unknown',
      )
      return jsonResponse(
        { statusCode: 503, message: 'خدمة التفعيل غير متاحة مؤقتًا.' },
        503,
      )
    }
  },
}
