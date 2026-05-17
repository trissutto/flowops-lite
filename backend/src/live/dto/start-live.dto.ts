import { IsOptional, IsString } from 'class-validator';

export class StartLiveDto {
  /**
   * ID da live no Instagram (Graph API media_id). Pode ser preenchido
   * depois quando vincular o webhook.
   */
  @IsOptional()
  @IsString()
  igMediaId?: string;
}
