import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * LIMITE ÚNICO DA REDE — exposição consolidada por PESSOA (CPF).
 *
 * Regra do dono (01/08/2026): o limite cobre CREDIÁRIO + MARCADOS somados em
 * TODAS as lojas. Sem limite disponível, a cliente não leva marcado e não fecha
 * crediário — nem em loja onde nunca comprou. Aumento é decisão da Matriz.
 *
 * Hoje o limite é por loja e ninguém aplica de verdade. A medição de 01/08
 * (`scripts/giga-etl/medir-exposicao-rede.js`) mostrou o tamanho disso:
 *
 *   706 pessoas com dívida        R$ 1.404.533,02
 *   204 JÁ ACIMA do limite        R$ 623.344,47
 *   7 com dívida e limite ZERO    R$ 8.804,81
 *   76 pessoas com ficha em mais de uma loja
 *
 * Ou seja: a regra nova não cria o problema, ela revela um que já existe. Há
 * caso de limite R$ 106 com dívida de R$ 63 mil, e até limite NEGATIVO.
 *
 * ── POR QUE NASCE DESLIGADA ──
 *
 * Ligar sem preparo tira 204 clientes ativas do crediário no dia seguinte. A
 * regra é entregue com o cálculo pronto e o bloqueio DESLIGADO, mais uma tela
 * que lista quem seria travado. O dono revisa limite caso a caso e liga quando
 * quiser.
 *
 * O interruptor mora no BANCO (SystemSetting), não em env: o botão está na tela
 * e precisa valer na hora, sem deploy nem restart.
 */
@Injectable()
export class LimiteRedeService {
  private readonly logger = new Logger(LimiteRedeService.name);

  private static readonly CHAVE = 'limite_rede_ativo';

  constructor(private readonly prisma: PrismaService) {}

  /** O bloqueio está valendo? Default FALSE — nasce desligado de propósito. */
  async ativo(): Promise<boolean> {
    try {
      const s = await (this.prisma as any).systemSetting.findUnique({
        where: { key: LimiteRedeService.CHAVE },
      });
      return String(s?.value ?? '') === '1';
    } catch {
      // Falha lendo a configuração NÃO pode ligar o bloqueio sozinha: na
      // dúvida, deixa vender. Travar venda por erro de leitura é pior.
      return false;
    }
  }

  async definirAtivo(ativo: boolean, usuario?: string): Promise<{ ativo: boolean }> {
    await (this.prisma as any).systemSetting.upsert({
      where: { key: LimiteRedeService.CHAVE },
      create: { key: LimiteRedeService.CHAVE, value: ativo ? '1' : '0' },
      update: { value: ativo ? '1' : '0' },
    });
    this.logger.warn(
      `[limite-rede] bloqueio ${ativo ? 'LIGADO' : 'DESLIGADO'} por ${usuario || '?'}`,
    );
    return { ativo };
  }

  private soDigitos(v: any): string {
    return String(v ?? '').replace(/\D/g, '');
  }

