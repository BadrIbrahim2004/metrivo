import { APP_GUARD } from '@nestjs/core'
import { AuthenticationGuard } from './auth/authentication.guard'
import { AuthorizationGuard } from './authorization.guard'

export const GLOBAL_AUTH_GUARD_PROVIDERS = [
  { provide: APP_GUARD, useExisting: AuthenticationGuard },
  { provide: APP_GUARD, useClass: AuthorizationGuard },
]
