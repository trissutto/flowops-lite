import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientesGigaService } from './clientes-giga.service';

/**
 * LIMPEZA DE CLIENTES (20/08 — casos Jessica e Rafaela do mesmo dia).
 *
 * Duas sujeiras herdadas do Wincred que quebram o balcão:
 *
 * 1. DUPLICATA na mesma loja: mesma pessoa (CPF) com 2+ fichas na MESMA loja
 *    (Jessica: 6099 "GONÇALVES" com A + limite, 6113 "GONÇALVEZ" sem
 *    avaliação). Medido em 20/08: 195 grupos / 395 fichas — 184 grupos só
 *    em Itanhaém (01). O painel mostra o grupo lado a lado, SUGERE qual
 *    manter e arquiva as outras.
 *
 * 2. FICHA SEM CPF: 1.959 fichas (25% do Wincred nunca teve CPF). O marcado
 *    cruza venda→ficha por CPF, então cliente com ficha perfeita é negada no
 *    balcão (Rafaela: ficha 08/285 com A + R$ 1.401 e CPF NULL). O painel
 *    casa a ficha com a pessoa do CRM (telefone/nome) e copia o CPF em 1
 *    clique.
 *
 * Arquivar NUNCA apaga: a linha fica com `arquivadoEm` e sai das buscas e do
 * marcado — histórico antigo que aponte pro código dela continua legível.
 */
@Injectable()
export class ClientesLimpezaService {
  private readonly logger = new Logger(ClientesLimpezaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fichas: ClientesGigaService,
  ) {}

  private digits(v: any): string {
    return String(v ?? '').replace(/\D+/g, '');
  }

  private normNome(v: any): string {
    return String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  }

  /** Grupos de fichas duplicadas (mesma loja + mesmo CPF), com sugestão. */
  async duplicatas() {
    const rows: any[] = await (this.prisma as any).$queryRawUnsafe(`
      WITH d AS (
        SELECT loja, regexp_replace(cpf, '[^0-9]', '', 'g') AS cpfn
        FROM giga_clientes
        WHERE arquivado_em IS NULL
          AND cpf IS NOT NULL
          AND length(regexp_replace(cpf, '[^0-9]', '', 'g')) = 11
        GROUP BY loja, regexp_replace(cpf, '[^0-9]', '', 'g')
        HAVING COUNT(DISTINCT codigo) > 1
      )
      SELECT g.loja,
             regexp_replace(g.cpf, '[^0-9]', '', 'g') AS cpfn,
             g.codigo, g.nome, g.avaliacao, g.limite_compras AS limite,
             g.bloqueado, g.nascimento, g.endereco, g.fone_cel,
             g.raw_json->>'ULTCOMPRA' AS ultcompra
      FROM giga_clientes g
      JOIN d ON d.loja = g.loja
            AND d.cpfn = regexp_replace(g.cpf, '[^0-9]', '', 'g')
      WHERE g.arquivado_em IS NULL
      ORDER BY g.loja, cpfn, g.codigo
    `);
    if (!rows.length) return { grupos: [] };

    // Marcados ativos por loja+codigo — peso forte da sugestão (ficha com
    // movimento é a ficha real).
    const marc: any[] = await (this.prisma as any).marcado.groupBy({
      by: ['storeCode', 'codCliente'],
      where: { status: 'ativo', isTraining: false },
      _count: { _all: true },
    }).catch(() => []);
    const marcKey = new Map(marc.map((m: any) => [`${m.storeCode}/${m.codCliente}`, m._count._all]));

    const porGrupo = new Map<string, any[]>();
    for (const r of rows) {
      const k = `${r.loja}|${r.cpfn}`;
      (porGrupo.get(k) ?? porGrupo.set(k, []).get(k))!.push(r);
    }

    const grupos = [...porGrupo.entries()].map(([k, fichas]) => {
      const [loja, cpfn] = k.split('|');
      const aval = (f: any) => {
        const temMov = f.ultcompra || marcKey.get(`${String(f.loja).replace(/^0+/, '') || '0'}/${f.codigo}`) || marcKey.get(`${f.loja}/${f.codigo}`);
        let score = 0;
        if (temMov) score += 3;
        if (String(f.avaliacao || '').trim()) score += 2;
        if (Number(f.limite) > 0) score += 1;
        if (f.nascimento || f.endereco) score += 1;
        return score;
      };
      const ordenadas = fichas
        .map((f) => ({ ...f, score: aval(f) }))
        .sort((a, b) => b.score - a.score || Number(a.codigo) - Number(b.codigo));
      return {
        loja,
        cpf: cpfn,
        sugerida: ordenadas[0].codigo,
        fichas: ordenadas.map((f) => ({
          codigo: f.codigo,
          nome: f.nome,
          avaliacao: f.avaliacao,
          limite: Number(f.limite) || 0,
          bloqueado: f.bloqueado,
          ultCompra: f.ultcompra || null,
          marcadosAtivos: marcKey.get(`${f.loja}/${f.codigo}`) || 0,
          temDados: !!(f.nascimento || f.endereco),
          score: f.score,
        })),
      };
    });
    return { grupos };
  }

