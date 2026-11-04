import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator'

const MONEY_PATTERN = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/
const PAYMENT_METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const

export class CreateExpenseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category!: string

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string

  @IsString()
  @Matches(MONEY_PATTERN)
  amount!: string

  @IsString()
  @IsIn(PAYMENT_METHODS)
  method!: (typeof PAYMENT_METHODS)[number]

  @IsOptional()
  @IsDateString()
  expenseDate?: string
}

export class ListExpensesDto {
  @IsOptional()
  @IsDateString()
  from?: string

  @IsOptional()
  @IsDateString()
  to?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category?: string
}
