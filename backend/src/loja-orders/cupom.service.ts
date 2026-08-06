import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CUPOM DO SITE — recalculado por quem cobra (item 3 da lista de lançamento).
 *
 * Antes: a única conta de cupom que existia rodava no BFF do e-commerce
 * (`ecommerce/src/lib/commerce/cupom.ts`) e o backend recebia o `discount`
 * pronto. Como o backend é quem cria o pedido e chama a Pagar.me, ele estava
 * cobrando um desconto que não conferiu — e o BFF não é o dono do dinheiro.
 *
 * Agora a regra tem TRÊS fontes, nesta ordem:
 *   1. tabela `site_cupons`  → é onde a retaguarda cria/edita (item 55)
 *   2. env `SITE_CUPONS_JSON` → escape hatch pra campanha relâmpago sem banco
 *   3. tabela embutida        → os mesmos 3 códigos que o site já anunciava,
 *                               pra nenhum cupom impresso parar de funcionar
 *                               no dia do deploy
 *
 * As mensagens são as MESMAS do site, palavra por palavra: a cliente não pode
 * ver um texto na sacola e outro no checkout.
 */

export type TipoCupom = 'percent' | 'fixed' | 'shipping';

export interface RegraCupom {
  code: string;
  label: string;
  tipo: TipoCupom;
  valor: number;
  minSubtotal?: number | null;
  primeiraCompra?: boolean;
  categorias?: string[] | null;
  inicioEm?: Date | null;
  fimEm?: Date | null;
  usoMaximo?: number | null;
  usos?: number;
}

export interface ResultadoCupom {
  ok: boolean;
  code: string;
  /** Desconto em REAIS sobre o subtotal (shipping devolve 0 — o abate é no frete). */
  desconto: number;
  tipo?: TipoCupom;
  /** Frase pronta pra tela. */
  mensagem: string;
}

/** Fallback embutido — espelho exato do que o site anunciava até 04/08/2026. */
const REGRAS_PADRAO: RegraCupom[] = [
  { code: 'BEMVINDA10', tipo: 'percent', valor: 10, minSubtotal: 149.9, label: 'Boas-vindas: 10% off' },
  { code: 'LURDS15', tipo: 'percent', valor: 15, minSubtotal: 349.9, label: '15% off acima de R$ 349,90' },
  { code: 'FRETEGRATIS', tipo: 'shipping', valor: 0, minSubtotal: 199.9, label: 'Frete grátis' },
];

@Injectable()
export class CupomService {
  private readonly logger = new Logger(CupomService.name);

  /** Cache curto: cupom muda por edição humana, não por segundo. */
  private cache: { at: number; regras: RegraCupom[] } | null = null;
  private static readonly TTL = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  private norm(code: any): string {
    return String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  }

