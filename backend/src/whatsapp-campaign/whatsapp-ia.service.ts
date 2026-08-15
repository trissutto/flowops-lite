import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappInboxService } from './whatsapp-inbox.service';

/**
 * IA DO INBOX (dono, 15/08/2026) — sugere a resposta pra atendente.
 *
 * Lê a conversa + os PEDIDOS daquela cliente (por telefone) e o Claude escreve
 * a próxima resposta da LOJA, no tom da Lurd's. A atendente edita e envia — a
 * IA rascunha, não manda sozinha. Reusa a conta Anthropic que já roda em prod
 * (mesmo padrão do ficha-ia: HttpService → api.anthropic.com).
 */
@Injectable()
export class WhatsappIaService {
  private readonly logger = new Logger(WhatsappIaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly inbox: WhatsappInboxService,
  ) {}

  private get apiKey(): string | null {
    const k = this.config.get<string>('ANTHROPIC_API_KEY');
    return k && k.trim() ? k.trim() : null;
  }
  private get modelo(): string {
    return this.config.get<string>('ANTHROPIC_MODEL') || 'claude-sonnet-4-6';
  }

  private readonly PERSONA =
    'Você é a atendente da Lurd\'s Plus Size (moda plus size do 46 ao 60, site www.lurdsplussize.com.br). ' +
    'Tom caloroso e brasileiro, direto, sem formalidade demais, no máximo 1 emoji. ' +
    'Pix tem 5% de desconto; troca em 7 dias na loja ou pelo portal; entrega pra todo o Brasil e retirada nas 14 lojas. ' +
    'Escreva como se fosse a PRÓXIMA mensagem da LOJA na conversa — curta (2 a 4 linhas). ' +
    'NUNCA invente preço, número de pedido ou rastreio: se não estiver nos dados abaixo, peça com jeito a REF da peça ou o link, ou diga que vai conferir e já retorna.';

  async sugerir(jid: string): Promise<{ sugestao: string }> {
    if (!this.apiKey) throw new BadRequestException('IA desabilitada — configure ANTHROPIC_API_KEY.');
    if (!jid) throw new BadRequestException('Conversa não informada.');
    const numero = String(jid).split('@')[0].replace(/\D/g, '');

    const msgs = await this.inbox.mensagens(jid);
    if (!msgs.length) throw new BadRequestException('Sem mensagens nessa conversa.');
    const conversa = msgs
      .slice(-15)
      .map((m) => `${m.fromMe ? 'LOJA' : 'CLIENTE'}: ${m.texto}`)
      .join('\n');

    // Pedidos desta cliente (casa pelos últimos 8 dígitos — formatos variam).
    let pedidos: any[] = [];
    try {
      pedidos = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT wc_order_number, status, tracking_code, total_amount,
                to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo','DD/MM') dia
           FROM orders
          WHERE regexp_replace(COALESCE(customer_phone,''),'\\D','','g') LIKE $1
          ORDER BY created_at DESC LIMIT 5`,
        `%${numero.slice(-8)}%`,
      );
    } catch (e: any) {
      this.logger.warn(`[wa-ia] falha ao buscar pedidos: ${e?.message || e}`);
    }
    const ctxPedidos = pedidos.length
      ? pedidos
          .map(
            (p) =>
              `- Pedido ${p.wc_order_number || '?'} (${p.dia}): ${p.status}${
                p.tracking_code ? ` · rastreio ${p.tracking_code}` : ''
              } · R$ ${p.total_amount}`,
          )
          .join('\n')
      : '(nenhum pedido encontrado no nome desse telefone)';

    const conteudo =
      `PEDIDOS DESTA CLIENTE:\n${ctxPedidos}\n\n` +
      `CONVERSA (mais recente por último):\n${conversa}\n\n` +
      'Escreva SÓ a próxima resposta da LOJA, sem aspas e sem prefixo "LOJA:".';

    const body = {
      model: this.modelo,
      max_tokens: 400,
      system: this.PERSONA,
      messages: [{ role: 'user', content: conteudo }],
    };

    try {
      const res = await firstValueFrom(
        this.http.post('https://api.anthropic.com/v1/messages', body, {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 45000,
        }),
      );
      const texto = ((res.data?.content as any[]) || [])
        .filter((b) => b?.type === 'text')
        .map((b) => String(b?.text || ''))
        .join('\n')
        .trim();
      if (!texto) throw new Error('resposta vazia da IA');
      return { sugestao: texto };
    } catch (e: any) {
      const status = e?.response?.status;
      const detalhe = e?.response?.data?.error?.message || e?.message || 'erro';
      throw new BadRequestException(`IA falhou (${status ?? 'sem status'}): ${detalhe}`);
    }
  }
}
