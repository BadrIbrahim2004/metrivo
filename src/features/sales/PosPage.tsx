import { useEffect, useMemo, useRef, useState } from 'react'
import { FilePlus2, Minus, Percent, Plus, Printer, Search, Trash2, X } from 'lucide-react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language, PageSession } from '../../types'
import InvoiceView from './InvoiceView'
import type { InvoiceData } from './InvoiceView'
import type { ReceiptSettings } from './receipt-settings'
import { authedFetch, authedPost, usePageSession } from '../../app/usePageSession'
import './pos.css'

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
  createdAt: string
  paymentMethod?: string
  items?: InvoiceData['items']
  returnId?: string | null
}

interface SaleDetail extends Sale {
  items: NonNullable<Sale['items']>
}

/** One open customer order (a tab in the POS). */
interface OrderTab {
  id: string
  label: string
  /** Optional customer name for this order. */
  customerName: string
  cart: SaleLine[]
  discount: string
  /** Why/how the discount (or surcharge) was applied. */
  discountReason: string
  /** 'discount' reduces the total, 'surcharge' adds to it. */
  discountMode: 'discount' | 'surcharge'
  selectedProductId?: string
  paymentMethod: string
  idempotencyKey: string
}

interface PosPageProps extends PageSession {
  t: AppTranslations
  language: Language
  /** Leaves the full-screen POS back to the manager layout. */
  onExitPos: () => void
}

function guessCategory(product: CatalogProduct, t: AppTranslations): string {
  const text = `${product.name} ${product.sku}`.toLowerCase()
  if (/(espresso|اسبريسو)/.test(text)) return t.ui.posCategoryEspresso
  if (/(latte|لاتيه)/.test(text)) return t.ui.posCategoryLatte
  if (/(cappucc|كابتشينو)/.test(text)) return t.ui.posCategoryCappuccino
  if (/(coffee|قهوة|قهوه|americano|mocha|لاته وايت)/.test(text)) return t.ui.posCategoryCoffee
  if (/(tea|شاي|كركديه|عصير|juice|مياه|water|مشروب غازي|soft|soda|كولا|cola|ليمون|mint|نعناع)/.test(text)) return t.ui.posCategoryDrinks
  if (/(cake|كيك|ديزرت|dessert|حلوانيات|تشيز|cheese|براوني|brownie|كرواسان|croissant|بسبوسه|بسبوسة|كنافة|قطايف)/.test(text)) return t.ui.posCategoryDessert
  if (/(ساندوتش|سندوتش|sandwich|برجر|burger|بيتزا|pizza|فطير|مناقيش|توست|toast)/.test(text)) return t.ui.posCategoryFood
  return t.ui.posCategoryOther
}

