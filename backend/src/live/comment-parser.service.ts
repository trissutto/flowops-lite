import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export type Intent =
  | 'buy'
  | 'size_query'
  | 'price_query'
  | 'fabric_query'
  | 'color_query'
  | 'greeting'
  | 'unknown';

export interface ParseResult {
  intent: Intent;
  code: string | null;
  size: string | null;
  confidence: number; // 0..1
  normalized: string;
  method: 'regex' | 'keyword' | 'ai' | 'unknown';
}

interface ParseContext {
  liveId: string;
  currentRefCode: string | null;
  aiFallbackEnabled: boolean;
}

/**
 * CommentParserService — interpreta comentários em PT-BR em 3 camadas:
 *
 *  1. Regex pra "CODIGO TAMANHO" (95%+ dos casos de compra direta)
 *  2. Keywords pra intenções comuns (quero/amei/tem 54)
 *  3. IA classificadora (Claude Haiku) — só se camadas 1 e 2 falharem
 *
 * Custo: regex é grátis. Haiku custa ~US$ 0.0001 por classificação.
 * Em uma live com 1000 comentários, ~50 vão pra IA → custo total ~US$ 0.005.
 */
@Injectable()
export class CommentParserService {
  private readonly logger = new Logger(CommentParserService.name);

  // Tamanhos plus size válidos da Lurds
  private readonly VALID_SIZES = new Set([
    '46', '48', '50', '52', '54', '56', '58', '60',
    'G', 'GG', 'EG', 'G1', 'G2', 'G3', 'G4',
  ]);

  // Palavras-chave por intenção (todas em minúsculo, sem acento)
  private readonly BUY_KEYWORDS = [
    'quero', 'to levando', 'tô levando', 'pega pra mim', 'pega pra min',
    'reserva', 'reservar', 'separa pra mim', 'separa pra min',
    'minha', 'eu quero', 'eu pego', 'amei vou levar', 'ja eh meu',
    'já é meu', 'me manda', 'me ve', 'me vê',
  ];

