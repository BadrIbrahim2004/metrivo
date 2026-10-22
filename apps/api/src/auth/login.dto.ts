import { Transform } from 'class-transformer'
import {
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator'
import { normalizeEmail } from './email-normalization'

export class LoginDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string
}
