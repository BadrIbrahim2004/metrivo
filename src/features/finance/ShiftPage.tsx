import { useEffect, useState } from 'react'
import { CheckCircle2, CircleDollarSign, Clock3 } from 'lucide-react'
import type { FormEvent } from 'react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language, PageSession } from '../../types'
import { authedFetch, authedPost, usePageSession } from '../../app/usePageSession'
import './shift.css'

interface CashShift {
  id: string
  status: 'OPEN' | 'CLOSED'
  openingCash: string
  expectedCash?: string | null
  countedCash?: string | null
  discrepancy?: string | null
}

interface ShiftPageProps extends PageSession {
  t: AppTranslations
  language: Language
  onExit: () => void
}

function money(value: string | null | undefined, language: Language): string {
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(Number(value ?? '0'))
}

export default function ShiftPage({
  t,
  language,
  sessionToken,
  workspaces,
  onSessionExpired,
  onExit,
}: ShiftPageProps) {
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const token = session.token
  const [branchId, setBranchId] = useState(session.branchId)
  const workspace = workspaces.find((item) => item.branchId === branchId)
  const base = workspace
    ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
    `/branches/${encodeURIComponent(workspace.branchId)}/cash`
    : ''
  const copy = t.cashManagement

  const [shift, setShift] = useState<CashShift | null>(null)
  const [openingCash, setOpeningCash] = useState('0.00')
  const [countedCash, setCountedCash] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!base || !token) return
    let cancelled = false
    authedFetch<{ shift: CashShift | null }>(`${base}/shift`, token, onSessionExpired)
      .then((data) => {
        if (!cancelled) {
          setShift(data.shift)
          setLoadFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(t.ui.shiftFetchFailed)
          setLoadFailed(true)
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [base, token, onSessionExpired, t.ui.shiftFetchFailed])

  async function openShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!base) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const data = await authedPost<CashShift>(`${base}/shifts`, token, onSessionExpired, {
        body: JSON.stringify({ openingCash }),
      })
      setShift(data)
      setNotice(t.ui.shiftOpenedNotice)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function closeShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!base || !shift) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const closedShift = await authedPost<CashShift>(
        `${base}/shifts/${encodeURIComponent(shift.id)}/close`,
        token, onSessionExpired,
        { body: JSON.stringify({ countedCash }) },
      )
      setShift(closedShift)
      setCountedCash('')
      setNotice(t.ui.shiftClosedNotice)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  const isOpen = shift?.status === 'OPEN'

  return (
    <section className="shift-screen">
      <header className="shift-head">
        <button type="button" className="module-back" onClick={onExit}>{t.ui.backHomeShort}</button>
        <strong>{t.ui.shiftTitle}</strong>
        <button type="button" className="module-logout" onClick={onSessionExpired}>
          {t.productManagement.logout}
        </button>
      </header>

      <div className="shift-body">
        {workspaces.length > 1 && (
          <label className="shift-branch-picker">
            <span>{t.productManagement.chooseBranch}</span>
            <select
              value={branchId}
              onChange={(event) => {
                setBranchId(event.target.value)
                setShift(null)
                setLoading(true)
                setLoadFailed(false)
                setError('')
                setNotice('')
              }}
            >
              {workspaces.map((item) => (
                <option key={`${item.tenantId}:${item.branchId}`} value={item.branchId}>
                  {item.tenantName} — {item.branchName}
                </option>
              ))}
            </select>
          </label>
        )}

        {loading ? (
          <section className="shift-card shift-loading" role="status">
            <span className="shift-status-icon"><Clock3 size={22} /></span>
            <strong>{t.productManagement.loading}</strong>
          </section>
        ) : loadFailed ? (
          <section className="shift-card shift-loading" role="alert">
            <strong>{t.ui.shiftFetchFailed}</strong>
          </section>
        ) : (
          <>
            <section className={`shift-card shift-status-card ${isOpen ? 'shift-open' : 'shift-closed'}`}>
              <div className="shift-status-heading">
                <span className="shift-status-icon">
                  {isOpen ? <CheckCircle2 size={22} /> : <CircleDollarSign size={22} />}
                </span>
                <div>
                  <p className="shift-state-label">
                    {isOpen ? t.ui.shiftStateOpen : t.ui.shiftStateClosed}
                  </p>
                  {!isOpen && <p className="shift-hint">{t.ui.shiftHintClosed}</p>}
                </div>
              </div>
              {shift && (
                <div className="shift-figures">
                  <div>
                    <span>{t.ui.shiftOpening}</span>
                    <strong>{money(shift.openingCash, language)}</strong>
                  </div>
                  {isOpen ? (
                    <div className="shift-figure-primary">
                      <span>{t.ui.shiftExpected}</span>
                      <strong>{money(shift.expectedCash, language)}</strong>
                    </div>
                  ) : (
                    <>
                      <div>
                        <span>{t.ui.shiftCounted}</span>
                        <strong>{money(shift.countedCash, language)}</strong>
                      </div>
                      <div>
                        <span>{t.ui.shiftDiscrepancy}</span>
                        <strong>{money(shift.discrepancy, language)}</strong>
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>

            {isOpen ? (
              <form className="shift-card shift-action-card" onSubmit={(event) => void closeShift(event)}>
                <div className="shift-action-heading">
                  <h2>{t.ui.shiftCloseTitle}</h2>
                  <p className="shift-action-hint">{t.ui.shiftCloseHint}</p>
                </div>
                <label>
                  <span>{t.ui.shiftCountedLabel}</span>
                  <div className="shift-input-wrap">
                    <input
                      type="number" min="0" step="0.01" required
                      value={countedCash}
                      onChange={(event) => setCountedCash(event.target.value)}
                    />
                    <small>{t.cashManagement.cash}</small>
                  </div>
                </label>
                <button type="submit" className="shift-confirm" disabled={busy || !countedCash}>
                  {busy ? t.productManagement.loading : t.ui.shiftCloseBtn}
                </button>
              </form>
            ) : (
              <form className="shift-card shift-action-card" onSubmit={(event) => void openShift(event)}>
                <div className="shift-action-heading">
                  <h2>{t.ui.shiftOpenTitle}</h2>
                  <p className="shift-action-hint">{t.ui.shiftOpenHint}</p>
                </div>
                <label>
                  <span>{t.ui.shiftOpeningLabel}</span>
                  <div className="shift-input-wrap">
                    <input
                      type="number" min="0" step="0.01" required
                      value={openingCash}
                      onChange={(event) => setOpeningCash(event.target.value)}
                    />
                    <small>{t.cashManagement.cash}</small>
                  </div>
                </label>
                <button type="submit" className="shift-confirm" disabled={busy}>
                  {busy ? t.productManagement.loading : t.ui.shiftOpenBtn}
                </button>
              </form>
            )}
          </>
        )}

        {error && <p className="product-error" role="alert">{error}</p>}
        {notice && <p className="product-success" role="status">{notice}</p>}
      </div>
    </section>
  )
}
