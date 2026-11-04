import { Search } from 'lucide-react'

import type { AppTranslations } from '../../../i18n'
import { numberLocale } from '../../../i18n/numbers'
import { transactions } from '../../../data/demoData'
import type {
  Language,
  Transaction,
} from '../../../types'

interface TransactionsTableProps {
  t: AppTranslations
  language: Language
  search: string
}

export default function TransactionsTable({
  t,
  language,
  search,
}: TransactionsTableProps) {
  const formatter = new Intl.NumberFormat(
    numberLocale(language),
  )

  const statusLabels = {
    completed: t.dashboard.completed,
    pending: t.dashboard.pending,
    cancelled: t.dashboard.cancelled,
  }

  const visibleTransactions = transactions.filter(
    (transaction: Transaction) => {
      const searchableText = [
        transaction.id,
        transaction.customer,
        String(transaction.amount),
      ]
        .join(' ')
        .toLowerCase()

      return searchableText.includes(search.trim().toLowerCase())
    },
  )

  return (
    <section className="panel transactions-panel">
      <div className="panel-heading">
        <div>
          <h2>{t.dashboard.recentTransactions}</h2>
          <p>{t.dashboard.transactionsDescription}</p>
        </div>

        <label className="table-search">
          <Search size={16} />

          <input
            type="search"
            value={search}
            readOnly
            placeholder={t.common.search}
            aria-label={t.common.search}
          />
        </label>
      </div>

      <div className="table-container">
        <table className="transactions-table">
          <thead>
            <tr>
              <th>{t.dashboard.transactionId}</th>
              <th>{t.dashboard.customer}</th>
              <th>{t.dashboard.date}</th>
              <th>{t.dashboard.amount}</th>
              <th>{t.dashboard.status}</th>
            </tr>
          </thead>

          <tbody>
            {visibleTransactions.map((transaction) => (
              <tr key={transaction.id}>
                <td>
                  <span className="transaction-id">
                    {transaction.id}
                  </span>
                </td>

                <td>
                  <div className="customer-cell">
                    <span
                      className={`customer-avatar avatar-${transaction.color}`}
                    >
                      {transaction.initials}
                    </span>

                    <strong>{transaction.customer}</strong>
                  </div>
                </td>

                <td>{transaction.date}</td>

                <td className="transaction-amount">
                  {formatter.format(transaction.amount)}{' '}
                  {t.common.currency}
                </td>

                <td>
                  <span
                    className={`status-badge status-${transaction.status}`}
                  >
                    {statusLabels[transaction.status]}
                  </span>
                </td>
              </tr>
            ))}

            {visibleTransactions.length === 0 && (
              <tr>
                <td colSpan={5} className="table-empty">
                  {t.common.noResults}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}