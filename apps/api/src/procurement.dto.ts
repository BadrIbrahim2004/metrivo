import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

const MONEY_PATTERN = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/
const PAYMENT_METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const

export class CreateSupplierDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null
}

export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null

  @IsOptional()
  @IsBoolean()
  isActive?: boolean
}

export class PurchaseLineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  productId!: string

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number

  @IsString()
  @Matches(MONEY_PATTERN)
  unitCost!: string
}

export class CreatePurchaseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  supplierId!: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplierInvoiceNumber?: string | null

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  items!: PurchaseLineDto[]
}

export class CreateSupplierPaymentDto {
  @IsString()
  @Matches(MONEY_PATTERN)
  amount!: string

  @IsString()
  @IsIn(PAYMENT_METHODS)
  method!: (typeof PAYMENT_METHODS)[number]
}
