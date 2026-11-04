import { IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

export class CreateTenantOnboardingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  tenantName!: string

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  branchName!: string

  @IsString()
  @IsEmail({}, { message: 'ownerEmail must be a valid email address' })
  @MaxLength(254)
  ownerEmail!: string

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  trialDays?: number
}
