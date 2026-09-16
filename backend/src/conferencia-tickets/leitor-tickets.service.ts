import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { LeituraFoto, normalizarLeitura, PROMPT_SISTEMA, SCHEMA_LEITURA, textoDaFoto } from './leitura-ia';

/**
 * Lê UMA foto de tickets com o Claude (visão + saída estruturada).
 *
 * Envs:
 *  - `ANTHROPIC_API_KEY` — a mesma das outras IAs do Flow. Sem ela a foto fica
 *    na fila com o motivo escrito (a tela mostra), nunca some.
 *  - `TICKETS_IA_MODELO` — padrão `claude-opus-5`.
 *  - `TICKETS_IA_ESFORCO` — low | medium | high | xhigh | max (padrão medium).
 *
 * `fallbacks: 'default'`: se o modelo recusar a foto por política, a própria
 * API tenta o modelo reserva recomendado na mesma chamada.
 */

export class ErroLeitura extends Error {
  constructor(
    message: string,
    /** vale tentar de novo mais tarde (rede, limite, servidor) */
    readonly temporario: boolean,
    /** espera sugerida antes da próxima tentativa */
    readonly esperaMs = 5 * 60_000,
  ) {
    super(message);
  }
}

export interface ResultadoLeitura {
  leitura: LeituraFoto;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
}

const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Esforco = (typeof ESFORCOS)[number];

@Injectable()
export class LeitorTicketsService {
  private readonly logger = new Logger(LeitorTicketsService.name);
  private client: Anthropic | null = null;

  get configurado(): boolean {
    return !!String(process.env.ANTHROPIC_API_KEY || '').trim();
  }

  get modelo(): string {
    return String(process.env.TICKETS_IA_MODELO || '').trim() || 'claude-opus-5';
  }

  private get esforco(): Esforco {
    const e = String(process.env.TICKETS_IA_ESFORCO || '').trim().toLowerCase();
    return (ESFORCOS as readonly string[]).includes(e) ? (e as Esforco) : 'medium';
  }

  private cliente(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: String(process.env.ANTHROPIC_API_KEY || '').trim(),
        timeout: 180_000,
        maxRetries: 2,
      });
    }
    return this.client;
  }

  async ler(
    imagem: Buffer,
    mime: 'image/jpeg' | 'image/png' | 'image/webp',
    ctx: { storeCode: string; storeName?: string | null; dia: string },
  ): Promise<ResultadoLeitura> {
    if (!this.configurado) {
      throw new ErroLeitura('IA desligada: falta ANTHROPIC_API_KEY no Railway', true, 60 * 60_000);
    }
    let resposta: Anthropic.Beta.Messages.BetaMessage;
    try {
      resposta = await this.cliente().beta.messages.create({
        model: this.modelo,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: this.esforco,
          format: { type: 'json_schema', schema: SCHEMA_LEITURA },
        },
        system: [{ type: 'text', text: PROMPT_SISTEMA, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: imagem.toString('base64') } },
              { type: 'text', text: textoDaFoto(ctx) },
            ],
          },
        ],
      });
    } catch (e) {
      throw this.traduzirErro(e);
    }

    if (resposta.stop_reason === 'refusal') {
      throw new ErroLeitura('a IA recusou ler esta foto — confira na mão', false);
    }
    if (resposta.stop_reason === 'max_tokens') {
      throw new ErroLeitura('leitura cortada no meio (foto com tickets demais?) — divida em fotos menores', false);
    }
    const texto = resposta.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    let bruto: unknown;
    try {
      bruto = JSON.parse(texto);
    } catch {
      throw new ErroLeitura('a IA devolveu uma resposta que não é JSON', true, 10 * 60_000);
    }

    const u = resposta.usage;
    return {
      leitura: normalizarLeitura(bruto),
      modelo: resposta.model,
      tokensEntrada:
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      tokensSaida: u.output_tokens || 0,
    };
  }

  private traduzirErro(e: unknown): ErroLeitura {
    if (e instanceof Anthropic.RateLimitError) {
      return new ErroLeitura('limite de uso da IA atingido — tenta de novo sozinho', true, 10 * 60_000);
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      this.logger.error(`[tickets-ia] chave recusada pela Anthropic: ${(e as Error).message}`);
      return new ErroLeitura('a chave da IA foi recusada (ANTHROPIC_API_KEY)', true, 60 * 60_000);
    }
    if (e instanceof Anthropic.BadRequestError) {
      return new ErroLeitura(`a IA não aceitou esta foto: ${e.message.slice(0, 200)}`, false);
    }
    if (e instanceof Anthropic.NotFoundError) {
      return new ErroLeitura(`modelo "${this.modelo}" não encontrado (TICKETS_IA_MODELO)`, true, 60 * 60_000);
    }
    if (e instanceof Anthropic.APIConnectionError) {
      return new ErroLeitura('sem conexão com a IA agora — tenta de novo sozinho', true);
    }
    if (e instanceof Anthropic.APIError) {
      return new ErroLeitura(`a IA respondeu ${e.status ?? 'erro'} — tenta de novo sozinho`, true);
    }
    return new ErroLeitura(`falha lendo a foto: ${(e as Error)?.message || e}`, true);
  }
}
