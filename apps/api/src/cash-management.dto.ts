import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator'

const MONEY_PATTERN = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/
const SETTLEMENT_METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const
const MOVEMENT_TYPES = ['CASH_IN', 'CASH_OUT'] as const

export class OpenCashShiftDto {
  @IsString()
  @Matches(MONEY_PATTERN)
  openingCash!: string
}

export class CloseCashShiftDto {
  @IsString()
  @Matches(MONEY_PATTERN)
  countedCash!: string
}

export class CreateCashMovementDto {
  @IsString()
  @IsIn(MOVEMENT_TYPES)
  type!: (typeof MOVEMENT_TYPES)[number]

  @IsString()
  @Matches(MONEY_PATTERN)
  amount!: string

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string
}

export class SettleRefundDto {
  @IsString()
  @IsIn(SETTLEMENT_METHODS)
  method!: (typeof SETTLEMENT_METHODS)[number]

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string | null
}
