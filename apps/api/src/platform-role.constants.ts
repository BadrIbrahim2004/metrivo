export const PLATFORM_OWNER_ROLE_KEY = 'PLATFORM_OWNER'
export const PLATFORM_ADMIN_ROLE_KEY = 'PLATFORM_ADMIN'

export const PLATFORM_ADMIN_PERMISSION_ALLOWLIST = [
  'support.tenant_access',
  'support.approve_access',
] as const

export type PlatformAdminPermission =
  (typeof PLATFORM_ADMIN_PERMISSION_ALLOWLIST)[number]
