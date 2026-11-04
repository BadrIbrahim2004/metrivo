import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

export class CreateStockTransferDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  destinationBranchId!: string

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  productId!: string

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null
}

export class ListTransfersDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  productId?: string
}
