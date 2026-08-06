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
import { CorreiosService } from '../correios/correios.service';

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
    private readonly correios: CorreiosService,
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
   * POST /api/public/loja/frete — COTAÇÃO REAL DOS CORREIOS pro site.
   *
   * O site cotava por TABELA FIXA de faixa de CEP (`ecommerce/src/lib/commerce/
   * frete.ts`), declarada como estimativa. O cálculo de verdade sempre existiu
   * aqui — e COM CONTRATO: `CORREIOS_CONTRATO` + `CORREIOS_CARTAO_POSTAGEM` +
   * `CORREIOS_DR` já configurados, é o preço NEGOCIADO (convênio SIGEP), não
   * tabela de balcão. Faltava só uma porta pública.
   *
   * ORIGEM = MATRIZ (dono, 04/08): CEP 11746-692. Uma origem só mantém a
   * cotação estável — o site cota antes de saber qual loja vai despachar, e
   * cotar por loja daria preço diferente pro mesmo carrinho a cada
   * recálculo do roteamento.
   *
   * Mesma porta do pedido: token `x-loja-token` + rate-limit por IP. Sem os
   * dois, isto vira consulta grátis ao contrato dos Correios pra qualquer um.
   *
   * FALHA NÃO TRAVA A COMPRA: se os Correios não responderem, devolve
   * `{ ok:false }` e o site cai na estimativa. Melhor frete aproximado do que
   * checkout parado.
   */
  @Post('frete')
  async frete(
    @Body() body: { cep: string; pecas?: number; pesoGramas?: number; comprimento?: number; largura?: number; altura?: number },
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

    /**
     * PESO E CAIXA — números do dono (04/08): 250 g por peça, embalagem
     * 28 (largura) × 40 (comprimento) × 3 cm (altura) por peça.
     *
     * A ALTURA é o único que acompanha a quantidade: duas peças na mesma
     * embalagem empilham (3 → 6 cm), largura e comprimento não mudam. Cotar
     * tudo com 3 cm fixo daria frete barato demais no pedido grande, e a conta
     * viria pra vocês na postagem.
     *
     * O site pode sobrescrever qualquer um; sem informação, vale 1 peça.
     */
    const pecas = Math.min(50, Math.max(1, Number(body?.pecas) || 1));
    const peso = Math.min(30000, Number(body?.pesoGramas) || 250 * pecas);
    const largura = Number(body?.largura) || 28;
    const comprimento = Number(body?.comprimento) || 40;
    const altura = Number(body?.altura) || 3 * pecas;

    try {
      // A ORIGEM sai de `CORREIOS_CEP_ORIGEM` (env) — o serviço não aceita
      // origem por chamada, e é bom que seja assim: uma origem só mantém a
      // cotação estável entre o carrinho e o checkout. Matriz = 11746-692.
      const r: any = await this.correios.calcularFrete({
        cepDestino: cep,
        pesoGramas: peso,
        comprimento,
        largura,
        altura,
      });
      return {
        ok: true,
        cep,
        pecas,
        caixa: { pesoGramas: peso, largura, comprimento, altura },
        servicos: r?.servicos ?? r,
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
