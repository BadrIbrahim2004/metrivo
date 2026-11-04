import { useMemo } from 'react'
import { CalendarDays, TrendingUp } from 'lucide-react'
import { chartData } from '../../../data/demoData'
import type { AppTranslations } from '../../../i18n'
import { numberLocale } from '../../../i18n/numbers'
import type { Language } from '../../../types'

type WeekdayKey =
  | 'saturday'
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'

type ChartPoint = {
  day: WeekdayKey
  value: number
}

interface SalesChartProps {
  t: AppTranslations
  language: Language
}

export default function SalesChart({
  t,
  language,
}: SalesChartProps) {
  const points = chartData as readonly ChartPoint[]

  const maxValue = useMemo(
    () => Math.max(...points.map((point) => point.value), 1),
    [points],
  )

  const total = points.reduce((sum, point) => sum + point.value, 0)

  return (
    <section className="panel sales-chart-panel">
      <div className="panel-heading">
        <div>
          <h2>{t.dashboard.salesChart}</h2>
          <p>{t.dashboard.salesChartDescription}</p>
        </div>

        <div className="chart-heading-icon">
          <CalendarDays size={19} />
        </div>
      </div>

      <div className="sales-chart-summary">
        <div>
          <strong>{total.toLocaleString(numberLocale(language))}</strong>
          <span>{t.dashboard.totalSales}</span>
        </div>

        <div className="chart-summary-trend">
          <TrendingUp size={15} />
          <span>{t.common.last7Days}</span>
        </div>
      </div>

      <div
        className="sales-chart"
        role="img"
        aria-label={t.dashboard.salesChart}
      >
        <div className="chart-grid" aria-hidden="true">
          {[100, 75, 50, 25, 0].map((percentage) => (
            <div className="chart-grid-row" key={percentage}>
              <span>
                {Math.round((maxValue * percentage) / 100)}
              </span>
              <div className="chart-grid-line" />
            </div>
          ))}
        </div>

        <div className="chart-bars">
          {points.map((point) => {
            const height = (point.value / maxValue) * 100

            return (
              <div className="chart-bar-column" key={point.day}>
                <div className="chart-bar-track">
                  <div
                    className="chart-bar"
                    style={{ height: `${height}%` }}
                    title={`${t.weekdays[point.day]}: ${point.value}`}
                  />
                </div>

                <span className="chart-day">
                  {t.weekdays[point.day]}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
