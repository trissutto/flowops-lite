import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { CriarPedidoInput, LojaOrdersService } from './loja-orders.service';
import { FreteService } from './frete.service';

/**
 * PEDIDO DO E-COMMERCE NOVO — porta SERVER-TO-SERVER (sprint 011).
 *
 * Quem bate aqui é o BFF do e-commerce (rotas /api do Next), NUNCA o
 * navegador da cliente. Por isso:
 *
 *  - Sem JWT (não há usuário logado do lado do site) e sim um segredo
 *    compartilhado no header `x-loja-token`, comparado em tempo constante.
 *  - Sem `LOJA_ORDER_TOKEN` configurada a rota responde 404 — mesmo padrão do
 *    `/api/events/logs` e do `/api/webhooks/payment` do e-commerce: ela
 *    simplesmente não existe pra quem não deveria saber que ela existe.
 *    Token errado TAMBÉM devolve 404 (não confirma a rota pra quem chuta).
 *  - Rate-limit por IP no POST: mesmo com token, um BFF em loop de retry não
 *    pode abrir 500 pedidos por minuto.
 *
 * Vive sob o mesmo prefixo público do catálogo (`/api/public/loja/...`) porque
 * é a mesma superfície do site — o catálogo é aberto, o pedido é autenticado.
 */

/* ─────────────────────── rate-limit em memória ────────────────────────── */

/**
 * Balde por IP guardado no `globalThis`: o Nest recria providers em hot-reload
 * e cada instância nova zeraria a contagem. É por processo (o Railway roda 1),
 * então serve de freio contra loop/scan — não é defesa distribuída.
 */
const BALDE_KEY = '__flowopsLojaOrderRate__';
const JANELA_MS = 60_000;
const LIMITE = 20;

function balde(): Map<string, number[]> {
  const g = globalThis as any;
  if (!g[BALDE_KEY]) g[BALDE_KEY] = new Map<string, number[]>();
  return g[BALDE_KEY];
}

function excedeuLimite(ip: string): boolean {
  const agora = Date.now();
  const m = balde();
  const hits = (m.get(ip) || []).filter((t) => agora - t < JANELA_MS);
  hits.push(agora);
  m.set(ip, hits);
  // Poda oportunista: sem isto o Map cresce pra sempre num scan de IPs.
  if (m.size > 5000) {
    for (const [k, v] of m) if (!v.some((t) => agora - t < JANELA_MS)) m.delete(k);
  }
  return hits.length > LIMITE;
}

@Controller('public/loja')
export class LojaOrdersController {
  constructor(
    private readonly svc: LojaOrdersService,
    private readonly freteSvc: FreteService,
  ) {}

