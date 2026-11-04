import { useEffect, useState } from 'react'
import {
  BarChart3, Boxes, ChefHat, Coins, Package,
  Receipt, Settings, ShoppingCart, Truck, Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { AppTranslations } from '../../i18n'
import type { Language, PageSession } from '../../types'
import { authedFetch, usePageSession } from '../../app/usePageSession'
import type { PageKey } from '../../types'
import './home.css'

interface HomePageProps extends PageSession {
  t: AppTranslations
  language: Language
  onOpenModule: (page: PageKey) => void
}

interface CardDef {
  page: PageKey
  icon: LucideIcon
  /** Any one of these permission keys unlocks the card ('*' = everyone). */
  permissions: string[]
  accent: string
}

const CARDS: CardDef[] = [
  {
    page: 'sales',
    icon: ShoppingCart,
    permissions: ['sales.create'],
    accent: '#4a7c59',
  },
  {
    page: 'finance',
    icon: Coins,
    permissions: ['cash.manage', 'cash.read', 'refunds.settle'],
    accent: '#0e9f6e',
  },
  {
    page: 'shift',
    icon: Coins,
    permissions: ['cash.manage', 'cash.read'],
    accent: '#12876f',
  },
  {
    page: 'settings',
    icon: Settings,
    permissions: ['*'],
    accent: '#5b6472',
  },
  {
    page: 'products',
    icon: Package,
    permissions: ['catalog.products.manage', 'catalog.products.read', 'inventory.adjust'],
    accent: '#e8871e',
  },
  {
    page: 'customers',
    icon: Users,
    permissions: ['customers.manage', 'customers.read'],
    accent: '#d926a9',
  },
  {
    page: 'suppliers',
    icon: Truck,
    permissions: ['suppliers.manage', 'purchases.create', 'purchases.read'],
    accent: '#1d7ed8',
  },
  {
    page: 'expenses',
    icon: Receipt,
    permissions: ['expenses.manage', 'expenses.read'],
    accent: '#b42318',
  },
  {
    page: 'production',
    icon: ChefHat,
    permissions: ['recipes.manage', 'recipes.read'],
    accent: '#6f4e37',
  },
  {
    page: 'reports',
    icon: BarChart3,
    permissions: ['reports.read'],
    accent: '#5b6472',
  },
  {
    page: 'inventory',
    icon: Boxes,
    permissions: ['inventory.transfer', 'inventory.waste'],
    accent: '#7048e8',
  },
]

export default function HomePage({
  t,
  sessionToken,
  workspaces,
  onSessionExpired,
  onOpenModule,
}: HomePageProps) {
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const [permissions, setPermissions] = useState<string[]>([])
  const [owner, setOwner] = useState(false)
  const [error, setError] = useState('')
  const [userName, setUserName] = useState('')

  useEffect(() => {
    if (!session.token) return
    let cancelled = false
    authedFetch<string[] | { permissions?: string[]; isPlatformOwner?: boolean; userName?: string }>(
      `/api/auth/permissions?tenantId=${encodeURIComponent(session.workspaces[0]?.tenantId ?? '')}`,
      session.token,
      onSessionExpired,
    )
      .then((data) => {
        if (cancelled) return
        if (Array.isArray(data)) {
          setPermissions(data)
        } else {
          setPermissions(data.permissions ?? [])
          setOwner(Boolean(data.isPlatformOwner))
          if (data.userName) setUserName(data.userName)
        }
      })
      .catch(() => {
        if (!cancelled) setError(t.ui.posPermissionsFailed)
      })
    return () => { cancelled = true }
  }, [session.token, session.workspaces, onSessionExpired, t.ui.posPermissionsFailed])

  const visibleCards = owner
    ? CARDS
    : CARDS.filter((card) =>
        card.permissions.includes('*') ||
        card.permissions.some((key) => permissions.includes(key)),
      )

  const hour = new Date().getHours()
  const greeting = hour < 12 ? t.ui.greetingMorning : t.ui.greetingEvening

  const cardText: Record<string, { title: string; desc: string }> = {
    sales: { title: t.ui.cardCashier, desc: t.ui.cardCashierDesc },
    finance: { title: t.ui.cardDrawer, desc: t.ui.cardDrawerDesc },
    shift: { title: t.ui.cardShift, desc: t.ui.cardShiftDesc },
    products: { title: t.ui.cardProducts, desc: t.ui.cardProductsDesc },
    customers: { title: t.ui.cardCustomers, desc: t.ui.cardCustomersDesc },
    suppliers: { title: t.ui.cardSuppliers, desc: t.ui.cardSuppliersDesc },
    expenses: { title: t.ui.cardExpenses, desc: t.ui.cardExpensesDesc },
    production: { title: t.ui.cardProduction, desc: t.ui.cardProductionDesc },
    reports: { title: t.ui.cardReports, desc: t.ui.cardReportsDesc },
    inventory: { title: t.ui.cardInventory, desc: t.ui.cardInventoryDesc },
    settings: { title: t.ui.cardSettings, desc: t.ui.cardSettingsDesc },
  }

  return (
    <section className="home-screen">
      <header className="home-header">
        <div>
          <p className="home-eyebrow">{greeting} {t.ui.wave}</p>
          <h1>{userName || t.app.profileName}</h1>
          <p className="home-sub">{t.ui.chooseSection}</p>
        </div>
        <div className="home-branch">
          {workspaces.map((item) => (
            <span key={item.branchId} className="home-branch-chip">
              {item.tenantName} — {item.branchName}
            </span>
          ))}
        </div>
      </header>

      {error && <p className="product-error home-error" role="alert">{error}</p>}

      <div className="home-cards">
        {visibleCards.length === 0 ? (
          <p className="home-empty">{t.ui.noPermissions}</p>
        ) : visibleCards.map((card) => (
          <button
            key={card.page}
            type="button"
            className="home-card"
            onClick={() => onOpenModule(card.page)}
          >
            <span className="home-card-icon" style={{ background: card.accent }}>
              <card.icon size={26} strokeWidth={2} />
            </span>
            <span className="home-card-copy">
              <strong>{cardText[card.page]?.title ?? card.page}</strong>
              <small>{cardText[card.page]?.desc ?? ''}</small>
            </span>
            <span className="home-card-arrow">←</span>
          </button>
        ))}
      </div>

      {!owner && permissions.length > 0 && (
        <p className="home-note">{t.ui.cardsLimitedNote}</p>
      )}
    </section>
  )
}
