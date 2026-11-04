import { useState } from 'react'

import DashboardPage from '../features/dashboard/DashboardPage'
import ProductManagementPage from '../features/products/ProductManagementPage'
import PosPage from '../features/sales/PosPage'
import ProcurementPage from '../features/suppliers/ProcurementPage'
import CashManagementPage from '../features/finance/CashManagementPage'
import ShiftPage from '../features/finance/ShiftPage'
import SettingsPage from '../features/settings/SettingsPage'
import ExpensesPage from '../features/finance/ExpensesPage'
import RecipesPage from '../features/production/RecipesPage'
import CustomersPage from '../features/customers/CustomersPage'
import PlatformPage from '../features/platform/PlatformPage'
import HomePage from '../features/home/HomePage'
import LoginPage, { type LoginSuccess } from '../features/auth/LoginPage'

import { SESSION_KEY } from './session'
import { translations } from '../i18n'
import { normalizeDigitsInData } from '../i18n/numbers'

import type {
  Language,
  PageKey,
} from '../types'

import '../App.css'
import '../styles/components.css'
import '../features/sales/pos.css'
import '../styles/sales.css'
import '../styles/procurement.css'
import '../styles/cash-management.css'
import '../styles/invoice.css'
import '../features/finance/shift.css'
import '../features/settings/settings.css'

interface StoredSession {
  accessToken: string
  userName: string
  userEmail: string
  workspaces: LoginSuccess['workspaces']
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredSession
    return parsed.accessToken ? normalizeDigitsInData(parsed) : null
  } catch {
    return null
  }
}

