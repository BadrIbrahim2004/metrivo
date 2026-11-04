import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { AppTranslations } from '../../i18n'
import { numberLocale } from '../../i18n/numbers'
import type { Language, PageSession } from '../../types'
import { authedFetch, usePageSession } from '../../app/usePageSession'

interface ProductRow {
  id: string
  name: string
  sku: string
  type: 'RETAIL' | 'INGREDIENT'
  price: string
  stock?: string
}

interface RecipeItem {
  id: string
  ingredientId: string
  ingredientName: string
  quantity: string
  wastePercent: string
  unitCost: string
  lineCost: string
}

interface RecipeRow {
  id: string
  productId: string
  productName: string
  productSku: string
  yieldQuantity: number
  estimatedCost: string
  items: RecipeItem[]
}

interface WasteRow {
  id: string
  productId: string
  productName: string
  quantity: string
  reason: string
  costImpact: string
  status: 'ACTIVE' | 'VOIDED'
}

interface BatchRow {
  id: string
  recipeId: string
  productName: string
  batchQuantity: number
  createdAt: string
}

interface RecipesPageProps extends PageSession {
  t: AppTranslations
  language: Language
}

function money(value: string, language: Language): string {
  return new Intl.NumberFormat(numberLocale(language), {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(Number(value))
}

export default function RecipesPage({
  t,
  language,
  sessionToken,
  workspaces,
  onSessionExpired,
}: RecipesPageProps) {
  const copy = t.recipes
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const token = session.token
  const [branchId, setBranchId] = useState(session.branchId)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [recipes, setRecipes] = useState<RecipeRow[]>([])
  const [waste, setWaste] = useState<WasteRow[]>([])
  const [selectedProductId, setSelectedProductId] = useState('')
  const [yieldQuantity, setYieldQuantity] = useState('1')
  const [items, setItems] = useState<Array<{ ingredientId: string; quantity: string; wastePercent: string }>>([])
  const [wasteForm, setWasteForm] = useState({ productId: '', quantity: '', reason: '' })
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const workspace = workspaces.find((item) => item.branchId === branchId)
  const basePath = workspace
    ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
      `/branches/${encodeURIComponent(workspace.branchId)}`
    : ''

  async function loadState(path = basePath, auth = token) {
    if (!path || !auth) return
    const [productList, recipeList, wasteList, batchList] = await Promise.all([
      authedFetch<ProductRow[]>(`${path}/products`, auth, onSessionExpired),
      authedFetch<RecipeRow[]>(`${path}/recipes`, auth, onSessionExpired),
      authedFetch<WasteRow[]>(`${path}/waste`, auth, onSessionExpired),
      authedFetch<BatchRow[]>(`${path}/production-batches`, auth, onSessionExpired),
    ])
    setProducts(productList)
    setRecipes(recipeList)
    setWaste(wasteList)
    setBatches(batchList)
  }

  useEffect(() => {
    if (!token || !basePath) return
    let cancelled = false
    const requestFailed = copy.requestFailed
    async function run() {
      try {
        const [productList, recipeList, wasteList, batchList] = await Promise.all([
          authedFetch<ProductRow[]>(`${basePath}/products`, token, onSessionExpired),
          authedFetch<RecipeRow[]>(`${basePath}/recipes`, token, onSessionExpired),
          authedFetch<WasteRow[]>(`${basePath}/waste`, token, onSessionExpired),
          authedFetch<BatchRow[]>(`${basePath}/production-batches`, token, onSessionExpired),
        ])
        if (cancelled) return
        setProducts(productList)
        setRecipes(recipeList)
        setWaste(wasteList)
        setBatches(batchList)
      } catch {
        if (!cancelled) setError(requestFailed)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [token, basePath, copy.requestFailed, onSessionExpired])

  function addItem() {
    setItems((current) => [...current, { ingredientId: '', quantity: '', wastePercent: '0' }])
  }

  function removeItem(index: number) {
    setItems((current) => current.filter((_, position) => position !== index))
  }

  async function saveRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!basePath || busy) return
    setBusy(true)
    setError('')
    try {
      await authedFetch(`${basePath}/recipes`, token, onSessionExpired, {
        method: 'POST',
        body: JSON.stringify({
          productId: selectedProductId,
          yieldQuantity: Number(yieldQuantity),
          items: items.map((item) => ({
            ingredientId: item.ingredientId,
            quantity: item.quantity,
            wastePercent: item.wastePercent || '0',
          })),
        }),
      })
      setItems([])
      setSelectedProductId('')
      await loadState()
      setNotice(copy.recipeSaved)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function produce(recipe: RecipeRow) {
    if (!basePath || busy) return
    if (!window.confirm(copy.confirmProduce)) return
    setBusy(true)
    setError('')
    try {
      await authedFetch(`${basePath}/production-batches`, token, onSessionExpired, {
        method: 'POST',
        headers: { 'Idempotency-Key': `batch-${crypto.randomUUID()}` },
        body: JSON.stringify({ recipeId: recipe.id, batchQuantity: 1 }),
      })
      await loadState()
      setNotice(copy.batchProduced)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function voidWaste(entry: WasteRow) {
    if (!basePath || busy) return
    if (!window.confirm(copy.confirmVoidWaste)) return
    setBusy(true)
    setError('')
    try {
      await authedFetch(`${basePath}/waste/${encodeURIComponent(entry.id)}`, token, onSessionExpired, {
        method: 'DELETE',
      })
      await loadState()
      setNotice(copy.wasteVoided)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function recordWaste(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!basePath || busy) return
    setBusy(true)
    setError('')
    try {
      await authedFetch(`${basePath}/waste`, token, onSessionExpired, {
        method: 'POST',
        headers: { 'Idempotency-Key': `waste-${crypto.randomUUID()}` },
        body: JSON.stringify(wasteForm),
      })
      setWasteForm({ productId: '', quantity: '', reason: '' })
      await loadState()
      setNotice(copy.wasteRecorded)
    } catch {
      setError(copy.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    onSessionExpired()
  }

  const ingredients = products.filter((product) => product.type === 'INGREDIENT')
  const retailProducts = products.filter((product) => product.type === 'RETAIL')

  return (
    <section className="page-content recipes-page">
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
          <label className="branch-picker">
            {t.productManagement.chooseBranch}
            <select value={branchId} onChange={(event) => {
              setBranchId(event.target.value)
              setProducts([])
              setRecipes([])
              setWaste([])
              setNotice('')
            }}>
              {workspaces.map((item) => (
                <option key={`${item.tenantId}:${item.branchId}`} value={item.branchId}>
                  {item.tenantName} â€” {item.branchName}
                </option>
              ))}
            </select>
          </label>

          <form className="cash-panel" onSubmit={(event) => void saveRecipe(event)}>
            <h2>{copy.recipeForm}</h2>
            <div className="cash-inline-form">
              <label>{copy.finishedProduct}
                <select required value={selectedProductId}
                  onChange={(event) => setSelectedProductId(event.target.value)}>
                  <option value="">â€”</option>
                  {retailProducts.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} ({product.sku})
                    </option>
                  ))}
                </select>
              </label>
              <label>{copy.yieldQuantity}
                <input type="number" min="1" required value={yieldQuantity}
                  onChange={(event) => setYieldQuantity(event.target.value)} />
              </label>
            </div>
            {items.map((item, index) => (
              <div className="cash-inline-form" key={`recipe-item-${index}`}>
                <label>{copy.ingredient}
                  <select required value={item.ingredientId}
                    onChange={(event) => {
                      const next = [...items]
                      next[index] = { ...item, ingredientId: event.target.value }
                      setItems(next)
                    }}>
                    <option value="">â€”</option>
                    {ingredients.map((ingredient) => (
                      <option key={ingredient.id} value={ingredient.id}>
                        {ingredient.name} ({ingredient.stock ?? '0'})
                      </option>
                    ))}
                  </select>
                </label>
                <label>{copy.quantity}
                  <input type="number" min="0.001" step="0.001" required value={item.quantity}
                    onChange={(event) => {
                      const next = [...items]
                      next[index] = { ...item, quantity: event.target.value }
                      setItems(next)
                    }} />
                </label>
                <label>{copy.wastePercent}
                  <input type="number" min="0" max="100" step="0.01" value={item.wastePercent}
                    onChange={(event) => {
                      const next = [...items]
                      next[index] = { ...item, wastePercent: event.target.value }
                      setItems(next)
                    }} />
                </label>
                <button type="button" className="button-secondary"
                  onClick={() => removeItem(index)}>
                  {copy.remove}
                </button>
              </div>
            ))}
            <div className="cash-inline-form">
              <button type="button" className="button-secondary" onClick={addItem}>
                {copy.addIngredient}
              </button>
              <button className="button-primary" disabled={busy || !items.length}>
                {copy.saveRecipe}
              </button>
            </div>
          </form>

          <section className="cash-panel">
            <h2>{copy.recipeList}</h2>
            {recipes.length === 0 ? <p>{copy.noRecipes}</p> : (
              <div className="cash-refund-list">
                {recipes.map((recipe) => (
                  <article key={recipe.id}>
                    <div>
                      <strong>{recipe.productName}</strong>
                      <span>
                        {copy.yieldQuantity}: {recipe.yieldQuantity} Â· {copy.estimatedCost}: {money(recipe.estimatedCost, language)}
                      </span>
                      {recipe.items.map((item) => (
                        <span key={item.id}>
                          {item.ingredientName}: {item.quantity} Ã— {money(item.unitCost, language)} = {money(item.lineCost, language)}
                        </span>
                      ))}
                    </div>
                    <button type="button" className="button-secondary" disabled={busy}
                      onClick={() => void produce(recipe)}>
                      {copy.produce}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>

          <form className="cash-panel cash-inline-form" onSubmit={(event) => void recordWaste(event)}>
            <h2>{copy.recordWaste}</h2>
            <label>{copy.product}
              <select required value={wasteForm.productId}
                onChange={(event) => setWasteForm({ ...wasteForm, productId: event.target.value })}>
                <option value="">â€”</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>{product.name}</option>
                ))}
              </select>
            </label>
            <label>{copy.quantity}
              <input type="number" min="1" step="1" required value={wasteForm.quantity}
                onChange={(event) => setWasteForm({ ...wasteForm, quantity: event.target.value })} />
            </label>
            <label>{copy.wasteReason}
              <input required maxLength={500} value={wasteForm.reason}
                onChange={(event) => setWasteForm({ ...wasteForm, reason: event.target.value })} />
            </label>
            <button className="button-primary" disabled={busy}>{copy.save}</button>
          </form>

          <section className="cash-panel">
            <h2>{copy.wasteHistory}</h2>
            {waste.length === 0 ? <p>{copy.noWaste}</p> : (
              <div className="cash-refund-list">
                {waste.map((entry) => (
                  <article key={entry.id} data-voided={entry.status === 'VOIDED' || undefined}>
                    <div>
                      <strong>{entry.productName}</strong>
                      <span>{entry.reason}</span>
                    </div>
                    <div className="cash-history-figures">
                      <strong>{entry.quantity}</strong>
                      <span>{money(entry.costImpact, language)}{entry.status === 'VOIDED' ? ` Â· ${copy.voided}` : ''}</span>
                    </div>
                    {entry.status === 'ACTIVE' && (
                      <button type="button" className="button-secondary" disabled={busy}
                        onClick={() => void voidWaste(entry)}>
                        {copy.voidAction}
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="cash-panel">
            <h2>{copy.batchHistory}</h2>
            {batches.length === 0 ? <p>{copy.noBatches}</p> : (
              <div className="cash-refund-list">
                {batches.map((batch) => (
                  <article key={batch.id}>
                    <div>
                      <strong>{batch.productName}</strong>
                      <span>{new Date(batch.createdAt).toLocaleString(numberLocale(language))}</span>
                    </div>
                    <div className="cash-history-figures">
                      <strong>Ã—{batch.batchQuantity}</strong>
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
