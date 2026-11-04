import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { AppTranslations } from '../../i18n'
import type { PageSession } from '../../types'
import { authedFetch, usePageSession } from '../../app/usePageSession'

interface WorkspaceBranch {
  tenantId: string
  tenantName: string
  branchId: string
  branchName: string
}

interface Product {
  id: string
  sku: string
  name: string
  category: string | null
  description: string | null
  price: string
  isActive: boolean
  stock: string
}

interface InventoryMovement {
  id: string
  quantityDelta: number
  reason: string
  createdAt: string
  actorUserId: string
}

interface ProductManagementPageProps extends PageSession {
  t: AppTranslations
}

interface ProductCardProps {
  product: Product
  token: string
  workspace: WorkspaceBranch
  t: AppTranslations
  onChanged: () => void
  onSessionExpired: () => void
}

function ProductCard({
  product,
  token,
  workspace,
  t,
  onChanged,
  onSessionExpired,
}: ProductCardProps) {
  const [name, setName] = useState(product.name)
  const [sku, setSku] = useState(product.sku)
  const [category, setCategory] = useState(product.category ?? '')
  const [price, setPrice] = useState(product.price)
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [movements, setMovements] = useState<InventoryMovement[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const basePath =
    `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
    `/branches/${encodeURIComponent(workspace.branchId)}/products/` +
    encodeURIComponent(product.id)

  async function updateProduct() {
    setBusy(true)
    setError('')
    try {
      await authedFetch<Product>(basePath, token, onSessionExpired, {
        method: 'PATCH',
        body: JSON.stringify({ name, sku, category, price }),
      })
      onChanged()
    } catch {
      setError(t.productManagement.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive() {
    setBusy(true)
    setError('')
    try {
      await authedFetch<Product>(basePath, token, onSessionExpired, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !product.isActive }),
      })
      onChanged()
    } catch {
      setError(t.productManagement.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function addMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await authedFetch(`${basePath}/movements`, token, onSessionExpired, {
        method: 'POST',
        body: JSON.stringify({ quantityDelta: delta, reason }),
      })
      setDelta('')
      setReason('')
      onChanged()
      if (movements !== null) {
        await loadMovements()
      }
    } catch {
      setError(t.productManagement.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  async function loadMovements() {
    setBusy(true)
    setError('')
    try {
      const result = await authedFetch<InventoryMovement[]>(
        `${basePath}/movements`,
        token,
        onSessionExpired,
      )
      setMovements(result)
    } catch {
      setError(t.productManagement.requestFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="product-card">
      <div className="product-card-heading">
        <div>
          <span className="product-sku">{product.sku}</span>
          <span className={`product-status ${product.isActive ? 'is-active' : ''}`}>
            {product.isActive
              ? t.productManagement.active
              : t.productManagement.inactive}
          </span>
        </div>
        <strong>{product.stock} {t.productManagement.stock}</strong>
      </div>

      <div className="product-edit-grid">
        <label>
          {t.productManagement.name}
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          {t.productManagement.sku}
          <input value={sku} onChange={(event) => setSku(event.target.value)} />
        </label>
        <label>
          {t.productManagement.category}
          <input value={category} onChange={(event) => setCategory(event.target.value)} />
        </label>
        <label>
          {t.productManagement.price}
          <input
            inputMode="decimal"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
        </label>
      </div>

      <div className="product-card-actions">
        <button type="button" className="button-primary" disabled={busy} onClick={() => void updateProduct()}>
          {t.productManagement.save}
        </button>
        <button type="button" className="button-secondary" disabled={busy} onClick={() => void toggleActive()}>
          {product.isActive
            ? t.productManagement.deactivate
            : t.productManagement.activate}
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => {
            if (movements === null) void loadMovements()
            else setMovements(null)
          }}
        >
          {t.productManagement.movements}
        </button>
      </div>

      <form className="movement-form" onSubmit={(event) => void addMovement(event)}>
        <label>
          {t.productManagement.quantityDelta}
          <input
            required
            inputMode="numeric"
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
          />
        </label>
        <label>
          {t.productManagement.reason}
          <input
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button type="submit" className="button-primary" disabled={busy}>
          {t.productManagement.adjustStock}
        </button>
      </form>

      {error && <p className="product-error" role="alert">{error}</p>}
      {movements && (
        <ul className="movement-list">
          {movements.length === 0
            ? <li>{t.productManagement.noMovements}</li>
            : movements.map((movement) => (
              <li key={movement.id}>
                <strong>{movement.quantityDelta > 0 ? '+' : ''}{movement.quantityDelta}</strong>
                <span>{movement.reason}</span>
                <time>{new Date(movement.createdAt).toLocaleString('en-EG-u-nu-latn')}</time>
              </li>
            ))}
        </ul>
      )}
    </article>
  )
}

export default function ProductManagementPage({
  t,
  sessionToken,
  workspaces,
  onSessionExpired,
}: ProductManagementPageProps) {
  const session = usePageSession({ sessionToken, workspaces, onSessionExpired })
  const token = session.token
  const [selectedBranchId, setSelectedBranchId] = useState(session.branchId)
  const [products, setProducts] = useState<Product[]>([])
  const [loadedBranchId, setLoadedBranchId] = useState('')
  const [sku, setSku] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [price, setPrice] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  const workspace = workspaces.find(
    ({ branchId }) => branchId === selectedBranchId,
  )

  useEffect(() => {
    const currentWorkspace = workspaces.find(
      ({ branchId }) => branchId === selectedBranchId,
    )
    if (!token || !currentWorkspace) return
    let cancelled = false
    const path =
      `/api/tenants/${encodeURIComponent(currentWorkspace.tenantId)}` +
      `/branches/${encodeURIComponent(currentWorkspace.branchId)}/products`
    void authedFetch<Product[]>(path, token, onSessionExpired)
      .then((result) => {
        if (!cancelled) {
          setProducts(result)
          setLoadedBranchId(currentWorkspace.branchId)
        }
      })
      .catch(() => {
        if (!cancelled) setError(t.productManagement.requestFailed)
      })
    return () => {
      cancelled = true
    }
  }, [token, workspaces, selectedBranchId, refresh, t.productManagement.requestFailed, onSessionExpired])

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!workspace || !token) return
    setLoading(true)
    setError('')
    try {
      const path =
        `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
        `/branches/${encodeURIComponent(workspace.branchId)}/products`
      await authedFetch<Product>(path, token, onSessionExpired, {
        method: 'POST',
        body: JSON.stringify({ sku, name, category, price }),
      })
      setSku('')
      setName('')
      setCategory('')
      setPrice('')
      setRefresh((value) => value + 1)
    } catch {
      setError(t.productManagement.requestFailed)
    } finally {
      setLoading(false)
    }
  }

  function logout() {
    onSessionExpired()
  }

  return (
    <section className="page-content product-management-page">
      <header className="product-management-heading">
        <div>
          <h1>{t.productManagement.title}</h1>
          <p>{t.productManagement.subtitle}</p>
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
            <select
              value={selectedBranchId}
              onChange={(event) => {
                setProducts([])
                setLoadedBranchId('')
                setError('')
                setSelectedBranchId(event.target.value)
              }}
            >
              {workspaces.map((branch) => (
                <option key={`${branch.tenantId}:${branch.branchId}`} value={branch.branchId}>
                  {branch.tenantName} — {branch.branchName}
                </option>
              ))}
            </select>
          </label>

          {workspaces.length === 0 && (
            <p className="product-empty">{t.productManagement.noBranches}</p>
          )}

          {workspace && (
            <>
              <form className="product-create-panel" onSubmit={(event) => void createProduct(event)}>
                <h2>{t.productManagement.addProduct}</h2>
                <div className="product-edit-grid">
                  <label>
                    {t.productManagement.sku}
                    <input required maxLength={64} value={sku} onChange={(event) => setSku(event.target.value)} />
                  </label>
                  <label>
                    {t.productManagement.name}
                    <input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label>
                    {t.productManagement.category}
                    <input maxLength={120} value={category} onChange={(event) => setCategory(event.target.value)} />
                  </label>
                  <label>
                    {t.productManagement.price}
                    <input required inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
                  </label>
                </div>
                <button type="submit" className="button-primary" disabled={loading}>
                  {t.productManagement.addProduct}
                </button>
              </form>

              {loadedBranchId !== workspace.branchId && !error && (
                <p>{t.productManagement.loading}</p>
              )}
              {loadedBranchId === workspace.branchId && products.length === 0 && (
                <p className="product-empty">{t.productManagement.noProducts}</p>
              )}
              <div className="product-list">
                {products.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    token={token}
                    workspace={workspace}
                    t={t}
                    onSessionExpired={onSessionExpired}
                    onChanged={() => {
                      setLoadedBranchId('')
                      setRefresh((value) => value + 1)
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </>

      {error && <p className="product-error" role="alert">{error}</p>}
    </section>
  )
}