export default function App() {
  const [session, setSession] = useState<StoredSession | null>(readStoredSession)
  const [activePage, setActivePage] = useState<PageKey>('home')
  const [language, setLanguage] = useState<Language>('ar')
  const [search, setSearch] = useState('')

  const t = translations[language]
  const shopWorkspaces = session?.workspaces ?? []

  function handleLogin(success: LoginSuccess) {
    const stored: StoredSession = {
      accessToken: success.accessToken,
      userName: success.userName,
      userEmail: success.userEmail,
      workspaces: success.workspaces,
    }
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(stored))
    } catch {
      // storage unavailable — session still works for this tab
    }
    setSession(stored)
    setActivePage('home')
    setSearch('')
  }

  function handleLogout() {
    sessionStorage.removeItem(SESSION_KEY)
    setSession(null)
    setActivePage('home')
    setSearch('')
  }

  function handleLanguageChange() {
    setLanguage((current) => (current === 'ar' ? 'en' : 'ar'))
  }

  // ---- Gate: nothing opens before sign-in ----
  if (!session) {
    return (
      <LoginPage
        t={t}
        language={language}
        onLanguageChange={handleLanguageChange}
        onLogin={handleLogin}
      />
    )
  }

  // Platform-only account: dedicated console, no shop chrome.
  if (shopWorkspaces.length === 0) {
    return (
      <div
        className={language === 'en' ? 'app-shell english' : 'app-shell'}
        dir={language === 'ar' ? 'rtl' : 'ltr'}
        lang={language}
      >
        <main className="main-content">
          <PlatformPage
            t={t}
            language={language}
            sessionToken={session.accessToken}
            onSessionExpired={handleLogout}
          />
        </main>
        <button type="button" className="platform-switch button-secondary"
          onClick={handleLogout}>
          {t.productManagement.logout}
        </button>
      </div>
    )
  }

  const shellClass = language === 'en' ? 'app-shell english' : 'app-shell'

  // ---- Card-based home (module launcher) ----
  if (activePage === 'home') {
    return (
      <div className={shellClass} dir={language === 'ar' ? 'rtl' : 'ltr'} lang={language}>
        <HomePage
          t={t}
          language={language}
          sessionToken={session.accessToken}
          workspaces={shopWorkspaces}
          onSessionExpired={handleLogout}
          onOpenModule={setActivePage}
        />
        <button type="button" className="platform-switch button-secondary"
          onClick={handleLogout}>
          {t.productManagement.logout}
        </button>
      </div>
    )
  }

  // ---- Cashier: full-screen POS with its own chrome ----
  if (activePage === 'sales') {
    return (
      <div className={shellClass} dir={language === 'ar' ? 'rtl' : 'ltr'} lang={language}>
        <PosPage
          t={t}
          language={language}
          sessionToken={session.accessToken}
          workspaces={shopWorkspaces}
          onSessionExpired={handleLogout}
          onExitPos={() => setActivePage('home')}
        />
      </div>
    )
  }

  // ---- Shift: dedicated full-page open/close screen ----
  if (activePage === 'shift') {
    return (
      <div className={shellClass} dir={language === 'ar' ? 'rtl' : 'ltr'} lang={language}>
        <ShiftPage
          t={t}
          language={language}
          sessionToken={session.accessToken}
          workspaces={shopWorkspaces}
          onSessionExpired={handleLogout}
          onExit={() => setActivePage('home')}
        />
      </div>
    )
  }

  // ---- Settings: invite users, change password, language, roles ----
  if (activePage === 'settings') {
    return (
      <div className={shellClass} dir={language === 'ar' ? 'rtl' : 'ltr'} lang={language}>
        <SettingsPage
          t={t}
          language={language}
          sessionToken={session.accessToken}
          workspaces={shopWorkspaces}
          onSessionExpired={handleLogout}
          onExit={() => setActivePage('home')}
          onLanguageChange={handleLanguageChange}
        />
      </div>
    )
  }

  // ---- Every other module: full-page, focused, with a slim return header ----
  return (
    <div className={shellClass} dir={language === 'ar' ? 'rtl' : 'ltr'} lang={language}>
      <header className="module-bar">
        <button type="button" className="module-back" onClick={() => setActivePage('home')}>
          ← الرئيسية
        </button>
        <strong>{t.nav[activePage]}</strong>
        <button type="button" className="module-logout" onClick={handleLogout}>
          {t.productManagement.logout}
        </button>
      </header>

      <main className="module-main">
        {activePage === 'dashboard' ? (
          <DashboardPage
            t={t}
            language={language}
            search={search}
            onNewSale={() => setActivePage('sales')}
            sessionToken={session.accessToken}
            workspaces={shopWorkspaces}
            onSessionExpired={handleLogout}
          />
        ) : activePage === 'suppliers' ? (
          <ProcurementPage
            t={t}
            language={language}
            sessionToken={session.accessToken}
            workspaces={shopWorkspaces}
            onSessionExpired={handleLogout}
          />
        ) : activePage === 'finance' ? (
          <CashManagementPage
            t={t}
            language={language}
            sessionToken={session.accessToken}
            workspaces={shopWorkspaces}
            onSessionExpired={handleLogout}
          />
        ) : activePage === 'expenses' ? (
          <ExpensesPage
            t={t}
            language={language}
            sessionToken={session.accessToken}
            workspaces={shopWorkspaces}
            onSessionExpired={handleLogout}
          />
        ) : activePage === 'production' ? (
          <RecipesPage
            t={t}
            language={language}
            sessionToken={session.accessToken}
            workspaces={shopWorkspaces}
            onSessionExpired={handleLogout}
          />
        ) : activePage === 'customers' ? (
          <CustomersPage
            t={t}
            language={language}
            sessionToken={session.accessToken}
            workspaces={shopWorkspaces}
            onSessionExpired={handleLogout}
          />
        ) : activePage === 'products' ? (
          <ProductManagementPage
            t={t}
            sessionToken={session.accessToken}
            workspaces={shopWorkspaces}
            onSessionExpired={handleLogout}
          />
        ) : (
          <section className="page-content placeholder-page">
            <h1>{activePage === 'inventory' ? t.ui.cardInventory : t.nav[activePage]}</h1>
            <p>{t.common.comingSoon}</p>
          </section>
        )}
      </main>
    </div>
  )
}
