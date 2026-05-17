import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service'; // @TODO_VALIDATE_VS_LOJA
import { MetaService } from './meta.service';
import { CommentParserService } from './comment-parser.service';

// ═══════════════════════════════════════════════════════════════════════
// Lista de lojas físicas da Lurds Plus Size
// Atualize aqui quando abrir/fechar loja. Cada loja tem página própria em
// lurds.com.br/tree/{slug}/ com endereço completo, Maps e telefone.
// ═══════════════════════════════════════════════════════════════════════
interface PhysicalStore {
  city: string;
  state: string;
  slug: string;          // URL: lurds.com.br/tree/{slug}/
  aliases?: string[];    // como a cliente pode escrever (variantes)
}

const LURDS_PHYSICAL_STORES: PhysicalStore[] = [
  { city: 'Campinas',            state: 'SP', slug: 'campinas' },
  { city: 'Indaiatuba',          state: 'SP', slug: 'indaiatuba' },
  { city: 'Itanhaém',            state: 'SP', slug: 'itanhaem',
    aliases: ['itanhaem'] },
  { city: 'Itu',                 state: 'SP', slug: 'itu' },
  { city: 'Jundiaí',             state: 'SP', slug: 'jundiai',
    aliases: ['jundiai'] },
  { city: 'Limeira',             state: 'SP', slug: 'limeira' },
  { city: 'Moema',               state: 'SP', slug: 'moema',
    aliases: ['sao paulo', 'são paulo', 'sp capital', 'capital', 'zona sul'] },
  { city: 'Mogi das Cruzes',     state: 'SP', slug: 'mogi-das-cruzes',
    aliases: ['mogi'] },
  { city: 'Piracicaba',          state: 'SP', slug: 'piracicaba' },
  { city: 'Praia Grande',        state: 'SP', slug: 'praia-grande' },
  { city: 'Santos',              state: 'SP', slug: 'santos' },
  { city: 'São José dos Campos', state: 'SP', slug: 'sao-jose-dos-campos',
    aliases: ['sao jose', 'são josé', 'sjc'] },
  { city: 'Sorocaba',            state: 'SP', slug: 'sorocaba' },
  { city: 'Suzano',              state: 'SP', slug: 'suzano' },
  { city: 'Vinhedo',             state: 'SP', slug: 'vinhedo' },
];

