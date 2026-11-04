import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Minus, Plus, Search, ShoppingBag, Trash2 } from 'lucide-react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import InvoiceView from './InvoiceView'
import type { ReceiptSettings } from './receipt-settings'
import type { PageSession } from '../../types'
import { authedFetch, usePageSession } from '../../app/usePageSession'

interface CatalogProduct {
  id: string
  sku: string
  name: string
  price: string
  stock: string
}

interface SaleLine {
  productId: string
  quantity: number
}

interface Sale {
  id: string
  invoiceNumber: string
  subtotal?: string
  discount?: string
  surcharge?: string
  customerName?: string | null
  adjustmentReason?: string | null
  cashReceived?: string | null
  changeDue?: string | null
  total: string
  status: string
  createdAt: string
  returnId?: string | null
  refundAmount?: string | null
  refundStatus?: string | null
  items?: Array<{
    productId: string
    productName: string
    productSku: string
    quantity: number
    unitPrice: string
    lineTotal: string
  }>
  paymentMethod?: string
}

interface SalesPageProps extends PageSession {
  t: AppTranslations
  language: 'ar' | 'en'
}

interface ReprintState {
  invoice: Sale & { items: NonNullable<Sale['items']> }
  branchName: string
  receiptSettings: ReceiptSettings
}

