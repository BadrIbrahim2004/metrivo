import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'

export interface PlatformAuditEvent {
  actorUserId: string
  action: string
  targetType: string
  targetId: string | null
  metadata: Record<string, string | string[]>
}

export async function writePlatformAudit(
  tx: Prisma.TransactionClient,
  event: PlatformAuditEvent,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "PlatformAuditLog"
      ("id", "actorUserId", "action", "targetType", "targetId", "outcome", "metadata", "occurredAt")
    VALUES (
      ${randomUUID()},
      ${event.actorUserId},
      ${event.action},
      ${event.targetType},
      ${event.targetId},
      'SUCCEEDED',
      ${JSON.stringify(event.metadata)}::jsonb,
      CURRENT_TIMESTAMP
    )
  `
}