  /**
   * Exposição consolidada de UMA pessoa, com a origem de cada real.
   *
   * `porLoja` existe pra tela do PDV poder dizer de ONDE vem a dívida — sem
   * isso a vendedora de Sorocaba vê uma recusa que não sabe explicar pra
   * cliente na frente dela.
   */
  async daPessoa(cpfRaw: string): Promise<{
    cpf: string;
    encontrada: boolean;
    limite: number;
    crediario: number;
    marcados: number;
    exposicao: number;
    disponivel: number;
    avaliacao: string | null;
    lojaOrigem: string | null;
    porLoja: Array<{ loja: string; codigo: string; crediario: number; marcados: number }>;
  }> {
    const cpf = this.soDigitos(cpfRaw);
    const vazio = {
      cpf, encontrada: false, limite: 0, crediario: 0, marcados: 0,
      exposicao: 0, disponivel: 0, avaliacao: null, lojaOrigem: null, porLoja: [],
    };
    if (cpf.length < 11) return vazio;

    // Todas as fichas da MESMA pessoa, em qualquer loja.
    const fichas: any[] = await (this.prisma as any).$queryRawUnsafe(
      `SELECT loja, codigo, COALESCE(limite_compras,0)::float AS limite,
              avaliacao, synced_at
         FROM giga_clientes
        WHERE regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $1
        ORDER BY synced_at ASC`,
      cpf,
    );
    if (!fichas.length) return vazio;

    const porLoja: any[] = [];
    let crediario = 0;
    let marcados = 0;

    for (const f of fichas) {
      const [cred]: any[] = await (this.prisma as any).$queryRawUnsafe(
        `SELECT COALESCE(SUM(valor_parcela),0)::float AS v
           FROM crediario_parcelas
          WHERE loja = $1 AND cod_cliente = $2 AND pago = false AND cancelado = false`,
        String(f.loja), String(f.codigo),
      );
      const [marc]: any[] = await (this.prisma as any).$queryRawUnsafe(
        `SELECT COALESCE(SUM(valor_total),0)::float AS v
           FROM marcados
          WHERE store_code = $1 AND cod_cliente = $2
            AND status = 'ativo' AND is_training = false`,
        String(f.loja), String(f.codigo),
      );
      const c = Number(cred?.v || 0);
      const m = Number(marc?.v || 0);
      crediario += c;
      marcados += m;
      porLoja.push({ loja: String(f.loja), codigo: String(f.codigo), crediario: c, marcados: m });
    }

    // O limite da PESSOA é o maior entre as fichas — não a soma. Somar daria
    // limite maior a quem tem cadastro em mais lojas, que é o oposto da regra.
    const limite = Math.max(0, ...fichas.map((f) => Number(f.limite || 0)));
    const exposicao = crediario + marcados;

    return {
      cpf,
      encontrada: true,
      limite,
      crediario,
      marcados,
      exposicao,
      disponivel: Math.max(0, limite - exposicao),
      // Avaliação também é a melhor entre as fichas (A ganha de B).
      avaliacao: fichas.map((f) => f.avaliacao).filter(Boolean).sort()[0] || null,
      // "Lembrada como cliente de tal loja": a ficha mais antiga é a origem.
      lojaOrigem: String(fichas[0].loja),
      porLoja,
    };
  }

  /**
   * Pode levar mais R$ X (marcado ou crediário)?
   *
   * Devolve SEMPRE o cálculo — mesmo com o bloqueio desligado. Assim a tela
   * pode mostrar o aviso antes de a regra valer, e a operação se acostuma com o
   * número antes de ele começar a barrar.
   */
  async podeLevar(cpf: string, valor: number): Promise<{
    permitido: boolean;
    bloqueioAtivo: boolean;
    motivo: string | null;
    exposicao: Awaited<ReturnType<LimiteRedeService['daPessoa']>>;
  }> {
    const bloqueioAtivo = await this.ativo();
    const exp = await this.daPessoa(cpf);
    const v = Number(valor) || 0;

    let motivo: string | null = null;
    if (!exp.encontrada) motivo = 'Cliente sem ficha cadastrada';
    else if (exp.limite <= 0) motivo = 'Cliente sem limite definido';
    else if (exp.exposicao + v > exp.limite) {
      const outras = exp.porLoja.filter((l) => l.crediario + l.marcados > 0);
      const onde = outras.length > 1
        ? ` (${outras.map((l) => `loja ${l.loja}: ${(l.crediario + l.marcados).toFixed(2)}`).join(', ')})`
        : '';
      motivo =
        `Limite da rede estourado: já deve R$ ${exp.exposicao.toFixed(2)} ` +
        `de R$ ${exp.limite.toFixed(2)}${onde}. Aumento é com a Matriz.`;
    }

    return {
      // Com o bloqueio desligado, SEMPRE permite — só informa.
      permitido: !bloqueioAtivo || !motivo,
      bloqueioAtivo,
      motivo,
      exposicao: exp,
    };
  }

