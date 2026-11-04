import { useMemo } from 'react'
import type { PageSession, WorkspaceBranch } from './pageSession'
import { normalizeDigitsInData } from '../i18n/numbers'

/**
 * Single source of truth for the authorized session inside feature pages.
 * Pages no longer own their own login state; the gate is the app-level
 * LoginPage, and the API remains the final permission authority per request.
 */
export function usePageSession(session: PageSession): {
  token: string
  workspaces: WorkspaceBranch[]
  branchId: string
  basePath: string
  onSessionExpired: () => void
} {
  return useMemo(() => {
    const workspaces = session.workspaces
    const workspace = workspaces[0]
    return {
      token: session.sessionToken,
      workspaces,
      branchId: workspace?.branchId ?? '',
      basePath: workspace
        ? `/api/tenants/${encodeURIComponent(workspace.tenantId)}` +
          `/branches/${encodeURIComponent(workspace.branchId)}`
        : '',
      onSessionExpired: session.onSessionExpired,
    }
  }, [session.sessionToken, session.workspaces, session.onSessionExpired])
}

/** Attach the auth header and surface 401 as session expiry. */
export async function authedFetch<T>(
  path: string,
  token: string,
  onUnauthorized: () => void,
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
  if (response.status === 401) onUnauthorized()
  if (!response.ok) throw new Error('request')
  return normalizeDigitsInData(await response.json() as T)
}

/**
 * POST helper that lets the caller distinguish conflict-type failures
 * (409: closed shift, duplicate, insufficient stock…) from generic errors.
 */
export async function authedPost<T>(
  path: string,
  token: string,
  onUnauthorized: () => void,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  if (response.status === 401) onUnauthorized()
  if (response.status === 409) throw new Error('conflict-shift')
  if (!response.ok) throw new Error('request')
  return normalizeDigitsInData(await response.json() as T)
}
