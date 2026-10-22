import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator'

const PRICE_PATTERN = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null

  @IsString()
  @Matches(PRICE_PATTERN)
  price!: string
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null

  @IsOptional()
  @IsString()
  @Matches(PRICE_PATTERN)
  price?: string

  @IsOptional()
  @IsBoolean()
  isActive?: boolean
}

export class CreateInventoryMovementDto {
  @Matches(/^-?[1-9]\d{0,6}$/)
  quantityDelta!: string

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string
}