function cents(value: string): number {
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

function money(centsValue: number, language: 'ar' | 'en'): string {
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(centsValue / 100)
}

export default function SalesPage({
  t,
  language,
  sessionToken,
  workspaces,
  onSessionExpired,
}: SalesPageProps) {
  const copy = t.salesManagement
  const session = usePageSession({
    sessionToken,
    workspaces,
    onSessionExpired,
  })
  const token = session.token
  const [selectedBranchId, setSelectedBranchId] = useState(session.branchId)
  const [catalog, setCatalog] = useState<CatalogProduct[]>([])
  const [cart, setCart] = useState<SaleLine[]>([])
  const [search, setSearch] = useState('')
  const [discount, setDiscount] = useState('0.00')
  const [paymentMethod, setPaymentMethod] = useState('CASH')
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [history, setHistory] = useState<Sale[]>([])
  const [receipt, setReceipt] = useState<Sale | null>(null)
  const [reprint, setReprint] = useState<ReprintState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const activeBranchId = selectedBranchId || session.branchId
  const workspace = workspaces.find((item) => item.branchId === activeBranchId)
  const basePath = workspace
    ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
      `/branches/${encodeURIComponent(workspace.branchId)}/sales`
    : ''

  const productsById = useMemo(
    () => new Map(catalog.map((product) => [product.id, product])),
    [catalog],
  )
  const filteredProducts = catalog.filter((product) => {
    const query = search.trim().toLocaleLowerCase()
    return !query ||
      product.name.toLocaleLowerCase().includes(query) ||
      product.sku.toLocaleLowerCase().includes(query)
  })
  const subtotalCents = cart.reduce((sum, line) => {
    const product = productsById.get(line.productId)
    return sum + (product ? cents(product.price) * line.quantity : 0)
  }, 0)
  const discountCents = /^\d{1,10}(\.\d{1,2})?$/.test(discount)
    ? cents(discount)
    : 0
  const totalCents = Math.max(0, subtotalCents - discountCents)

  useEffect(() => {
    if (!token || !basePath) return
    let cancelled = false
    void Promise.all([
      authedFetch<CatalogProduct[]>(`${basePath}/catalog`, token, onSessionExpired),
      authedFetch<Sale[]>(basePath, token, onSessionExpired).catch(() => []),
    ]).then(([nextCatalog, nextHistory]) => {
      if (!cancelled) {
        setCatalog(nextCatalog)
        setHistory(nextHistory)
      }
    }).catch(() => {
      if (!cancelled) setError(copy.requestFailed)
    })
    return () => {
      cancelled = true
    }
  }, [token, basePath, copy.requestFailed, onSessionExpired])

  function addProduct(productId: string) {
    setCart((current) => {
      const existing = current.find((line) => line.productId === productId)
      if (existing) {
        return current.map((line) =>
          line.productId === productId
            ? { ...line, quantity: line.quantity + 1 }
            : line,
        )
      }
      return [...current, { productId, quantity: 1 }]
    })
  }

  function changeQuantity(productId: string, delta: number) {
    setCart((current) =>
      current
        .map((line) =>
          line.productId === productId
            ? { ...line, quantity: line.quantity + delta }
            : line,
        )
        .filter((line) => line.quantity > 0),
    )
  }

  async function checkout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!workspace || !cart.length) return
    setBusy(true)
    setError('')
    try {
      const completed = await authedFetch<Sale>(basePath, token, onSessionExpired, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          lines: cart,
          discount,
          paymentMethod,
        }),
      })
      setReceipt(completed)
      setCart([])
      setDiscount('0.00')
      setIdempotencyKey(crypto.randomUUID())
      const refreshed = await authedFetch<Sale[]>(basePath, token, onSessionExpired).catch(() => history)
      setHistory(refreshed)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function returnSale(sale: Sale) {
    if (!basePath || sale.returnId || busy) return
    if (!window.confirm(copy.confirmFullReturn)) return
    const reason = window.prompt(copy.returnReasonPrompt)?.trim() ?? ''
    if (reason.length < 5) {
      setError(copy.returnReasonRequired)
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const recorded = await authedFetch<{
        id: string
        refundAmount: string
        refundStatus: string
      }>(
        `${basePath}/${encodeURIComponent(sale.id)}/return`,
        token,
        onSessionExpired,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': `return-${crypto.randomUUID()}` },
          body: JSON.stringify({ reason }),
        },
      )
      setHistory((current) => current.map((item) =>
        item.id === sale.id
          ? {
              ...item,
              returnId: recorded.id,
              refundAmount: recorded.refundAmount,
              refundStatus: recorded.refundStatus,
            }
          : item,
      ))
      setNotice(copy.returnRecorded)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function openReprint(sale: Sale) {
    if (!basePath || !workspace || busy) return
    setError('')
    try {
      const detail = await authedFetch<Sale & { items: NonNullable<Sale['items']> }>(
        `${basePath}/${encodeURIComponent(sale.id)}`,
        token,
        onSessionExpired,
      )
      const receiptSettings = await authedFetch<ReceiptSettings>(
        `/api/tenants/${encodeURIComponent(workspace.tenantId)}/receipt-settings`,
        token,
        onSessionExpired,
      )
      setReprint({
        invoice: detail,
        branchName: workspace?.branchName ?? '',
        receiptSettings,
      })
    } catch {
      setError(copy.requestFailed)
    }
  }

  function logout() {
    onSessionExpired()
  }

  return (
    <section className="page-content sales-page">
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

      {workspaces.length === 0 ? (
        <p className="product-empty">{t.productManagement.noBranches}</p>
      ) : (
      <>
          <div className="sales-toolbar">
            <label className="branch-picker">
              {t.productManagement.chooseBranch}
              <select
                value={selectedBranchId}
                onChange={(event) => {
                  setSelectedBranchId(event.target.value)
                  setCatalog([])
                  setCart([])
                  setReceipt(null)
                }}
              >
                {workspaces.map((item) => (
                  <option key={`${item.tenantId}:${item.branchId}`} value={item.branchId}>
                    {item.tenantName} â€” {item.branchName}
                  </option>
                ))}
              </select>
            </label>
            <label className="sales-search">
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                placeholder={copy.searchProducts}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>

          {workspaces.length === 0 ? (
            <p className="product-empty">{t.productManagement.noBranches}</p>
          ) : (
            <div className="sales-layout">
              <section className="sales-catalog" aria-label={copy.products}>
                {filteredProducts.length === 0 ? (
                  <p className="product-empty">{copy.noProducts}</p>
                ) : filteredProducts.map((product) => {
                  const stock = Number(product.stock)
                  const selectedQuantity =
                    cart.find((line) => line.productId === product.id)?.quantity ?? 0
                  return (
                    <button
                      type="button"
                      className="sales-product"
                      key={product.id}
                      disabled={stock <= selectedQuantity}
                      onClick={() => addProduct(product.id)}
                    >
                      <span className="sales-product-copy">
                        <strong>{product.name}</strong>
                        <small>{product.sku} Â· {copy.available}: {product.stock}</small>
                      </span>
                      <strong>{money(cents(product.price), language)}</strong>
                    </button>
                  )
                })}
              </section>

              <form className="sales-checkout" onSubmit={(event) => void checkout(event)}>
                <h2><ShoppingBag size={20} /> {copy.cart}</h2>
                <div className="sales-cart-lines">
                  {cart.length === 0 ? (
                    <p className="product-empty">{copy.emptyCart}</p>
                  ) : cart.map((line) => {
                    const product = productsById.get(line.productId)
                    if (!product) return null
                    return (
                      <div className="sales-cart-line" key={line.productId}>
                        <div className="sales-line-description">
                          <strong>{product.name}</strong>
                          <span>{money(cents(product.price) * line.quantity, language)}</span>
                        </div>
                        <div className="sales-quantity">
                          <button
                            type="button"
                            aria-label={copy.decrease}
                            onClick={() => changeQuantity(line.productId, -1)}
                          >
                            <Minus size={15} />
                          </button>
                          <span>{line.quantity}</span>
                          <button
                            type="button"
                            aria-label={copy.increase}
                            disabled={line.quantity >= Number(product.stock)}
                            onClick={() => changeQuantity(line.productId, 1)}
                          >
                            <Plus size={15} />
                          </button>
                          <button
                            type="button"
                            className="sales-remove"
                            aria-label={copy.remove}
                            onClick={() => setCart((current) =>
                              current.filter((item) => item.productId !== line.productId),
                            )}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>

                <label>
                  {copy.discount}
                  <input
                    type="number"
                    min="0"
                    max={(subtotalCents / 100).toFixed(2)}
                    step="0.01"
                    value={discount}
                    onChange={(event) => setDiscount(event.target.value)}
                  />
                </label>
                <label>
                  {copy.paymentMethod}
                  <select
                    value={paymentMethod}
                    onChange={(event) => setPaymentMethod(event.target.value)}
                  >
                    <option value="CASH">{copy.cash}</option>
                    <option value="CARD">{copy.card}</option>
                    <option value="BANK_TRANSFER">{copy.bankTransfer}</option>
                    <option value="OTHER">{copy.other}</option>
                  </select>
                </label>
                <div className="sales-total-row">
                  <span>{copy.subtotal}</span>
                  <strong>{money(subtotalCents, language)}</strong>
                </div>
                <div className="sales-total-row">
                  <span>{copy.discount}</span>
                  <strong>-{money(discountCents, language)}</strong>
                </div>
                <div className="sales-total-row sales-grand-total">
                  <span>{copy.total}</span>
                  <strong>{money(totalCents, language)}</strong>
                </div>
                <button
                  type="submit"
                  className="button-primary sales-submit"
                  disabled={busy || !cart.length || discountCents > subtotalCents}
                >
                  {busy ? t.productManagement.loading : copy.completeSale}
                </button>
              </form>
            </div>
          )}

          {receipt && (
            <div className="sales-receipt" role="status">
              <strong>{copy.saleComplete}: {receipt.invoiceNumber}</strong>
              <span>{money(cents(receipt.total), language)}</span>
              <button
                type="button"
                className="button-secondary"
                onClick={() => void openReprint(receipt)}
              >
                {t.invoice.print}
              </button>
            </div>
          )}

          <section className="sales-history">
            <h2>{copy.recentSales}</h2>
            {history.length === 0 ? (
              <p className="product-empty">{copy.noSales}</p>
            ) : (
              <div className="sales-history-list">
                {history.map((sale) => (
                  <article key={sale.id}>
                    <div>
                      <strong>{sale.invoiceNumber}</strong>
                      <time>{new Date(sale.createdAt).toLocaleString(numberLocale(language))}</time>
                    </div>
                    <div className="sales-history-actions">
                      <strong>{money(cents(sale.total), language)}</strong>
                      <button
                        type="button"
                        className="button-secondary"
                        disabled={busy}
                        onClick={() => void openReprint(sale)}
                      >
                        {t.invoice.reprint}
                      </button>
                      {sale.returnId ? (
                        <small>
                          {copy.returnPending}
                          {sale.refundAmount
                            ? ` Â· ${money(cents(sale.refundAmount), language)}`
                            : ''}
                        </small>
                      ) : (
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={busy}
                          onClick={() => void returnSale(sale)}
                        >
                          {copy.returnFullSale}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
      </>
      )}

      {error && <p className="product-error" role="alert">{error}</p>}
      {notice && <p className="product-success" role="status">{notice}</p>}

      {reprint && (
        <InvoiceView
          invoice={reprint.invoice}
          branchName={reprint.branchName}
          receiptSettings={reprint.receiptSettings}
          language={language}
          t={t}
          onClose={() => setReprint(null)}
        />
      )}
    </section>
  )
}
