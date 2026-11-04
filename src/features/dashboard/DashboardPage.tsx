import { useEffect, useState } from 'react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language, PageSession } from '../../types'
import { authedFetch, usePageSession } from '../../app/usePageSession'

interface DashboardSummary {
  revenue: string
  orderCount: number
  averageOrderValue: string
  activeCustomers: number
  netProfit: string
  cogs: string
  expenses: string
  refundsSettledCash: string
  lowStockCount: number
}

interface DashboardPageProps extends PageSession {
  t: AppTranslations
  language: Language
  search: string
  onNewSale: () => void
}

function money(value: string, language: Language): string {
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(Number(value))
}

export default function DashboardPage({
  t,
  language,
  onNewSale,
  sessionToken,
  workspaces,
  onSessionExpired,
}: DashboardPageProps) {
  const copy = t.reports
  const session = usePageSession({
    sessionToken,
    workspaces,
    onSessionExpired,
  })
  const [selectedBranchId, setSelectedBranchId] = useState(session.branchId)
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [error, setError] = useState('')

  const branchId = selectedBranchId

  const workspace = workspaces.find((item) => item.branchId === branchId)
  const basePath = workspace
    ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
    `/branches/${encodeURIComponent(workspace.branchId)}/reports`
    : ''

  useEffect(() => {
    if (!session.token || !basePath) return
    let cancelled = false
    const requestFailed = copy.requestFailed
    async function run() {
      try {
        const data = await authedFetch<DashboardSummary>(
          `${basePath}/dashboard`,
          session.token,
          onSessionExpired,
        )
        if (!cancelled) setSummary(data)
      } catch {
        if (!cancelled) setError(requestFailed)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [session.token, basePath, copy.requestFailed, onSessionExpired])

  const numberFormatter = new Intl.NumberFormat(numberLocale(language))

  const stats: Array<{ id: string; title: string; value: string }> = summary
    ? [
      { id: 'revenue', title: t.dashboard.totalSales, value: money(summary.revenue, language) },
      { id: 'orders', title: t.dashboard.totalOrders, value: numberFormatter.format(summary.orderCount) },
      { id: 'profit', title: t.dashboard.netProfit, value: money(summary.netProfit, language) },
      { id: 'customers', title: t.dashboard.customers, value: numberFormatter.format(summary.activeCustomers) },
    ]
    : []

  return (
    <div className="page-content">
      <section className="welcome-row">
        <div>
          <div className="eyebrow">
            <span className="live-dot" />
            {t.dashboard.overview}
          </div>
          <h1>
            {t.dashboard.greeting}
            <span className="wave">✳</span>
          </h1>
          <p>{t.dashboard.subtitle}</p>
        </div>
        <div className="welcome-actions">
          <button type="button" className="button-secondary" onClick={onSessionExpired}>
            {t.productManagement.logout}
          </button>
          <button type="button" className="button-primary" onClick={onNewSale}>
            {t.common.newSale}
          </button>
        </div>
      </section>

      <label className="branch-picker">
        {t.productManagement.chooseBranch}
        <select value={branchId} onChange={(event) => {
          setSelectedBranchId(event.target.value)
          setSummary(null)
        }}>
          {workspaces.map((item) => (
            <option key={`${item.tenantId}:${item.branchId}`} value={item.branchId}>
              {item.tenantName} — {item.branchName}
            </option>
          ))}
        </select>
      </label>

      {summary ? (
        <>
          <section className="stats-grid" aria-label={t.dashboard.overview}>
            {stats.map((stat) => (
              <article className="stat-card" key={stat.id}>
                <p>{stat.title}</p>
                <div className="stat-value">{stat.value}</div>
                {stat.id === 'profit' && (
                  <div className="stat-footer">
                    <span>
                      {copy.expenses}: {money(summary.expenses, language)} · {copy.cogs}: {money(summary.cogs, language)}
                    </span>
                  </div>
                )}
                {stat.id === 'customers' && summary.lowStockCount > 0 && (
                  <div className="stat-footer">
                    <span>{copy.lowStock}: {numberFormatter.format(summary.lowStockCount)}</span>
                  </div>
                )}
              </article>
            ))}
          </section>
          <p className="cash-panel">
            {copy.averageOrder}: <strong>{money(summary.averageOrderValue, language)}</strong>
          </p>
        </>
      ) : (
        <p>{t.productManagement.loading}</p>
      )}

      {error && <p className="product-error" role="alert">{error}</p>}
    </div>
  )
}