  private reais(v: number): string {
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  private tipoValido(v: any): TipoCupom {
    return v === 'fixed' || v === 'shipping' ? v : 'percent';
  }

  /** Lê a tabela; vazia ou indisponível cai pro env e depois pro padrão. */
  private async regras(): Promise<RegraCupom[]> {
    if (this.cache && Date.now() - this.cache.at < CupomService.TTL) return this.cache.regras;

    let regras: RegraCupom[] = [];
    try {
      const rows: any[] = await (this.prisma as any).siteCupom.findMany({ where: { ativo: true } });
      regras = rows.map((r) => ({
        code: this.norm(r.code),
        label: String(r.label || r.code),
        tipo: this.tipoValido(r.tipo),
        valor: Number(r.valor) || 0,
        minSubtotal: r.minSubtotal ?? null,
        primeiraCompra: !!r.primeiraCompra,
        categorias: String(r.categorias || '')
          .split(',')
          .map((c: string) => c.trim().toLowerCase())
          .filter(Boolean),
        inicioEm: r.inicioEm ?? null,
        fimEm: r.fimEm ?? null,
        usoMaximo: r.usoMaximo ?? null,
        usos: Number(r.usos) || 0,
      }));
    } catch (e: any) {
      // Tabela ainda não existe (deploy anterior ao db push) — não é erro fatal.
      this.logger.warn(`[cupom] tabela indisponível, usando env/padrão: ${e?.message || e}`);
    }

    if (!regras.length && process.env.SITE_CUPONS_JSON) {
      try {
        const parsed = JSON.parse(process.env.SITE_CUPONS_JSON);
        if (Array.isArray(parsed) && parsed.length) {
          regras = parsed.map((r: any) => ({
            code: this.norm(r.code),
            label: String(r.label || r.code),
            // Aceita o vocabulário do site (`kind`) pra env copiada de lá.
            tipo: this.tipoValido(r.tipo ?? r.kind),
            valor: Number(r.valor ?? r.value) || 0,
            minSubtotal: r.minSubtotal ?? null,
            fimEm: r.expiresAt ? new Date(r.expiresAt) : (r.fimEm ? new Date(r.fimEm) : null),
          }));
        }
      } catch {
        this.logger.warn('[cupom] SITE_CUPONS_JSON inválido — usando tabela padrão');
      }
    }

    if (!regras.length) regras = REGRAS_PADRAO;

    this.cache = { at: Date.now(), regras };
    return regras;
  }

  /** Zera o cache — chamado pela retaguarda depois de criar/editar cupom. */
  invalidarCache(): void {
    this.cache = null;
  }

  /**
   * Aplica o cupom sobre o subtotal JÁ CONFERIDO no catálogo.
   *
   * `primeiraCompra` é checado pelo CPF: se a pessoa já tem pedido do site
   * pago, o cupom de boas-vindas não vale. Falha na checagem não derruba o
   * pedido — deixa passar e registra (melhor um desconto a mais que um
   * checkout travado por indisponibilidade de banco).
   */
  async aplicar(
    codigoBruto: string,
    subtotal: number,
    contexto?: { cpf?: string; categorias?: string[] },
  ): Promise<ResultadoCupom> {
    const code = this.norm(codigoBruto);
    if (!code) return { ok: false, code, desconto: 0, mensagem: 'Digite o código do cupom.' };

    const regra = (await this.regras()).find((r) => r.code === code);
    if (!regra) {
      return {
        ok: false,
        code,
        desconto: 0,
        mensagem: 'Não encontramos esse cupom. Confira o código e tente de novo.',
      };
    }

    const agora = Date.now();
    if (regra.inicioEm && new Date(regra.inicioEm).getTime() > agora) {
      return { ok: false, code, desconto: 0, mensagem: 'Esse cupom ainda não começou a valer. Fique de olho!' };
    }
    if (regra.fimEm && new Date(regra.fimEm).getTime() < agora) {
      return {
        ok: false,
        code,
        desconto: 0,
        mensagem: 'Esse cupom já expirou — mas fique de olho: sempre temos novidades.',
      };
    }
    if (regra.usoMaximo != null && (regra.usos ?? 0) >= regra.usoMaximo) {
      return {
        ok: false,
        code,
        desconto: 0,
        mensagem: 'Esse cupom já foi todo utilizado. Fique de olho: sempre temos novidades. 💜',
      };
    }
    if (regra.minSubtotal && subtotal < regra.minSubtotal) {
      return {
        ok: false,
        code,
        desconto: 0,
        mensagem: `Esse cupom vale para compras a partir de ${this.reais(regra.minSubtotal)}. Faltam ${this.reais(regra.minSubtotal - subtotal)}.`,
      };
    }
    if (regra.categorias?.length && contexto?.categorias?.length) {
      const alvo = contexto.categorias.map((c) => c.toLowerCase());
      if (!regra.categorias.some((c) => alvo.includes(c))) {
        return {
          ok: false,
          code,
          desconto: 0,
          mensagem: 'Esse cupom não vale para as peças da sua sacola. 💜',
        };
      }
    }
    if (regra.primeiraCompra && contexto?.cpf) {
      const jaComprou = await this.jaComprou(contexto.cpf);
      if (jaComprou) {
        return {
          ok: false,
          code,
          desconto: 0,
          mensagem: 'Esse cupom é só para a primeira compra no site — mas temos outras condições pra você. 💜',
        };
      }
    }

    const desconto =
      regra.tipo === 'percent'
        ? Math.round(subtotal * (regra.valor / 100) * 100) / 100
        : regra.tipo === 'fixed'
          ? Math.min(regra.valor, subtotal)
          : 0; // shipping: o abate é no frete, não no subtotal

    return {
      ok: true,
      code,
      desconto,
      tipo: regra.tipo,
      mensagem:
        regra.tipo === 'shipping'
          ? 'Cupom aplicado: seu frete sai grátis.'
          : `Cupom aplicado: ${regra.label.toLowerCase()} (−${this.reais(desconto)}).`,
    };
  }

  /** Já existe pedido do SITE pago no CPF? */
  private async jaComprou(cpf: string): Promise<boolean> {
    const d = String(cpf || '').replace(/\D/g, '');
    if (d.length !== 11) return false;
    try {
      const achou = await (this.prisma as any).order.findFirst({
        where: { source: 'ecommerce', customerCpf: d, paidAt: { not: null } },
        select: { id: true },
      });
      return !!achou;
    } catch (e: any) {
      this.logger.warn(`[cupom] não consegui checar primeira compra (liberando): ${e?.message || e}`);
      return false;
    }
  }

  /** Marca o uso depois que o pedido nasceu. Falha aqui nunca derruba a venda. */
  async registrarUso(code?: string | null): Promise<void> {
    const c = this.norm(code);
    if (!c) return;
    try {
      await (this.prisma as any).siteCupom.update({
        where: { code: c },
        data: { usos: { increment: 1 } },
      });
      this.cache = null;
    } catch {
      /* cupom de env/padrão não tem linha — nada a contar */
    }
  }
}
