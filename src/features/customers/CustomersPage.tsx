import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language, PageSession } from '../../types'
import { authedFetch, usePageSession } from '../../app/usePageSession'

interface CustomerRow {
  id: string
  name: string
  phone: string | null
  isActive: boolean
}

interface CustomerHistoryRow {
  id: string
  invoiceNumber: string
  total: string
  paymentMethod: string
  createdAt: string
  returned: boolean
}

interface CustomersPageProps extends PageSession {
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

export default function CustomersPage({
  t,
  language,
  sessionToken,
  workspaces,
  onSessionExpired,
}: CustomersPageProps) {
  const copy = t.customers
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const token = session.token
  const [selectedBranchId, setSelectedBranchId] = useState(session.branchId)
  const [customers, setCustomers] = useState<CustomerRow[]>([])
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [history, setHistory] = useState<{ customer: CustomerRow; sales: CustomerHistoryRow[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const workspace = workspaces.find((item) => item.branchId === selectedBranchId)
  const basePath = workspace
    ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
      `/branches/${encodeURIComponent(workspace.branchId)}/customers`
    : ''

  async function loadCustomers(path = basePath, auth = token, term = search) {
    if (!path || !auth) return
    const query = term.trim() ? `?search=${encodeURIComponent(term.trim())}` : ''
    const rows = await authedFetch<CustomerRow[]>(`${path}${query}`, auth, onSessionExpired)
    setCustomers(rows)
  }

  useEffect(() => {
    if (!token || !basePath) return
    let cancelled = false
    const requestFailed = copy.requestFailed
    async function run() {
      try {
        const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''
        const rows = await authedFetch<CustomerRow[]>(`${basePath}${query}`, token, onSessionExpired)
        if (!cancelled) setCustomers(rows)
      } catch {
        if (!cancelled) setError(requestFailed)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [token, basePath, search, copy.requestFailed, onSessionExpired])

  async function createCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!basePath || busy) return
    setBusy(true)
    setError('')
    try {
      await authedFetch(basePath, token, onSessionExpired, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() || null }),
      })
      setName('')
      setPhone('')
      await loadCustomers()
      setNotice(copy.customerSaved)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function viewHistory(customer: CustomerRow) {
    if (!basePath || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await authedFetch<{ customer: CustomerRow; sales: CustomerHistoryRow[] }>(
        `${basePath}/${encodeURIComponent(customer.id)}/history`, token, onSessionExpired,
      )
      setHistory(result)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function archiveCustomer(customer: CustomerRow) {
    if (!basePath || busy) return
    if (!window.confirm(copy.confirmArchive)) return
    setBusy(true)
    setError('')
    try {
      await authedFetch(`${basePath}/${encodeURIComponent(customer.id)}`, token, onSessionExpired, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: false }),
      })
      await loadCustomers()
      setNotice(copy.customerArchived)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    onSessionExpired()
  }

  return (
    <section className="page-content customers-page">
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
          <label className="branch-picker">
            {t.productManagement.chooseBranch}
            <select value={selectedBranchId} onChange={(event) => {
              setCustomers([])
              setHistory(null)
              setNotice('')
              setSelectedBranchId(event.target.value)
            }}>
              {workspaces.map((item) => (
                <option key={`${item.tenantId}:${item.branchId}`} value={item.branchId}>
                  {item.tenantName} â€” {item.branchName}
                </option>
              ))}
            </select>
          </label>

          <form className="cash-panel cash-inline-form" onSubmit={(event) => void createCustomer(event)}>
            <h2>{copy.addCustomer}</h2>
            <label>{copy.name}
              <input required maxLength={200} value={name}
                onChange={(event) => setName(event.target.value)} />
            </label>
            <label>{copy.phone}
              <input type="tel" maxLength={40} value={phone}
                onChange={(event) => setPhone(event.target.value)} />
            </label>
            <button className="button-primary" disabled={busy}>{copy.save}</button>
          </form>

          <section className="cash-panel">
            <h2>{copy.customerList}</h2>
            <label className="cash-inline-form">
              {copy.search}
              <input maxLength={200} value={search}
                onChange={(event) => setSearch(event.target.value)} />
            </label>
            {customers.length === 0 ? <p>{copy.noCustomers}</p> : (
              <div className="cash-refund-list">
                {customers.map((customer) => (
                  <article key={customer.id} data-voided={!customer.isActive || undefined}>
                    <div>
                      <strong>{customer.name}</strong>
                      <span>{customer.phone ?? 'â€”'}</span>
                    </div>
                    <div className="cash-history-actions">
                      <button type="button" className="button-secondary" disabled={busy}
                        onClick={() => void viewHistory(customer)}>
                        {copy.viewHistory}
                      </button>
                      {customer.isActive && (
                        <button type="button" className="button-secondary" disabled={busy}
                          onClick={() => void archiveCustomer(customer)}>
                          {copy.archive}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {history && (
            <section className="cash-panel">
              <h2>
                {copy.historyFor} {history.customer.name}
                <button type="button" className="button-secondary"
                  onClick={() => setHistory(null)}>
                  {copy.close}
                </button>
              </h2>
              {history.sales.length === 0 ? <p>{copy.noHistory}</p> : (
                <div className="cash-refund-list">
                  {history.sales.map((sale) => (
                    <article key={sale.id}>
                      <div>
                        <strong>{sale.invoiceNumber}</strong>
                        <span>{new Date(sale.createdAt).toLocaleString(numberLocale(language))}</span>
                      </div>
                      <div className="cash-history-figures">
                        <strong>{money(sale.total, language)}</strong>
                        <span>
                          {sale.paymentMethod === 'CASH' ? copy.cash : copy.nonCash}
                          {sale.returned ? ` Â· ${copy.returned}` : ''}
                        </span>
                      </div>
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
