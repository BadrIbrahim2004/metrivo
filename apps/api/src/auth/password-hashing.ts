import { argon2id, hash } from 'argon2'
import type { HashOptions } from 'argon2'

export const PASSWORD_HASH_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_HASH_OPTIONS)
}
