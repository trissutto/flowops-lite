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
