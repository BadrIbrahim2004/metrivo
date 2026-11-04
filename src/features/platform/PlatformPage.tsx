import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language } from '../../types'
import { authedFetch } from '../../app/usePageSession'

interface PlanRow {
  id: string
  name: string
  period: 'MONTHLY' | 'ANNUAL'
  price: string
  trialDays: number
  isActive: boolean
}

interface TenantSubscriptionRow {
  tenantId: string
  tenantName: string
  planName: string
  period: 'MONTHLY' | 'ANNUAL'
  status: 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'CANCELLED'
  trialEndsAt: string | null
  currentPeriodEnd: string | null
}

interface OnboardingResult {
  tenantId: string
  branchId: string
  ownerEmail: string
  invitationToken: string
  invitationExpiresAt: string
  trialDays: number | null
  subscriptionStatus: 'TRIAL' | 'NONE'
}

interface PlatformPageProps {
  t: AppTranslations
  language: Language
  /** Provided by the app-level session gate (platform owner only). */
  sessionToken: string
  /** Called when the API rejects the token, to return to the login screen. */
  onSessionExpired: () => void
}

async function apiRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  return authedFetch<T>(path, token, () => { throw new Error('session') }, init)
}

function money(value: string, language: Language): string {
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(Number(value))
}

const STATUS_LABELS: Record<TenantSubscriptionRow['status'], 'trial' | 'active' | 'expired' | 'suspended' | 'cancelled'> = {
  TRIAL: 'trial',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
}

