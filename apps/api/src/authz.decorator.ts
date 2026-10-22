import { SetMetadata } from '@nestjs/common'

export const IS_PUBLIC_ROUTE = 'authorization:is-public'
export const PLATFORM_PERMISSION = 'authorization:platform-permission'
export const TENANT_PERMISSION = 'authorization:tenant-permission'
export const PLATFORM_OWNER_ONLY = 'authorization:platform-owner-only'
export const AUTHENTICATED_ONLY = 'authorization:authenticated-only'

export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true)

export const RequirePlatformPermission = (permissionKey: string) =>
  SetMetadata(PLATFORM_PERMISSION, permissionKey)

export const RequireTenantPermission = (permissionKey: string) =>
  SetMetadata(TENANT_PERMISSION, permissionKey)

export const RequirePlatformOwner = () =>
  SetMetadata(PLATFORM_OWNER_ONLY, true)

export const RequireAuthenticated = () =>
  SetMetadata(AUTHENTICATED_ONLY, true)
