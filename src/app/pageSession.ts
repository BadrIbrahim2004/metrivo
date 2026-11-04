import type { LoginSuccess } from '../features/auth/LoginPage'

/** Shared per-page session props passed down from App. */
export interface PageSession {
  sessionToken: string
  workspaces: LoginSuccess['workspaces']
  /** Called on 401 responses so the user is returned to the login screen. */
  onSessionExpired: () => void
}

export interface WorkspaceBranch {
  tenantId: string
  tenantName: string
  branchId: string
  branchName: string
}
