import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator'

export class UpdateBranchAccessDto {
  @IsString()
  @IsIn(['ALL_BRANCHES', 'SELECTED_BRANCHES'])
  mode!: 'ALL_BRANCHES' | 'SELECTED_BRANCHES'

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(255, { each: true })
  branchIds!: string[]
}
