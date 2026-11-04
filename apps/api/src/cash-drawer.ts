import { Prisma } from '@prisma/client'

/**
 * Single source of truth for the expected cash drawer balance of a shift.
 *
 * expected = opening cash
 *          + cash-in movements - cash-out movements
 *          + cash sales
 *          - cash refund settlements
 *          - active cash expenses
 *
 * Used by the cash-management service, the expenses service, and the
 * database triggers that guard drawer movements (kept in sync by design —
 * the SQL below is the canonical statement to copy into trigger functions).
 */
export async function getExpectedDrawerCash(
  tx: Prisma.TransactionClient,
  shift: { id: string; tenantId: string; openingCash: string },
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ expected: string }>>`
    SELECT (
      ${shift.openingCash}::numeric
      + COALESCE((SELECT SUM(CASE WHEN cm.type = 'CASH_IN' THEN cm.amount ELSE -cm.amount END)
          FROM "CashMovement" cm
         WHERE cm."cashShiftId" = ${shift.id} AND cm."tenantId" = ${shift.tenantId}), 0)
      + COALESCE((SELECT SUM(s.total) FROM "Sale" s
         WHERE s."cashShiftId" = ${shift.id} AND s."tenantId" = ${shift.tenantId}), 0)
      - COALESCE((SELECT SUM(rs.amount) FROM "SaleReturnSettlement" rs
         WHERE rs."cashShiftId" = ${shift.id} AND rs."tenantId" = ${shift.tenantId}
           AND rs.method = 'CASH'), 0)
      - COALESCE((SELECT SUM(e.amount) FROM "Expense" e
         WHERE e."cashShiftId" = ${shift.id} AND e."tenantId" = ${shift.tenantId}
           AND e.method = 'CASH' AND e.status = 'ACTIVE'), 0)
    )::numeric(12, 2)::text AS expected
  `
  return rows[0]?.expected ?? '0.00'
}
