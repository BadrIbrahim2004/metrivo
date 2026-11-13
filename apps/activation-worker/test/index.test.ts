import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, verify } from 'node:crypto'
import { describe, it } from 'node:test'
import { createOfflineLicense, hmacHex, isValidDeviceId } from '../src/index.js'

describe('activation worker helpers', () => {
  it('accepts only 43-character base64url device identifiers', () => {
    assert.equal(isValidDeviceId('A'.repeat(43)), true)
    assert.equal(isValidDeviceId('A'.repeat(42)), false)
    assert.equal(isValidDeviceId('A'.repeat(42) + '!'), false)
  })

  it('matches Node HMAC output for activation relay signatures', async () => {
    const secret = 'a sufficiently long shared secret for tests'
    assert.equal(
      await hmacHex(secret, '1700000000000\nowner@example.test\n012345\n2026-11-13T00:00:00.000Z'),
      createHmac('sha256', secret)
        .update('1700000000000\nowner@example.test\n012345\n2026-11-13T00:00:00.000Z')
        .digest('hex'),
    )
  })

  it('issues a device-bound mtr2 license verified by the desktop public key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const deviceId = 'A'.repeat(43)
    const license = await createOfflineLicense(
      deviceId,
      'license-id',
      new Date('2026-11-13T00:00:00.000Z'),
      privatePem,
    )
    const [prefix, payload, signature] = license.split('.')

    assert.equal(prefix, 'mtr2')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      app: string
      deviceId: string
      version: number
    }
    assert.deepEqual(decoded, {
      app: 'com.metrivo.desktop',
      deviceId,
      issuedAt: '2026-11-13T00:00:00.000Z',
      licenseId: 'license-id',
      version: 2,
    })
    assert.equal(
      verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64url')),
      true,
    )
  })
})
