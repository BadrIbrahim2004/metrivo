/**
 * Bootstrap the FIRST platform owner account.
 *
 * Safety properties:
 * - Never resets, deletes or overwrites existing data.
 * - Refuses to run if a platform owner already exists.
 * - Refuses to run against a non-local database host unless
 *   ALLOW_REMOTE_BOOTSTRAP=true is explicitly set (needed for the first
 *   production setup on a server).
 * - Password comes from BOOTSTRAP_ADMIN_PASSWORD (min 12 chars), never hardcoded.
 *
 * Usage (from apps/api, after `npm run build`):
 *   node dist/scripts/bootstrap-local-admin.js
 */
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import * as argon2 from 'argon2'

async function main() {
  const databaseUrl = process.env.DATABASE_URL ?? ''
  let host: string
  try {
    host = new URL(databaseUrl).hostname
  } catch {
    throw new Error('DATABASE_URL must be set to a valid connection string')
  }
  const isLocal = ['localhost', '127.0.0.1', '::1', 'db'].includes(host)
  if (
    !isLocal &&
    process.env.ALLOW_REMOTE_BOOTSTRAP !== 'true'
  ) {
    throw new Error(
      `Refusing bootstrap: ${host} is not a local database host. ` +
      'Set ALLOW_REMOTE_BOOTSTRAP=true to bootstrap a remote/production database.',
    )
  }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD
  if (!email || !password || password.length < 12) {
    throw new Error(
      'BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (min 12 chars) are required',
    )
  }

  const prisma = new PrismaClient()
  try {
    const existingOwner = await prisma.platformOwnerRegistry.findFirst({
      where: { singleton: true },
    })
    if (existingOwner) {
      console.log('Platform owner already exists; nothing to do.')
      return
    }

    const passwordHash = await argon2.hash(password)
    const userId = randomUUID()
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(127987, 1)`
      const owners = await tx.$queryRaw<Array<{ singleton: boolean }>>`
        SELECT singleton FROM "PlatformOwnershipState" WHERE singleton = TRUE
      `;
      if (owners[0]) {
        throw new Error('Ownership state already initialized; refusing to bootstrap again')
      }
      await tx.platformOwnershipState.create({ data: { singleton: true, initialized: true } })
      await tx.platformOwnerRegistry.create({
        data: { singleton: true, ownerUserId: userId },
      })
      const user = await tx.user.create({
        data: {
          id: userId,
          email,
          emailNormalized: email,
          name: 'Platform Owner',
          passwordHash,
          status: 'ACTIVE',
        },
      })
      await tx.userPlatformRole.create({
        data: { userId: user.id, platformRoleId: 'platform-owner-role' },
      })
      return user
    })
    console.log(`Bootstrap complete. Platform owner created: ${result.email}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
