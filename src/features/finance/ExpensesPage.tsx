import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language, PageSession } from '../../types'
import { authedFetch, usePageSession } from '../../app/usePageSession'

interface ExpenseRow {
  id: string
  category: string
  description: string
  amount: string
  method: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'OTHER'
  expenseDate: string
  status: 'ACTIVE' | 'VOIDED'
}

interface ExpensesPageProps extends PageSession {
  t: AppTranslations
  language: Language
}

const METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const

type Method = typeof METHODS[number]

function money(value: string, language: Language): string {
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(Number(value))
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function ExpensesPage({
  t,
  language,
  sessionToken,
  workspaces,
  onSessionExpired,
}: ExpensesPageProps) {
  const copy = t.expenses
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const token = session.token
  const [branchId, setBranchId] = useState(session.branchId)
  const [expenses, setExpenses] = useState<ExpenseRow[]>([])
  const [category, setCategory] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<Method>('CASH')
  const [expenseDate, setExpenseDate] = useState(today())
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<'view' | 'add' | 'edit' | 'delete'>('view')

  const workspace = workspaces.find((item) => item.branchId === branchId)
  const basePath = workspace
    ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
      `/branches/${encodeURIComponent(workspace.branchId)}/expenses`
    : ''

  async function loadExpenses(path = basePath, auth = token) {
    if (!path || !auth) return
    const params = new URLSearchParams()
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    const query = params.toString()
    const rows = await authedFetch<ExpenseRow[]>(
      query ? `${path}?${query}` : path, auth, onSessionExpired,
    )
    setExpenses(rows)
  }

  useEffect(() => {
    if (!token || !basePath) return
    let cancelled = false
    const params = new URLSearchParams()
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    const query = params.toString()
    authedFetch<ExpenseRow[]>(query ? `${basePath}?${query}` : basePath, token, onSessionExpired)
      .then((rows) => {
        if (!cancelled) setExpenses(rows)
      })
      .catch(() => {
        if (!cancelled) setError(copy.requestFailed)
      })
    return () => {
      cancelled = true
    }
  }, [token, basePath, from, to, copy.requestFailed, onSessionExpired])

  async function createExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!basePath) return
    setBusy(true)
    setError('')
    try {
      await authedFetch(basePath, token, onSessionExpired, {
        method: 'POST',
        headers: { 'Idempotency-Key': `expense-${crypto.randomUUID()}` },
        body: JSON.stringify({
          category: category.trim(),
          description: description.trim(),
          amount,
          method,
          expenseDate,
        }),
      })
      setAmount('')
      setDescription('')
      await loadExpenses()
      setNotice(copy.expenseSaved)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function voidExpense(expense: ExpenseRow) {
    if (!basePath || busy) return
    if (!window.confirm(copy.confirmVoid)) return
    setBusy(true)
    setError('')
    try {
      await authedFetch(`${basePath}/${encodeURIComponent(expense.id)}`, token, onSessionExpired, {
        method: 'DELETE',
      })
      await loadExpenses()
      setNotice(copy.expenseVoided)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    onSessionExpired()
  }

  const total = expenses
    .filter((expense) => expense.status === 'ACTIVE')
    .reduce((sum, expense) => sum + Number(expense.amount), 0)

  return (
    <section className="page-content expenses-page">
      <header className="product-management-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        {token && (
          <button type="button" className="button-secondary" onClick={logout}>
            {t.productManagement.logout}
          </button>
        )}
      </header>

      <>
        <nav className="page-tabs" aria-label={t.ui.expensesTabsLabel}>
          <button type="button"
            className={`page-tab ${tab === 'view' ? 'page-tab-active' : ''}`}
            onClick={() => setTab('view')}>{t.ui.tabsView}</button>
          <button type="button"
            className={`page-tab ${tab === 'add' ? 'page-tab-active' : ''}`}
            onClick={() => setTab('add')}>{t.ui.tabsAdd}</button>
          <button type="button"
            className={`page-tab ${tab === 'edit' ? 'page-tab-active' : ''}`}
            onClick={() => setTab('edit')}>{t.ui.tabsEdit}</button>
          <button type="button"
            className={`page-tab ${tab === 'delete' ? 'page-tab-active' : ''}`}
            onClick={() => setTab('delete')}>{t.ui.tabsDelete}</button>
        </nav>

          <label className="branch-picker">
            {t.productManagement.chooseBranch}
            <select value={branchId} onChange={(event) => {
              setBranchId(event.target.value)
              setExpenses([])
              setNotice('')
            }}>
              {workspaces.map((item) => (
                <option key={`${item.tenantId}:${item.branchId}`} value={item.branchId}>
                  {item.tenantName} — {item.branchName}
                </option>
              ))}
            </select>
          </label>

          {tab === 'add' && (<form className="cash-panel cash-inline-form" onSubmit={(event) => void createExpense(event)}>
            <h2>{copy.recordExpense}</h2>
            <label>{copy.category}
              <input required maxLength={100} value={category}
                onChange={(event) => setCategory(event.target.value)} />
            </label>
            <label>{copy.description}
              <input required maxLength={500} value={description}
                onChange={(event) => setDescription(event.target.value)} />
            </label>
            <label>{copy.amount}
              <input type="number" min="0.01" step="0.01" required value={amount}
                onChange={(event) => setAmount(event.target.value)} />
            </label>
            <label>{copy.method}
              <select value={method} onChange={(event) => setMethod(event.target.value as Method)}>
                {METHODS.map((option) => (
                  <option key={option} value={option}>
                    {option === 'CASH' ? copy.cash : option === 'CARD' ? copy.card : option === 'BANK_TRANSFER' ? copy.bankTransfer : copy.other}
                  </option>
                ))}
              </select>
            </label>
            <label>{copy.date}
              <input type="date" max={today()} required value={expenseDate}
                onChange={(event) => setExpenseDate(event.target.value)} />
            </label>
            <button className="button-primary" disabled={busy}>{copy.save}</button>
          </form>)}

          {(tab === 'view' || tab === 'delete') && (
            <section className="cash-panel">
              <h2>{tab === 'delete' ? t.ui.expensesDeleteHeading : t.ui.expensesViewHeading}</h2>
              {tab === 'view' && (
                <div className="cash-inline-form expense-filters">
                  <label>{copy.from}
                    <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
                  </label>
                  <label>{copy.to}
                    <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
                  </label>
                  <button type="button" className="button-secondary" onClick={() => window.print()}>
                    {t.ui.expensesPrint}
                  </button>
                </div>
              )}
              {tab === 'delete' && (
                <p className="muted-note">{t.ui.expensesVoidHint}</p>
              )}
              <p>{copy.total}: <strong>{money(total.toFixed(2), language)}</strong></p>
              {expenses.length === 0 ? <p>{copy.noExpenses}</p> : (
                <div className="cash-refund-list">
                  {expenses.map((expense) => (
                    <article key={expense.id} data-voided={expense.status === 'VOIDED' || undefined}>
                      <div>
                        <strong>{expense.category}</strong>
                        <span>{expense.description} · {expense.expenseDate}</span>
                      </div>
                      <div className="cash-history-figures">
                        <strong>{money(expense.amount, language)}</strong>
                        <span>
                          {expense.method === 'CASH' ? copy.cash : expense.method === 'CARD' ? copy.card : expense.method === 'BANK_TRANSFER' ? copy.bankTransfer : copy.other}
                          {expense.status === 'VOIDED' ? ` · ${copy.voided}` : ''}
                        </span>
                      </div>
                      {tab === 'delete' && expense.status === 'ACTIVE' && (
                        <button type="button" className="button-secondary"
                          disabled={busy}
                          onClick={() => void voidExpense(expense)}>
                          {copy.void}
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
      </>

      {error && <p className="product-error" role="alert">{error}</p>}
      {notice && <p className="product-success" role="status">{notice}</p>}
    </section>
  )
}