  /**
   * Resolve um grupo: mantém `manterCodigo`, arquiva as demais fichas do
   * grupo. Antes de arquivar, o que a perdedora tem de VALIOSO e a mantida
   * não tem (avaliação, limite maior) é copiado — senão "manter a errada"
   * jogaria fora o limite que o gerente deu.
   */
  async resolverDuplicata(input: { loja: string; cpf: string; manterCodigo: string; usuario?: string }) {
    const loja = String(input.loja || '').trim();
    const cpfn = this.digits(input.cpf);
    const manter = String(input.manterCodigo || '').trim();
    if (!loja || cpfn.length !== 11 || !manter) {
      throw new BadRequestException('Informe loja, cpf e manterCodigo');
    }
    const fichas: any[] = await (this.prisma as any).$queryRawUnsafe(
      `SELECT codigo, avaliacao, limite_compras AS limite FROM giga_clientes
       WHERE arquivado_em IS NULL AND loja = $1
         AND regexp_replace(coalesce(cpf,''), '[^0-9]', '', 'g') = $2`,
      loja, cpfn,
    );
    const keeper = fichas.find((f) => String(f.codigo) === manter);
    if (!keeper) throw new NotFoundException(`Ficha ${manter} não está no grupo ${loja}/${cpfn}`);
    const perdedoras = fichas.filter((f) => String(f.codigo) !== manter);
    if (!perdedoras.length) return { ok: true, arquivadas: 0 };

    // Copia o valioso pra mantida (via editarFicha: replica pro espelho Giga).
    const campos: Record<string, any> = {};
    const melhorAval = perdedoras.map((f) => String(f.avaliacao || '').trim()).find((a) => a);
    if (!String(keeper.avaliacao || '').trim() && melhorAval) campos.AVALIACAO = melhorAval;
    const maiorLimite = Math.max(...perdedoras.map((f) => Number(f.limite) || 0));
    if (maiorLimite > (Number(keeper.limite) || 0)) campos.LIMITECOMPRAS = maiorLimite;
    if (Object.keys(campos).length) {
      await this.fichas.editarFicha(loja, manter, campos, input.usuario || 'limpeza');
    }

    const r = await (this.prisma as any).gigaCliente.updateMany({
      where: { loja, codigo: { in: perdedoras.map((f) => String(f.codigo)) }, arquivadoEm: null },
      data: {
        arquivadoEm: new Date(),
        arquivadoMotivo: `duplicata — mantida a ficha ${manter} (por ${input.usuario || 'matriz'})`,
      },
    });
    this.logger.log(
      `[limpeza] grupo ${loja}/${cpfn}: mantida ${manter}, ${r.count} arquivada(s)` +
        (Object.keys(campos).length ? ` (copiado: ${Object.keys(campos).join(', ')})` : ''),
    );
    return { ok: true, arquivadas: r.count, copiado: campos };
  }

