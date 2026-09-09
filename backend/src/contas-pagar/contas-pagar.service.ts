import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdiantamentosService } from '../adiantamentos/adiantamentos.service';

/**
 * Operação do Contas a Pagar 100% Flow (Fase 2 — telas do mockup aprovado
 * 11/07). Regras herdadas do dossiê (docs/GIGA-CONTAS-DESCOBERTA.md):
 *  - busca por QUALQUER parte (fornecedor, funcionária, NF, obs, banco, valor, nº);
 *  - filtro De/Até (convenção do dono) + loja + espécie + status + em mãos;
 *  - baixa pede JUROS e DESCONTO (P3);
 *  - espécies RESTRITAS (RH/VALE/SALARIO/COMISSAO) só pra autorizadas —
 *    v1: módulo inteiro é admin/master (matriz), o filtro fica pronto;
 *  - toda alteração vira ContaPagarLog (campo, antes → depois, quem);
 *  - excluir = soft delete.
 */

export interface ListFilters {
  search?: string;
  de?: string;   // YYYY-MM-DD (vencimento)
  ate?: string;
  lojaCode?: string;
  especieId?: string;
  status?: 'pendentes' | 'pagas' | 'todas';
  emMaos?: boolean;
  incluirRestritas?: boolean;
  page?: number;
  perPage?: number;
}

/**
 * NOME COMPLETO da funcionária no financeiro (ordem do dono 09/09/2026: "usar o
 * nome completo e não o apelido").
 *
 * Nenhuma das duas fontes serve sozinha, e isso foi MEDIDO em setembro/2026
 * (53 pessoas na aba Funcionárias):
 *
 *   - em 8 delas o CADASTRO do RH guarda o nome curto ou um rótulo de operação
 *     — "DANI" (folha: DANIELI), "EDNA" (EDNA ROCHA GRANSO), "LIEGE" (MARIA
 *     LIEGE SANTOS SILVA), "PAMELA NOVA" (PAMELA MARTINS MENDES);
 *   - nas outras 45 é o contrário — a conta guarda "Angelica" e o cadastro tem
 *     "Maria Angelica Sousa".
 *
 * Quem amarra a pessoa é o `sellerId`, não o texto: todos os candidatos são da
 * MESMA funcionária por construção, então dá pra escolher o mais completo sem
 * risco nenhum de trocar de gente. Mais PALAVRAS ganha; empate desempata no
 * mais longo.
 *
 * ⚠️ A tentação errada aqui é "consertar o cadastro" gravando o nome cheio em
 * `sellers.name`. NÃO FAZER: esse campo é o que a whitelist do PDV casa por
 * nome (`ActiveSellersService.list` → `porNome`) e o que a comissão soma.
 * Renomear ali é o caminho que já fez vendedora sumir do PDV. Aqui é só EXIBIÇÃO.
 */
function nomeMaisCompleto(...candidatos: (string | null | undefined)[]): string | null {
  const limpos = candidatos.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (!limpos.length) return null;
  const palavras = (s: string) => s.split(/\s+/).length;
  return limpos.reduce((melhor, atual) => {
    if (palavras(atual) !== palavras(melhor)) return palavras(atual) > palavras(melhor) ? atual : melhor;
    return atual.length > melhor.length ? atual : melhor;
  });
}

const CAMPOS_EDITAVEIS = new Set([
  'lojaCode', 'fornecedorNome', 'fornecedorGigaCodigo', 'sellerId', 'sellerNome', 'sellerCpf',
  'beneficiarioTipo', 'especieId', 'notaFiscal', 'banco', 'cheque', 'emissao', 'vencimento',
  'valorCents', 'observacao', 'emMaos',
]);

@Injectable()
export class ContasPagarService {
  private readonly logger = new Logger(ContasPagarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adiantamentos: AdiantamentosService,
  ) {}

