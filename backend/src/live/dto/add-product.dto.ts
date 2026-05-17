import {
  IsArray, IsInt, IsOptional, IsString, Min,
} from 'class-validator';

export class AddProductDto {
  @IsString()
  erpProductId: string;

  @IsString()
  refCode: string;

  @IsString()
  displayName: string;

  @IsInt()
  @Min(0)
  priceCents: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  promoPriceCents?: number;

  @IsOptional()
  @IsString()
  wcProductId?: string;

  /**
   * Estoque por tamanho. Se omitido, o service tenta buscar do ERP.
   * Formato: [["52", 8], ["54", 3]] ou [{size:"52", stock:8}, ...]
   */
  @IsOptional()
  @IsArray()
  sizes?: any[];
}
