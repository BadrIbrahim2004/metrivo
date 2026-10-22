import {
  BarChart3,
  ChevronDown,
  CircleHelp,
  LayoutDashboard,
  Package,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  Warehouse,
  X,
} from 'lucide-react'

import type { LucideIcon } from 'lucide-react'
import type { AppTranslations } from '../../i18n'
import type { PageKey } from '../../types'

interface SidebarProps {
  activePage: PageKey
  t: AppTranslations
  mobileMenuOpen: boolean
  onNavigate: (page: PageKey) => void
  onClose: () => void
}

const navigationItems: {
  key: PageKey
  icon: LucideIcon
}[] = [
  { key: 'dashboard', icon: LayoutDashboard },
  { key: 'sales', icon: ShoppingCart },
  { key: 'products', icon: Package },
  { key: 'inventory', icon: Warehouse },
  { key: 'customers', icon: Users },
  { key: 'suppliers', icon: Truck },
  { key: 'finance', icon: Wallet },
  { key: 'reports', icon: BarChart3 },
]

export default function Sidebar({
  activePage,
  t,
  mobileMenuOpen,
  onNavigate,
  onClose,
}: SidebarProps) {
  return (
    <>
      <aside
        className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}
        aria-label={t.common.mainMenu}
      >
        <div className="brand">
          <div className="brand-mark">
            <BarChart3 size={23} strokeWidth={2.5} />
          </div>

          <div className="brand-copy">
            <strong>Metrivo</strong>
            <span>{t.app.tagline}</span>
          </div>

          <button
            type="button"
            className="mobile-close icon-button"
            onClick={onClose}
            aria-label={t.common.close}
          >
            <X size={20} />
          </button>
        </div>

        <button
          type="button"
          className="workspace"
          onClick={() =>
            window.alert(
              'إدارة الفروع ومساحات العمل سيتم تنفيذها لاحقًا.',
            )
          }
        >
          <span className="workspace-icon">M</span>

          <span className="workspace-copy">
            <strong>{t.app.workspace}</strong>
            <span>{t.app.branch}</span>
          </span>

          <ChevronDown size={16} className="muted-icon" />
        </button>

        <div className="nav-label">{t.common.mainMenu}</div>

        <nav className="main-nav">
          {navigationItems.map(({ key, icon: Icon }) => (
            <button
              key={key}
              type="button"
              className={`nav-item ${
                activePage === key ? 'nav-active' : ''
              }`}
              aria-current={activePage === key ? 'page' : undefined}
              onClick={() => onNavigate(key)}
            >
              <Icon size={19} strokeWidth={1.8} />

              <span>{t.nav[key]}</span>

              {key === 'inventory' && (
                <span className="nav-count">3</span>
              )}
            </button>
          ))}
        </nav>

        <div className="nav-label settings-label">
          {t.common.system}
        </div>

        <button
          type="button"
          className={`nav-item ${
            activePage === 'settings' ? 'nav-active' : ''
          }`}
          onClick={() => onNavigate('settings')}
        >
          <Settings size={19} strokeWidth={1.8} />
          <span>{t.nav.settings}</span>
        </button>

        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon">
              <CircleHelp size={20} />
            </div>

            <strong>{t.common.help}</strong>

            <p>{t.common.helpDescription}</p>

            <button
              type="button"
              onClick={() =>
                window.alert(t.common.helpComingSoon)
              }
            >
              {t.common.helpCenter}
              <CircleHelp size={15} />
            </button>
          </div>

          <div className="profile">
            <div className="profile-avatar">
              {t.app.profileName.charAt(0)}
            </div>

            <div className="profile-copy">
              <strong>{t.app.profileName}</strong>
              <span>{t.app.role}</span>
            </div>
          </div>
        </div>
      </aside>

      {mobileMenuOpen && (
        <button
          type="button"
          className="mobile-backdrop"
          onClick={onClose}
          aria-label={t.common.close}
        />
      )}
    </>
  )
}