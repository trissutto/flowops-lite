import {
  IsInt, IsOptional, IsString, Min,
} from 'class-validator';

export class ReserveDto {
  @IsString()
  liveProductId: string;

  @IsString()
  customerId: string;

  @IsString()
  size: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;
}
