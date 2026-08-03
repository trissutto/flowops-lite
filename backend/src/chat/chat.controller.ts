import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Param,
  Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ChatService } from './chat.service';

/**
 * PÚBLICO — a assistente do site.
 *
 * Sem login: tirar dúvida não pode exigir cadastro. Se a cliente ESTIVER
 * logada, o BFF do site manda o token dela e a assistente ganha a ferramenta
 * de pedidos — token inválido não derruba a conversa, só volta ao modo
 * anônimo (a alternativa seria a cliente perder o atendimento por causa de uma
 * sessão vencida).
 *
 * RATE-LIMIT por sessão + por IP. Endpoint público que chama IA é convite pra
 * queimar crédito, e aqui cada mensagem custa dinheiro de verdade.
 */
@Controller('public/loja/chat')
export class ChatPublicController {
  /** sessão/IP → timestamps das últimas mensagens */
  private readonly janela = new Map<string, number[]>();
  private readonly LIMITE = 12;
  private readonly JANELA_MS = 60_000;

  constructor(
    private readonly svc: ChatService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private permitido(chave: string): boolean {
    const agora = Date.now();
    const anteriores = (this.janela.get(chave) ?? []).filter((t) => agora - t < this.JANELA_MS);
    if (anteriores.length >= this.LIMITE) {
      this.janela.set(chave, anteriores);
      return false;
    }
    anteriores.push(agora);
    this.janela.set(chave, anteriores);
    // O mapa é por instância e some no restart — é contenção de aba em loop,
    // não anti-DDoS (isso é papel da borda).
    if (this.janela.size > 5000) this.janela.clear();
    return true;
  }

  /** Token do app cliente, quando vier. Inválido = anônima, sem erro. */
  private async accountId(req: any): Promise<string | null> {
    const bruto = (req.headers['x-cliente-token'] as string | undefined) || '';
    if (!bruto) return null;
    try {
      const payload: any = await this.jwt.verifyAsync(bruto, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
      return payload?.scope === 'customer' ? String(payload.sub || payload.id || '') || null : null;
    } catch {
      return null;
    }
  }

  @Get('status')
  status() {
    return { disponivel: this.svc.isEnabled() };
  }

  @Post()
  async conversar(
    @Req() req: any,
    @Body() body: { chatId?: string; sessaoId?: string; mensagem?: string; contexto?: string },
  ) {
    const sessao = String(body?.sessaoId || '').slice(0, 80);
    if (!sessao) throw new BadRequestException('sessão ausente');

    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (!this.permitido(`s:${sessao}`) || !this.permitido(`i:${ip}`)) {
      throw new ForbiddenException('Muitas mensagens seguidas — respira e tenta de novo em um minuto.');
    }

    return this.svc.responder({
      chatId: body?.chatId,
      sessaoId: sessao,
      mensagem: String(body?.mensagem || ''),
      contexto: body?.contexto ?? null,
      accountId: await this.accountId(req),
    });
  }
}

/**
 * RETAGUARDA — a fila de quem pediu consultora.
 */
@Controller('site-chat')
@UseGuards(JwtAuthGuard)
export class ChatAdminController {
  constructor(private readonly svc: ChatService) {}

  @Get()
  fila(@Query('status') status?: string) {
    return this.svc.fila(status);
  }

  @Post(':id/atendida')
  atendida(@Param('id') id: string, @Req() req: any) {
    const quem = req?.user?.name || req?.user?.email || 'equipe';
    return this.svc.marcarAtendida(id, quem);
  }
}
