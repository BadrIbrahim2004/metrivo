import { AlertTriangle, Package } from 'lucide-react'

import type { AppTranslations } from '../../../i18n'
import { products } from '../../../data/demoData'
import type { Language } from '../../../types'

interface InventoryAlertsProps {
  t: AppTranslations
  language: Language
}

export default function InventoryAlerts({
  t,
  language,
}: InventoryAlertsProps) {
  const lowStockProducts = products.filter(
    (product) => product.stock <= 10,
  )

  const formatter = new Intl.NumberFormat(
    language === 'ar' ? 'ar-EG' : 'en-US',
  )

  return (
    <section className="panel inventory-panel">
      <div className="panel-heading">
        <div>
          <h2>{t.dashboard.inventoryAlerts}</h2>
          <p>{t.dashboard.inventoryDescription}</p>
        </div>

        <span className="inventory-heading-icon">
          <AlertTriangle size={18} />
        </span>
      </div>

      {lowStockProducts.length === 0 ? (
        <div className="empty-state">
          <Package size={25} />
          <p>{t.dashboard.noAlerts}</p>
        </div>
      ) : (
        <div className="inventory-list">
          {lowStockProducts.map((product) => (
            <article
              className="inventory-item"
              key={product.id}
            >
              <div className="inventory-product-icon">
                <Package size={19} />
              </div>

              <div className="inventory-product-copy">
                <strong>{product.name}</strong>
                <span>{product.category}</span>
              </div>

              <div className="inventory-stock">
                <strong>
                  {formatter.format(product.stock)}
                </strong>
                <span>{t.common.remaining}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="inventory-footer">
        <span>
          {formatter.format(lowStockProducts.length)}{' '}
          {t.common.item}
        </span>
        <span className="inventory-alert-label">
          {t.common.lowStock}
        </span>
      </div>
    </section>
  )
}