export default function PlatformPage({ t, language, sessionToken, onSessionExpired }: PlatformPageProps) {
  const copy = t.platform
  const onboardingCopy = t.onboarding
  const token = sessionToken
  const [plans, setPlans] = useState<PlanRow[]>([])
  const [subscriptions, setSubscriptions] = useState<TenantSubscriptionRow[]>([])
  const [planName, setPlanName] = useState('')
  const [planPeriod, setPlanPeriod] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY')
  const [planPrice, setPlanPrice] = useState('')
  const [planTrialDays, setPlanTrialDays] = useState('0')
  const [assignTenantId, setAssignTenantId] = useState('')
  const [assignPlanId, setAssignPlanId] = useState('')
  const [assignTrial, setAssignTrial] = useState(false)
  const [newTenantName, setNewTenantName] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [newOwnerEmail, setNewOwnerEmail] = useState('')
  const [newTrialDays, setNewTrialDays] = useState('14')
  const [onboardingResult, setOnboardingResult] = useState<OnboardingResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function loadState(path = '/api/platform/subscriptions', auth = token) {
    if (!auth) return
    const [planList, subscriptionList] = await Promise.all([
      apiRequest<PlanRow[]>(`${path}/plans`, auth),
      apiRequest<TenantSubscriptionRow[]>(`${path}/tenants`, auth),
    ])
    setPlans(planList)
    setSubscriptions(subscriptionList)
  }

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const requestFailed = copy.requestFailed
    async function run() {
      try {
        const [planList, subscriptionList] = await Promise.all([
          apiRequest<PlanRow[]>('/api/platform/subscriptions/plans', token),
          apiRequest<TenantSubscriptionRow[]>('/api/platform/subscriptions/tenants', token),
        ])
        if (!cancelled) {
          setPlans(planList)
          setSubscriptions(subscriptionList)
        }
      } catch {
        if (!cancelled) setError(requestFailed)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [token, copy.requestFailed])

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await apiRequest('/api/platform/subscriptions/plans', token, {
        method: 'POST',
        body: JSON.stringify({
          name: planName.trim(),
          period: planPeriod,
          price: planPrice,
          trialDays: Number(planTrialDays),
        }),
      })
      setPlanName('')
      setPlanPrice('')
      setPlanTrialDays('0')
      await loadState()
      setNotice(copy.planCreated)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function assignSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await apiRequest(
        `/api/platform/subscriptions/tenants/${encodeURIComponent(assignTenantId)}/assign`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ planId: assignPlanId, startTrial: assignTrial }),
        },
      )
      await loadState()
      setNotice(copy.subscriptionAssigned)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function createTenant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await apiRequest<OnboardingResult>('/api/platform/tenants', token, {
        method: 'POST',
        body: JSON.stringify({
          tenantName: newTenantName.trim(),
          branchName: newBranchName.trim(),
          ownerEmail: newOwnerEmail.trim(),
          trialDays: Number(newTrialDays),
        }),
      })
      setNewTenantName('')
      setNewBranchName('')
      setNewOwnerEmail('')
      setNewTrialDays('14')
      setOnboardingResult(result)
      await loadState()
      setNotice(onboardingCopy.tenantCreated)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function changeState(
    subscription: TenantSubscriptionRow,
    action: 'SUSPEND' | 'RESUME' | 'CANCEL' | 'EXPIRE',
  ) {
    if (busy) return
    if (action === 'CANCEL' && !window.confirm(copy.confirmCancel)) return
    setBusy(true)
    setError('')
    try {
      await apiRequest(
        `/api/platform/subscriptions/tenants/${encodeURIComponent(subscription.tenantId)}/action`,
        token,
        { method: 'POST', body: JSON.stringify({ action }) },
      )
      await loadState()
      setNotice(copy.stateChanged)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    onSessionExpired()
  }

  return (
    <section className="page-content platform-page">
      <header className="product-management-heading">
        <div>
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        {token && (
          <button type="button" className="button-secondary" onClick={logout}>
            {t.productManagement.logout}
          </button>
        )}
      </header>

      <>
          <form className="cash-panel cash-inline-form" onSubmit={(event) => void createTenant(event)}>
            <h2>{onboardingCopy.onboardTenant}</h2>
            <label>{onboardingCopy.tenantName}
              <input required maxLength={200} value={newTenantName}
                onChange={(event) => setNewTenantName(event.target.value)} />
            </label>
            <label>{onboardingCopy.firstBranch}
              <input required maxLength={200} value={newBranchName}
                onChange={(event) => setNewBranchName(event.target.value)} />
            </label>
            <label>{onboardingCopy.ownerEmail}
              <input type="email" required maxLength={254} value={newOwnerEmail}
                onChange={(event) => setNewOwnerEmail(event.target.value)} />
            </label>
            <label>{onboardingCopy.trialDays}
              <input type="number" min="0" max="90" required value={newTrialDays}
                onChange={(event) => setNewTrialDays(event.target.value)} />
            </label>
            <button className="button-primary" disabled={busy}>{onboardingCopy.create}</button>
          </form>

          {onboardingResult && (
            <section className="cash-panel">
              <h2>{onboardingCopy.invitationReady}</h2>
              <p>{onboardingCopy.tenantId}: <strong>{onboardingResult.tenantId}</strong></p>
              <p>{onboardingCopy.ownerEmail}: <strong>{onboardingResult.ownerEmail}</strong></p>
              <p>{onboardingCopy.trialDays}: <strong>{onboardingResult.trialDays ?? 0}</strong></p>
              <p>{onboardingCopy.copyInvitation}</p>
              <code className="invitation-token">{onboardingResult.invitationToken}</code>
              <p>{onboardingCopy.invitationExpires}: <strong>{new Date(onboardingResult.invitationExpiresAt).toLocaleString(numberLocale(language))}</strong></p>
            </section>
          )}

          <form className="cash-panel cash-inline-form" onSubmit={(event) => void createPlan(event)}>
            <h2>{copy.createPlan}</h2>
            <label>{copy.planName}
              <input required maxLength={100} value={planName}
                onChange={(event) => setPlanName(event.target.value)} />
            </label>
            <label>{copy.period}
              <select value={planPeriod} onChange={(event) => setPlanPeriod(event.target.value as 'MONTHLY' | 'ANNUAL')}>
                <option value="MONTHLY">{copy.monthly}</option>
                <option value="ANNUAL">{copy.annual}</option>
              </select>
            </label>
            <label>{copy.price}
              <input type="number" min="0.01" step="0.01" required value={planPrice}
                onChange={(event) => setPlanPrice(event.target.value)} />
            </label>
            <label>{copy.trialDays}
              <input type="number" min="0" max="365" required value={planTrialDays}
                onChange={(event) => setPlanTrialDays(event.target.value)} />
            </label>
            <button className="button-primary" disabled={busy}>{copy.save}</button>
          </form>

          <section className="cash-panel">
            <h2>{copy.planList}</h2>
            {plans.length === 0 ? <p>{copy.noPlans}</p> : (
              <div className="cash-refund-list">
                {plans.map((plan) => (
                  <article key={plan.id}>
                    <div>
                      <strong>{plan.name}</strong>
                      <span>{plan.period === 'MONTHLY' ? copy.monthly : copy.annual} · {copy.trialDays}: {plan.trialDays}</span>
                    </div>
                    <div className="cash-history-figures">
                      <strong>{money(plan.price, language)}</strong>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <form className="cash-panel cash-inline-form" onSubmit={(event) => void assignSubscription(event)}>
            <h2>{copy.assignSubscription}</h2>
            <label>{onboardingCopy.tenantId}
              <input required maxLength={128} value={assignTenantId}
                onChange={(event) => setAssignTenantId(event.target.value)} />
            </label>
            <label>{copy.plan}
              <select required value={assignPlanId}
                onChange={(event) => setAssignPlanId(event.target.value)}>
                <option value="">—</option>
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} ({plan.period === 'MONTHLY' ? copy.monthly : copy.annual})
                  </option>
                ))}
              </select>
            </label>
            <label className="cash-inline-form">
              {copy.startTrial}
              <input type="checkbox" checked={assignTrial}
                onChange={(event) => setAssignTrial(event.target.checked)} />
            </label>
            <button className="button-primary" disabled={busy}>{copy.save}</button>
          </form>

          <section className="cash-panel">
            <h2>{copy.subscriptionList}</h2>
            {subscriptions.length === 0 ? <p>{copy.noSubscriptions}</p> : (
              <div className="cash-refund-list">
                {subscriptions.map((subscription) => (
                  <article key={subscription.tenantId}>
                    <div>
                      <strong>{subscription.tenantName}</strong>
                      <span>{subscription.planName} · {subscription.period === 'MONTHLY' ? copy.monthly : copy.annual}</span>
                    </div>
                    <div className="cash-history-figures">
                      <strong>{copy[STATUS_LABELS[subscription.status]]}</strong>
                      <span>
                        {subscription.status === 'TRIAL' && subscription.trialEndsAt
                          ? `${copy.ends}: ${new Date(subscription.trialEndsAt).toLocaleDateString(numberLocale(language))}`
                          : subscription.currentPeriodEnd
                            ? `${copy.ends}: ${new Date(subscription.currentPeriodEnd).toLocaleDateString(numberLocale(language))}`
                            : ''}
                      </span>
                    </div>
                    <div className="cash-history-actions">
                      {(subscription.status === 'ACTIVE' || subscription.status === 'TRIAL') && (
                        <button type="button" className="button-secondary" disabled={busy}
                          onClick={() => void changeState(subscription, 'SUSPEND')}>
                          {copy.suspend}
                        </button>
                      )}
                      {subscription.status === 'SUSPENDED' && (
                        <button type="button" className="button-secondary" disabled={busy}
                          onClick={() => void changeState(subscription, 'RESUME')}>
                          {copy.resume}
                        </button>
                      )}
                      {subscription.status !== 'CANCELLED' && (
                        <button type="button" className="button-secondary" disabled={busy}
                          onClick={() => void changeState(subscription, 'CANCEL')}>
                          {copy.cancelLabel}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
      </>

      {error && <p className="product-error" role="alert">{error}</p>}
      {notice && <p className="product-success" role="status">{notice}</p>}
    </section>
  )
}
