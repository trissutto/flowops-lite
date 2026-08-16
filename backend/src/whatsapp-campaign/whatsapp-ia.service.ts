import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { lojasComoTexto } from './lojas-info';

/**
 * IA DO INBOX — a "Lulú", atendente virtual da Lurd's (dono, 15-16/08/2026).
 *
 * `sugerir` rascunha a resposta pra atendente (humano edita e envia).
 * `decidirAutoResposta` decide se a Lulú responde SOZINHA (usado pelo cron de
 * auto-resposta, com trava dura). Lê a conversa + os PEDIDOS daquela cliente
 * (por telefone) + a lista de LOJAS. Reusa a conta Anthropic de prod (mesmo
 * padrão do ficha-ia: HttpService → api.anthropic.com).
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
    'Você é a Lulú, atendente da Lurd\'s Plus Size (moda plus size do 46 ao 60, site www.lurdsplussize.com.br). ' +
    'Tom caloroso e brasileiro, direto, sem formalidade demais, no máximo 1 emoji. ' +
    'Pix tem 5% de desconto; troca em 7 dias na loja ou pelo portal; entrega pra todo o Brasil e retirada nas lojas. ' +
    'Escreva como se fosse a PRÓXIMA mensagem da LOJA na conversa — curta (2 a 4 linhas). ' +
    'NUNCA invente preço, número de pedido, rastreio ou ENDEREÇO de loja: endereço/telefone/horário use SÓ a lista de LOJAS dada; ' +
    'se a cidade não estiver na lista, mande pra www.lurdsplussize.com.br/lojas. Sem o dado, peça a REF/link ou diga que vai conferir e já retorna.';

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
      `LOJAS DA REDE (endereço/telefone/horário — use SÓ isto):\n${lojasComoTexto()}\n\n` +
      `PEDIDOS DESTA CLIENTE:\n${ctxPedidos}\n\n` +
      `CONVERSA (mais recente por último):\n${conversa}\n\n` +
      'Escreva SÓ a próxima resposta da LOJA, sem aspas e sem prefixo "LOJA:".';

    try {
      const texto = await this.chamarClaude(this.PERSONA, conteudo, 400);
      if (!texto) throw new Error('resposta vazia da IA');
      return { sugestao: texto };
    } catch (e: any) {
      const status = e?.response?.status;
      const detalhe = e?.response?.data?.error?.message || e?.message || 'erro';
      throw new BadRequestException(`IA falhou (${status ?? 'sem status'}): ${detalhe}`);
    }
  }

  /** Chamada crua ao Claude → texto puro. Lança em erro (quem chama trata). */
  private async chamarClaude(system: string, user: string, maxTokens = 400): Promise<string> {
    const res = await firstValueFrom(
      this.http.post(
        'https://api.anthropic.com/v1/messages',
        { model: this.modelo, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
        {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 45000,
        },
      ),
    );
    return ((res.data?.content as any[]) || [])
      .filter((b) => b?.type === 'text')
      .map((b) => String(b?.text || ''))
      .join('\n')
      .trim();
  }

  private readonly REGRAS_AUTO =
    'MODO AUTO-RESPOSTA: você vai responder SOZINHA, sem um humano revisar — então seja CONSERVADORA. ' +
    'Só responda (responder=true) se for algo SIMPLES e SEGURO que você resolve com CERTEZA pelos dados: ' +
    'horário/endereço/telefone de loja (lista de LOJAS), formas de pagamento, Pix 5%, política de troca (7 dias), ' +
    'prazo geral de entrega, retirada na loja, saudação/agradecimento, ou uma acolhida enquanto uma pessoa assume. ' +
    'NÃO responda (responder=false) se: negociar preço/desconto, reclamação, problema de pagamento, ' +
    'status/rastreio de um pedido que NÃO esteja nos dados, se uma peça/tamanho específico tem em estoque ' +
    '(você NÃO vê o estoque ao vivo), qualquer coisa que precise de decisão humana, ou se tiver QUALQUER dúvida. ' +
    'FORA do horário: pode mandar um retorno curto e caloroso mesmo pro que não resolve ("nosso atendimento volta amanhã às 9h, mas já te adianto…"). ' +
    'DENTRO do horário: seja AINDA mais conservadora — só o trivial; no resto responder=false pra uma pessoa assumir. ' +
    'Máximo 4 linhas, no máximo 1 emoji. Na dúvida, responder=false.';

  /**
   * Decide se a Lulú responde SOZINHA a conversa. Decisão estruturada.
   * Qualquer falha (IA off, parse, erro) → responder=false (lado seguro).
   */
  async decidirAutoResposta(
    jid: string,
    opts: { fora: boolean },
  ): Promise<{ responder: boolean; resposta: string; motivo: string }> {
    const nao = (motivo: string) => ({ responder: false, resposta: '', motivo });
    if (!this.apiKey) return nao('IA off (sem ANTHROPIC_API_KEY)');
    if (!jid) return nao('sem jid');
    const numero = String(jid).split('@')[0].replace(/\D/g, '');

    let msgs: Array<{ fromMe: boolean; texto: string }> = [];
    try {
      msgs = await this.inbox.mensagens(jid);
    } catch {
      return nao('sem mensagens');
    }
    if (!msgs.length) return nao('conversa vazia');
    if (msgs[msgs.length - 1].fromMe) return nao('última mensagem é da loja');

    const conversa = msgs
      .slice(-12)
      .map((m) => `${m.fromMe ? 'LOJA' : 'CLIENTE'}: ${m.texto}`)
      .join('\n');

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
    } catch {
      /* segue sem pedidos */
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
      : '(nenhum pedido no telefone desta cliente)';

    const conteudo =
      `SITUAÇÃO: ${opts.fora ? 'FORA do horário (loja fechada agora)' : 'DENTRO do horário'}.\n\n` +
      `LOJAS DA REDE (endereço/telefone/horário — use SÓ isto):\n${lojasComoTexto()}\n\n` +
      `PEDIDOS DESTA CLIENTE:\n${ctxPedidos}\n\n` +
      `CONVERSA (mais recente por último):\n${conversa}\n\n` +
      'Responda SÓ com um JSON válido, nada além dele: ' +
      '{"responder": true|false, "resposta": "<texto que a Lulú manda, ou vazio>", "motivo": "<curto>"}.';

    let bruto = '';
    try {
      bruto = await this.chamarClaude(`${this.PERSONA}\n\n${this.REGRAS_AUTO}`, conteudo, 500);
    } catch (e: any) {
      return nao(`erro na IA: ${e?.message || e}`);
    }
    // Extrai o primeiro objeto JSON do texto (a IA às vezes embrulha em prosa).
    const bloco = bruto.match(/\{[\s\S]*\}/);
    if (!bloco) return nao('IA não devolveu JSON');
    try {
      const j = JSON.parse(bloco[0]);
      const responder = j?.responder === true;
      const resposta = String(j?.resposta || '').trim();
      const motivo = String(j?.motivo || '').slice(0, 200);
      if (responder && !resposta) return nao('IA disse responder mas veio vazio');
      return { responder, resposta, motivo };
    } catch {
      return nao('JSON inválido da IA');
    }
  }
}