  /** Comparação em tempo constante sobre os hashes (iguala o tamanho dos dois
   *  lados e impede que a diferença de tempo entregue o segredo byte a byte). */
  private segredoConfere(recebido: string, esperado: string): boolean {
    const a = crypto.createHash('sha256').update(recebido).digest();
    const b = crypto.createHash('sha256').update(esperado).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** Sem env ou token errado → 404 (nunca 401: não confirma que a rota existe). */
  private exigirToken(token?: string): void {
    const esperado = process.env.LOJA_ORDER_TOKEN;
    if (!esperado) throw new NotFoundException();
    if (!token || !this.segredoConfere(token, esperado)) throw new NotFoundException();
  }

  private ipDe(req: any): string {
    const xff = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return xff || req?.ip || req?.socket?.remoteAddress || 'desconhecido';
  }

  /**
   * POST /api/public/loja/frete — AS OPÇÕES DE ENTREGA do site, prontas.
   *
   * Nasceu (04/08) como proxy da cotação crua dos Correios. Virou a FONTE
   * ÚNICA do frete: aplica a tabela promocional cadastrada, completa com a
   * cotação real do contrato onde a promoção não cobre, soma os dias de
   * separação e devolve a régua do frete grátis. A regra inteira mora no
   * `FreteService` — o site só desenha o que vier.
   *
   * Por que a regra saiu do site: a tabela promocional muda por campanha, e
   * campanha não pode esperar deploy (itens 22 a 24). Enquanto ela vivia em
   * `ecommerce/src/lib/commerce/frete.ts`, mudar R$ 19,99 pra R$ 14,99 era um
   * commit.
   *
   * ORIGEM = MATRIZ (dono, 04/08): CEP 11746-692, via `CORREIOS_CEP_ORIGEM`.
   * Uma origem só mantém a cotação estável — o site cota antes de saber qual
   * loja vai despachar, e cotar por loja daria preço diferente pro mesmo
   * carrinho a cada recálculo do roteamento. Peso e caixa (250 g/peça, 28×40,
   * altura por faixa) também vivem lá dentro agora.
   *
   * Mesma porta do pedido: token `x-loja-token` + rate-limit por IP. Sem os
   * dois, isto vira consulta grátis ao contrato dos Correios pra qualquer um.
   *
   * FALHA NÃO TRAVA A COMPRA (item 20): Correios fora do ar cai na estimativa
   * interna, marcada com `estimado: true`. A promocional — que é a maior parte
   * dos pedidos — nem depende da cotação pra existir.
   */
  @Post('frete')
  async frete(
    @Body() body: { cep: string; pecas?: number; subtotal?: number },
    @Headers('x-loja-token') token: string,
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ) {
    this.exigirToken(token);
    if (excedeuLimite(this.ipDe(req))) {
      res.status(429);
      return { ok: false, error: 'Muitas consultas seguidas. Tente de novo em instantes.' };
    }

    const cep = String(body?.cep || '').replace(/\D/g, '');
    if (cep.length !== 8) return { ok: false, error: 'CEP inválido' };

    try {
      const cotacao = await this.freteSvc.cotar({
        cep,
        subtotal: Number(body?.subtotal) || 0,
        pecas: Number(body?.pecas) || 1,
      });
      const { cfg } = await this.freteSvc.config();
      return {
        ...cotacao,
        // A tela de entrega monta o texto da retirada com isto (item 27) — não
        // é página de ajuda, é a informação no momento da escolha.
        retirada: {
          prazoHoras: Number(cfg?.retiradaPrazoHoras ?? 3),
          instrucoes: cfg?.retiradaInstrucoes ?? null,
        },
      };
    } catch (e: any) {
      return { ok: false, error: 'Não consegui cotar agora', detalhe: String(e?.message || e).slice(0, 200) };
    }
  }

  /**
   * POST /api/public/loja/pedido
   *  201 { ok: true, order: { id, number, status, total, payment } }
   *  200 { ok: false, error } — recusa de negócio (cartão negado, valores
   *      divergentes...). É 200 de propósito: o BFF trata como resposta
   *      esperada e mostra a mensagem, não como falha de integração.
   */
  @Post('pedido')
  async criar(
    @Body() body: CriarPedidoInput,
    @Headers('x-loja-token') token: string,
    @Req() req: any,
    @Res({ passthrough: true }) res: any,
  ) {
    this.exigirToken(token);

    if (excedeuLimite(this.ipDe(req))) {
      res.status(429);
      return { ok: false, error: 'Muitas tentativas seguidas. Aguarde um minutinho e tente de novo. 💜' };
    }

    const r = await this.svc.criarPedido(body);
    res.status(r.ok ? 201 : 200);
    return r;
  }

  /** GET /api/public/loja/pedido/:id — CPF mascarado, sem tracking, sem gateway. */
  @Get('pedido/:id')
  async buscar(@Param('id') id: string, @Headers('x-loja-token') token: string) {
    this.exigirToken(token);
    const r = await this.svc.buscarPedido(id);
    if (!r.ok) throw new NotFoundException(r.error || 'Pedido não encontrado.');
    return r;
  }

  /** GET /api/public/loja/pedido/:id/status — é o poll do PIX. */
  @Get('pedido/:id/status')
  async status(@Param('id') id: string, @Headers('x-loja-token') token: string) {
    this.exigirToken(token);
    const r = await this.svc.statusPedido(id);
    if (!r.ok) throw new NotFoundException(r.error || 'Pedido não encontrado.');
    return r;
  }
}
