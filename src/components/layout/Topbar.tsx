import {
  Bell,
  CalendarDays,
  Globe2,
  Menu,
  Search,
} from 'lucide-react'

import type { AppTranslations } from '../../i18n'
import type { Language, PageKey } from '../../types'

interface TopbarProps {
  activePage: PageKey
  language: Language
  t: AppTranslations
  search: string
  onSearchChange: (value: string) => void
  onLanguageChange: () => void
  onMenuOpen: () => void
}

export default function Topbar({
  activePage,
  language,
  t,
  search,
  onSearchChange,
  onLanguageChange,
  onMenuOpen,
}: TopbarProps) {
  const pageTitle =
    activePage === 'dashboard'
      ? t.nav.dashboard
      : t.nav[activePage]

  const date = new Intl.DateTimeFormat(
    language === 'ar' ? 'ar-EG' : 'en-GB',
    {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    },
  ).format(new Date())

  return (
    <header className="topbar">
      <div className="topbar-start">
        <button
          type="button"
          className="mobile-menu icon-button"
          onClick={onMenuOpen}
          aria-label={t.common.mainMenu}
        >
          <Menu size={22} />
        </button>

        <div className="breadcrumb">
          <span>{t.common.home}</span>
          <span className="breadcrumb-separator">/</span>
          <strong>{pageTitle}</strong>
        </div>
      </div>

      <div className="topbar-actions">
        <button
          type="button"
          className="language-button"
          onClick={onLanguageChange}
          aria-label={t.common.language}
        >
          <Globe2 size={17} />
          <span>{t.common.language}</span>
        </button>

        {activePage === 'dashboard' && (
          <label
            className="topbar-search"
            aria-label={t.common.search}
          >
            <Search size={17} />

            <input
              type="search"
              value={search}
              onChange={(event) =>
                onSearchChange(event.target.value)
              }
              placeholder={t.common.search}
            />
          </label>
        )}

        <button
          type="button"
          className="icon-button notification-button"
          aria-label={t.common.notifications}
          onClick={() =>
            window.alert(t.common.noNotifications)
          }
        >
          <Bell size={19} />
          <span className="notification-dot" />
        </button>

        <div className="topbar-divider" />

        <div className="header-date">
          <CalendarDays size={17} />
          <span>{date}</span>
        </div>
      </div>
    </header>
  )
}