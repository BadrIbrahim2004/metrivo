import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowLeftRight, CheckCircle2, CircleDollarSign, History,
  List, LockKeyhole, ReceiptText,
} from 'lucide-react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language, PageSession } from '../../types'
import { authedFetch, usePageSession } from '../../app/usePageSession'

interface CashMovement {
  id: string
  type: 'CASH_IN' | 'CASH_OUT'
  amount: string
  reason: string
  createdAt: string
}

interface CashShift {
  id: string
  status: 'OPEN' | 'CLOSED'
  openingCash: string
  expectedCash: string | null
  countedCash: string | null
  discrepancy: string | null
  openedAt: string
}

interface PendingRefund {
  id: string
  invoiceNumber: string
  refundAmount: string
  reason: string
  createdAt: string
}

interface ClosedShiftSummary {
  id: string
  openingCash: string
  expectedCash: string | null
  countedCash: string | null
  discrepancy: string | null
  openedAt: string
  closedAt: string | null
}

interface CashManagementPageProps extends PageSession {
  t: AppTranslations
  language: Language
}

function money(value: string, language: Language): string {
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(Number(value))
}

export default function CashManagementPage({
  t,
  language,
  sessionToken,
  workspaces,
  onSessionExpired,
}: CashManagementPageProps) {
  const copy = t.cashManagement
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const token = session.token
  const [branchId, setBranchId] = useState(session.branchId)
  const [shift, setShift] = useState<CashShift | null>(null)
  const [history, setHistory] = useState<ClosedShiftSummary[]>([])
  const [refunds, setRefunds] = useState<PendingRefund[]>([])
  const [movements, setMovements] = useState<CashMovement[]>([])
  const [openingCash, setOpeningCash] = useState('0.00')
  const [countedCash, setCountedCash] = useState('')
  const [movementType, setMovementType] = useState<'CASH_IN' | 'CASH_OUT'>('CASH_IN')
  const [movementAmount, setMovementAmount] = useState('')
  const [movementReason, setMovementReason] = useState('')
  const [settlementMethod, setSettlementMethod] = useState('CASH')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const workspace = workspaces.find((item) => item.branchId === branchId)
  const basePath = workspace
    ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
      `/branches/${encodeURIComponent(workspace.branchId)}/cash`
    : ''

  async function loadCashState(path = basePath, auth = token) {
    if (!path || !auth) return
    const [current, pending, past] = await Promise.all([
      authedFetch<{ shift: CashShift | null }>(`${path}/shift`, auth, onSessionExpired),
      authedFetch<PendingRefund[]>(`${path}/refunds`, auth, onSessionExpired),
      authedFetch<ClosedShiftSummary[]>(`${path}/shifts`, auth, onSessionExpired),
    ])
    setShift(current.shift)
    setRefunds(pending)
    setHistory(past)
    setMovements(current.shift
      ? await authedFetch<CashMovement[]>(
          `${path}/shifts/${encodeURIComponent(current.shift.id)}/movements`,
          auth,
          onSessionExpired,
        )
      : [])
  }

  useEffect(() => {
    if (!token || !basePath) return
    let cancelled = false
    void (async () => {
      try {
        const [current, pending, past] = await Promise.all([
          authedFetch<{ shift: CashShift | null }>(`${basePath}/shift`, token, onSessionExpired),
          authedFetch<PendingRefund[]>(`${basePath}/refunds`, token, onSessionExpired),
          authedFetch<ClosedShiftSummary[]>(`${basePath}/shifts`, token, onSessionExpired),
        ])
        if (cancelled) return
        const currentMovements = current.shift
          ? await authedFetch<CashMovement[]>(
              `${basePath}/shifts/${encodeURIComponent(current.shift.id)}/movements`,
              token,
              onSessionExpired,
            )
          : []
        if (cancelled) return
        setLoadFailed(false)
        setShift(current.shift)
        setRefunds(pending)
        setHistory(past)
        setMovements(currentMovements)
      } catch {
        if (!cancelled) {
          setError(copy.requestFailed)
          setLoadFailed(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, basePath, copy.requestFailed, onSessionExpired])

  async function openShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!basePath) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await authedFetch<CashShift>(`${basePath}/shifts`, token, onSessionExpired, {
        method: 'POST',
        body: JSON.stringify({ openingCash }),
      })
      await loadCashState()
      setNotice(copy.shiftOpened)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function recordMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!basePath || !shift) return
    setBusy(true)
    setError('')
    try {
      await authedFetch(
        `${basePath}/shifts/${encodeURIComponent(shift.id)}/movements`,
        token,
        onSessionExpired,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': `cash-${crypto.randomUUID()}` },
          body: JSON.stringify({
            type: movementType,
            amount: movementAmount,
            reason: movementReason,
          }),
        },
      )
      setMovementAmount('')
      setMovementReason('')
      await loadCashState()
      setNotice(copy.movementSaved)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function settleRefund(refund: PendingRefund) {
    if (!basePath || !shift || busy) return
    if (!window.confirm(copy.confirmInternalSettlement)) return
    const reference = window.prompt(copy.referencePrompt)?.trim() ?? ''
    setBusy(true)
    setError('')
    try {
      await authedFetch(
        `${basePath}/shifts/${encodeURIComponent(shift.id)}` +
          `/refunds/${encodeURIComponent(refund.id)}/settle`,
        token,
        onSessionExpired,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': `refund-${crypto.randomUUID()}` },
          body: JSON.stringify({
            method: settlementMethod,
            reference: reference || null,
          }),
        },
      )
      await loadCashState()
      setNotice(copy.refundRecorded)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function closeShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!basePath || !shift) return
    setBusy(true)
    setError('')
    try {
      await authedFetch<CashShift>(
        `${basePath}/shifts/${encodeURIComponent(shift.id)}/close`,
        token,
        onSessionExpired,
        { method: 'POST', body: JSON.stringify({ countedCash }) },
      )
      setCountedCash('')
      await loadCashState()
      setNotice(copy.shiftClosed)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page-content cash-page">
      <header className="product-management-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
      </header>

      <label className="branch-picker cash-branch-picker">
        <span>{t.productManagement.chooseBranch}</span>
        <select value={branchId} onChange={(event) => {
          setBranchId(event.target.value)
          setShift(null)
          setRefunds([])
          setMovements([])
          setHistory([])
          setLoading(true)
          setLoadFailed(false)
          setError('')
          setNotice('')
        }}>
          {workspaces.map((item) => (
            <option key={`${item.tenantId}:${item.branchId}`} value={item.branchId}>
              {item.tenantName} — {item.branchName}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="product-error cash-feedback" role="alert">{error}</p>}
      {notice && <p className="product-success cash-feedback" role="status">{notice}</p>}

      {loading ? (
        <section className="cash-panel cash-loading" role="status">
          <span className="cash-loading-dot" />
          <strong>{t.productManagement.loading}</strong>
        </section>
      ) : loadFailed ? (
        <section className="cash-panel cash-loading cash-load-error" role="alert">
          <strong>{copy.requestFailed}</strong>
        </section>
      ) : (
      <>
          {!shift ? (
            <form className="cash-panel cash-open-panel" onSubmit={(event) => void openShift(event)}>
              <div className="cash-panel-heading">
                <span className="cash-panel-icon"><CircleDollarSign size={20} /></span>
                <div>
                  <h2>{copy.openShift}</h2>
                  <p>{t.ui.shiftOpenHint}</p>
                </div>
              </div>
              <label className="cash-field">{copy.openingCash}
                <div className="cash-input-wrap">
                  <input type="number" min="0" step="0.01" required value={openingCash}
                    onChange={(event) => setOpeningCash(event.target.value)} />
                  <small>{copy.cash}</small>
                </div>
              </label>
              <button className="button-primary" disabled={busy}>
                {busy ? t.productManagement.loading : copy.startShift}
              </button>
            </form>
          ) : (
            <>
              <section className="cash-panel cash-current-panel">
                <div className="cash-panel-heading">
                  <span className="cash-panel-icon cash-open-icon"><CheckCircle2 size={20} /></span>
                  <div>
                    <h2>{copy.shiftOpen}</h2>
                  </div>
                  <span className="cash-state-badge">{t.ui.shiftStateOpen}</span>
                </div>
                <div className="cash-summary-grid">
                  <div>
                    <span>{copy.openingCash}</span>
                    <strong>{money(shift.openingCash, language)}</strong>
                  </div>
                  <div className="cash-summary-primary">
                    <span>{copy.expectedCash}</span>
                    <strong>{money(shift.expectedCash ?? '0', language)}</strong>
                  </div>
                  <div>
                    <span>{copy.openedAt}</span>
                    <strong>{new Date(shift.openedAt).toLocaleString(numberLocale(language))}</strong>
                  </div>
                </div>
              </section>

              <div className="cash-work-grid">
                <form className="cash-panel cash-form-panel" onSubmit={(event) => void recordMovement(event)}>
                  <div className="cash-panel-heading">
                    <span className="cash-panel-icon"><ArrowLeftRight size={20} /></span>
                    <div>
                      <h2>{copy.cashMovement}</h2>
                      <p>{copy.movementHistory}</p>
                    </div>
                  </div>
                  <div className="cash-form-fields">
                    <label className="cash-field">{copy.movementType}
                      <select value={movementType}
                        onChange={(event) => setMovementType(event.target.value as 'CASH_IN' | 'CASH_OUT')}>
                        <option value="CASH_IN">{copy.cashIn}</option>
                        <option value="CASH_OUT">{copy.cashOut}</option>
                      </select>
                    </label>
                    <label className="cash-field">{copy.amount}
                      <div className="cash-input-wrap">
                        <input type="number" min="0.01" step="0.01" required value={movementAmount}
                          onChange={(event) => setMovementAmount(event.target.value)} />
                        <small>{copy.cash}</small>
                      </div>
                    </label>
                    <label className="cash-field cash-field-wide">{copy.reason}
                      <input required maxLength={500} value={movementReason}
                        onChange={(event) => setMovementReason(event.target.value)} />
                    </label>
                  </div>
                  <button className="button-primary" disabled={busy}>
                    {busy ? t.productManagement.loading : copy.saveMovement}
                  </button>
                </form>

                <section className="cash-panel cash-movement-panel">
                  <div className="cash-panel-heading">
                    <span className="cash-panel-icon"><List size={20} /></span>
                    <div>
                      <h2>{copy.movementHistory}</h2>
                      <p>{movements.length} · {copy.cashMovement}</p>
                    </div>
                  </div>
                  {movements.length === 0 ? (
                    <p className="cash-empty">{copy.noMovements}</p>
                  ) : (
                    <div className="cash-movement-list">
                      {[...movements]
                        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
                        .map((movement) => (
                        <article key={movement.id} className={movement.type === 'CASH_IN' ? 'cash-in' : 'cash-out'}>
                          <span className="cash-movement-sign" aria-hidden="true">
                            {movement.type === 'CASH_IN' ? '+' : '−'}
                          </span>
                          <div>
                            <strong>{movement.type === 'CASH_IN' ? copy.cashIn : copy.cashOut}</strong>
                            <small>{movement.reason}</small>
                            <time dateTime={movement.createdAt}>
                              {new Date(movement.createdAt).toLocaleString(numberLocale(language))}
                            </time>
                          </div>
                          <strong className="cash-movement-amount">
                            {movement.type === 'CASH_OUT' ? '−' : '+'}{money(movement.amount, language)}
                          </strong>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <form className="cash-panel cash-close-panel" onSubmit={(event) => void closeShift(event)}>
                <div className="cash-panel-heading">
                  <span className="cash-panel-icon cash-close-icon"><LockKeyhole size={20} /></span>
                  <div>
                    <h2>{copy.closeShift}</h2>
                    <p>{t.ui.shiftCloseHint}</p>
                  </div>
                </div>
                <div className="cash-close-fields">
                  <label className="cash-field">{copy.countedCash}
                    <div className="cash-input-wrap">
                      <input type="number" min="0" step="0.01" required value={countedCash}
                        onChange={(event) => setCountedCash(event.target.value)} />
                      <small>{copy.cash}</small>
                    </div>
                  </label>
                  <button className="button-secondary" disabled={busy}>
                    {busy ? t.productManagement.loading : copy.closeShift}
                  </button>
                </div>
              </form>
            </>
          )}

          <section className="cash-panel cash-history-panel">
            <div className="cash-panel-heading">
              <span className="cash-panel-icon"><History size={20} /></span>
              <div>
                <h2>{copy.shiftHistory}</h2>
                <p>{history.length}</p>
              </div>
            </div>
            {history.length === 0 ? <p>{copy.noShiftHistory}</p> : (
              <div className="cash-refund-list cash-shift-list">
                {history.map((entry) => (
                  <article key={entry.id}>
                    <div>
                      <strong>{copy.closedShort} · {new Date(entry.closedAt ?? entry.openedAt).toLocaleString(numberLocale(language))}</strong>
                      <span>{copy.openingCash}: {money(entry.openingCash, language)}</span>
                    </div>
                    <div className="cash-history-figures">
                      <span>{copy.expectedCash}: {money(entry.expectedCash ?? '0', language)}</span>
                      <span>{copy.countedCash}: {money(entry.countedCash ?? '0', language)}</span>
                      <strong>{copy.discrepancy}: {money(entry.discrepancy ?? '0', language)}</strong>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="cash-panel cash-refunds-panel">
            <div className="cash-panel-heading">
              <span className="cash-panel-icon cash-refund-icon"><ReceiptText size={20} /></span>
              <div>
                <h2>{copy.pendingRefunds}</h2>
                <p>{refunds.length} {copy.pendingRefunds}</p>
              </div>
            </div>
            <p className="cash-refund-note">{copy.settlementNotice}</p>
            <label className="cash-field cash-settlement-method">{copy.settlementMethod}
              <select value={settlementMethod} onChange={(event) => setSettlementMethod(event.target.value)}>
                <option value="CASH">{copy.cash}</option>
                <option value="CARD">{copy.card}</option>
                <option value="BANK_TRANSFER">{copy.bankTransfer}</option>
                <option value="OTHER">{copy.other}</option>
              </select>
            </label>
            {refunds.length === 0 ? <p>{copy.noPendingRefunds}</p> : (
              <div className="cash-refund-list">
                {refunds.map((refund) => (
                  <article key={refund.id}>
                    <div>
                      <strong>{refund.invoiceNumber}</strong>
                      <span>{refund.reason}</span>
                      <time dateTime={refund.createdAt}>
                        {new Date(refund.createdAt).toLocaleString(numberLocale(language))}
                      </time>
                    </div>
                    <strong>{money(refund.refundAmount, language)}</strong>
                    <button type="button" className="button-secondary"
                      disabled={busy || !shift || shift.status !== 'OPEN'}
                      onClick={() => void settleRefund(refund)}>
                      {copy.recordSettlement}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
      </>
      )}
    </section>
  )
}
