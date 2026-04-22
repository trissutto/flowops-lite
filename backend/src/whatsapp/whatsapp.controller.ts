import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsString, ValidateNested, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WhatsappService } from './whatsapp.service';

class SendItemDto {
  @IsString() number: string;
  @IsString() text: string;
  @IsOptional() @IsString() tag?: string;
}

class SendBulkDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => SendItemDto)
  items: SendItemDto[];

  @IsOptional() @IsInt() @Min(800)
  delayMs?: number;
}

class SendDto {
  @IsString() number: string;
  @IsString() text: string;
}

@Controller('whatsapp')
@UseGuards(JwtAuthGuard)
export class WhatsappController {
  constructor(private readonly wa: WhatsappService) {}

  @Get('status')
  status() {
    return this.wa.getStatus();
  }

  @Post('connect')
  async connect() {
    // Dispara conexão em background e retorna imediatamente. Frontend faz
    // polling em /status pra pegar o QR quando ele aparecer (1-3s).
    this.wa.connect().catch(() => {});
    return { ok: true };
  }

  @Post('logout')
  async logout() {
    await this.wa.logout();
    return { ok: true };
  }

  @Post('send')
  async send(@Body() dto: SendDto) {
    return this.wa.sendText(dto.number, dto.text);
  }

  @Post('send-bulk')
  async sendBulk(@Body() dto: SendBulkDto) {
    return this.wa.sendBulk(dto.items, { delayMs: dto.delayMs });
  }
}
