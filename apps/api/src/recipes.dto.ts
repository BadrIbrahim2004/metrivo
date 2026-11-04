import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

const QUANTITY_PATTERN = /^(0|[1-9]\d{0,5})(\.\d{1,3})?$/;
const WASTE_PERCENT_PATTERN = /^(0|[1-9]\d?)(\.\d{1,2})?$|^100$/;

export class RecipeItemInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  ingredientId!: string;

  @IsString()
  @Matches(QUANTITY_PATTERN)
  quantity!: string;

  @IsOptional()
  @IsString()
  @Matches(WASTE_PERCENT_PATTERN)
  wastePercent?: string;
}

export class SaveRecipeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  yieldQuantity!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  items!: RecipeItemInputDto[];
}

export class ProduceBatchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  recipeId!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  batchQuantity!: number;
}

export class RecordWasteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  productId!: string;

  @IsString()
  @Matches(QUANTITY_PATTERN)
  quantity!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class ListWasteDto {
  @IsOptional()
  @IsIn(["ACTIVE", "VOIDED"])
  status?: "ACTIVE" | "VOIDED";

  @IsOptional()
  @IsString()
  @MaxLength(128)
  productId?: string;
}
