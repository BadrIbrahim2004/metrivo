import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator'

const LOGO_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export class ReceiptSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  receiptDisplayName?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(700_000)
  @Matches(LOGO_DATA_URL_PATTERN)
  receiptLogoDataUrl?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(40)
  receiptPhone?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptAddress?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(120)
  receiptFacebook?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(120)
  receiptInstagram?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptTiktok?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptYoutube?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptWhatsapp?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptX?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptTelegram?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptSnapchat?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptLinkedin?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptWebsite?: string | null
}
