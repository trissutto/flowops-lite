import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service'; // @TODO_VALIDATE_VS_LOJA
import { MetaService } from './meta.service';

/**
 * AiAgentService — a "Lú", atendente IA da live.
 *
 * Responsabilidades:
 *  - Responder dúvidas no PRÓPRIO COMENTÁRIO do Instagram (não tira cliente da live)
 *  - Tom feminino, brasileiro, acolhedor, vendedor curto
 *  - SEMPRE incentivar permanência na live
 *  - NUNCA prometer prazo, dar desconto não autorizado, ou inventar dado
 *
 * Modelo: Claude Sonnet 4.6 (qualidade). Tokens controlados: max 200 saída.
 */
@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);
  private readonly defaultModel = 'claude-sonnet-4-6';

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
    private readonly meta: MetaService,
  ) {}

  private get apiKey(): string | null {
    const k = this.config.get<string>('ANTHROPIC_API_KEY');
    return k && k.trim() ? k.trim() : null;
  }

  isEnabled(): boolean {
    return !!this.apiKey;
  }

  /**
   * Gera resposta + posta como REPLY no comentário do Instagram.
   * Fallback: se Meta não configurada, registra a resposta na DB pra
   * atendente humano enviar manualmente.
   */
  async replyToCommentInPublic(opts: {
    liveId: string;
    commentId: string;
    igCommentId: string;
    productContext: any | null;
    question: string;
  }) {
    if (!this.isEnabled()) {
      this.logger.warn('IA desabilitada — sem ANTHROPIC_API_KEY');
      return;
    }

    // Buscar contexto extra: live, regras ativas, FAQ se houver
    const live = await this.prisma.live.findUnique({
      where: { id: opts.liveId },
      select: { aiEnabled: true, title: true },
    });
    if (!live?.aiEnabled) {
      this.logger.debug('IA desativada para esta live');
      return;
    }

    const answer = await this.generateAnswer({
      question: opts.question,
      product: opts.productContext,
    });

    if (!answer) return;

    // Tenta postar resposta no IG
    const result = await this.meta.replyToComment({
      igCommentId: opts.igCommentId,
      text: answer,
    });

    // Registrar resposta no histórico (independente de sucesso)
    await this.prisma.dmMessage
      .create({
        data: {
          customerId: '', // ⚠️ se tiver customerId no contexto, passa aqui
          liveId: opts.liveId,
          direction: 'out',
          channel: 'ig_direct', // representativo — não é DM, é reply de comment
          body: answer,
          template: 'ai_comment_reply',
          aiGenerated: true,
          status: result.error ? 'failed' : 'sent',
          error: result.error,
          sentAt: new Date(),
        },
      })
      .catch(() => null);

    if (result.error) {
      this.logger.warn(`Reply IG falhou: ${result.error}`);
    }
  }

  /**
   * Endpoint de teste isolado — útil pra calibrar tom sem precisar
   * gerar comentário real no Instagram.
   */
  async chat(opts: {
    question: string;
    productContext?: any;
  }): Promise<{ answer: string | null; model: string }> {
    const answer = await this.generateAnswer({
      question: opts.question,
      product: opts.productContext,
    });
    return { answer, model: this.config.get('ANTHROPIC_MODEL') || this.defaultModel };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // "LÚ POSTS" — IA pra responder comentários em POSTS NORMAIS (sem live ativa)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Recebe um comentário de post normal (não-live) e responde publicamente
   * no Instagram. Sem reserva, sem produto específico — foco em engajar e
   * redirecionar pro DM.
   *
   * @TODO_CUSTOMIZAR_TOM: o system prompt aqui é a versão inicial.
   * Pra alterar tom/objetivo (ex: enviar link de carrinho, link do site,
   * agendar consultora), edita só a constante POSTS_SYSTEM_PROMPT abaixo.
   */
  async replyToPostComment(opts: {
    igCommentId: string;
    igUsername: string;
    question: string;
  }): Promise<{ ok: boolean; answer?: string; error?: string }> {
    if (!this.isEnabled()) {
      this.logger.warn('[Lú Posts] IA desabilitada — sem ANTHROPIC_API_KEY');
      return { ok: false, error: 'IA desabilitada' };
    }

    const answer = await this.generatePostAnswer({
      question: opts.question,
      username: opts.igUsername,
    });

    if (!answer) {
      return { ok: false, error: 'IA não gerou resposta' };
    }

    // Posta a resposta como reply público
    const result = await this.meta.replyToComment({
      igCommentId: opts.igCommentId,
      text: answer,
    });

    // Registra no histórico (independente de sucesso)
    // Como não tem customer no banco ainda, salva como log no integration-logs.
    this.logger.log(
      `[Lú Posts] @${opts.igUsername}: "${opts.question}" → "${answer}"${result.error ? ` ERRO: ${result.error}` : ''}`,
    );

    return result.error
      ? { ok: false, answer, error: result.error }
      : { ok: true, answer };
  }

  /**
   * Gera resposta da Lú Posts via Claude.
   * Tom: acolhedor, informativo, sempre direciona pro DM.
   */
  private async generatePostAnswer(input: {
    question: string;
    username: string;
  }): Promise<string | null> {
    if (!this.apiKey) return null;
    const model =
      this.config.get<string>('ANTHROPIC_MODEL') || this.defaultModel;

    // ─── POSTS_SYSTEM_PROMPT — edite aqui pra ajustar tom e objetivo ───
    const system = `Você é a Lú, atendente da Lurds Plus Size respondendo
comentários em posts do Instagram (NÃO é live).

CONTEXTO:
- Lurds Plus Size é uma rede de lojas de moda feminina plus size.
- A cliente comentou num post (foto/reels) e quer informação.
- Você NÃO está numa live — então NÃO mencione "live", "ao vivo", etc.

PERSONALIDADE:
- Brasileira, 32 anos, vendedora acolhedora.
- NUNCA julga corpo, tamanho ou idade.
- Direta, sem enrolar.
- "amor", "linda", "querida" — máximo 1x por mensagem.
- Máximo 1 emoji por mensagem.
- Resposta CURTA: até 180 caracteres (pra caber bem no Instagram).

REGRAS DE OURO (NUNCA QUEBRAR):
1. NUNCA prometa prazo de entrega.
2. NUNCA invente preço, tecido, medida que não saiba.
3. NUNCA dê desconto.
4. SEMPRE convide a cliente a chamar no DM pra detalhes.
5. Se for pergunta sobre estoque/tamanho/preço específico: "te passo no DM, linda"
6. Se for elogio ou marca de amiga: agradece curto e convida pro DM.
7. Se for spam ou ofensa: NÃO responde (retorna vazio).

EXEMPLOS DE BOA RESPOSTA:
- "quanto custa?" → "Te passo o valor agora no DM, linda 💖"
- "tem 54?" → "Tenho sim, amor! Me chama no DM que separo pra você ✨"
- "linda demais!" → "Obrigada, amor! Qualquer dúvida me chama no DM 💖"
- "tenho 90kg, serve?" → "Tenho certeza que serve! Me chama no DM que vou te ajudar a escolher o tamanho perfeito 🙌"
- "qual o tecido?" → "Te passo todos os detalhes no DM, linda 💖"
- "@maria_amiga olha isso" → (não responde, ignora)
- "que feio" → (não responde, ignora)
- "vocês têm em loja física?" → "Sim! Me chama no DM que te passo os endereços ❤️"

@${input.username} comentou:
"${input.question}"

Responda em PT-BR, natural, curto. Sem markdown. Sem aspas envoltórias.
Se NÃO for pra responder (spam/ofensa/ambíguo), retorne apenas a palavra: SKIP`;

    try {
      const resp = await firstValueFrom(
        this.http.post(
          'https://api.anthropic.com/v1/messages',
          {
            model,
            max_tokens: 180,
            system,
            messages: [
              { role: 'user', content: input.question },
            ],
          },
          {
            headers: {
              'x-api-key': this.apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            timeout: 12_000,
          },
        ),
      );
      const text = resp.data?.content?.[0]?.text ?? '';
      const sanitized = this.sanitize(text);

      // Se modelo decidiu não responder (spam/ofensa)
      if (!sanitized || sanitized.toUpperCase() === 'SKIP') {
        return null;
      }
      return sanitized;
    } catch (err: any) {
      this.logger.error(
        `[Lú Posts] Claude falhou: ${err.response?.data?.error?.message || err.message}`,
      );
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Geração de resposta (Claude)
  // ─────────────────────────────────────────────────────────────────────

  private async generateAnswer(input: {
    question: string;
    product: any | null;
  }): Promise<string | null> {
    if (!this.apiKey) return null;
    const model =
      this.config.get<string>('ANTHROPIC_MODEL') || this.defaultModel;

    const productBlock = input.product
      ? this.formatProductContext(input.product)
      : 'Sem produto ao vivo no momento. Incentive a cliente a ver os próximos.';

    const system = `Você é a Lú, atendente da Lurds Plus Size em uma LIVE de Instagram.

PERSONALIDADE:
- Mulher brasileira de 32 anos, vendedora experiente de moda plus size.
- Acolhedora. NUNCA julga corpo ou tamanho.
- Direta, vai pro ponto, sem enrolar.
- Pode usar "amor", "linda", "meu bem" — máximo 1 vez por mensagem.
- Máximo 1 emoji por mensagem. Não exagera.
- Português brasileiro informal, mas correto.

REGRAS DE OURO (NUNCA QUEBRAR):
1. NUNCA prometa prazo de entrega — diga "vou chamar uma consultora pra te passar".
2. NUNCA dê desconto que não esteja no preço da live.
3. SEMPRE incentive a cliente a continuar assistindo a live.
4. Resposta CURTA: até 200 caracteres. Se a cliente pediu detalhe técnico, pode até 300.
5. Se não souber: "vou chamar uma consultora pra te ajudar, linda".
6. Se a cliente quer COMPRAR, oriente: "comenta CÓDIGO + TAMANHO que eu já separo".

CONTEXTO DO PRODUTO:
${productBlock}

PERGUNTA DA CLIENTE:
${input.question}

Responda em português brasileiro, natural, curto. Sem markdown. Sem aspas envolvendo a resposta.`;

    try {
      const resp = await firstValueFrom(
        this.http.post(
          'https://api.anthropic.com/v1/messages',
          {
            model,
            max_tokens: 200,
            system,
            messages: [
              { role: 'user', content: input.question },
            ],
          },
          {
            headers: {
              'x-api-key': this.apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            timeout: 12_000,
          },
        ),
      );
      const text = resp.data?.content?.[0]?.text ?? '';
      return this.sanitize(text);
    } catch (err: any) {
      this.logger.error(
        `Claude generateAnswer falhou: ${err.response?.data?.error?.message || err.message}`,
      );
      return null;
    }
  }

  private formatProductContext(p: any): string {
    const sizes = Array.isArray(p.sizes)
      ? p.sizes
          .filter((s: any) => s.stock > 0)
          .map((s: any) => `${s.size} (${s.stock} un)`)
          .join(', ')
      : 'sem info';
    return `Código: ${p.refCode}
Nome: ${p.displayName}
Preço: R$ ${(p.priceCents / 100).toFixed(2)}
Tamanhos disponíveis: ${sizes}
Promo: ${p.promoPriceCents ? `SIM (R$ ${(p.promoPriceCents / 100).toFixed(2)})` : 'não'}`;
  }

  /**
   * Sanitiza saída do modelo: remove markdown, aspas envoltórias,
   * limita comprimento.
   */
  private sanitize(text: string): string {
    return text
      .replace(/^["“]/, '')
      .replace(/["”]$/, '')
      .replace(/\*\*/g, '')
      .replace(/^\s+|\s+$/g, '')
      .slice(0, 400);
  }
}
