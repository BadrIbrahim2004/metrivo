import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import { SalePaymentMethod } from '@prisma/client'

const MONEY_PATTERN = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/

export class CreateSaleLineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  productId!: string

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number
}

export class CreateSaleDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateSaleLineDto)
  lines!: CreateSaleLineDto[]

  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  discount?: string

  @IsEnum(SalePaymentMethod)
  paymentMethod!: SalePaymentMethod
}
