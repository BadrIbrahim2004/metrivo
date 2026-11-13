import { IsString, Matches, MaxLength } from 'class-validator'

export class RequestLocalActivationCodeDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  deviceId!: string
}

export class VerifyLocalActivationCodeDto extends RequestLocalActivationCodeDto {
  @IsString()
  @Matches(/^\d{6}$/)
  @MaxLength(6)
  code!: string
}
