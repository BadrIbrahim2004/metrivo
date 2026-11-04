import {
  ArrowUpLeft,
  ShoppingCart,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'

import type { AppTranslations } from '../../../i18n'
import { numberLocale } from '../../../i18n/numbers'

interface StatsGridProps {
  t: AppTranslations
  language: 'ar' | 'en'
}

export default function StatsGrid({
  t,
  language,
}: StatsGridProps) {
  const currency = t.common.currency

  const stats = [
    {
      id: 'revenue',
      title: t.dashboard.totalSales,
      value: 48250,
      change: '12.8%',
      icon: Wallet,
      iconClass: 'revenue-icon',
    },
    {
      id: 'orders',
      title: t.dashboard.totalOrders,
      value: 186,
      change: '8.2%',
      icon: ShoppingCart,
      iconClass: 'orders-icon',
    },
    {
      id: 'profit',
      title: t.dashboard.netProfit,
      value: 12480,
      change: '6.4%',
      icon: TrendingUp,
      iconClass: 'profit-icon',
    },
    {
      id: 'customers',
      title: t.dashboard.customers,
      value: 324,
      change: '4.7%',
      icon: Users,
      iconClass: 'customers-icon',
    },
  ]

  const numberFormatter = new Intl.NumberFormat(
    numberLocale(language),
  )

  return (
    <section className="stats-grid" aria-label={t.dashboard.overview}>
      {stats.map((stat) => {
        const Icon = stat.icon

        return (
          <article className="stat-card" key={stat.id}>
            <div className="stat-top">
              <span className={`stat-icon ${stat.iconClass}`}>
                <Icon size={20} />
              </span>

              <span className="trend positive">
                <TrendingUp size={14} />
                {stat.change}
              </span>
            </div>

            <p>{stat.title}</p>

            <div className="stat-value">
              {numberFormatter.format(stat.value)}

              {stat.id === 'revenue' || stat.id === 'profit' ? (
                <small>{` ${currency}`}</small>
              ) : null}
            </div>

            <div className="stat-footer">
              <span>{t.common.versusPrevious}</span>
              <ArrowUpLeft size={14} />
            </div>
          </article>
        )
      })}
    </section>
  )
}