  // ── helpers ────────────────────────────────────────────────────────────────
  private dia(d = new Date()): Date {
    // Datas do módulo são @db.Date — compara sempre no "dia" UTC.
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private async log(contaId: string, campo: string, antigo: any, novo: any, usuario?: string, origem = 'tela') {
    await (this.prisma as any).contaPagarLog.create({
      data: {
        contaId,
        campo,
        valorAntigo: antigo == null ? null : String(antigo).slice(0, 300),
        valorNovo: novo == null ? null : String(novo).slice(0, 300),
        usuario: usuario || null,
        origem,
      },
    });
  }

  private async especiesRestritasIds(): Promise<Set<string>> {
    const rows: any[] = await (this.prisma as any).especieConta.findMany({ where: { restrita: true }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  // ── catálogos/opções ──────────────────────────────────────────────────────
  /**
   * Só as ATIVAS. Espécie inativada (ex: as formas de pagamento herdadas do
   * Giga — BOLETO, CHEQUE, DEPOSITO…) some do lançamento novo, mas continua
   * valendo nas contas antigas que já a usam.
   */
  especies() {
    return (this.prisma as any).especieConta.findMany({
      where: { ativa: true },
      orderBy: { nome: 'asc' },
    });
  }

  /**
   * LOJAS do filtro (dono 30/07): o dropdown listava TODO código que já teve
   * conta — inativas e até códigos-fantasma da migração do Giga (51, 50, 99,
   * 48, 22, 60, 70). Agora as operacionais vêm em `ativa` e o resto em
   * `historico` (só aparece quem TEM conta — a tela agrupa as duas listas,
   * então nenhum histórico fica inacessível).
   *
   * A lista das operacionais é do dono e sai por env (muda no Railway sem
   * deploy): CONTAS_PAGAR_LOJAS="01,02,...". Inclui a 20 PESSOA FÍSICA —
   * não é loja, é o centro de custo das contas particulares.
   */
  private static readonly LOJAS_ATIVAS_DEFAULT =
    '01,02,03,04,05,06,07,08,09,10,11,14,15,19,20';

  /**
   * RÓTULO DO CENTRO DE CUSTO (dono 30/07) — vale SÓ AQUI.
   *
   * No financeiro a 01 é a matriz T.O. e a 09 é a matriz LURDS; no resto do
   * sistema elas continuam sendo a loja de Itanhaém e o cadastro de origem.
   * Por isso o nome fica nesta tabela, e não no cadastro da loja: trocar
   * `Store.name` mudaria o PDV, o faturamento e o ranking junto.
   */
  private static readonly ROTULO_CONTAS_PAGAR: Record<string, string> = {
    '1': 'MATRIZ T.O.',
    '9': 'MATRIZ LURDS',
    '20': 'PESSOA FISICA',
  };

  async lojas() {
    const [distinctRaw, stores] = await Promise.all([
      this.prisma.$queryRawUnsafe(`SELECT DISTINCT loja_code AS code FROM conta_pagar WHERE deleted_at IS NULL ORDER BY 1`),
      (this.prisma as any).store.findMany({ select: { code: true, name: true } }),
    ]);
    const distinct = distinctRaw as any[];
    const nameByCode = new Map<string, string>(stores.map((s: any) => [String(s.code), s.name]));

    const norm = (c: any) => String(c ?? '').trim().replace(/^0+/, '') || '0';
    const ativasSet = new Set(
      String(process.env.CONTAS_PAGAR_LOJAS || ContasPagarService.LOJAS_ATIVAS_DEFAULT)
        .split(',')
        .map((c) => norm(c))
        .filter((c) => c && c !== '0'),
    );

    // Códigos com conta + os operacionais que ainda não têm nenhuma (pra dar
    // pra LANÇAR neles — ex.: a 20 no primeiro uso).
    const codes = new Set<string>(distinct.map((d) => String(d.code)));
    for (const s of stores as any[]) {
      if (ativasSet.has(norm(s.code))) codes.add(String(s.code));
    }

    return Array.from(codes)
      .map((code) => ({
        code,
        // Rótulo do financeiro vence o nome do cadastro — só nesta tela.
        nome:
          ContasPagarService.ROTULO_CONTAS_PAGAR[norm(code)] ||
          nameByCode.get(code) ||
          `LOJA ${code} — HISTÓRICO`,
        grupo: ativasSet.has(norm(code)) ? 'ativa' : 'historico',
      }))
      .sort((a, b) => {
        if (a.grupo !== b.grupo) return a.grupo === 'ativa' ? -1 : 1;
        return a.code.localeCompare(b.code, 'pt-BR', { numeric: true });
      });
  }

  async fornecedoresOptions(q?: string) {
    const term = String(q || '').trim();
    // Fornecedores ASSOCIADOS a funcionária ficam fora do autocomplete
    // (viraram pessoa — decisão do dono 11/07). "Não é pessoa" continua.
    const associados: any[] = await (this.prisma as any).contaPagarAssociacao.findMany({
      where: { sellerId: { not: null } },
      select: { fornecedorGigaCodigo: true },
    });
    const excluir = associados.map((a) => a.fornecedorGigaCodigo);
    // Termo só de dígitos também busca por CÓDIGO do fornecedor no GIGA
    // (o placeholder da tela promete "767" — antes só nome/CNPJ casavam).
    const or: any[] = [
      { razaoSocial: { contains: term, mode: 'insensitive' } },
      { fantasia: { contains: term, mode: 'insensitive' } },
      { cnpj: { contains: term } },
    ];
    if (/^\d+$/.test(term)) or.push({ codigo: parseInt(term, 10) });
    return (this.prisma as any).wincredFornecedor.findMany({
      where: {
        ...(excluir.length ? { codigo: { notIn: excluir } } : {}),
        ...(term ? { OR: or } : {}),
      },
      select: { codigo: true, razaoSocial: true, fantasia: true, cnpj: true },
      orderBy: { razaoSocial: 'asc' },
      take: 20,
    });
  }

  funcionariasOptions(q?: string) {
    const term = String(q || '').trim();
    // ATENÇÃO: Seller NÃO tem storeId — selecionar campo inexistente faz o
    // Prisma lançar erro e o autocomplete voltar VAZIO (bug real 13/07: a
    // busca de funcionária nunca retornava nada na tela Nova conta).
    return (this.prisma as any).seller.findMany({
      where: {
        active: true,
        ...(term ? { name: { contains: term, mode: 'insensitive' } } : {}),
      },
      select: { id: true, name: true, cpf: true },
      orderBy: { name: 'asc' },
      take: 20,
    });
  }

  // ── painel: cards de resumo ───────────────────────────────────────────────
  async stats() {
    const hoje = this.dia();
    const em7 = new Date(hoje.getTime() + 7 * 86400000);
    const mesIni = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));
    const mesFim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 1));
    const base = { deletedAt: null } as any;
    const cp = (this.prisma as any).contaPagar;
    const [vencidas, vencidasSum, doDia, doDiaSum, prox7, prox7Sum, pagasMes, pagasMesSum, pend, pendSum] =
      await Promise.all([
        cp.count({ where: { ...base, status: 'aberta', vencimento: { lt: hoje } } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'aberta', vencimento: { lt: hoje } } }),
        cp.count({ where: { ...base, status: 'aberta', vencimento: hoje } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'aberta', vencimento: hoje } }),
        cp.count({ where: { ...base, status: 'aberta', vencimento: { gt: hoje, lte: em7 } } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'aberta', vencimento: { gt: hoje, lte: em7 } } }),
        cp.count({ where: { ...base, status: 'paga', pagamento: { gte: mesIni, lt: mesFim } } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'paga', pagamento: { gte: mesIni, lt: mesFim } } }),
        cp.count({ where: { ...base, status: 'aberta' } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'aberta' } }),
      ]);
    const c = (n: any) => Number(n?._sum?.valorCents || 0);
    return {
      vencidas: { qtd: vencidas, cents: c(vencidasSum) },
      hoje: { qtd: doDia, cents: c(doDiaSum) },
      prox7: { qtd: prox7, cents: c(prox7Sum) },
      pagasMes: { qtd: pagasMes, cents: c(pagasMesSum) },
      pendenteTotal: { qtd: pend, cents: c(pendSum) },
    };
  }

  // ── filtros → where (compartilhado entre list e baixa em lote) ────────────
  private async montarWhere(f: ListFilters): Promise<any> {
    const where: any = { deletedAt: null };
    if (f.status === 'pendentes' || !f.status) where.status = 'aberta';
    else if (f.status === 'pagas') where.status = 'paga';
    if (f.lojaCode) where.lojaCode = f.lojaCode;
    if (f.especieId) where.especieId = f.especieId;
    if (f.emMaos) where.emMaos = true;
    if (f.de || f.ate) {
      // Recorte de tempo: no filtro PAGAS o De/Até corta pela data do
      // PAGAMENTO ("o que paguei no período") — a conta baixada hoje quase
      // sempre venceu em outro dia, então cortar por vencimento vinha vazio
      // (bug real 13/07). Pendentes/todas seguem cortando por vencimento.
      const campo = f.status === 'pagas' ? 'pagamento' : 'vencimento';
      where[campo] = {};
      if (f.de) where[campo].gte = new Date(`${f.de}T00:00:00.000Z`);
      if (f.ate) where[campo].lte = new Date(`${f.ate}T00:00:00.000Z`);
    }
    if (!f.incluirRestritas) {
      const restritas = await this.especiesRestritasIds();
      if (restritas.size) where.NOT = { especieId: { in: Array.from(restritas) } };
    }

    // BUSCA POR QUALQUER PARTE: cada palavra precisa casar em ALGUM campo.
    const words = String(f.search || '').trim().split(/\s+/).filter((w) => w.length >= 1).slice(0, 8);
    if (words.length) {
      where.AND = words.map((w) => {
        const or: any[] = [
          { fornecedorNome: { contains: w, mode: 'insensitive' } },
          { sellerNome: { contains: w, mode: 'insensitive' } },
          { notaFiscal: { contains: w, mode: 'insensitive' } },
          { observacao: { contains: w, mode: 'insensitive' } },
          { banco: { contains: w, mode: 'insensitive' } },
          { cheque: { contains: w, mode: 'insensitive' } },
          { especieOriginal: { contains: w, mode: 'insensitive' } },
        ];
        // palavra numérica: também casa nº da conta e VALOR ("1.250" / "1250,00")
        const digits = w.replace(/[^\d,\.]/g, '');
        if (digits && digits === w) {
          const asInt = parseInt(digits.replace(/[\.,]/g, ''), 10);
          if (!isNaN(asInt)) or.push({ numero: asInt }, { gigaRegistro: asInt });
          const cents = Math.round(parseFloat(digits.replace(/\./g, '').replace(',', '.')) * 100);
          if (!isNaN(cents) && cents > 0) or.push({ valorCents: cents });
        }
        return { OR: or };
      });
    }
    return where;
  }

  // ── painel: listagem ──────────────────────────────────────────────────────
  async list(f: ListFilters) {
    const where = await this.montarWhere(f);
    const page = Math.max(1, f.page || 1);
    // 200 por página (pedido do dono, 11/07) — quebra de página de 200 em 200.
    const perPage = Math.min(200, Math.max(10, f.perPage || 200));
    const cp = (this.prisma as any).contaPagar;
    const [total, soma, rows] = await Promise.all([
      cp.count({ where }),
      cp.aggregate({ _sum: { valorCents: true }, where }),
      cp.findMany({
        where,
        include: { especie: { select: { nome: true, restrita: true } } },
        orderBy: f.status === 'pagas' ? [{ pagamento: 'desc' }] : [{ vencimento: 'asc' }, { numero: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);
    const hoje = this.dia().getTime();
    // Nome completo também na LISTA — mesma régua da aba Funcionárias, senão a
    // mesma pessoa sai "EDNA" aqui e "EDNA ROCHA GRANSO" ali. Só os sellerIds
    // desta página; erro SOBE (nada de catch devolvendo nome velho).
    const idsPagina = Array.from(
      new Set(rows.filter((r: any) => r.sellerId).map((r: any) => r.sellerId)),
    ) as string[];
    const nomeCadastroById = new Map<string, string>(
      idsPagina.length
        ? (
            await (this.prisma as any).seller.findMany({
              where: { id: { in: idsPagina } },
              select: { id: true, name: true },
            })
          ).map((s: any) => [s.id, s.name])
        : [],
    );
    return {
      total,
      somaCents: Number(soma?._sum?.valorCents || 0),
      page,
      perPage,
      rows: rows.map((r: any) => ({
        id: r.id,
        numero: r.numero,
        gigaRegistro: r.gigaRegistro,
        lojaCode: r.lojaCode,
        beneficiarioTipo: r.beneficiarioTipo,
        beneficiario:
          r.beneficiarioTipo === 'funcionaria'
            ? nomeMaisCompleto(r.sellerId ? nomeCadastroById.get(r.sellerId) : null, r.sellerNome)
            : r.fornecedorNome,
        // pra tela abrir a ficha do RH e travar a edição do nome no lugar certo
        sellerId: r.sellerId || null,
        especieId: r.especieId,
        especie: r.especie?.nome || r.especieOriginal || '—',
        especieRestrita: !!r.especie?.restrita,
        notaFiscal: r.notaFiscal,
        banco: r.banco,
        emissao: r.emissao,
        vencimento: r.vencimento,
        pagamento: r.pagamento,
        valorCents: r.valorCents,
        jurosCents: r.jurosCents,
        descontoCents: r.descontoCents,
        emMaos: r.emMaos,
        observacao: r.observacao,
        comprovanteUrl: r.comprovanteUrl,
        comprovanteNome: r.comprovanteNome,
        parcela: r.parcelaNum && r.parcelaTotal ? `${r.parcelaNum}/${r.parcelaTotal}` : null,
        status: r.status,
        vencida: r.status === 'aberta' && r.vencimento && new Date(r.vencimento).getTime() < hoje,
        hoje: r.status === 'aberta' && r.vencimento && new Date(r.vencimento).getTime() === hoje,
        favorecidoOrfao: r.favorecidoOrfao,
        dataSuspeita: r.dataSuspeita,
      })),
    };
  }

  // ── criar (com parcelas) ─────────────────────────────────────────────────
  async criar(body: any, usuario?: string) {
    const lojaCode = String(body.lojaCode || '').trim();
    if (!lojaCode) throw new BadRequestException('Informe a loja');
    const valorTotal = Math.round(Number(body.valorCents || 0));
    if (!valorTotal || valorTotal <= 0) throw new BadRequestException('Valor inválido');
    const venc1 = body.vencimento ? new Date(`${body.vencimento}T00:00:00.000Z`) : null;
    if (!venc1 || isNaN(venc1.getTime())) throw new BadRequestException('Informe o 1º vencimento');

    const tipo = body.beneficiarioTipo === 'funcionaria' ? 'funcionaria' : 'fornecedor';
    // A funcionária NASCE ligada ao cadastro do RH (05/09). Aceitar só o nome
    // digitado criava conta SOLTA — texto sem dono, que a ficha da funcionária
    // não alcança e que a aba Funcionárias agrupa por string. Nome e CPF saem
    // do cadastro, não do que foi digitado na tela: é o cadastro que manda.
    let seller: any = null;
    if (tipo === 'funcionaria') {
      const sid = String(body.sellerId || '').trim();
      if (!sid) {
        throw new BadRequestException(
          'Escolha a funcionária NA LISTA — a conta precisa ficar ligada ao cadastro do RH',
        );
      }
      seller = await (this.prisma as any).seller.findUnique({
        where: { id: sid },
        select: { id: true, name: true, cpf: true },
      });
      if (!seller) throw new BadRequestException('Funcionária não encontrada no cadastro do RH');
    }
    if (tipo === 'fornecedor' && !String(body.fornecedorNome || '').trim()) {
      throw new BadRequestException('Informe o fornecedor');
    }

    // Parcelas: usa as customizadas da PRÉVIA se vieram; senão gera mensal.
    // Duplicata (numerarDuplicatas): cada parcela ganha nota própria "NF/1", "NF/2"…
    const nfBase = String(body.notaFiscal || '').trim();
    let parcelas: Array<{ vencimento: Date; valorCents: number; emMaos: boolean; notaFiscal?: string | null }> = [];
    if (Array.isArray(body.parcelasCustom) && body.parcelasCustom.length) {
      parcelas = body.parcelasCustom.map((p: any) => ({
        vencimento: new Date(`${p.vencimento}T00:00:00.000Z`),
        valorCents: Math.round(Number(p.valorCents || 0)),
        emMaos: !!p.emMaos,
        notaFiscal: String(p.notaFiscal || '').trim() || null,
      }));
      const soma = parcelas.reduce((s, p) => s + p.valorCents, 0);
      if (Math.abs(soma - valorTotal) > parcelas.length) {
        throw new BadRequestException(`Parcelas somam R$ ${(soma / 100).toFixed(2)} ≠ total R$ ${(valorTotal / 100).toFixed(2)}`);
      }
    } else {
      const n = Math.min(60, Math.max(1, Number(body.parcelas || 1)));
      const numerar = !!body.numerarDuplicatas && !!nfBase && n > 1;
      const base = Math.floor(valorTotal / n);
      for (let i = 0; i < n; i++) {
        const v = new Date(venc1);
        v.setUTCMonth(v.getUTCMonth() + i);
        parcelas.push({
          vencimento: v,
          valorCents: i === n - 1 ? valorTotal - base * (n - 1) : base,
          emMaos: i === 0 ? !!body.emMaos : false,
          notaFiscal: numerar ? `${nfBase}/${i + 1}` : null,
        });
      }
    }

    const grupoParcelaId = parcelas.length > 1 ? `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
    const criadas: any[] = [];
    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const conta = await (this.prisma as any).contaPagar.create({
        data: {
          lojaCode,
          beneficiarioTipo: tipo,
          fornecedorGigaCodigo: tipo === 'fornecedor' ? (body.fornecedorGigaCodigo ?? null) : null,
          fornecedorNome: tipo === 'fornecedor' ? String(body.fornecedorNome).trim() : null,
          sellerId: seller?.id || null,
          sellerNome: seller?.name || null,
          sellerCpf: seller?.cpf ? String(seller.cpf).replace(/\D/g, '') || null : null,
          especieId: body.especieId || null,
          notaFiscal: p.notaFiscal || nfBase || null,
          banco: body.banco || null,
          emissao: body.emissao ? new Date(`${body.emissao}T00:00:00.000Z`) : null,
          vencimento: p.vencimento,
          valorCents: p.valorCents,
          emMaos: p.emMaos,
          observacao: body.observacao || null,
          parcelaNum: parcelas.length > 1 ? i + 1 : null,
          parcelaTotal: parcelas.length > 1 ? parcelas.length : null,
          grupoParcelaId,
          status: 'aberta',
          createdBy: usuario || null,
        },
      });
      await this.log(conta.id, 'criada', null, `R$ ${(p.valorCents / 100).toFixed(2)} venc ${p.vencimento.toISOString().slice(0, 10)}`, usuario);
      criadas.push(conta);
    }
    this.logger.log(`[contas] criadas ${criadas.length} conta(s) por ${usuario || '?'} (loja ${lojaCode})`);
    return { ok: true, criadas: criadas.length, ids: criadas.map((c) => c.id) };
  }

  // ── baixa / reabrir / em mãos / editar / excluir ──────────────────────────
  private async getConta(id: string) {
    const c = await (this.prisma as any).contaPagar.findUnique({ where: { id } });
    if (!c || c.deletedAt) throw new NotFoundException('Conta não encontrada');
    return c;
  }

  async pagar(id: string, body: any, usuario?: string) {
    const c = await this.getConta(id);
    if (c.status === 'paga') throw new BadRequestException('Conta já está paga');
    const pagamento = body?.pagamento ? new Date(`${body.pagamento}T00:00:00.000Z`) : this.dia();
    const jurosCents = Math.max(0, Math.round(Number(body?.jurosCents || 0)));
    let descontoCents = Math.max(0, Math.round(Number(body?.descontoCents || 0)));

    // ── ABATIMENTO DE ADIANTAMENTO ──────────────────────────────────────────
    // Se é pagamento de FUNCIONÁRIA e a espécie é VALE ou SALÁRIO, desconta os
    // adiantamentos pendentes dela NESTE pagamento (o que vier primeiro). Vira
    // desconto na conta e marca os adiantamentos como abatidos (rastreado).
    let abatimentoAdiantoCents = 0;
    if ((c as any).beneficiarioTipo === 'funcionaria' && ((c as any).sellerId || (c as any).sellerNome)) {
      const esp = (c as any).especieId
        ? await (this.prisma as any).especieConta.findUnique({ where: { id: (c as any).especieId }, select: { nome: true } }).catch(() => null)
        : null;
      const nomeEsp = String(esp?.nome || '').toUpperCase();
      if (nomeEsp === 'VALE' || nomeEsp === 'SALARIO' || nomeEsp === 'SALÁRIO') {
        const restante = Math.max(0, ((c as any).valorCents || 0) - descontoCents);
        abatimentoAdiantoCents = await this.adiantamentos.abaterParaConta({
          sellerId: (c as any).sellerId, sellerNome: (c as any).sellerNome, contaId: id, maxCents: restante,
        });
        descontoCents += abatimentoAdiantoCents;
      }
    }

    const upd = await (this.prisma as any).contaPagar.update({
      where: { id },
      data: { status: 'paga', pagamento, jurosCents, descontoCents, pagoPor: usuario || null, updatedBy: usuario || null },
    });
    await this.log(id, 'pagamento', null, `${pagamento.toISOString().slice(0, 10)} (juros ${(jurosCents / 100).toFixed(2)}, desc ${(descontoCents / 100).toFixed(2)})`, usuario);
    if (abatimentoAdiantoCents > 0) {
      await this.log(id, 'abatimento_adiantamento', null, (abatimentoAdiantoCents / 100).toFixed(2), usuario);
    }
    return { ...upd, abatimentoAdiantoCents };
  }

  async reabrir(id: string, usuario?: string) {
    const c = await this.getConta(id);
    if (c.status !== 'paga') throw new BadRequestException('Só conta PAGA pode reabrir');
    const upd = await (this.prisma as any).contaPagar.update({
      where: { id },
      data: { status: 'aberta', pagamento: null, jurosCents: 0, descontoCents: 0, pagoPor: null, updatedBy: usuario || null },
    });
    await this.log(id, 'reaberta', c.pagamento ? new Date(c.pagamento).toISOString().slice(0, 10) : null, null, usuario);
    return upd;
  }

  async toggleEmMaos(id: string, usuario?: string) {
    const c = await this.getConta(id);
    const upd = await (this.prisma as any).contaPagar.update({
      where: { id },
      data: { emMaos: !c.emMaos, updatedBy: usuario || null },
    });
    await this.log(id, 'emMaos', c.emMaos ? 'SIM' : 'NÃO', !c.emMaos ? 'SIM' : 'NÃO', usuario);
    return upd;
  }

  async atualizar(id: string, patch: any, usuario?: string) {
    const c = await this.getConta(id);
    const data: any = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!CAMPOS_EDITAVEIS.has(k)) continue;
      let novo: any = v;
      if (k === 'vencimento' || k === 'emissao') novo = v ? new Date(`${v}T00:00:00.000Z`) : null;
      if (k === 'valorCents') novo = Math.round(Number(v || 0));
      data[k] = novo;
      const antigo = (c as any)[k];
      const fmt = (x: any) => (x instanceof Date ? x.toISOString().slice(0, 10) : x);
      if (String(fmt(antigo)) !== String(fmt(novo))) {
        await this.log(id, k, fmt(antigo), fmt(novo), usuario);
      }
    }
    if (!Object.keys(data).length) return c;
    data.updatedBy = usuario || null;
    return (this.prisma as any).contaPagar.update({ where: { id }, data });
  }

  async excluir(id: string, usuario?: string) {
    await this.getConta(id);
    const upd = await (this.prisma as any).contaPagar.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: usuario || null },
    });
    await this.log(id, 'excluida', null, `por ${usuario || '?'}`, usuario);
    return { ok: true, id: upd.id };
  }

  /**
   * EXCLUSÃO EM LOTE (14/07, pedido do dono): checkbox por lançamento +
   * "selecionar todos" na tela. Mesmo soft-delete auditado do individual —
   * um log por conta. Máx. 500 por chamada (proteção contra clique acidental
   * num filtro gigante).
   */
  async excluirLote(ids: string[], usuario?: string) {
    const clean = Array.from(
      new Set((ids || []).map((s) => String(s || '').trim()).filter(Boolean)),
    );
    if (!clean.length) throw new BadRequestException('Nenhum lançamento selecionado');
    if (clean.length > 500) throw new BadRequestException('Máximo de 500 lançamentos por vez');
    let excluidas = 0;
    const erros: Array<{ id: string; erro: string }> = [];
    for (const id of clean) {
      try {
        await this.excluir(id, usuario);
        excluidas++;
      } catch (e) {
        erros.push({ id, erro: (e as Error).message?.slice(0, 120) || 'erro' });
      }
    }
    return { ok: true, excluidas, erros };
  }

  async logs(id: string) {
    return (this.prisma as any).contaPagarLog.findMany({
      where: { contaId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ── BAIXA EM LOTE (11/07 — "precisa verificar e baixar") ─────────────────
  // O GIGA veio com 6.452 contas em aberto acumuladas em 20+ anos (1977,
  // 2000, testes de R$0,01…) — pagas na vida real, nunca baixadas no WinCred.
  // Baixa TODAS as contas ABERTAS do filtro atual de uma vez, com motivo
  // OBRIGATÓRIO e auditoria individual (quem, quando, motivo).
  async baixaEmLote(f: ListFilters, body: any, usuario?: string) {
    const motivo = String(body?.motivo || '').trim();
    if (motivo.length < 5) throw new BadRequestException('Informe o motivo da baixa em lote (mín. 5 caracteres)');
    const pagamento = body?.pagamento ? new Date(`${body.pagamento}T00:00:00.000Z`) : this.dia();

    const where = await this.montarWhere({ ...f, status: 'pendentes' });
    const alvo: any[] = await (this.prisma as any).contaPagar.findMany({
      where,
      select: { id: true, valorCents: true },
    });
    if (!alvo.length) throw new BadRequestException('Nenhuma conta aberta no filtro atual');
    if (alvo.length > 20000) throw new BadRequestException('Filtro pega contas demais — refine antes de baixar');

    const ids = alvo.map((a) => a.id);
    const somaCents = alvo.reduce((s, a) => s + a.valorCents, 0);

    // Baixa + observação do motivo (updateMany não concatena — motivo vai no log)
    await (this.prisma as any).contaPagar.updateMany({
      where: { id: { in: ids } },
      data: { status: 'paga', pagamento, jurosCents: 0, descontoCents: 0, pagoPor: usuario || null, updatedBy: usuario || null },
    });

    // Auditoria individual em lotes (1 log por conta)
    const logMsg = `${pagamento.toISOString().slice(0, 10)} — BAIXA EM LOTE: ${motivo}`.slice(0, 300);
    for (let i = 0; i < ids.length; i += 1000) {
      await (this.prisma as any).contaPagarLog.createMany({
        data: ids.slice(i, i + 1000).map((contaId) => ({
          contaId,
          campo: 'pagamento',
          valorAntigo: null,
          valorNovo: logMsg,
          usuario: usuario || null,
          origem: 'lote',
        })),
      });
    }
    this.logger.log(`[contas] BAIXA EM LOTE por ${usuario || '?'}: ${ids.length} conta(s), R$ ${(somaCents / 100).toFixed(2)} — ${motivo}`);
    return { ok: true, baixadas: ids.length, somaCents };
  }

  // ── aba FUNCIONÁRIAS (restrita) ───────────────────────────────────────────
  async funcionariasResumo(mes?: string) {
    const m = /^\d{4}-\d{2}$/.test(String(mes || '')) ? String(mes) : new Date().toISOString().slice(0, 7);
    const ini = new Date(`${m}-01T00:00:00.000Z`);
    const fim = new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth() + 1, 1));
    const rows: any[] = await (this.prisma as any).contaPagar.findMany({
      where: {
        deletedAt: null,
        beneficiarioTipo: 'funcionaria',
        vencimento: { gte: ini, lt: fim },
      },
      include: { especie: { select: { nome: true } } },
      orderBy: [{ sellerNome: 'asc' }, { vencimento: 'asc' }],
    });
    // SALDO DE ADIANTAMENTO (extrato): quanto cada funcionária ainda deve de
    // adiantamentos pendentes — abatido no próximo vale/salário.
    const saldos = await this.adiantamentos.saldosPendentes();

    // O NOME DE VERDADE É O DO CADASTRO (`sellers`). O `sellerNome` gravado na
    // conta é cópia CONGELADA do fornecedor da folha antiga — "Angelica" pra
    // Maria Angelica Sousa, "ANDREA DE PAULA MACHADO" pra Andrea De Paula
    // Machado Diesner. Medido em 05/09: 5.991 das 8.803 contas divergiam do
    // RH. A cópia vira HISTÓRICO (`nomeNaConta`), não rótulo da tela.
    // NÃO envolver em try/catch: espelho que falha tem que subir 500 honesto,
    // nunca virar tela com nome velho e cara de normal (regra de ouro).
    const idsCadastro = Array.from(
      new Set([...rows, ...saldos].map((r: any) => r.sellerId).filter(Boolean)),
    ) as string[];
    const cadastro: any[] = idsCadastro.length
      ? await (this.prisma as any).seller.findMany({
          where: { id: { in: idsCadastro } },
          select: { id: true, name: true, cpf: true, active: true, storeCodeOrigin: true },
        })
      : [];
    const byId = new Map<string, any>(cadastro.map((s) => [s.id, s]));

    type Pessoa = {
      nome: string;
      nomeCadastro: string | null;
      nomeNaConta: string | null;
      nomesNaConta: string[];
      sellerId: string | null;
      cpf: string | null;
      lojaCadastro: string | null;
      ativa: boolean | null;
      semCadastro: boolean;
      totalCents: number;
      saldoAdiantamentoCents: number;
      itens: any[];
    };
    const novaPessoa = (sellerId: string | null, nomeCongelado: string | null): Pessoa => {
      const s = sellerId ? byId.get(sellerId) : null;
      return {
        nome: '', // resolvido no fim, quando já se sabe TODOS os nomes dela
        nomeCadastro: s?.name || null,
        nomeNaConta: null,
        nomesNaConta: nomeCongelado ? [nomeCongelado] : [],
        sellerId,
        cpf: s?.cpf || null,
        lojaCadastro: s?.storeCodeOrigin || null,
        ativa: s ? !!s.active : null,
        // vínculo apontando pra cadastro que sumiu: APARECE na tela em vez de
        // virar nome órfão silencioso (0 casos em 05/09 — a tela é o alarme).
        semCadastro: !!sellerId && !s,
        totalCents: 0,
        saldoAdiantamentoCents: 0,
        itens: [],
      };
    };
    const porPessoa = new Map<string, Pessoa>();
    for (const r of rows) {
      const key = r.sellerId || r.sellerNome || '?';
      let p = porPessoa.get(key);
      if (!p) porPessoa.set(key, (p = novaPessoa(r.sellerId, r.sellerNome)));
      if (r.sellerNome && !p.nomesNaConta.includes(r.sellerNome)) p.nomesNaConta.push(r.sellerNome);
      p.totalCents += r.valorCents;
      p.itens.push({
        id: r.id,
        especie: r.especie?.nome || r.especieOriginal || '—',
        lojaCode: r.lojaCode,
        vencimento: r.vencimento,
        pagamento: r.pagamento,
        valorCents: r.valorCents,
        status: r.status,
        observacao: r.observacao,
      });
    }

    const saldoById = new Map<string, number>();
    const saldoByNome = new Map<string, number>();
    for (const s of saldos) {
      if (s.sellerId) saldoById.set(s.sellerId, (saldoById.get(s.sellerId) || 0) + s.cents);
      saldoByNome.set(s.sellerNome, (saldoByNome.get(s.sellerNome) || 0) + s.cents);
    }
    for (const p of porPessoa.values()) {
      // O casamento por NOME (fallback do adiantamento lançado sem sellerId)
      // tenta TODOS os nomes conhecidos dela — o do cadastro e os gravados nas
      // contas. Mudar o nome que a TELA exibe não pode fazer o adiantamento
      // parar de casar.
      let porNome = 0;
      for (const n of [p.nomeCadastro, ...p.nomesNaConta]) {
        if (n && saldoByNome.has(n)) { porNome = saldoByNome.get(n) || 0; break; }
      }
      p.saldoAdiantamentoCents = (p.sellerId ? saldoById.get(p.sellerId) : 0) || porNome || 0;
    }
    // Funcionária que SÓ tem adiantamento pendente (sem conta no mês) também aparece.
    for (const s of saldos) {
      const key = s.sellerId || s.sellerNome || '?';
      if (s.cents > 0 && !porPessoa.has(key)) {
        const p = novaPessoa(s.sellerId, s.sellerNome);
        p.saldoAdiantamentoCents = s.cents;
        porPessoa.set(key, p);
      }
    }

    // Nome resolvido só AGORA, quando já se conhece todos os nomes da pessoa.
    const pessoas = Array.from(porPessoa.values())
      .map(({ nomesNaConta, ...p }) => {
        const nome = nomeMaisCompleto(p.nomeCadastro, ...nomesNaConta) || '?';
        const daConta = nomeMaisCompleto(...nomesNaConta);
        return {
          ...p,
          nome,
          // Rodapé do card: o nome que NÃO está sendo exibido. Cadastro curto é
          // pendência de RH (dá pra consertar na ficha); folha antiga é só
          // histórico. Um dos dois, nunca os dois.
          nomeCadastro: p.nomeCadastro && p.nomeCadastro !== nome ? p.nomeCadastro : null,
          nomeNaConta: daConta && daConta !== nome ? daConta : null,
        };
      })
      .sort((a, b) => b.totalCents - a.totalCents);

    return {
      mes: m,
      pessoas,
      totalCents: rows.reduce((s, r) => s + r.valorCents, 0),
      saldoAdiantamentoTotalCents: saldos.reduce((s, x) => s + x.cents, 0),
      qtd: rows.length,
    };
  }
}
