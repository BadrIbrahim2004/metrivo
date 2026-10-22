import { useState } from 'react'

import Sidebar from '../components/layout/Sidebar'
import Topbar from '../components/layout/Topbar'
import DashboardPage from '../features/dashboard/DashboardPage'
import ProductManagementPage from '../features/products/ProductManagementPage'
import SalesPage from '../features/sales/SalesPage'

import { translations } from '../i18n'

import type {
  Language,
  PageKey,
} from '../types'

import '../App.css'
import '../styles/components.css'
import '../styles/sales.css'

export default function App() {
  const [activePage, setActivePage] =
    useState<PageKey>('dashboard')

  const [language, setLanguage] =
    useState<Language>('ar')

  const [mobileMenuOpen, setMobileMenuOpen] =
    useState(false)

  const [search, setSearch] = useState('')

  const t = translations[language]

  function handleNavigate(page: PageKey) {
    setActivePage(page)
    setMobileMenuOpen(false)
    setSearch('')
  }

  function handleLanguageChange() {
    setLanguage((current) =>
      current === 'ar' ? 'en' : 'ar',
    )
  }

  return (
    <div
      className={
        language === 'en'
          ? 'app-shell english'
          : 'app-shell'
      }
      dir={language === 'ar' ? 'rtl' : 'ltr'}
      lang={language}
    >
      <Sidebar
        activePage={activePage}
        t={t}
        mobileMenuOpen={mobileMenuOpen}
        onNavigate={handleNavigate}
        onClose={() => setMobileMenuOpen(false)}
      />

      <main className="main-content">
        <Topbar
          activePage={activePage}
          language={language}
          t={t}
          search={search}
          onSearchChange={setSearch}
          onLanguageChange={handleLanguageChange}
          onMenuOpen={() => setMobileMenuOpen(true)}
        />

        {activePage === 'dashboard' ? (
          <DashboardPage
            t={t}
            language={language}
            search={search}
            onNewSale={() => setActivePage('sales')}
          />
        ) : activePage === 'sales' ? (
          <SalesPage t={t} language={language} />
        ) : activePage === 'products' || activePage === 'inventory' ? (
          <ProductManagementPage
            t={t}
          />
        ) : (
          <section className="page-content placeholder-page">
            <h1>{t.nav[activePage]}</h1>
            <p>{t.common.comingSoon}</p>
          </section>
        )}
      </main>
    </div>
  )
}