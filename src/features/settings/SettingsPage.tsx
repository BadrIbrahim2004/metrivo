import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { AppTranslations } from '../../i18n'
import type { Language, PageSession } from '../../types'
import type { ReceiptSettings } from '../sales/receipt-settings'
import { authedFetch, authedPost, usePageSession } from '../../app/usePageSession'
import './settings.css'

interface RoleRow {
  id: string
  name: string
}

interface BranchRow {
  tenantId: string
  branchId: string
  branchName: string
}

interface RolesLoadResult {
  tenantId: string
  failed: boolean
}

interface SettingsPageProps extends PageSession {
  t: AppTranslations
  language: Language
  onExit: () => void
  onLanguageChange: () => void
}

type Tab = 'invite' | 'password' | 'language' | 'roles' | 'receipt'

export default function SettingsPage({
  t,
  language,
  sessionToken,
  workspaces,
  onSessionExpired,
  onExit,
  onLanguageChange,
}: SettingsPageProps) {
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const token = session.token
  const [tab, setTab] = useState<Tab>('invite')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  // ---- Invite user ----
  const [inviteEmail, setInviteEmail] = useState('')
  const [roleId, setRoleId] = useState('')
  const [roles, setRoles] = useState<RoleRow[]>([])
  const [rolesLoadResult, setRolesLoadResult] = useState<RolesLoadResult | null>(null)
  const branches: BranchRow[] = workspaces
  const [branchId, setBranchId] = useState(session.branchId)
  const [inviteResult, setInviteResult] = useState('')

  // ---- Change password ----
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [repeatPassword, setRepeatPassword] = useState('')
  const [receiptSettings, setReceiptSettings] = useState<ReceiptSettings | null>(null)

  const receiptSettingsPath = workspaces[0]
    ? `/api/tenants/${encodeURIComponent(workspaces[0].tenantId)}/receipt-settings`
    : ''
  const selectedWorkspace = workspaces.find((item) => item.branchId === branchId)
  const rolesLoading = Boolean(
    selectedWorkspace && rolesLoadResult?.tenantId !== selectedWorkspace.tenantId,
  )
  const rolesLoadFailed = Boolean(
    selectedWorkspace &&
    rolesLoadResult?.tenantId === selectedWorkspace.tenantId &&
    rolesLoadResult.failed,
  )

  useEffect(() => {
    if (!selectedWorkspace || !token) return
    let cancelled = false
    authedFetch<RoleRow[]>(
      `/api/auth/tenant-roles?tenantId=${encodeURIComponent(selectedWorkspace.tenantId)}`,
      token,
      onSessionExpired,
    )
      .then((rows) => {
        if (!cancelled) {
          setRoles(rows)
          setRoleId(rows[0]?.id ?? '')
          setRolesLoadResult({ tenantId: selectedWorkspace.tenantId, failed: false })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(t.ui.settingsRolesLoadFailed)
          setRoles([])
          setRoleId('')
          setRolesLoadResult({ tenantId: selectedWorkspace.tenantId, failed: true })
        }
      })
    return () => { cancelled = true }
  }, [selectedWorkspace, token, onSessionExpired, t.ui.settingsRolesLoadFailed])

  useEffect(() => {
    if (!receiptSettingsPath || !token) return
    let cancelled = false
    authedFetch<ReceiptSettings>(
      receiptSettingsPath,
      token,
      onSessionExpired,
    )
      .then((settings) => {
        if (!cancelled) setReceiptSettings(settings)
      })
      .catch(() => {
        if (!cancelled) setError(t.ui.receiptSettingsLoadFailed)
      })
    return () => { cancelled = true }
  }, [receiptSettingsPath, token, onSessionExpired, t.ui.receiptSettingsLoadFailed])

  async function sendInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedWorkspace || !roleId) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await authedPost<{ token?: string; invitationToken?: string }>(
        '/api/invitations', token, onSessionExpired, {
        body: JSON.stringify({
          email: inviteEmail.trim(),
          tenantId: selectedWorkspace.tenantId,
          roleId,
          branchId: selectedWorkspace.branchId,
        }),
      },
      )
      const tokenText = result.invitationToken ?? result.token ?? ''
      setInviteResult(
        tokenText
          ? `${t.ui.settingsInviteDone} ${tokenText.slice(0, 12)}…`
          : t.ui.settingsInviteDone,
      )
      setInviteEmail('')
    } catch {
      setError(t.ui.settingsInviteFailed)
    } finally {
      setBusy(false)
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (newPassword !== repeatPassword) {
      setError(t.ui.settingsMismatch)
      return
    }
    if (newPassword.length < 12) {
      setError(t.ui.settingsTooShort)
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await authedPost<{ changed: true }>(
        '/api/auth/change-password', token, onSessionExpired, {
        body: JSON.stringify({ currentPassword, newPassword }),
      },
      )
      setCurrentPassword('')
      setNewPassword('')
      setRepeatPassword('')
      setNotice(t.ui.settingsPasswordDone)
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'conflict-shift'
          ? t.ui.settingsPasswordWrong
          : t.ui.settingsPasswordFailed,
      )
    } finally {
      setBusy(false)
    }
  }

  async function saveReceiptSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!receiptSettingsPath || !token || !receiptSettings?.canManageReceiptSettings) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const payload = {
        receiptDisplayName: receiptSettings.receiptDisplayName,
        receiptLogoDataUrl: receiptSettings.receiptLogoDataUrl,
        receiptPhone: receiptSettings.receiptPhone,
        receiptAddress: receiptSettings.receiptAddress,
        receiptFacebook: receiptSettings.receiptFacebook,
        receiptInstagram: receiptSettings.receiptInstagram,
        receiptTiktok: receiptSettings.receiptTiktok,
        receiptYoutube: receiptSettings.receiptYoutube,
        receiptWhatsapp: receiptSettings.receiptWhatsapp,
        receiptX: receiptSettings.receiptX,
        receiptTelegram: receiptSettings.receiptTelegram,
        receiptSnapchat: receiptSettings.receiptSnapchat,
        receiptLinkedin: receiptSettings.receiptLinkedin,
        receiptWebsite: receiptSettings.receiptWebsite,
      }
      await authedFetch<ReceiptSettings>(
        receiptSettingsPath,
        token,
        onSessionExpired,
        { method: 'PUT', body: JSON.stringify(payload) },
      )
      setNotice(t.ui.receiptSettingsSaved)
    } catch {
      setError(t.ui.receiptSettingsFailed)
    } finally {
      setBusy(false)
    }
  }

  async function chooseReceiptLogo(file?: File) {
    if (!file || !receiptSettings) return
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 512 * 1024
    ) {
      setError(t.ui.receiptLogoInvalid)
      return
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          if (typeof reader.result === 'string') resolve(reader.result)
          else reject(new Error('Invalid image data'))
        }
        reader.onerror = () => reject(new Error('Could not read image'))
        reader.readAsDataURL(file)
      })
      setError('')
      setReceiptSettings({ ...receiptSettings, receiptLogoDataUrl: dataUrl })
    } catch {
      setError(t.ui.receiptLogoInvalid)
    }
  }

  return (
    <section className="settings-screen">
      <header className="shift-head">
        <button type="button" className="module-back" onClick={onExit}>{t.ui.backHomeShort}</button>
        <strong>{t.ui.settingsTitle}</strong>
        <button type="button" className="module-logout" onClick={onSessionExpired}>
          {t.productManagement.logout}
        </button>
      </header>

      <nav className="page-tabs" aria-label={t.ui.settingsTabsLabel}>
        <button type="button" className={`page-tab ${tab === 'invite' ? 'page-tab-active' : ''}`}
          onClick={() => setTab('invite')}>{t.ui.tabsInvite}</button>
        <button type="button" className={`page-tab ${tab === 'password' ? 'page-tab-active' : ''}`}
          onClick={() => setTab('password')}>{t.ui.tabsPassword}</button>
        <button type="button" className={`page-tab ${tab === 'language' ? 'page-tab-active' : ''}`}
          onClick={() => setTab('language')}>{t.ui.tabsLanguage}</button>
        <button type="button" className={`page-tab ${tab === 'roles' ? 'page-tab-active' : ''}`}
          onClick={() => setTab('roles')}>{t.ui.tabsRoles}</button>
        {receiptSettings?.canManageReceiptSettings ? (
          <button type="button" className={`page-tab ${tab === 'receipt' ? 'page-tab-active' : ''}`}
            onClick={() => setTab('receipt')}>{t.ui.settingsTabReceipt}</button>
        ) : null}
      </nav>

      <div className="settings-body">
        {error && <p className="product-error" role="alert">{error}</p>}
        {notice && <p className="product-success" role="status">{notice}</p>}

        {tab === 'invite' && (
          <section className="settings-card">
            <h2>{t.ui.settingsInviteTitle}</h2>
            <p className="settings-hint">{t.ui.settingsInviteHint}</p>
            <form onSubmit={(event) => void sendInvite(event)}>
              <label>
                {t.ui.settingsEmailLabel}
                <input type="email" required maxLength={320} dir="ltr"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)} />
              </label>
              <label>
                {t.ui.settingsRoleLabel}
                <select required value={roleId} disabled={rolesLoading || roles.length === 0}
                  onChange={(event) => setRoleId(event.target.value)}>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </select>
              </label>
              {rolesLoading ? (
                <p className="settings-hint">{t.productManagement.loading}</p>
              ) : roles.length === 0 && !rolesLoadFailed ? (
                <p className="settings-hint">{t.ui.settingsInviteRolesEmpty}</p>
              ) : null}
              <label>
                {t.ui.settingsBranchLabel}
                <select required value={branchId}
                  onChange={(event) => setBranchId(event.target.value)}>
                  {branches.map((branch) => (
                    <option key={branch.branchId} value={branch.branchId}>
                      {branch.branchName}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="settings-confirm"
                disabled={busy || rolesLoading || roles.length === 0 || !roleId}>
                {busy ? t.productManagement.loading : t.ui.settingsInviteBtn}
              </button>
            </form>
            {inviteResult && <p className="settings-result">{inviteResult}</p>}
          </section>
        )}

        {tab === 'password' && (
          <section className="settings-card">
            <h2>{t.ui.settingsPasswordTitle}</h2>
            <p className="settings-hint">{t.ui.settingsPasswordHint}</p>
            <form onSubmit={(event) => void changePassword(event)}>
              <label>
                {t.ui.settingsCurrentLabel}
                <input type="password" required autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)} />
              </label>
              <label>
                {t.ui.settingsNewLabel}
                <input type="password" required minLength={12} autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)} />
              </label>
              <label>
                {t.ui.settingsRepeatLabel}
                <input type="password" required minLength={12} autoComplete="new-password"
                  value={repeatPassword}
                  onChange={(event) => setRepeatPassword(event.target.value)} />
              </label>
              <button type="submit" className="settings-confirm" disabled={busy}>
                {busy ? t.productManagement.loading : t.ui.settingsPasswordBtn}
              </button>
            </form>
          </section>
        )}

        {tab === 'language' && (
          <section className="settings-card">
            <h2>{t.ui.settingsLanguageTitle}</h2>
            <p className="settings-hint">{t.ui.settingsLanguageHint}</p>
            <div className="settings-lang-row">
              <button
                type="button"
                className={`settings-lang ${language === 'ar' ? 'settings-lang-active' : ''}`}
                onClick={language !== 'ar' ? onLanguageChange : undefined}
              >
                {t.ui.settingsLangAr}
              </button>
              <button
                type="button"
                className={`settings-lang ${language === 'en' ? 'settings-lang-active' : ''}`}
                onClick={language !== 'en' ? onLanguageChange : undefined}
              >
                English
              </button>
            </div>
          </section>
        )}

        {tab === 'roles' && (
          <section className="settings-card">
            <h2>{t.ui.settingsRolesTitle}</h2>
            <p className="settings-hint">{t.ui.settingsRolesHint}</p>
            {rolesLoading ? (
              <p className="muted-note">{t.productManagement.loading}</p>
            ) : rolesLoadFailed ? null : roles.length === 0 ? (
              <p className="muted-note">{t.ui.settingsRolesEmpty}</p>
            ) : (
              <div className="settings-roles-list">
                {roles.map((role) => (
                  <article key={role.id} className="settings-role">
                    <strong>{role.name}</strong>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'receipt' && receiptSettings?.canManageReceiptSettings && (
          <section className="settings-card">
            <h2>{t.ui.receiptSettingsTitle}</h2>
            <p className="settings-hint">{t.ui.receiptSettingsHint}</p>
            <form onSubmit={(event) => void saveReceiptSettings(event)}>
              <label>
                {t.ui.receiptDisplayNameLabel}
                <input
                  type="text"
                  maxLength={120}
                  value={receiptSettings.receiptDisplayName ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings,
                    receiptDisplayName: event.target.value,
                  })}
                />
              </label>
              <label>
                {t.ui.receiptLogoLabel}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => void chooseReceiptLogo(event.target.files?.[0])}
                />
                <small className="settings-hint">{t.ui.receiptLogoHelp}</small>
              </label>
              {receiptSettings.receiptLogoDataUrl ? (
                <div className="settings-receipt-logo">
                  <img src={receiptSettings.receiptLogoDataUrl} alt={t.ui.receiptLogoLabel} />
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => setReceiptSettings({
                      ...receiptSettings,
                      receiptLogoDataUrl: null,
                    })}
                  >
                    {t.ui.receiptLogoRemove}
                  </button>
                </div>
              ) : null}
              <label>
                {t.ui.receiptPhoneLabel}
                <input
                  type="text"
                  maxLength={40}
                  value={receiptSettings.receiptPhone ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings,
                    receiptPhone: event.target.value,
                  })}
                />
              </label>
              <label>
                {t.ui.receiptAddressLabel}
                <input
                  type="text"
                  maxLength={200}
                  value={receiptSettings.receiptAddress ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings,
                    receiptAddress: event.target.value,
                  })}
                />
              </label>
              <label>
                {t.ui.receiptFacebookLabel}
                <input
                  type="text"
                  maxLength={120}
                  value={receiptSettings.receiptFacebook ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings,
                    receiptFacebook: event.target.value,
                  })}
                />
              </label>
              <label>
                {t.ui.receiptInstagramLabel}
                <input
                  type="text"
                  maxLength={120}
                  value={receiptSettings.receiptInstagram ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings,
                    receiptInstagram: event.target.value,
                  })}
                />
              </label>
              <label>
                {t.ui.receiptTiktokLabel}
                <input type="text" maxLength={200} value={receiptSettings.receiptTiktok ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings, receiptTiktok: event.target.value,
                  })} />
              </label>
              <label>
                {t.ui.receiptYoutubeLabel}
                <input type="text" maxLength={200} value={receiptSettings.receiptYoutube ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings, receiptYoutube: event.target.value,
                  })} />
              </label>
              <label>
                {t.ui.receiptWhatsappLabel}
                <input type="text" maxLength={200} value={receiptSettings.receiptWhatsapp ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings, receiptWhatsapp: event.target.value,
                  })} />
              </label>
              <label>
                {t.ui.receiptXLabel}
                <input type="text" maxLength={200} value={receiptSettings.receiptX ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings, receiptX: event.target.value,
                  })} />
              </label>
              <label>
                {t.ui.receiptTelegramLabel}
                <input type="text" maxLength={200} value={receiptSettings.receiptTelegram ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings, receiptTelegram: event.target.value,
                  })} />
              </label>
              <label>
                {t.ui.receiptSnapchatLabel}
                <input type="text" maxLength={200} value={receiptSettings.receiptSnapchat ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings, receiptSnapchat: event.target.value,
                  })} />
              </label>
              <label>
                {t.ui.receiptLinkedinLabel}
                <input type="text" maxLength={200} value={receiptSettings.receiptLinkedin ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings, receiptLinkedin: event.target.value,
                  })} />
              </label>
              <label>
                {t.ui.receiptWebsiteLabel}
                <input type="text" maxLength={200} value={receiptSettings.receiptWebsite ?? ''}
                  onChange={(event) => setReceiptSettings({
                    ...receiptSettings, receiptWebsite: event.target.value,
                  })} />
              </label>
              <button type="submit" className="settings-confirm" disabled={busy}>
                {busy ? t.productManagement.loading : t.ui.receiptSettingsSave}
              </button>
            </form>
          </section>
        )}
      </div>
    </section>
  )
}