function cents(value: string): number {
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

function money(centsValue: number, language: Language): string {
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(centsValue / 100)
}

// Category accent colors keyed by the Arabic canonical label; English labels
// fall back to the sage green.
function categoryColor(label: string): string {
  return CATEGORY_COLORS[label] ?? '#4a7c59'
}

/** Payment labels live in the i18n table; nothing computed here anymore. */

const CATEGORY_COLORS: Record<string, string> = {
  espresso: '#6f4e37',
  latte: '#a0715c',
  cappuccino: '#8b5e3c',
  coffee: '#4b2e2a',
  drinks: '#1d7ed8',
  dessert: '#d926a9',
  food: '#e8871e',
  other: '#5b6472',
}



export default function PosPage({
  t,
  language,
  sessionToken,
  workspaces,
  onSessionExpired,
  onExitPos,
}: PosPageProps) {
  const copy = t.salesManagement
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const token = session.token
  const [selectedBranchId] = useState(session.branchId)
  const [catalog, setCatalog] = useState<CatalogProduct[]>([])
  const [loaded, setLoaded] = useState(false)
  const [tabs, setTabs] = useState<OrderTab[]>([
    {
      id: crypto.randomUUID(),
      label: t.ui.posTabFirst,
      customerName: '',
      cart: [],
      discount: '0.00',
      discountReason: '',
      discountMode: 'discount',
      paymentMethod: 'CASH',
      idempotencyKey: crypto.randomUUID(),
    },
  ])
  const [activeTabId, setActiveTabId] = useState(() => '')
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('')
  // '' means 'show everything' (the All tab)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  /** Discount / surcharge modal (value, reason, type). */
  const [discountOpen, setDiscountOpen] = useState(false)
  const [discountPercent, setDiscountPercent] = useState('')
  const [discountReason, setDiscountReason] = useState('')
  const [discountMode, setDiscountMode] = useState<'discount' | 'surcharge'>('discount')
  /** Payment chooser (restored) — opens from the checkout button. */
  const [payOpen, setPayOpen] = useState(false)
  const [cashPaymentOpen, setCashPaymentOpen] = useState(false)
  const [cashReceived, setCashReceived] = useState('')
  /** Reprint modal: today's orders, newest first, searchable by invoice code. */
  const [reprintOpen, setReprintOpen] = useState(false)
  const [recentSales, setRecentSales] = useState<Sale[]>([])
  const [reprintQuery, setReprintQuery] = useState('')
  const [reprintLoading, setReprintLoading] = useState(false)
  const [receipt, setReceipt] = useState<SaleDetail | null>(null)
  const [receiptSettings, setReceiptSettings] = useState<ReceiptSettings | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const branchId = selectedBranchId || session.branchId
  const workspace = workspaces.find((item) => item.branchId === branchId)
  const basePath = workspace
    ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
    `/branches/${encodeURIComponent(workspace.branchId)}/sales`
    : ''

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]
  const cart = activeTab?.cart ?? []
  const discount = activeTab?.discount ?? '0.00'
  const discountModeTab = activeTab?.discountMode ?? 'discount'
  const discountCents = /^\d{1,10}(\.\d{1,2})?$/.test(discount)
    ? cents(discount)
    : 0
  /** Negative value = discount, positive = surcharge (extra fee). */
  const adjustValue = discountCents > 0
    ? (discountModeTab === 'surcharge' ? discountCents : -discountCents)
    : 0
  const adjustReason = activeTab?.discountReason ?? ''
  const paymentMethod = activeTab?.paymentMethod ?? 'CASH'

  function updateActiveTab(patch: Partial<OrderTab>) {
    if (!activeTab) return
    setTabs((current) => current.map((tab) =>
      tab.id === activeTab.id ? { ...tab, ...patch } : tab,
    ))
  }

  function openNewTab() {
    const ordinals = [
      t.ui.posTabFirst, t.ui.posTabSecond, t.ui.posTabThird, t.ui.posTabFourth,
      t.ui.posTabFifth, t.ui.posTabSixth, t.ui.posTabSeventh, t.ui.posTabEighth,
    ]
    const tab: OrderTab = {
      id: crypto.randomUUID(),
      label: ordinals[tabs.length] ?? `${tabs.length + 1}`,
      customerName: '',
      cart: [],
      discount: '0.00',
      discountReason: '',
      discountMode: 'discount',
      paymentMethod: 'CASH',
      idempotencyKey: crypto.randomUUID(),
    }
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
  }

  function closeTab(tabId: string) {
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.id !== tabId)
      if (remaining.length === 0) {
        const fresh: OrderTab = {
          id: crypto.randomUUID(),
          label: t.ui.posTabFirst,
          customerName: '',
          cart: [],
          discount: '0.00',
      discountReason: '',
      discountMode: 'discount',
          paymentMethod: 'CASH',
          idempotencyKey: crypto.randomUUID(),
        }
        setActiveTabId(fresh.id)
        return [fresh]
      }
      if (activeTabId === tabId) setActiveTabId(remaining[0].id)
      return remaining
    })
  }

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogProduct[]>()
    for (const product of catalog) {
      const key = guessCategory(product, t)
      const list = map.get(key) ?? []
      list.push(product)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ar'))
  }, [catalog, t])

  const categories = useMemo(
    () => [t.ui.posCategoryAll, ...grouped.map(([key]) => key)],
    [grouped, t],
  )

  const visibleProducts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return catalog.filter((product) => {
      const inCategory =
        activeCategory === '' || guessCategory(product, t) === activeCategory
      if (!inCategory) return false
      if (!query) return true
      return (
        product.name.toLocaleLowerCase().includes(query) ||
        product.sku.toLocaleLowerCase().includes(query)
      )
    })
  }, [catalog, activeCategory, search, t])

  const productsById = useMemo(
    () => new Map(catalog.map((product) => [product.id, product])),
    [catalog],
  )

  const subtotalCents = Math.round(cart.reduce((sum, line) => {
    const product = productsById.get(line.productId)
    return sum + (product ? cents(product.price) * line.quantity : 0)
  }, 0))
  const totalCents = Math.max(0,
    discountModeTab === 'surcharge'
      ? subtotalCents + discountCents
      : subtotalCents - discountCents,
  )
  const selectedProductId = activeTab?.selectedProductId &&
    cart.some((line) => line.productId === activeTab.selectedProductId)
    ? activeTab.selectedProductId
    : cart[cart.length - 1]?.productId
  const selectedCartLine = cart.find((line) => line.productId === selectedProductId)
  const selectedProduct = selectedProductId
    ? productsById.get(selectedProductId)
    : undefined
  const receivedCents = /^\d{1,10}(\.\d{1,2})?$/.test(cashReceived.trim())
    ? cents(cashReceived.trim())
    : 0
  const changeCents = Math.max(0, receivedCents - totalCents)
  const cashPaymentValid = paymentMethod !== 'CASH' || receivedCents >= totalCents
  const cashSuggestions = (() => {
    const roundUpTo = (amount: number, step: number) =>
      Math.ceil((amount + 1) / step) * step
    return [...new Set([
      totalCents,
      roundUpTo(totalCents, 5000),
      roundUpTo(totalCents, 10000),
      roundUpTo(totalCents, 20000),
    ])]
  })()

  // Load catalog on mount / whenever the branch changes.
  useEffect(() => {
    if (!basePath || !token) return
    let cancelled = false
    authedFetch<CatalogProduct[]>(`${basePath}/catalog`, token, onSessionExpired)
      .then((products) => {
        if (!cancelled) {
          setCatalog(products)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) setError(copy.requestFailed)
      })
    return () => { cancelled = true }
  }, [basePath, token, copy.requestFailed, onSessionExpired])

  // Shift status fetch (kept minimal; wording drives checkout errors only).
  useEffect(() => {
    if (!basePath || !token) return
    authedFetch<{ shift: { status: string } | null }>(
      basePath.replace('/sales', '/cash/shift'), token, onSessionExpired,
    ).catch(() => undefined)
  }, [basePath, token, onSessionExpired])

  // Focus modals when they open.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  function addProduct(productId: string) {
    if (!activeTab) return
    const product = productsById.get(productId)
    const currentQuantity =
      activeTab.cart.find((line) => line.productId === productId)?.quantity ?? 0
    if (!product || currentQuantity >= Number(product.stock)) return
    setTabs((current) => current.map((tab) => {
      if (tab.id !== activeTab.id) return tab
      const existing = tab.cart.find((line) => line.productId === productId)
      if (existing) {
        return {
          ...tab,
          selectedProductId: productId,
          cart: tab.cart.map((line) =>
            line.productId === productId
              ? { ...line, quantity: line.quantity + 1 }
              : line,
          ),
        }
      }
      return {
        ...tab,
        cart: [...tab.cart, { productId, quantity: 1 }],
        selectedProductId: productId,
      }
    }))
    setError('')
  }

  /** Sale quantities are whole units to match inventory and the API contract. */
  function setQuantity(productId: string, value: number) {
    if (!activeTab) return
    const product = productsById.get(productId)
    if (!product || !Number.isSafeInteger(value)) return
    const qty = Math.min(Math.max(value, 0), Number(product.stock))
    setTabs((current) => current.map((tab) => {
      if (tab.id !== activeTab.id) return tab
      if (qty === 0) {
        const remaining = tab.cart.filter((line) => line.productId !== productId)
        return {
          ...tab,
          cart: remaining,
          selectedProductId: tab.selectedProductId === productId
            ? remaining[remaining.length - 1]?.productId
            : tab.selectedProductId,
        }
      }
      const exists = tab.cart.some((line) => line.productId === productId)
      return {
        ...tab,
        selectedProductId: productId,
        cart: exists
          ? tab.cart.map((line) =>
              line.productId === productId ? { ...line, quantity: qty } : line,
            )
          : [...tab.cart, { productId, quantity: qty }],
      }
    }))
  }

  function changeQuantity(productId: string, delta: number) {
    if (!activeTab) return
    const product = productsById.get(productId)
    if (!product) return
    setTabs((current) => current.map((tab) => {
      if (tab.id !== activeTab.id) return tab
      const currentQuantity = tab.cart.find((line) => line.productId === productId)?.quantity ?? 0
      const quantity = Math.min(currentQuantity + delta, Number(product.stock))
      const cart = tab.cart
        .map((line) => line.productId === productId ? { ...line, quantity } : line)
        .filter((line) => line.quantity > 0)
      return {
        ...tab,
        cart,
        selectedProductId: quantity > 0
          ? productId
          : cart[cart.length - 1]?.productId,
      }
    }))
  }

  /** Barcode scanner auto-fire: any Enter/typed SKU outside inputs → add to cart. */
  useEffect(() => {
    if (!catalog.length) return
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.key === 'Enter') {
        const code = buffer.trim().toLocaleLowerCase()
        buffer = ''
        if (!code) return
        const match = catalog.find(
          (product) => product.sku.toLocaleLowerCase() === code,
        )
        if (match) {
          addProduct(match.id)
        } else {
          setError(t.ui.posBarcodeNoMatch)
        }
        return
      }
      if (event.key.length === 1) {
        buffer += event.key
        clearTimeout(timer)
        timer = setTimeout(() => { buffer = '' }, 300)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog])

  /** Two-step checkout: checkout button opens the payment chooser, then confirms. */
  async function confirmCheckout() {
    if (!workspace || !cart.length || !activeTab) return
    if (!cashPaymentValid) {
      setError(t.ui.posCashInsufficient)
      return
    }
    setBusy(true)
    setError('')
    try {
      const salePayload: {
        lines: SaleLine[]
        discount: string
        paymentMethod: string
        surcharge?: string
        customerName?: string
        adjustmentReason?: string
        cashReceived?: string
      } = {
        lines: cart,
        discount: discountModeTab === 'discount' ? discount : '0.00',
        paymentMethod,
      }
      if (paymentMethod === 'CASH') {
        salePayload.cashReceived = cashReceived.trim() || (totalCents / 100).toFixed(2)
      }
      if (discountModeTab === 'surcharge' && discountCents > 0) {
        salePayload.surcharge = discount
      }
      if (activeTab.customerName.trim()) {
        salePayload.customerName = activeTab.customerName.trim()
      }
      if (adjustReason.trim()) {
        salePayload.adjustmentReason = adjustReason.trim()
      }
      const currentReceiptSettings = receiptSettings ?? await authedFetch<ReceiptSettings>(
        `/api/tenants/${encodeURIComponent(workspace.tenantId)}/receipt-settings`,
        token,
        onSessionExpired,
      )
      const completed = await authedPost<SaleDetail>(basePath, token, onSessionExpired, {
        method: 'POST',
        headers: { 'Idempotency-Key': activeTab.idempotencyKey },
        body: JSON.stringify(salePayload),
      })
      setReceiptSettings(currentReceiptSettings)
      // This tab is done: clear it for the next customer, keep others intact.
      updateActiveTab({
        cart: [],
        selectedProductId: undefined,
        discount: '0.00',
        customerName: '',
        discountReason: '',
        discountMode: 'discount',
        idempotencyKey: crypto.randomUUID(),
      })
      setNotice(`${t.ui.posSaleDone} ${completed.invoiceNumber}`)
      setReceipt(completed)
      setPayOpen(false)
      setCashPaymentOpen(false)
      setCashReceived('')
      // Toast auto-dismisses after 3 seconds.
      setTimeout(() => setNotice(''), 3000)
      const refreshed = await authedFetch<CatalogProduct[]>(
        `${basePath}/catalog`, token, onSessionExpired,
      ).catch(() => catalog)
      setCatalog(refreshed)
    } catch (err) {
      if (activeTab) {
        updateActiveTab({ idempotencyKey: crypto.randomUUID() })
      }
      setError(
        err instanceof Error && err.message === 'conflict-shift'
          ? t.ui.posNeedOpenShift
          : copy.requestFailed,
      )
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    onSessionExpired()
  }

  function openPayment() {
    setError('')
    setPayOpen(true)
  }

  function openCashPayment() {
    updateActiveTab({ paymentMethod: 'CASH' })
    setCashReceived((totalCents / 100).toFixed(2))
    setPayOpen(false)
    setCashPaymentOpen(true)
    setError('')
  }

  /** Apply a percentage discount or surcharge (money value the API expects). */
  function applyDiscountPercent() {
    const pct = Number(discountPercent)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100 || discountPercent.trim() === '') {
      setError(t.ui.posDiscountInvalid)
      return
    }
    const value = Math.round(subtotalCents * pct) / 100 / 100
    updateActiveTab({
      discount: value.toFixed(2),
      discountReason: discountReason.trim(),
      discountMode,
    })
    setError('')
    setDiscountOpen(false)
    setDiscountPercent('')
    setDiscountReason('')
  }

  function clearDiscount() {
    updateActiveTab({ discount: '0.00', discountReason: '', discountMode: 'discount' })
    setDiscountOpen(false)
    setDiscountPercent('')
    setDiscountReason('')
  }

  /** Today's orders (newest first) for the reprint modal. */
  function openReprint() {
    setReprintQuery('')
    setReprintOpen(true)
    setRecentSales([])
    if (!basePath || !token) return
    setReprintLoading(true)
    authedFetch<Sale[]>(basePath, token, onSessionExpired)
      .then((sales) => {
        const today = new Date().toDateString()
        const todays = sales.filter(
          (sale) => new Date(sale.createdAt).toDateString() === today,
        )
        setRecentSales(
          todays.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
        )
      })
      .catch(() => setError(copy.requestFailed))
      .finally(() => setReprintLoading(false))
  }

  async function reprintSale(sale: Sale) {
    if (!basePath || !token || !workspace) return
    try {
      const detail = await authedFetch<SaleDetail>(
        `${basePath}/${encodeURIComponent(sale.id)}`,
        token,
        onSessionExpired,
      )
      const currentReceiptSettings = receiptSettings ?? await authedFetch<ReceiptSettings>(
        `/api/tenants/${encodeURIComponent(workspace.tenantId)}/receipt-settings`,
        token,
        onSessionExpired,
      )
      setReceiptSettings(currentReceiptSettings)
      setReceipt(detail)
      setReprintOpen(false)
    } catch {
      setError(copy.requestFailed)
    }
  }

  const qtyOf = (productId: string) =>
    cart.find((line) => line.productId === productId)?.quantity ?? 0
  const selectedCartLabel = selectedProduct
    ? `${copy.remove}: ${selectedProduct.name}`
    : copy.remove

  function removeSelectedCartLine() {
    if (!activeTab || !selectedProductId) return
    const remaining = activeTab.cart.filter((line) => line.productId !== selectedProductId)
    updateActiveTab({
      cart: remaining,
      selectedProductId: remaining[remaining.length - 1]?.productId,
    })
  }

  function startNewSale() {
    if (!activeTab) return
    updateActiveTab({
      cart: [],
      selectedProductId: undefined,
      discount: '0.00',
      discountReason: '',
      discountMode: 'discount',
      customerName: '',
      idempotencyKey: crypto.randomUUID(),
    })
    setError('')
    setNotice(t.ui.posNewSaleCleared)
    window.setTimeout(() => setNotice(''), 2500)
  }

  return (
    <section className="pos-screen" aria-label={copy.title}>
      {/* Slim corner bar */}
      <header className="pos-cornerbar">
        <button type="button" className="pos-corner-btn" onClick={onExitPos}>
          {t.ui.posExitPos}
        </button>
        <span className="pos-corner-brand">Metrivo</span>
        <button type="button" className="pos-corner-btn pos-corner-danger" onClick={logout}>
          {t.ui.logout}
        </button>
      </header>

      {/* 4-column workspace: categories | products | cart | side panel */}
      <div className="pos-workspace">
        {/* Column 1: categories as vertical small cards */}
        <nav className="pos-sidecats" aria-label={t.ui.settingsModulesLabel}>
          {categories.map((key) => (
            <button
              key={key}
              type="button"
              className={`pos-sidecat ${
                (activeCategory === '' && key === t.ui.posCategoryAll) ||
                activeCategory === key
                  ? 'pos-sidecat-active'
                  : ''
              }`}
              style={activeCategory === key && key !== t.ui.posCategoryAll
                ? { background: categoryColor(key), borderColor: categoryColor(key) }
                : undefined}
              onClick={() => setActiveCategory(key === t.ui.posCategoryAll ? '' : key)}
            >
              <span className="pos-sidecat-dot" style={{ background: categoryColor(key) }} />
              {key}
              <small>{key === t.ui.posCategoryAll ? catalog.length : (grouped.find(([k]) => k === key)?.[1].length ?? 0)}</small>
            </button>
          ))}
        </nav>

        {/* Column 2: products grid ~6 per row */}
        <main className="pos-grid" aria-label={copy.products}>
          {visibleProducts.length === 0 ? (
            <p className="pos-empty">
              {loaded ? copy.noProducts : t.ui.posLoadingItems}
            </p>
          ) : visibleProducts.map((product) => {
            const stock = Number(product.stock)
            const inCart = qtyOf(product.id)
            const color = categoryColor(guessCategory(product, t))
            return (
              <button
                type="button"
                className="pos-product"
                key={product.id}
                style={{ '--cat-color': color } as React.CSSProperties}
                disabled={stock <= inCart}
                onClick={() => addProduct(product.id)}
              >
                <span className="pos-product-copy">
                  <strong className="pos-product-name">{product.name}</strong>
                  <small>
                    {copy.available}: {product.stock}
                    {inCart > 0 && ` · ${t.ui.posInCart}: ${inCart}`}
                  </small>
                </span>
                <strong className="pos-product-price">
                  {money(cents(product.price), language)}
                </strong>
              </button>
            )
          })}
        </main>

        {/* Column 3: active cart + totals */}
        <aside className="pos-cart" aria-label={copy.cart}>
          <div className="pos-cart-headbar">
            <button
              type="button"
              className="pos-head-btn"
              disabled={
                !selectedCartLine ||
                selectedCartLine.quantity >=
                  Number(productsById.get(selectedCartLine.productId)?.stock ?? 0)
              }
              aria-label={`${copy.increase}: ${selectedProduct?.name ?? ''}`}
              title={selectedProduct?.name}
              onClick={() => {
                if (selectedProductId) changeQuantity(selectedProductId, 1)
              }}
            >
              <Plus size={17} />
            </button>
            <button
              type="button"
              className="pos-head-btn pos-head-btn-remove"
              disabled={!selectedCartLine}
              aria-label={selectedCartLabel}
              title={selectedCartLabel}
              onClick={removeSelectedCartLine}
            >
              <Trash2 size={17} />
            </button>
            <button
              type="button"
              className="pos-head-btn"
              disabled={!selectedCartLine}
              aria-label={`${copy.decrease}: ${selectedProduct?.name ?? ''}`}
              title={selectedProduct?.name}
              onClick={() => {
                if (selectedProductId) changeQuantity(selectedProductId, -1)
              }}
            >
              <Minus size={17} />
            </button>
          </div>
          <div className="pos-cart-lines">
            {cart.length === 0 ? (
              <p className="pos-empty">{t.ui.posCartHint}</p>
            ) : cart.map((line) => {
              const product = productsById.get(line.productId)
              if (!product) return null
              const stock = Number(product.stock)
              return (
                <div
                  className={`pos-cart-line${line.productId === selectedProductId ? ' pos-cart-line-selected' : ''}`}
                  key={line.productId}
                >
                  <button
                    type="button"
                    className="pos-line-name"
                    aria-pressed={line.productId === selectedProductId}
                    onClick={() => updateActiveTab({ selectedProductId: line.productId })}
                    title={product.name}
                  >
                    {product.name}
                  </button>
                  <strong className="pos-line-total">
                    {money(Math.round(cents(product.price) * line.quantity), language)}
                  </strong>
                  <input
                    className="pos-qty-input"
                    type="number"
                    min="0"
                    max={stock}
                    step="1"
                    inputMode="numeric"
                    value={line.quantity}
                    aria-label={copy.cart}
                    onChange={(event) => {
                      const value = Number(event.target.value)
                      if (Number.isSafeInteger(value) && event.target.value !== '') {
                        setQuantity(line.productId, value)
                      }
                    }}
                  />
                </div>
              )
            })}
          </div>

          <footer className="pos-cart-foot">
            <div className="pos-total-row pos-grand">
              <span>{t.ui.posTotalDue}</span>
              <strong>{money(totalCents, language)}</strong>
            </div>
            <div className="pos-cart-checkout-actions">
              <button
                type="button"
                className="pos-checkout pos-cart-cash-button"
                disabled={busy || !cart.length || adjustValue < 0 && -adjustValue > subtotalCents}
                onClick={openCashPayment}
              >
                {t.ui.posPayCash}
              </button>
              <button
                type="button"
                className="pos-checkout pos-cart-other-payment-button"
                disabled={busy || !cart.length || adjustValue < 0 && -adjustValue > subtotalCents}
                onClick={openPayment}
              >
                {busy ? t.productManagement.loading : t.ui.posOtherPaymentMethods}
              </button>
            </div>
            <div className="pos-foot-cards">
              <button
                type="button"
                className={`pos-mini-card ${adjustValue !== 0 ? 'pos-mini-card-active' : ''}`}
                onClick={() => { setDiscountOpen(true); setDiscountPercent(''); setDiscountReason('') }}
              >
                <span className="pos-mini-card-title">
                  <Percent size={15} aria-hidden="true" />
                  <strong>{t.ui.posDiscountCard}</strong>
                </span>
                <small>
                  {adjustValue !== 0
                    ? `${discountModeTab === 'surcharge' ? t.ui.posDiscountModeSurcharge : t.ui.posDiscountModeDiscount} · ${money(Math.abs(adjustValue), language)}`
                    : t.ui.posDiscountCardHint}
                </small>
              </button>
              <button
                type="button"
                className="pos-mini-card"
                onClick={openReprint}
              >
                <span className="pos-mini-card-title">
                  <Printer size={15} aria-hidden="true" />
                  <strong>{t.ui.posReprintTrigger}</strong>
                </span>
                <small>{t.ui.posReprintCardHint}</small>
              </button>
              <button
                type="button"
                className="pos-mini-card pos-mini-card-new"
                disabled={!cart.length || busy}
                onClick={startNewSale}
              >
                <span className="pos-mini-card-title">
                  <FilePlus2 size={15} aria-hidden="true" />
                  <strong>{t.ui.posNewSale}</strong>
                </span>
                <small>{t.ui.posNewSaleHint}</small>
              </button>
            </div>
          </footer>
        </aside>
        {/* Column 4: side panel — barcode, search trigger, open invoices */}
        <aside className="pos-sidepanel">
          <button
            type="button"
            className="pos-search-trigger"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={18} />
            {t.ui.posSearchTrigger}
          </button>

          <label className="pos-side-customer">
            <span>{t.ui.posCustomerLabel}</span>
            <input
              type="text"
              placeholder={t.ui.posCustomerPlaceholder}
              value={activeTab?.customerName ?? ''}
              onChange={(event) => updateActiveTab({ customerName: event.target.value })}
            />
          </label>

          <h3 className="pos-side-title">{t.ui.posOpenTabs}</h3>
          <div className="pos-opentabs">
            {tabs.map((tab) => {
              const tabTotal = tab.cart.reduce((sum, line) => {
                const product = productsById.get(line.productId)
                return sum + (product ? cents(product.price) * line.quantity : 0)
              }, 0)
              return (
                <div
                  key={tab.id}
                  className={`pos-opentab ${tab.id === activeTab?.id ? 'pos-opentab-active' : ''}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab.id === activeTab?.id}
                    onClick={() => setActiveTabId(tab.id)}
                  >
                    <strong>{tab.customerName.trim() || tab.label}</strong>
                    <small>
                      {tab.cart.length > 0
                        ? `${tab.cart.length} · ${money(Math.round(tabTotal), language)}`
                        : t.ui.posEmptyTab}
                    </small>
                  </button>
                  {tabs.length > 1 && (
                    <button
                      type="button"
                      className="pos-tab-close"
                      aria-label={t.ui.posPayClose}
                      onClick={() => closeTab(tab.id)}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              )
            })}
            <button type="button" className="pos-tab-add" onClick={openNewTab}>
              {t.ui.posNewTab}
            </button>
          </div>
        </aside>
      </div>

      {error && <p className="product-error pos-alert" role="alert">{error}</p>}
      {notice && <p className="pos-toast" role="status">{notice}</p>}

      {/* Centered search modal */}
      {searchOpen && (
        <div className="pos-modal-backdrop" onClick={() => setSearchOpen(false)}>
          <div className="pos-modal" role="dialog" aria-label={t.ui.posSearchTitle}
            onClick={(event) => event.stopPropagation()}>
            <header className="pos-modal-head">
              <h2><Search size={20} /> {t.ui.posSearchTitle}</h2>
              <button type="button" className="pos-modal-close"
                onClick={() => setSearchOpen(false)} aria-label={t.ui.posSearchClose}>
                <X size={18} />
              </button>
            </header>
            <div className="pos-modal-search">
              <Search size={18} />
              <input
                ref={searchRef}
                type="search"
                placeholder={copy.searchProducts}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className="pos-modal-results">
              {visibleProducts.length === 0 ? (
                <p className="pos-empty">{copy.noProducts}</p>
              ) : visibleProducts.slice(0, 24).map((product) => {
                const stock = Number(product.stock)
                const inCart = qtyOf(product.id)
                return (
                  <button
                    key={product.id}
                    type="button"
                    className="pos-modal-item"
                    disabled={stock <= inCart}
                    onClick={() => {
                      addProduct(product.id)
                      setSearch('')
                      setSearchOpen(false)
                    }}
                  >
                    <strong>{product.name}</strong>
                    <small>{product.sku} · {copy.available}: {product.stock}</small>
                    <strong>{money(cents(product.price), language)}</strong>
                  </button>
                )
              })}
            </div>
            <p className="pos-modal-hint">{t.ui.posSearchHint}</p>
          </div>
        </div>
      )}

      {/* Discount modal: percentage + reason */}
      {discountOpen && (
        <div className="pos-modal-backdrop" onClick={() => setDiscountOpen(false)}>
          <div className="pos-modal pos-modal-sm" role="dialog" aria-label={t.ui.posDiscountModalTitle}
            onClick={(event) => event.stopPropagation()}>
            <header className="pos-modal-head">
              <h2>{t.ui.posDiscountModalTitle}</h2>
              <button type="button" className="pos-modal-close"
                onClick={() => setDiscountOpen(false)} aria-label={t.ui.posPayClose}>
                <X size={18} />
              </button>
            </header>
            <div className="pos-modal-body">
              <div className="pos-mode-toggle">
                <button
                  type="button"
                  className={`pos-mode-btn pos-mode-btn-minus ${discountMode === 'discount' ? 'pos-mode-btn-active' : ''}`}
                  onClick={() => setDiscountMode('discount')}
                >
                  <span className="pos-mode-sign">−</span> {t.ui.posDiscountModeDiscount}
                </button>
                <button
                  type="button"
                  className={`pos-mode-btn pos-mode-btn-plus ${discountMode === 'surcharge' ? 'pos-mode-btn-active' : ''}`}
                  onClick={() => setDiscountMode('surcharge')}
                >
                  <span className="pos-mode-sign">+</span> {t.ui.posDiscountModeSurcharge}
                </button>
              </div>
              <label className="pos-field">
                <span>
                  {discountMode === 'surcharge'
                    ? t.ui.posSurchargePercentLabel
                    : t.ui.posDiscountPercentLabel}
                </span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  autoFocus
                  value={discountPercent}
                  onChange={(event) => setDiscountPercent(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') applyDiscountPercent()
                  }}
                />
              </label>
              <div className="pos-quick-row">
                <span>{t.ui.posDiscountQuick}</span>
                {[5, 10, 20, 50].map((pct) => (
                  <button key={pct} type="button" className="pos-quick-btn"
                    onClick={() => setDiscountPercent(String(pct))}>
                    {pct}%
                  </button>
                ))}
              </div>
              <label className="pos-field">
                <span>{t.ui.posDiscountReasonLabel}</span>
                <input
                  type="text"
                  placeholder={t.ui.posDiscountReasonPlaceholder}
                  value={discountReason}
                  onChange={(event) => setDiscountReason(event.target.value)}
                />
              </label>
            </div>
            <div className="pos-modal-actions">
              {discountCents > 0 && (
                <button type="button" className="pos-pay-card pos-discount-clear"
                  onClick={clearDiscount}>
                  {t.ui.posDiscountClear}
                </button>
              )}
              <button type="button" className="pos-checkout pos-pay-confirm"
                onClick={applyDiscountPercent}>
                {t.ui.posDiscountApply}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reprint modal: today's orders, newest first, search by invoice code */}
      {reprintOpen && (
        <div className="pos-modal-backdrop" onClick={() => setReprintOpen(false)}>
          <div className="pos-modal" role="dialog" aria-label={t.ui.posReprintTitle}
            onClick={(event) => event.stopPropagation()}>
            <header className="pos-modal-head">
              <h2><Printer size={20} aria-hidden="true" /> {t.ui.posReprintTitle}</h2>
              <button type="button" className="pos-modal-close"
                onClick={() => setReprintOpen(false)} aria-label={t.ui.posPayClose}>
                <X size={18} />
              </button>
            </header>
            <div className="pos-modal-search">
              <Search size={18} />
              <input
                autoFocus
                type="text"
                placeholder={t.ui.posReprintSearchPlaceholder}
                value={reprintQuery}
                onChange={(event) => setReprintQuery(event.target.value)}
                autoComplete="off"
              />
            </div>
            <p className="pos-reprint-subtitle">{t.ui.posReprintToday}</p>
            <div className="pos-modal-results">
              {(() => {
                const q = reprintQuery.trim().toLocaleLowerCase()
                const list = q
                  ? recentSales.filter((sale) =>
                      sale.invoiceNumber.toLocaleLowerCase().includes(q),
                    )
                  : recentSales
                if (reprintLoading) {
                  return <p className="pos-empty">{t.ui.posReprintLoading}</p>
                }
                if (list.length === 0) return <p className="pos-empty">{t.ui.posReprintEmpty}</p>
                return list.map((sale) => (
                  <div key={sale.id} className="pos-reprint-item">
                    <div className="pos-reprint-info">
                      <strong>{sale.invoiceNumber}</strong>
                      <small>
                        {new Date(sale.createdAt).toLocaleTimeString(
                          numberLocale(language),
                          { hour: '2-digit', minute: '2-digit' },
                        )}
                        {' · '}{money(cents(sale.total), language)}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="pos-reprint-btn"
                      onClick={() => void reprintSale(sale)}
                    >
                      {t.ui.posReprintPrint}
                    </button>
                  </div>
                ))
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Payment chooser — restored: opens when hitting اكمل البيع */}
      {payOpen && (
        <div className="pos-modal-backdrop" onClick={() => setPayOpen(false)}>
          <div className="pos-modal pos-modal-sm" role="dialog" aria-label={t.ui.posPayTitle}
            onClick={(event) => event.stopPropagation()}>
            <header className="pos-modal-head">
              <h2>{t.ui.posPayTitle}</h2>
              <button type="button" className="pos-modal-close"
                onClick={() => setPayOpen(false)} aria-label={t.ui.posPayClose}>
                <X size={18} />
              </button>
            </header>
            <div className="pos-pay-total">
              <span>{t.ui.posTotalDue}</span>
              <strong>{money(totalCents, language)}</strong>
            </div>
            <div className="pos-pay-cards">
              {([
                ['INSTAPAY', '📲', t.ui.posPayInstapay],
                ['WALLET', '👛', t.ui.posPayWallet],
                ['FAWRY', '🏪', t.ui.posPayFawry],
                ['CARD', '💳', t.ui.posPayCard],
                ['BANK_TRANSFER', '🏦', t.ui.posPayBank],
              ] as Array<[string, string, string]>).map(([value, emoji, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`pos-pay-card ${paymentMethod === value ? 'pos-pay-card-active' : ''}`}
                  onClick={() => updateActiveTab({ paymentMethod: value })}
                >
                  <span className="pos-pay-emoji">{emoji}</span>
                  <strong>{label}</strong>
                </button>
              ))}
            </div>
            <div className="pos-pay-actions pos-pay-actions-single">
              <button
                type="button"
                className="pos-checkout pos-pay-confirm"
                disabled={busy || !cart.length || paymentMethod === 'CASH'}
                onClick={() => void confirmCheckout()}
              >
                {busy ? t.productManagement.loading : `✔ ${t.ui.posPayConfirm} — ${money(totalCents, language)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {cashPaymentOpen && (
        <div className="pos-modal-backdrop" onClick={() => setCashPaymentOpen(false)}>
          <div
            className="pos-modal pos-modal-sm pos-cash-modal"
            role="dialog"
            aria-label={t.ui.posPayCash}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="pos-modal-head">
              <h2>{t.ui.posCashTitle}</h2>
              <button
                type="button"
                className="pos-modal-close"
                onClick={() => setCashPaymentOpen(false)}
                aria-label={t.ui.posPayClose}
              >
                <X size={18} />
              </button>
            </header>
            <div className="pos-pay-total">
              <span>{t.ui.posTotalDue}</span>
              <strong>{money(totalCents, language)}</strong>
            </div>
            <div className="pos-cash-modal-body">
              <label htmlFor="pos-cash-received">{t.ui.posCashReceived}</label>
              <div className="pos-cash-tender-input">
                <input
                  id="pos-cash-received"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  autoFocus
                  value={cashReceived}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setCashReceived(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !busy && cashPaymentValid) {
                      event.preventDefault()
                      void confirmCheckout()
                    }
                  }}
                />
                <small>{t.cashManagement.cash}</small>
              </div>
              <div className="pos-cash-suggestions" aria-label={t.ui.posCashSuggestions}>
                {cashSuggestions.map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    className={receivedCents === amount ? 'pos-cash-suggestion-active' : ''}
                    onClick={() => setCashReceived((amount / 100).toFixed(2))}
                  >
                    {money(amount, language)}
                  </button>
                ))}
              </div>
              <p className={receivedCents < totalCents ? 'pos-cash-change pos-cash-short' : 'pos-cash-change'}>
                <span>{receivedCents < totalCents ? t.ui.posCashInsufficient : t.ui.posCashChange}</span>
                <strong>
                  {receivedCents < totalCents
                    ? money(Math.max(0, totalCents - receivedCents), language)
                    : money(changeCents, language)}
                </strong>
              </p>
            </div>
            <div className="pos-pay-actions pos-pay-actions-single">
              <button
                type="button"
                className="pos-checkout pos-pay-confirm"
                disabled={busy || !cart.length || !cashPaymentValid}
                onClick={() => void confirmCheckout()}
              >
                {busy ? t.productManagement.loading : `✔ ${t.ui.posPayConfirm} — ${money(totalCents, language)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {receipt && (
        <InvoiceView
          invoice={receipt}
          branchName={workspace?.branchName ?? ''}
          receiptSettings={receiptSettings}
          language={language}
          t={t}
          autoPrint
          onClose={() => setReceipt(null)}
        />
      )}
    </section>
  )
}
