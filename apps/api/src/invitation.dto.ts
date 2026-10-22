import { Transform } from 'class-transformer'
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator'
import { normalizeEmail } from './auth/email-normalization'

export class CreateTenantInvitationDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  tenantId!: string

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  roleId!: string
}

export class AcceptInvitationDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string
}
