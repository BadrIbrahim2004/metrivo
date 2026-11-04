import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { BarChart3, Eye, EyeOff, Save } from 'lucide-react'

import type { AppTranslations } from '../../i18n'
import type { Language } from '../../types'
import { normalizeDigitsInData } from '../../i18n/numbers'
import './login.css'

export interface LoginSuccess {
  accessToken: string
  userName: string
  userEmail: string
  /** Empty for platform-only accounts. */
  workspaces: Array<{
    tenantId: string
    tenantName: string
    branchId: string
    branchName: string
  }>
}

interface LoginPageProps {
  t: AppTranslations
  language: Language
  onLanguageChange: () => void
  onLogin: (session: LoginSuccess) => void
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('request')
  return normalizeDigitsInData(await response.json() as T)
}

interface WorkspaceBranchApi {
  tenantId: string
  tenantName: string
  branchId: string
  branchName: string
}

interface PasswordCredentialData {
  id: string
  password: string
  name: string
}

interface PasswordCredentialWindow extends Window {
  PasswordCredential?: new (data: PasswordCredentialData) => Credential
}

export default function LoginPage({
  t,
  language,
  onLanguageChange,
  onLogin,
}: LoginPageProps) {
  const copy = t.loginPage
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [credentialMessage, setCredentialMessage] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  async function saveCredentials() {
    setError('')
    setCredentialMessage('')
    if (!formRef.current?.reportValidity()) return

    const PasswordCredentialConstructor =
      (window as PasswordCredentialWindow).PasswordCredential
    if (!navigator.credentials || !PasswordCredentialConstructor) {
      setError(copy.saveCredentialsUnsupported)
      return
    }

    try {
      const credential = new PasswordCredentialConstructor({
        id: email.trim(),
        password,
        name: 'Metrivo',
      })
      await navigator.credentials.store(credential)
      setCredentialMessage(copy.credentialsSaved)
    } catch {
      setError(copy.saveCredentialsFailed)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await post<{ accessToken: string; user?: { name?: string | null; email: string } }>(
        '/api/auth/login',
        { email, password },
      )
      let workspaces: WorkspaceBranchApi[] = []
      try {
        const response = await fetch('/api/auth/workspaces', {
          headers: { Authorization: `Bearer ${result.accessToken}` },
        })
        if (!response.ok) throw new Error('workspaces')
        workspaces = normalizeDigitsInData(await response.json() as WorkspaceBranchApi[])
      } catch {
        throw new Error('workspaces')
      }
      onLogin({
        accessToken: result.accessToken,
        userName: result.user?.name ?? email,
        userEmail: result.user?.email ?? email,
        workspaces,
      })
    } catch (error) {
      setError(
        error instanceof Error && error.message === 'workspaces'
          ? copy.workspaceLoadFailed
          : copy.invalidCredentials,
      )
      setBusy(false)
    }
  }

  return (
    <div
      className={language === 'en' ? 'login-screen english' : 'login-screen'}
      dir={language === 'ar' ? 'rtl' : 'ltr'}
      lang={language}
    >
      <div className="login-backdrop" aria-hidden="true">
        <span className="glow glow-a" />
        <span className="glow glow-b" />
        <span className="glow glow-c" />
      </div>

      <button
        type="button"
        className="login-language"
        onClick={onLanguageChange}
      >
        {t.common.language}
      </button>

      <main className="login-card">
        <header className="login-brand">
          <div className="login-brand-mark">
            <BarChart3 size={26} strokeWidth={2.4} />
          </div>
          <h1>Metrivo</h1>
          <p className="login-tagline">{copy.tagline}</p>
        </header>

        <form
          ref={formRef}
          className="login-form"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <label>
            <span>{t.productManagement.email}</span>
            <input
              type="email"
              name="username"
              required
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              dir="ltr"
              placeholder="name@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label>
            <span>{t.productManagement.password}</span>
            <span className="login-password">
              <input
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                dir="ltr"
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="login-reveal"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? copy.hidePassword : copy.showPassword}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </span>
          </label>

          {error && (
            <p className="login-error" role="alert">{error}</p>
          )}

          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? t.productManagement.loading : copy.signIn}
          </button>
          <button
            type="button"
            className="login-save"
            disabled={busy}
            onClick={() => void saveCredentials()}
          >
            <Save size={17} aria-hidden="true" />
            {copy.saveCredentials}
          </button>
        </form>

        {credentialMessage && (
          <p className="login-saved" role="status">{credentialMessage}</p>
        )}
        <p className="login-hint">{copy.passwordManagerHint}</p>
        <p className="login-hint">{copy.roleHint}</p>

        <footer className="login-footer">
          <span className="login-owner-name">{copy.ownerName}</span>
          <span className="login-owner-role">{copy.ownerRole}</span>
        </footer>
      </main>
    </div>
  )
}