const LURDS_TREE_URL = 'https://lurds.com.br/tree';

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
    private readonly parser: CommentParserService,
  ) {}

  // URL base do site (configurável via env)
  private get siteBaseUrl(): string {
    return this.config.get<string>('LURDS_SITE_URL') || 'https://lurds.com.br';
  }

  /**
   * Tenta identificar uma cidade mencionada pela cliente que bata com a lista
   * de lojas físicas da Lurds. Retorna a loja correspondente ou null.
   */
  private detectMentionedStore(text: string): PhysicalStore | null {
    const norm = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, ''); // remove acentos pra match mais robusto

    for (const store of LURDS_PHYSICAL_STORES) {
      const cityNorm = store.city
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
      // Match exato da cidade ou aliases
      if (norm.includes(cityNorm)) return store;
      if (store.aliases) {
        for (const alias of store.aliases) {
          if (norm.includes(alias.toLowerCase())) return store;
        }
      }
    }
    return null;
  }

  /**
   * Lista todas as cidades onde há loja física, formatada pra usar no prompt.
   */
  private listAllStoresAsText(): string {
    return LURDS_PHYSICAL_STORES.map((s) => s.city).join(', ');
  }

  /**
   * Monta a URL de CTA pro Instagram comment.
   * Se o parser detectou código (e opcionalmente tamanho), tenta levar direto
   * pro produto específico. Senão, manda pra loja geral.
   *
   * @TODO V1.1 — criar endpoint /api/cart-redirect?code=X&size=Y no backend
   * que faz lookup no banco/ERP e retorna URL precisa do WooCommerce com
   * carrinho já populado. Por enquanto, usa search do site (WooCommerce
   * indexa por ref_code).
   */
  private buildCtaUrl(refCode: string | null, size: string | null): {
    url: string;
    isProductSpecific: boolean;
  } {
    if (refCode) {
      // Busca no site pelo código. Quando V1.1 chegar, troca por endpoint
      // de redirect que sabe o slug correto do produto.
      const url = size
        ? `${this.siteBaseUrl}/?s=${encodeURIComponent(refCode)}&utm_source=instagram&utm_medium=comment&utm_campaign=lu-posts`
        : `${this.siteBaseUrl}/?s=${encodeURIComponent(refCode)}&utm_source=instagram&utm_medium=comment&utm_campaign=lu-posts`;
      return { url, isProductSpecific: true };
    }
    return {
      url: `${this.siteBaseUrl}/?utm_source=instagram&utm_medium=comment&utm_campaign=lu-posts`,
      isProductSpecific: false,
    };
  }

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

    // Roda parser pra detectar código + tamanho mesmo sem live ativa
    const parsed = await this.parser.parse(opts.question, {
      liveId: '',
      currentRefCode: null,
      aiFallbackEnabled: false,
    });

    // Monta CTA url (genérica ou específica do produto)
    const cta = this.buildCtaUrl(parsed.code ?? null, parsed.size ?? null);

    // Detecta menção a cidade com loja física
    const mentionedStore =
      parsed.intent === 'location_query'
        ? this.detectMentionedStore(opts.question)
        : null;

    this.logger.debug(
      `[Lú Posts] parsed=${JSON.stringify({ intent: parsed.intent, code: parsed.code, size: parsed.size })} cta=${cta.isProductSpecific ? 'produto' : 'geral'} mentionedStore=${mentionedStore?.city ?? 'nenhuma'}`,
    );

    const answer = await this.generatePostAnswer({
      question: opts.question,
      username: opts.igUsername,
      ctaUrl: cta.url,
      isProductSpecific: cta.isProductSpecific,
      refCode: parsed.code ?? null,
      size: parsed.size ?? null,
      intent: parsed.intent,
      mentionedStore,
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
   * Tom: SUPER amável com emojis, direciona pro link do site.
   */
  private async generatePostAnswer(input: {
    question: string;
    username: string;
    ctaUrl: string;
    isProductSpecific: boolean;
    refCode: string | null;
    size: string | null;
    intent?: string;
    mentionedStore?: PhysicalStore | null;
  }): Promise<string | null> {
    if (!this.apiKey) return null;
    const model =
      this.config.get<string>('ANTHROPIC_MODEL') || this.defaultModel;

    // ─── BLOCO CTA — adapta conforme tipo de pergunta ───────────────
    let ctaBlock: string;

    // CASO 1: pergunta sobre LOJA FÍSICA
    if (input.intent === 'location_query') {
      if (input.mentionedStore) {
        // Cliente mencionou uma cidade que TEM loja Lurds
        const storeUrl = `${LURDS_TREE_URL}/${input.mentionedStore.slug}/`;
        ctaBlock = `🏪 A cliente perguntou sobre loja física e mencionou **${input.mentionedStore.city}** — onde TEMOS loja!

INSTRUÇÃO:
- Confirma com entusiasmo que tem loja em ${input.mentionedStore.city}
- Inclui o link da loja específica: ${storeUrl}
- TAMBÉM sugere o site online como alternativa: ${input.ctaUrl}

Exemplo: "Aaaai amor, temos sim em ${input.mentionedStore.city}! 🥰 Endereço, telefone e Maps aqui: ${storeUrl} 💖 Ou se preferir comprar online: ${input.ctaUrl} ✨"`;
      } else {
        // Cliente perguntou sobre loja mas não mencionou cidade OU mencionou cidade sem loja
        ctaBlock = `🏪 A cliente perguntou sobre LOJA FÍSICA mas não mencionou cidade específica (ou mencionou cidade onde não temos).

LISTA DE CIDADES com loja Lurds (estado de SP):
${this.listAllStoresAsText()}

INSTRUÇÃO:
- Cite que temos lojas no estado de SP (interior, capital, litoral)
- Pode citar 3-4 cidades de exemplo se ficar natural
- SEMPRE incluir o link com todas as lojas (com Maps e telefone): ${LURDS_TREE_URL}/
- TAMBÉM sugerir compra online: ${input.ctaUrl}

Exemplo SEM cidade mencionada: "Temos várias lojas no estado de SP, amor! 💖 Vê todas (com Maps e telefone) aqui: ${LURDS_TREE_URL}/ 🛍️ Ou compra online em ${input.ctaUrl} ✨"

Exemplo CIDADE FORA da lista (ex: "tem em Manaus?"): "Ainda não temos loja em [cidade], florzinha 😢 Mas atendemos online com entrega pra todo Brasil: ${input.ctaUrl} 💖 E temos lojas no estado de SP: ${LURDS_TREE_URL}/ ✨"`;
      }
    }
    // CASO 2: cliente mencionou produto específico (código + tamanho)
    else if (input.isProductSpecific) {
      ctaBlock = `🎯 A cliente mencionou ${input.refCode ? `o código ${input.refCode}` : 'um produto'}${input.size ? ` no tamanho ${input.size}` : ''}.
INCLUA SEMPRE este link COMPLETO no final da resposta (leva direto pro produto no site):
${input.ctaUrl}

Exemplo: "Tá disponível sim, linda! Garante o seu aqui ${input.ctaUrl} 💖✨"`;
    }
    // CASO 3 (default): site geral
    else {
      ctaBlock = `INCLUA SEMPRE este link COMPLETO no final da resposta (leva pra loja online):
${input.ctaUrl}

Exemplo: "Te conto tudo aqui, amor! ${input.ctaUrl} 💖✨"`;
    }

    // ─── POSTS_SYSTEM_PROMPT — edite aqui pra ajustar tom e objetivo ───
    const system = `Você é a Lú, atendente da Lurds Plus Size respondendo comentários em posts do Instagram.

CONTEXTO:
- Lurds Plus Size é uma rede de lojas femininas plus size com loja online.
- A cliente comentou num post/reels da @lurdsplussize.
- NÃO é live ao vivo. Não fale "live", "ao vivo", etc.

🌸 PERSONALIDADE (MUITO AMÁVEL!):
- Brasileira, calorosa, expressiva, super acolhedora.
- ADORA usar emojis — 2 a 3 por mensagem (💖✨🥰❤️😍🛍️🌸🙌🤩💕)
- Usa expressões carinhosas: "linda", "amor", "querida", "florzinha", "amorzinho", "maravilhosa"
- Pode usar 2 dessas expressões por mensagem
- Tom de amiga, vendedora apaixonada
- NUNCA julga corpo, tamanho, idade ou aparência
- Sempre dá REAÇÃO emocional ao elogio ("aaai gente, obrigada!", "ameeei seu comentário")
- Resposta curtinha: até 220 caracteres (cabe bem no IG)

🎯 CTA (CALL TO ACTION — OBRIGATÓRIO):
${ctaBlock}

⛔ REGRAS DE OURO (NUNCA QUEBRAR):
1. NUNCA prometa prazo de entrega.
2. NUNCA invente preço, tecido, medida.
3. NUNCA dê desconto.
4. Se for SPAM, OFENSA, palavrão ou marca de amiga sem pergunta: retorne SKIP (não responde).
5. SEMPRE inclui o link de CTA na resposta.

📝 EXEMPLOS DE BOA RESPOSTA (tom amável + CTA):

- "quanto custa?" → "Aaaai amor, te conto tudinho aqui 💖✨ ${input.ctaUrl} 🛍️"
- "tem 54?" → "Tenho sim, linda! 🥰 Garante o seu aqui: ${input.ctaUrl} 💕"
- "linda demais!" → "Aaaai obrigada, florzinha! 🥰💖 Quer ver mais? ${input.ctaUrl} ✨"
- "tenho 90kg, serve?" → "Com certeza serve, amor! 💖 Confere a tabela de medidas aqui ${input.ctaUrl} 🙌✨"
- "qual o tecido?" → "Te conto tudo aqui, linda! 💕 ${input.ctaUrl} 🌸"
- "@maria_amiga olha" → SKIP
- "feio demais" → SKIP

@${input.username} comentou:
"${input.question}"

Responda em PT-BR, natural, amável, com emojis e o link CTA. Sem markdown. Sem aspas envoltórias.
Se for spam/ofensa, retorne APENAS a palavra: SKIP`;

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
