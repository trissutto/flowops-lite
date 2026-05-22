import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateLiveDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  hostUserId?: string;

  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;
}
