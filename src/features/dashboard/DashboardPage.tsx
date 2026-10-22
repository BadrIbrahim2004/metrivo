import {
  BarChart3,
  Plus,
} from 'lucide-react'

import type { AppTranslations } from '../../i18n'
import type { Language } from '../../types'

import StatsGrid from './components/StatsGrid'
import SalesChart from './components/SalesChart'
import InventoryAlerts from './components/InventoryAlerts'
import TransactionsTable from './components/TransactionsTable'

interface DashboardPageProps {
  t: AppTranslations
  language: Language
  search: string
  onNewSale: () => void
}

export default function DashboardPage({
  t,
  language,
  search,
  onNewSale,
}: DashboardPageProps) {
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
          <button
            type="button"
            className="button-secondary"
            onClick={() =>
              window.alert(t.common.exportComingSoon)
            }
          >
            <BarChart3 size={17} />
            {t.common.export}
          </button>

          <button
            type="button"
            className="button-primary"
            onClick={onNewSale}
          >
            <Plus size={18} />
            {t.common.newSale}
          </button>
        </div>
      </section>

      <StatsGrid t={t} language={language} />

      <div className="middle-grid">
        <SalesChart t={t} language={language} />

        <InventoryAlerts t={t} language={language} />
      </div>

      <TransactionsTable
        t={t}
        language={language}
        search={search}
      />
    </div>
  )
}