  /**
   * A PRÉVIA: quem seria travado se o bloqueio fosse ligado agora.
   *
   * É a lista que o dono revisa antes de virar a chave.
   */
  async previa(): Promise<{
    ativo: boolean;
    totais: {
      pessoasComDivida: number; exposicaoTotal: number;
      travadas: number; exposicaoTravadas: number;
      semLimite: number; exposicaoSemLimite: number;
    };
    lista: Array<{
      cpf: string; nome: string | null; lojaOrigem: string; lojas: number;
      limite: number; crediario: number; marcados: number; exposicao: number;
      excedente: number; semLimite: boolean;
    }>;
  }> {
    const rows: any[] = await (this.prisma as any).$queryRawUnsafe(
      `WITH ficha AS (
         SELECT regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') AS cpf,
                loja, codigo, COALESCE(limite_compras,0)::float AS limite,
                nome, synced_at
           FROM giga_clientes
          WHERE regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') <> ''
       ),
       cred AS (
         SELECT f.cpf, COALESCE(SUM(p.valor_parcela),0)::float AS v
           FROM ficha f JOIN crediario_parcelas p
             ON p.loja = f.loja AND p.cod_cliente = f.codigo
            AND p.pago = false AND p.cancelado = false
          GROUP BY 1
       ),
       marc AS (
         SELECT f.cpf, COALESCE(SUM(m.valor_total),0)::float AS v
           FROM ficha f JOIN marcados m
             ON m.store_code = f.loja AND m.cod_cliente = f.codigo
            AND m.status = 'ativo' AND m.is_training = false
          GROUP BY 1
       ),
       pessoa AS (
         SELECT cpf, MAX(limite) AS limite, COUNT(DISTINCT loja)::int AS lojas,
                (ARRAY_AGG(nome ORDER BY synced_at))[1] AS nome,
                (ARRAY_AGG(loja ORDER BY synced_at))[1] AS loja_origem
           FROM ficha GROUP BY cpf
       )
       SELECT p.cpf, p.nome, p.loja_origem, p.lojas, p.limite,
              COALESCE(c.v,0) AS crediario, COALESCE(m.v,0) AS marcados,
              COALESCE(c.v,0) + COALESCE(m.v,0) AS exposicao
         FROM pessoa p
         LEFT JOIN cred c ON c.cpf = p.cpf
         LEFT JOIN marc m ON m.cpf = p.cpf
        WHERE COALESCE(c.v,0) + COALESCE(m.v,0) > 0
        ORDER BY 8 DESC`,
    );

    const lista = rows.map((r) => {
      const exposicao = Number(r.exposicao);
      const limite = Number(r.limite);
      return {
        cpf: String(r.cpf),
        nome: r.nome || null,
        lojaOrigem: String(r.loja_origem),
        lojas: Number(r.lojas),
        limite,
        crediario: Number(r.crediario),
        marcados: Number(r.marcados),
        exposicao,
        excedente: Math.max(0, exposicao - limite),
        semLimite: limite <= 0,
      };
    });

    const travadas = lista.filter((l) => l.exposicao > l.limite);
    const semLimite = lista.filter((l) => l.semLimite);
    const soma = (a: any[], k: string) => a.reduce((s, x) => s + Number(x[k] || 0), 0);

    return {
      ativo: await this.ativo(),
      totais: {
        pessoasComDivida: lista.length,
        exposicaoTotal: soma(lista, 'exposicao'),
        travadas: travadas.length,
        exposicaoTravadas: soma(travadas, 'exposicao'),
        semLimite: semLimite.length,
        exposicaoSemLimite: soma(semLimite, 'exposicao'),
      },
      lista: travadas.slice(0, 500),
    };
  }

  /** Ajuste de limite direto da tela de análise, pra destravar caso a caso. */
  async ajustarLimite(cpfRaw: string, novoLimite: number, usuario?: string) {
    const cpf = this.soDigitos(cpfRaw);
    if (cpf.length < 11) return { ok: false, erro: 'CPF inválido' };
    const valor = Number(novoLimite);
    if (!Number.isFinite(valor) || valor < 0) return { ok: false, erro: 'Limite inválido' };

    // Aplica em TODAS as fichas da pessoa: como o limite é da rede, deixar
    // valores diferentes por loja só cria confusão na próxima leitura.
    const n = await (this.prisma as any).$executeRawUnsafe(
      `UPDATE giga_clientes
          SET limite_compras = $2, flow_is_source = true, edited_at = NOW(), edited_by = $3
        WHERE regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $1`,
      cpf, valor, usuario || null,
    );
    this.logger.warn(`[limite-rede] limite do CPF ${cpf.slice(0, 3)}*** ajustado pra ${valor} por ${usuario || '?'} (${n} ficha[s])`);
    return { ok: true, fichas: n, limite: valor };
  }
}
