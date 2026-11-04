import {
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator'

export class ChangeOwnPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string

  @IsString()
  @MinLength(12)
  @MaxLength(200)
  newPassword!: string
}
