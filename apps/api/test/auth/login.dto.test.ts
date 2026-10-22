import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { LoginDto } from '../../src/auth/login.dto'
import { normalizeEmail } from '../../src/auth/email-normalization'

describe('LoginDto', () => {
  it('normalizes email using the existing trim-and-lowercase behavior', () => {
    assert.equal(
      normalizeEmail('  User.Name+Shop@Example.COM  '),
      'user.name+shop@example.com',
    )
    assert.equal(normalizeEmail(' Iİ@Example.COM '), 'ii̇@example.com')
  })

  it('trims and lowercases email without modifying the password', async () => {
    const dto = plainToInstance(LoginDto, {
      email: '  User.Name+Shop@Example.COM  ',
      password: ' exact password ',
    })

    assert.equal(dto.email, 'user.name+shop@example.com')
    assert.equal(dto.password, ' exact password ')
    assert.deepEqual(await validate(dto), [])
  })

  it('rejects missing credentials, invalid email, oversized passwords, and unrecognized fields', async () => {
    const invalidInputs: unknown[] = [
      {},
      { email: 'not-an-email', password: 'password' },
      { email: 'user@example.com', password: '' },
      { email: 'user@example.com', password: 'x'.repeat(129) },
      {
        email: 'user@example.com',
        password: 'password',
        userId: 'forged-user',
      },
    ]

    for (const input of invalidInputs) {
      const dto = plainToInstance(LoginDto, input)
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
      assert.notEqual(errors.length, 0)
    }
  })
})