  /**
   * Fichas SEM CPF com candidato no CRM (telefone e/ou nome exato). Ordena
   * por quem tem movimento — a Rafaela da fila do balcão vem antes da ficha
   * morta de 2019.
   */
  async semCpf(page = 1) {
    const take = 50;
    const skip = (Math.max(1, page) - 1) * take;
    const fichas: any[] = await (this.prisma as any).$queryRawUnsafe(`
      SELECT loja, codigo, nome, fone_cel, fone_res, nascimento,
             raw_json->>'ULTCOMPRA' AS ultcompra,
             avaliacao, limite_compras AS limite
      FROM giga_clientes
      WHERE arquivado_em IS NULL
        AND (cpf IS NULL OR length(regexp_replace(cpf, '[^0-9]', '', 'g')) < 11)
      ORDER BY (raw_json->>'ULTCOMPRA') DESC NULLS LAST, loja, codigo
      LIMIT ${take} OFFSET ${skip}
    `);
    const total: any[] = await (this.prisma as any).$queryRawUnsafe(`
      SELECT COUNT(*)::int AS n FROM giga_clientes
      WHERE arquivado_em IS NULL
        AND (cpf IS NULL OR length(regexp_replace(cpf, '[^0-9]', '', 'g')) < 11)
    `);

    // Candidatos do CRM em lote: por telefone (forte) e nome exato (fraco).
    const fones = new Set<string>();
    const nomes = new Set<string>();
    for (const f of fichas) {
      for (const t of [f.fone_cel, f.fone_res]) {
        const d = this.digits(t);
        if (d.length >= 10) { fones.add(d); fones.add(`55${d}`); }
      }
      const n = this.normNome(f.nome);
      if (n.length >= 8) nomes.add(n);
    }
    const candidatos: any[] = fones.size || nomes.size
      ? await (this.prisma as any).customer.findMany({
          where: {
            cpf: { not: null },
            OR: [
              ...(fones.size ? [{ phone: { in: [...fones] } }] : []),
              ...(nomes.size ? [{ name: { in: [...nomes], mode: 'insensitive' } }] : []),
            ],
          },
          select: { id: true, name: true, cpf: true, phone: true },
        })
      : [];
    const validos = candidatos.filter((c) => this.digits(c.cpf).length === 11);
    const porFone = new Map<string, any[]>();
    const porNome = new Map<string, any[]>();
    for (const c of validos) {
      const d = this.digits(c.phone).replace(/^55(?=\d{10,11}$)/, '');
      if (d) (porFone.get(d) ?? porFone.set(d, []).get(d))!.push(c);
      const n = this.normNome(c.name);
      if (n) (porNome.get(n) ?? porNome.set(n, []).get(n))!.push(c);
    }

    const rows = fichas.map((f) => {
      const achados = new Map<string, { customer: any; via: string }>();
      for (const t of [f.fone_cel, f.fone_res]) {
        const d = this.digits(t).replace(/^55(?=\d{10,11}$)/, '');
        for (const c of porFone.get(d) || []) achados.set(c.id, { customer: c, via: 'telefone' });
      }
      for (const c of porNome.get(this.normNome(f.nome)) || []) {
        if (!achados.has(c.id)) achados.set(c.id, { customer: c, via: 'nome' });
      }
      return {
        loja: f.loja,
        codigo: f.codigo,
        nome: f.nome,
        fone: f.fone_cel || f.fone_res || null,
        ultCompra: f.ultcompra || null,
        avaliacao: f.avaliacao,
        limite: Number(f.limite) || 0,
        candidatos: [...achados.values()].map(({ customer, via }) => ({
          customerId: customer.id,
          nome: customer.name,
          cpfMascarado: `${this.digits(customer.cpf).slice(0, 3)}.***.***-${this.digits(customer.cpf).slice(-2)}`,
          telefone: customer.phone,
          via,
        })),
      };
    });
    return { rows, total: total[0]?.n ?? rows.length, page, porPagina: take };
  }

  /** Copia o CPF da pessoa do CRM pra ficha da loja — o conserto da Rafaela. */
  async copiarCpf(input: { loja: string; codigo: string; customerId: string; usuario?: string }) {
    const loja = String(input.loja || '').trim();
    const codigo = String(input.codigo || '').trim();
    const ficha: any = await (this.prisma as any).gigaCliente.findUnique({
      where: { loja_codigo: { loja, codigo } },
    });
    if (!ficha || ficha.arquivadoEm) throw new NotFoundException('Ficha não encontrada (ou arquivada)');
    if (this.digits(ficha.cpf).length === 11) {
      throw new BadRequestException('Essa ficha já tem CPF — nada a copiar');
    }
    const customer: any = await (this.prisma as any).customer.findUnique({
      where: { id: String(input.customerId || '') },
      select: { id: true, name: true, cpf: true },
    });
    const cpf = this.digits(customer?.cpf);
    if (cpf.length !== 11) throw new BadRequestException('Pessoa do CRM sem CPF válido');

    // Não pode CRIAR uma duplicata: se já existe ficha viva nessa loja com
    // esse CPF, o caminho certo é o painel de duplicatas, não a cópia.
    const jaExiste: any[] = await (this.prisma as any).$queryRawUnsafe(
      `SELECT codigo FROM giga_clientes
       WHERE arquivado_em IS NULL AND loja = $1 AND codigo <> $2
         AND regexp_replace(coalesce(cpf,''), '[^0-9]', '', 'g') = $3`,
      loja, codigo, cpf,
    );
    if (jaExiste.length) {
      throw new BadRequestException(
        `A loja ${loja} já tem a ficha ${jaExiste[0].codigo} com esse CPF — ` +
          `resolva na aba Duplicatas em vez de copiar.`,
      );
    }

    // Via editarFicha: merge no rawJson + réplica pro espelho, igual à tela.
    const r = await this.fichas.editarFicha(loja, codigo, { CPF: cpf }, input.usuario || 'limpeza');
    if (!(r as any)?.ok) throw new BadRequestException((r as any)?.erro || 'Falha ao gravar CPF');
    this.logger.log(`[limpeza] CPF do CRM (${customer.name}) copiado pra ficha ${loja}/${codigo} por ${input.usuario || 'matriz'}`);
    return { ok: true };
  }
}
