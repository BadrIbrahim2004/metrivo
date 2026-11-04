import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, RefreshCw, Truck } from 'lucide-react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language, PageSession } from '../../types'
import { authedFetch, usePageSession } from '../../app/usePageSession'

interface Supplier {
  id: string
  name: string
  phone: string | null
  email: string | null
  isActive: boolean
}

interface Product {
  id: string
  sku: string
  name: string
  isActive: boolean
}

interface PurchaseItem {
  id: string
  productId: string
  productName: string
  productSku: string
  quantity: number
  unitCost: string
  lineTotal: string
}

interface Purchase {
  id: string
  receiptNumber: string
  supplierInvoiceNumber: string | null
  supplierId: string
  supplierName: string
  status: 'DRAFT' | 'RECEIVED' | 'CANCELLED'
  subtotal: string
  paid: string
  balance: string
  createdAt: string
  items: PurchaseItem[]
}

interface PurchaseLineDraft {
  productId: string
  quantity: string
  unitCost: string
}

interface ProcurementPageProps extends PageSession {
  t: AppTranslations
  language: Language
}

function formatMoney(value: string, language: Language): string {
  const amount = Number(value)
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(amount)
}

export default function ProcurementPage({
  t,
  language,
  sessionToken,
  workspaces,
  onSessionExpired,
}: ProcurementPageProps) {
  const copy = t.procurement
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const token = session.token
  const [branchId, setBranchId] = useState(session.branchId)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [loadedBranch, setLoadedBranch] = useState('')
  const [supplierName, setSupplierName] = useState('')
  const [supplierPhone, setSupplierPhone] = useState('')
  const [supplierEmail, setSupplierEmail] = useState('')
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState('')
  const [selectedSupplierId, setSelectedSupplierId] = useState('')
  const [selectedProductId, setSelectedProductId] = useState('')
  const [lineQuantity, setLineQuantity] = useState('1')
  const [lineUnitCost, setLineUnitCost] = useState('')
  const [purchaseLines, setPurchaseLines] = useState<PurchaseLineDraft[]>([])
  const [paymentAmounts, setPaymentAmounts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [procTab, setProcTab] = useState<'view' | 'add' | 'purchase' | 'pay'>('view')

  const workspace = workspaces.find((item) => item.branchId === branchId)
  const branchBase = workspace
    ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
      `/branches/${encodeURIComponent(workspace.branchId)}`
    : ''

  const loadData = useCallback(async (currentToken: string, basePath: string) => {
    const [nextSuppliers, nextProducts, nextPurchases] = await Promise.all([
      authedFetch<Supplier[]>(`${basePath}/suppliers`, currentToken, onSessionExpired),
      authedFetch<Product[]>(`${basePath}/products`, currentToken, onSessionExpired),
      authedFetch<Purchase[]>(`${basePath}/purchases`, currentToken, onSessionExpired),
    ])
    setSuppliers(nextSuppliers)
    setProducts(nextProducts.filter((product) => product.isActive))
    setPurchases(nextPurchases)
    setLoadedBranch(basePath)
    setSelectedSupplierId((current) =>
      nextSuppliers.some((supplier) => supplier.id === current)
        ? current
        : nextSuppliers.find((supplier) => supplier.isActive)?.id ?? '',
    )
    setSelectedProductId((current) =>
      nextProducts.some((product) => product.id === current && product.isActive)
        ? current
        : nextProducts.find((product) => product.isActive)?.id ?? '',
    )
  }, [onSessionExpired])

  useEffect(() => {
    if (!token || !branchBase) return
    let cancelled = false
    void Promise.resolve()
      .then(() => cancelled ? undefined : loadData(token, branchBase))
      .catch(() => {
        if (!cancelled) setError(copy.requestFailed)
      })
      .finally(() => {
        if (!cancelled) setBusy('')
      })
    return () => {
      cancelled = true
    }
  }, [token, branchBase, copy.requestFailed, onSessionExpired, loadData])

  async function addSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!branchBase) return
    setBusy('supplier')
    setError('')
    setNotice('')
    try {
      await authedFetch<Supplier>(`${branchBase}/suppliers`, token, onSessionExpired, {
        method: 'POST',
        body: JSON.stringify({
          name: supplierName,
          phone: supplierPhone || undefined,
          email: supplierEmail || undefined,
        }),
      })
      setSupplierName('')
      setSupplierPhone('')
      setSupplierEmail('')
      setNotice(copy.supplierCreated)
      await loadData(token, branchBase)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy('')
    }
  }

  async function toggleSupplier(supplier: Supplier) {
    if (!branchBase) return
    setBusy(`supplier:${supplier.id}`)
    setError('')
    setNotice('')
    try {
      await authedFetch<Supplier>(
        `${branchBase}/suppliers/${encodeURIComponent(supplier.id)}`,
        token,
        onSessionExpired,
        {
          method: 'PATCH',
          body: JSON.stringify({ isActive: !supplier.isActive }),
        },
      )
      setNotice(supplier.isActive ? copy.supplierDisabled : copy.supplierEnabled)
      await loadData(token, branchBase)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy('')
    }
  }

  function addPurchaseLine() {
    const quantity = Number(lineQuantity)
    if (
      !selectedProductId ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(lineUnitCost) ||
      purchaseLines.some((line) => line.productId === selectedProductId)
    ) {
      setError(copy.invalidLine)
      return
    }
    setError('')
    setPurchaseLines((current) => [
      ...current,
      { productId: selectedProductId, quantity: String(quantity), unitCost: lineUnitCost },
    ])
    setLineQuantity('1')
    setLineUnitCost('')
  }

  async function createPurchase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!branchBase || !selectedSupplierId || !purchaseLines.length) return
    setBusy('purchase')
    setError('')
    setNotice('')
    try {
      await authedFetch<Purchase>(`${branchBase}/purchases`, token, onSessionExpired, {
        method: 'POST',
        headers: { 'Idempotency-Key': `purchase-${crypto.randomUUID()}` },
        body: JSON.stringify({
          supplierId: selectedSupplierId,
          supplierInvoiceNumber: supplierInvoiceNumber || undefined,
          items: purchaseLines.map((line) => ({
            productId: line.productId,
            quantity: Number(line.quantity),
            unitCost: line.unitCost,
          })),
        }),
      })
      setPurchaseLines([])
      setSupplierInvoiceNumber('')
      setNotice(copy.purchaseCreated)
      await loadData(token, branchBase)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy('')
    }
  }

  async function receivePurchase(purchaseId: string) {
    if (!branchBase) return
    setBusy(`receive:${purchaseId}`)
    setError('')
    setNotice('')
    try {
      await authedFetch<Purchase>(
        `${branchBase}/purchases/${encodeURIComponent(purchaseId)}/receive`,
        token,
        onSessionExpired,
        { method: 'POST' },
      )
      setNotice(copy.purchaseReceived)
      await loadData(token, branchBase)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy('')
    }
  }

  async function cancelDraftPurchase(purchaseId: string) {
    if (!branchBase) return
    setBusy(`cancel:${purchaseId}`)
    setError('')
    setNotice('')
    try {
      await authedFetch<Purchase>(
        `${branchBase}/purchases/${encodeURIComponent(purchaseId)}/cancel`,
        token,
        onSessionExpired,
        { method: 'POST' },
      )
      setNotice(copy.purchaseCancelled)
      await loadData(token, branchBase)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy('')
    }
  }

  async function payPurchase(purchase: Purchase) {
    const amount = paymentAmounts[purchase.id] ?? ''
    if (!branchBase || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(amount)) {
      setError(copy.invalidPayment)
      return
    }
    setBusy(`payment:${purchase.id}`)
    setError('')
    setNotice('')
    try {
      await authedFetch(
        `${branchBase}/purchases/${encodeURIComponent(purchase.id)}/payments`,
        token,
        onSessionExpired,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': `payment-${crypto.randomUUID()}` },
          body: JSON.stringify({ amount, method: 'CASH' }),
        },
      )
      setPaymentAmounts((current) => ({ ...current, [purchase.id]: '' }))
      setNotice(copy.paymentRecorded)
      await loadData(token, branchBase)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy('')
    }
  }

  function logout() {
    onSessionExpired()
  }

  const productName = (productId: string) =>
    products.find((product) => product.id === productId)?.name ?? productId

  return (
    <section className="page-content procurement-page">
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

      <nav className="page-tabs" aria-label={t.ui.suppliersTabsLabel}>
        <button type="button"
          className={`page-tab ${procTab === 'view' ? 'page-tab-active' : ''}`}
          onClick={() => setProcTab('view')}>{t.ui.tabsView}</button>
        <button type="button"
          className={`page-tab ${procTab === 'add' ? 'page-tab-active' : ''}`}
          onClick={() => setProcTab('add')}>{t.ui.tabsNewSupplier}</button>
        <button type="button"
          className={`page-tab ${procTab === 'purchase' ? 'page-tab-active' : ''}`}
          onClick={() => setProcTab('purchase')}>{t.ui.tabsPurchase}</button>
        <button type="button"
          className={`page-tab ${procTab === 'pay' ? 'page-tab-active' : ''}`}
          onClick={() => setProcTab('pay')}>{t.ui.tabsPayments}</button>
      </nav>

      <div className="sales-toolbar">
            <label className="branch-picker">
              {t.productManagement.chooseBranch}
              <select
                value={branchId}
                onChange={(event) => setBranchId(event.target.value)}
              >
                {workspaces.map((item) => (
                  <option key={`${item.tenantId}:${item.branchId}`} value={item.branchId}>
                    {item.tenantName} â€” {item.branchName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button-secondary"
              disabled={!branchBase || busy !== ''}
              onClick={() => void loadData(token, branchBase).catch(() => setError(copy.requestFailed))}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {copy.refresh}
            </button>
          </div>

          {workspaces.length === 0 ? (
            <p className="product-empty">{t.productManagement.noBranches}</p>
          ) : loadedBranch !== branchBase ? (
            <p className="product-empty">{t.productManagement.loading}</p>
          ) : (
            <>
              {error && <p className="product-error" role="alert">{error}</p>}
              {notice && <p className="procurement-notice" role="status">{notice}</p>}

              {(procTab === 'add') && (
                <form className="procurement-card" onSubmit={(event) => void addSupplier(event)}>
                  <h2><Truck size={19} />{copy.addSupplier}</h2>
                  <label>
                    {copy.supplierName}
                    <input required maxLength={200} value={supplierName} onChange={(event) => setSupplierName(event.target.value)} />
                  </label>
                  <label>
                    {copy.phone}
                    <input maxLength={40} value={supplierPhone} onChange={(event) => setSupplierPhone(event.target.value)} />
                  </label>
                  <label>
                    {t.productManagement.email}
                    <input type="email" maxLength={320} value={supplierEmail} onChange={(event) => setSupplierEmail(event.target.value)} />
                  </label>
                  <button className="button-primary" type="submit" disabled={busy !== ''}>
                    {busy === 'supplier' ? t.productManagement.loading : copy.saveSupplier}
                  </button>
                </form>
                )}

                {(procTab === 'purchase') && (
                <form className="procurement-card" onSubmit={(event) => void createPurchase(event)}>
                  <h2>{copy.createPurchase}</h2>
                  <label>
                    {copy.supplier}
                    <select required value={selectedSupplierId} onChange={(event) => setSelectedSupplierId(event.target.value)}>
                      <option value="">{copy.chooseSupplier}</option>
                      {suppliers.filter((supplier) => supplier.isActive).map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {copy.supplierInvoice}
                    <input maxLength={100} value={supplierInvoiceNumber} onChange={(event) => setSupplierInvoiceNumber(event.target.value)} />
                  </label>
                  <div className="procurement-line-entry">
                    <label>
                      {t.dashboard.product}
                      <select value={selectedProductId} onChange={(event) => setSelectedProductId(event.target.value)}>
                        {products.map((product) => <option key={product.id} value={product.id}>{product.name} Â· {product.sku}</option>)}
                      </select>
                    </label>
                    <label>
                      {copy.quantity}
                      <input type="number" min="1" max="1000000" step="1" value={lineQuantity} onChange={(event) => setLineQuantity(event.target.value)} />
                    </label>
                    <label>
                      {copy.unitCost}
                      <input inputMode="decimal" value={lineUnitCost} onChange={(event) => setLineUnitCost(event.target.value)} />
                    </label>
                    <button type="button" className="button-secondary" onClick={addPurchaseLine} aria-label={copy.addLine}>
                      <Plus size={18} />
                    </button>
                  </div>
                  {purchaseLines.length > 0 && (
                    <ul className="procurement-draft-lines">
                      {purchaseLines.map((line) => (
                        <li key={line.productId}>
                          <span>{productName(line.productId)} Ã— {line.quantity}</span>
                          <span>{formatMoney(String(Number(line.unitCost) * Number(line.quantity)), language)}</span>
                          <button type="button" onClick={() => setPurchaseLines((current) => current.filter((item) => item.productId !== line.productId))}>
                            {copy.remove}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button className="button-primary" type="submit" disabled={busy !== '' || !selectedSupplierId || purchaseLines.length === 0}>
                    {busy === 'purchase' ? t.productManagement.loading : copy.saveDraft}
                  </button>
                </form>
                )}

              {(procTab === 'view' || procTab === 'pay') && (
              <section className="procurement-card procurement-table-card">
                <h2>{copy.suppliers}</h2>
                {suppliers.length === 0 ? (
                  <p className="product-empty">{copy.noSuppliers}</p>
                ) : (
                  <div className="procurement-suppliers">
                    {suppliers.map((supplier) => (
                      <article key={supplier.id}>
                        <div>
                          <strong>{supplier.name}</strong>
                          <span>{supplier.phone || supplier.email || copy.noContact}</span>
                        </div>
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={busy !== ''}
                          onClick={() => void toggleSupplier(supplier)}
                        >
                          {busy === `supplier:${supplier.id}`
                            ? t.productManagement.loading
                            : supplier.isActive ? copy.disableSupplier : copy.enableSupplier}
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </section>
              )}

              {(procTab === 'view' || procTab === 'purchase' || procTab === 'pay') && (
              <section className="procurement-card procurement-table-card">
                <h2>{procTab === 'pay' ? t.ui.suppliersPaymentsHeading : copy.purchases}</h2>
                {purchases.length === 0 ? (
                  <p className="product-empty">{copy.noPurchases}</p>
                ) : (
                  <div className="procurement-purchases">
                    {purchases.map((purchase) => (
                      <article key={purchase.id} className="procurement-purchase">
                        <div className="procurement-purchase-heading">
                          <div>
                            <strong>{purchase.supplierName}</strong>
                            <span>{purchase.receiptNumber}{purchase.supplierInvoiceNumber ? ` Â· ${purchase.supplierInvoiceNumber}` : ''}</span>
                          </div>
                          <span className={`procurement-status ${purchase.status.toLowerCase()}`}>
                            {purchase.status === 'DRAFT'
                              ? copy.draft
                              : purchase.status === 'RECEIVED' ? copy.received : copy.cancelled}
                          </span>
                        </div>
                        <ul>
                          {purchase.items.map((item) => (
                            <li key={item.id}>
                              <span>{item.productName} Ã— {item.quantity}</span>
                              <span>{formatMoney(item.lineTotal, language)}</span>
                            </li>
                          ))}
                        </ul>
                        <div className="procurement-balance">
                          <span>{copy.total}: {formatMoney(purchase.subtotal, language)}</span>
                          <span>{copy.paid}: {formatMoney(purchase.paid, language)}</span>
                          <strong>{copy.balance}: {formatMoney(purchase.balance, language)}</strong>
                        </div>
                        {procTab !== 'view' && (purchase.status === 'DRAFT' ? (
                          <div className="procurement-actions">
                            <button
                              type="button"
                              className="button-primary"
                              disabled={busy !== ''}
                              onClick={() => void receivePurchase(purchase.id)}
                            >
                              {busy === `receive:${purchase.id}` ? t.productManagement.loading : copy.receive}
                            </button>
                            <button
                              type="button"
                              className="button-secondary"
                              disabled={busy !== ''}
                              onClick={() => void cancelDraftPurchase(purchase.id)}
                            >
                              {busy === `cancel:${purchase.id}` ? t.productManagement.loading : copy.cancelDraft}
                            </button>
                          </div>
                        ) : Number(purchase.balance) > 0 ? (
                          <div className="procurement-payment">
                            <label>
                              {copy.paymentAmount}
                              <input
                                inputMode="decimal"
                                value={paymentAmounts[purchase.id] ?? ''}
                                onChange={(event) => setPaymentAmounts((current) => ({ ...current, [purchase.id]: event.target.value }))}
                              />
                            </label>
                            <button
                              type="button"
                              className="button-secondary"
                              disabled={busy !== ''}
                              onClick={() => void payPurchase(purchase)}
                            >
                              {busy === `payment:${purchase.id}` ? t.productManagement.loading : copy.recordPayment}
                            </button>
                          </div>
                        ) : null)}
                      </article>
                    ))}
                  </div>
                )}
              </section>
              )}
            </>
          )}
    </section>
  )
}
