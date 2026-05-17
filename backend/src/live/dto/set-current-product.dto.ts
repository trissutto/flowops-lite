import { IsOptional, IsString } from 'class-validator';

export class SetCurrentProductDto {
  /**
   * Texto livre opcional que a apresentadora vai dizer ao mostrar.
   * Usado pra contexto da IA. Não obrigatório.
   */
  @IsOptional()
  @IsString()
  speakerNote?: string;
}