  private readonly SIZE_QUERY_KEYWORDS = ['tem', 'tem o', 'tem do', 'que tamanho'];
  private readonly PRICE_QUERY_KEYWORDS = ['quanto', 'valor', 'preco', 'preço'];
  private readonly FABRIC_QUERY_KEYWORDS = [
    'tecido', 'malha', 'elastano', 'estica', 'marca barriga',
    'transparente',
  ];
  private readonly COLOR_QUERY_KEYWORDS = [
    'tem outra cor', 'outras cores', 'tem em',
  ];
  private readonly GREETING_KEYWORDS = ['oi', 'ola', 'olá', 'boa noite', 'boa tarde'];

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  async parse(text: string, ctx: ParseContext): Promise<ParseResult> {
    const normalized = this.normalize(text);

    // ── Camada 1: regex CODIGO + TAMANHO ─────────────────────────────
    const codeSize = this.matchCodeSize(normalized);
    if (codeSize) {
      return {
        intent: 'buy',
        code: codeSize.code,
        size: codeSize.size,
        confidence: 0.95,
        normalized,
        method: 'regex',
      };
    }

    // ── Camada 2: keywords ───────────────────────────────────────────
    if (this.hasAny(normalized, this.BUY_KEYWORDS)) {
      // Sem código explícito, assume produto atual
      const inferredSize = this.extractSize(normalized);
      return {
        intent: 'buy',
        code: ctx.currentRefCode,
        size: inferredSize,
        confidence: ctx.currentRefCode ? 0.75 : 0.5,
        normalized,
        method: 'keyword',
      };
    }

    if (
      /\btem\s+(\d{2})\b/.test(normalized) ||
      this.hasAny(normalized, this.SIZE_QUERY_KEYWORDS)
    ) {
      const size = this.extractSize(normalized);
      return {
        intent: 'size_query',
        code: ctx.currentRefCode,
        size,
        confidence: 0.85,
        normalized,
        method: 'keyword',
      };
    }

    if (this.hasAny(normalized, this.PRICE_QUERY_KEYWORDS)) {
      return {
        intent: 'price_query',
        code: ctx.currentRefCode,
        size: null,
        confidence: 0.85,
        normalized,
        method: 'keyword',
      };
    }

    if (this.hasAny(normalized, this.FABRIC_QUERY_KEYWORDS)) {
      return {
        intent: 'fabric_query',
        code: ctx.currentRefCode,
        size: null,
        confidence: 0.85,
        normalized,
        method: 'keyword',
      };
    }

    if (this.hasAny(normalized, this.COLOR_QUERY_KEYWORDS)) {
      return {
        intent: 'color_query',
        code: ctx.currentRefCode,
        size: null,
        confidence: 0.85,
        normalized,
        method: 'keyword',
      };
    }

    if (this.hasAny(normalized, this.GREETING_KEYWORDS)) {
      return {
        intent: 'greeting',
        code: null,
        size: null,
        confidence: 0.9,
        normalized,
        method: 'keyword',
      };
    }

    // ── Camada 3: IA classificadora (opcional, se habilitada) ─────────
    if (ctx.aiFallbackEnabled) {
      const ai = await this.classifyWithAi(text, ctx).catch((err) => {
        this.logger.warn(`IA classify falhou: ${err.message}`);
        return null;
      });
      if (ai) {
        return { ...ai, normalized, method: 'ai' };
      }
    }

    return {
      intent: 'unknown',
      code: null,
      size: null,
      confidence: 0,
      normalized,
      method: 'unknown',
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  private normalize(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[!?.,;:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hasAny(text: string, keywords: string[]): boolean {
    return keywords.some((k) => text.includes(k));
  }

  private matchCodeSize(
    text: string,
  ): { code: string; size: string } | null {
    // Aceita "205 52", "205-52", "205/52", "205x52", "205 tam 54"
    const patterns = [
      /\b(\d{2,5})\s*[\s\-x/]\s*(\d{2})\b/,
      /\b(\d{2,5})\s+tam(?:anho)?\s*(\d{2})\b/,
      /\b(\d{2,5})\s+n(?:o|°)\s*(\d{2})\b/,
    ];
    for (const re of patterns) {
      const m = re.exec(text);
      if (m && this.VALID_SIZES.has(m[2])) {
        return { code: m[1], size: m[2] };
      }
    }
    return null;
  }

  private extractSize(text: string): string | null {
    const m = /\b(\d{2})\b/.exec(text);
    if (m && this.VALID_SIZES.has(m[1])) return m[1];
    const letter = /\b(g{1,2}|eg|g[1-4])\b/i.exec(text);
    if (letter) return letter[1].toUpperCase();
    return null;
  }

  /**
   * Camada 3: Claude Haiku classifica intenção quando regex/keywords falham.
   * Chamada simples (sem tools), JSON estruturado.
   */
  private async classifyWithAi(
    text: string,
    ctx: ParseContext,
  ): Promise<Omit<ParseResult, 'normalized' | 'method'> | null> {
    const key = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!key) return null;

    const model =
      this.config.get<string>('ANTHROPIC_CLASSIFIER_MODEL') ||
      'claude-haiku-4-5-20251001';

    const system = `Classifique o comentário de uma live de moda feminina plus size em JSON.
Intents possíveis: buy, size_query, price_query, fabric_query, color_query, greeting, unknown.
Responda SOMENTE com JSON válido no formato:
{"intent":"...","code":null,"size":null,"confidence":0.0}
Contexto: produto atual da live tem código ${ctx.currentRefCode ?? 'desconhecido'}.`;

    try {
      const resp = await firstValueFrom(
        this.http.post(
          'https://api.anthropic.com/v1/messages',
          {
            model,
            max_tokens: 100,
            system,
            messages: [{ role: 'user', content: text }],
          },
          {
            headers: {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            timeout: 8_000,
          },
        ),
      );
      const content = resp.data?.content?.[0]?.text ?? '';
      const parsed = JSON.parse(content);
      return {
        intent: parsed.intent ?? 'unknown',
        code: parsed.code ?? ctx.currentRefCode ?? null,
        size: parsed.size ?? null,
        confidence: Number(parsed.confidence ?? 0.6),
      };
    } catch (err: any) {
      this.logger.debug(`IA classify err: ${err.message}`);
      return null;
    }
  }
}
