import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Minus, Plus, Search, ShoppingBag, Trash2 } from 'lucide-react'
import type { AppTranslations } from '../../i18n'

interface WorkspaceBranch {
  tenantId: string
  tenantName: string
  branchId: string
  branchName: string
}

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
  total: string
  status: string
  createdAt: string
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

interface SalesPageProps {
  t: AppTranslations
  language: 'ar' | 'en'
}

async function apiRequest<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    throw new Error('request')
  }
  return await response.json() as T
}

function cents(value: string): number {
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

function money(centsValue: number, language: 'ar' | 'en'): string {
  return new Intl.NumberFormat(language === 'ar' ? 'ar-EG' : 'en-EG', {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(centsValue / 100)
}

export default function SalesPage({ t, language }: SalesPageProps) {
  const copy = t.salesManagement
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [workspaces, setWorkspaces] = useState<WorkspaceBranch[]>([])
  const [branchId, setBranchId] = useState('')
  const [catalog, setCatalog] = useState<CatalogProduct[]>([])
  const [cart, setCart] = useState<SaleLine[]>([])
  const [search, setSearch] = useState('')
  const [discount, setDiscount] = useState('0.00')
  const [paymentMethod, setPaymentMethod] = useState('CASH')
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [history, setHistory] = useState<Sale[]>([])
  const [receipt, setReceipt] = useState<Sale | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const workspace = workspaces.find((item) => item.branchId === branchId)
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

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await apiRequest<{ accessToken: string }>(
        '/api/auth/login',
        '',
        { method: 'POST', body: JSON.stringify({ email, password }) },
      )
      const authorizedBranches = await apiRequest<WorkspaceBranch[]>(
        '/api/auth/workspaces',
        result.accessToken,
      )
      setToken(result.accessToken)
      setWorkspaces(authorizedBranches)
      setBranchId(authorizedBranches[0]?.branchId ?? '')
      setPassword('')
    } catch {
      setError(copy.loginFailed)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!token || !basePath) return
    let cancelled = false
    void Promise.all([
      apiRequest<CatalogProduct[]>(`${basePath}/catalog`, token),
      apiRequest<Sale[]>(basePath, token).catch(() => []),
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
  }, [token, basePath, copy.requestFailed])

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
      const completed = await apiRequest<Sale>(basePath, token, {
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
      const refreshed = await apiRequest<Sale[]>(basePath, token).catch(() => history)
      setHistory(refreshed)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    setToken('')
    setWorkspaces([])
    setBranchId('')
    setCatalog([])
    setCart([])
    setHistory([])
    setReceipt(null)
    setPassword('')
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

      {!token ? (
        <form className="product-login-panel sales-login" onSubmit={(event) => void login(event)}>
          <p>{copy.loginRequired}</p>
          <label>
            {t.productManagement.email}
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            {t.productManagement.password}
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button type="submit" className="button-primary" disabled={busy}>
            {busy ? t.productManagement.loading : t.productManagement.login}
          </button>
        </form>
      ) : (
        <>
          <div className="sales-toolbar">
            <label className="branch-picker">
              {t.productManagement.chooseBranch}
              <select
                value={branchId}
                onChange={(event) => {
                  setBranchId(event.target.value)
                  setCatalog([])
                  setCart([])
                  setReceipt(null)
                }}
              >
                {workspaces.map((item) => (
                  <option key={`${item.tenantId}:${item.branchId}`} value={item.branchId}>
                    {item.tenantName} — {item.branchName}
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
                        <small>{product.sku} · {copy.available}: {product.stock}</small>
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
                      <time>{new Date(sale.createdAt).toLocaleString(language === 'ar' ? 'ar-EG' : 'en-EG')}</time>
                    </div>
                    <strong>{money(cents(sale.total), language)}</strong>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {error && <p className="product-error" role="alert">{error}</p>}
    </section>
  )
}
