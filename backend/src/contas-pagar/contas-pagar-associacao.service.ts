import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * ASSOCIAÇÃO Fornecedor(GIGA) → Funcionária (plano aprovado pelo dono 11/07).
 *
 * Números medidos no GIGA: 439 "fornecedores" usados em RH/VALE são PESSOAS
 * (269 só existem em folha); a maioria é EX-funcionária com sufixo de loja no
 * nome ("KASLEM ... - MB ITANHAEM"). Fluxo:
 *   1. importarFuncionariasGiga(): 135 ativas do `funcionarios` (CPF) → Seller
 *      (cria INATIVA se não existir — não polui a lista de vendedoras do PDV).
 *   2. candidatos(): fornecedores com lançamento RH/VALE + SUGESTÃO de match
 *      (nome normalizado: exato > contido > tokens em comum).
 *   3. associar(): converte TODAS as contas do fornecedor pra beneficiária
 *      FUNCIONÁRIA (auditado, reversível); fornecedor sai do autocomplete.
 *      "Criar histórica": gera Seller inativa a partir do nome limpo.
 */
@Injectable()
export class ContasPagarAssociacaoService {
  private readonly logger = new Logger(ContasPagarAssociacaoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  // ── normalização de nome (sufixos de loja, acentos, pontuação) ────────────
  private limparNome(raw: string): string {
    let s = String(raw || '').toUpperCase().trim();
    s = s.split(/\s[-–(]\s?/)[0]; // corta " - MB ITANHAEM", " (PIRACICABA)"...
    s = s.replace(/[()]/g, ' ');
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  }

  private tokens(nome: string): Set<string> {
    return new Set(this.limparNome(nome).split(' ').filter((t) => t.length >= 3));
  }

  /** Mapa code → nome da loja (pra exibir "· ITANHAÉM" ao lado da pessoa). */
  private async mapaLojas(): Promise<Map<string, string>> {
    const stores: any[] = await (this.prisma as any).store.findMany({ select: { code: true, name: true } });
    return new Map(stores.map((s) => [String(s.code), String(s.name)]));
  }

  /** Loja/cidade de exibição da funcionária (facilita escolher a pessoa certa). */
  private lojaDisplay(s: { storeCodeOrigin?: string | null; cidade?: string | null }, lojaNome: Map<string, string>): string | null {
    const code = s.storeCodeOrigin ? String(s.storeCodeOrigin).trim() : '';
    if (code) return lojaNome.get(code) || `LOJA ${code}`;
    return s.cidade ? String(s.cidade).trim() : null;
  }

  // ── 1. IMPORTA as funcionárias ATIVAS do GIGA (CPF, cargo, salário, loja) ─
  async importarFuncionariasGiga(usuario?: string) {
    const pool: any = (this.erp as any).pool;
    if (!pool) throw new BadRequestException('Conexão com o GIGA indisponível');
    const [rows] = await pool.query({
      sql: 'SELECT CODIGO, NOME, CPF, CARGO, LOJA FROM funcionarios',
      timeout: 60_000,
    });
    const sellers: any[] = await (this.prisma as any).seller.findMany({
      select: { id: true, name: true, cpf: true },
    });
    const byCpf = new Map<string, any>();
    const byNome = new Map<string, any>();
    for (const s of sellers) {
      if (s.cpf) byCpf.set(String(s.cpf).replace(/\D/g, ''), s);
      byNome.set(this.limparNome(s.name), s);
    }

    let vinculadas = 0, cpfPreenchido = 0, criadas = 0;
    for (const f of rows as any[]) {
      const nome = String(f.NOME || '').trim();
      if (!nome) continue;
      const cpf = String(f.CPF || '').replace(/\D/g, '');
      const chaveNome = this.limparNome(nome);
      let seller = (cpf && byCpf.get(cpf)) || byNome.get(chaveNome) || null;
      if (seller) {
        vinculadas++;
        if (cpf && !seller.cpf) {
          await (this.prisma as any).seller.update({ where: { id: seller.id }, data: { cpf } });
          cpfPreenchido++;
        }
      } else {
        // INATIVA de propósito: não aparece na lista de vendedoras do PDV.
        // wincredCodigo fica NULL (o código do PDV atribui venda — não misturar).
        const nova = await (this.prisma as any).seller.create({
          data: {
            name: nome,
            active: false,
            cpf: cpf || null,
            storeCodeOrigin: f.LOJA ? String(f.LOJA).trim() : null,
            cargo: 'VENDEDORA',
          },
        }).catch(() => null); // nome duplicado (unique) → já existe, ignora
        if (nova) { criadas++; byNome.set(chaveNome, nova); if (cpf) byCpf.set(cpf, nova); }
      }
    }
    this.logger.log(`[associacao] import GIGA por ${usuario}: ${vinculadas} vinculadas, ${cpfPreenchido} CPFs, ${criadas} criadas (inativas)`);
    return { ok: true, total: (rows as any[]).length, vinculadas, cpfPreenchido, criadas };
  }

  // ── 2. CANDIDATOS com sugestão de match ───────────────────────────────────
  async candidatos() {
    // Fornecedores com lançamento RH/VALE nas contas migradas
    const grupos: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT fornecedor_giga_codigo AS codigo,
              MAX(fornecedor_nome) AS nome,
              COUNT(*)::int AS total_contas,
              SUM(CASE WHEN UPPER(COALESCE(especie_original,'')) IN ('RH','VALE') THEN 1 ELSE 0 END)::int AS contas_rh_vale,
              COALESCE(SUM(valor_cents), 0)::float AS soma_cents
         FROM conta_pagar
        WHERE fornecedor_giga_codigo IS NOT NULL
          AND deleted_at IS NULL
          AND beneficiario_tipo = 'fornecedor'
        GROUP BY fornecedor_giga_codigo
       HAVING SUM(CASE WHEN UPPER(COALESCE(especie_original,'')) IN ('RH','VALE') THEN 1 ELSE 0 END) > 0
        ORDER BY contas_rh_vale DESC`,
    );
    const jaDecididos: any[] = await (this.prisma as any).contaPagarAssociacao.findMany({
      select: { fornecedorGigaCodigo: true },
    });
    const decididos = new Set(jaDecididos.map((d) => d.fornecedorGigaCodigo));

    const lojaNome = await this.mapaLojas();
    const sellers: any[] = await (this.prisma as any).seller.findMany({
      select: { id: true, name: true, cpf: true, active: true, storeCodeOrigin: true, cidade: true },
    });
    const sellersNorm = sellers.map((s) => ({
      ...s,
      norm: this.limparNome(s.name),
      toks: this.tokens(s.name),
      loja: this.lojaDisplay(s, lojaNome),
    }));

    const out: any[] = [];
    for (const g of grupos) {
      if (decididos.has(Number(g.codigo))) continue;
      const norm = this.limparNome(g.nome || '');
      const toks = this.tokens(g.nome || '');
      let sugestao: any = null;
      let nivel: 'exato' | 'contido' | 'parecido' | null = null;
      // exato
      const exato = sellersNorm.find((s) => s.norm === norm && norm.length > 5);
      if (exato) { sugestao = exato; nivel = 'exato'; }
      if (!sugestao) {
        const contido = sellersNorm.find((s) => norm.length > 8 && (s.norm.includes(norm) || norm.includes(s.norm)) && s.norm.length > 8);
        if (contido) { sugestao = contido; nivel = 'contido'; }
      }
      if (!sugestao && toks.size >= 2) {
        // TODOS os tokens da funcionária dentro do nome do fornecedor (em
        // QUALQUER posição): "ANDREA DIESNER" ⊂ "ANDREA DE PAULA MACHADO
        // DIESNER - SANTOS 2". Pega o que o "contido" (contíguo) perdia.
        const subset = sellersNorm.find((s) => {
          if (s.toks.size < 2) return false;
          for (const t of s.toks) if (!toks.has(t)) return false;
          return true;
        });
        if (subset) { sugestao = subset; nivel = 'contido'; }
      }
      if (!sugestao && toks.size >= 2) {
        let best: any = null; let bestScore = 0;
        for (const s of sellersNorm) {
          if (s.toks.size < 2) continue;
          let comum = 0;
          for (const t of toks) if (s.toks.has(t)) comum++;
          const score = comum / Math.max(toks.size, s.toks.size);
          if (score > bestScore) { bestScore = score; best = s; }
        }
        if (best && bestScore >= 0.6) { sugestao = best; nivel = 'parecido'; }
      }
      out.push({
        codigo: Number(g.codigo),
        nome: g.nome,
        nomeLimpo: norm,
        totalContas: Number(g.total_contas),
        contasRhVale: Number(g.contas_rh_vale),
        somaCents: Number(g.soma_cents),
        sugestao: sugestao
          ? { sellerId: sugestao.id, nome: sugestao.name, cpf: sugestao.cpf, ativa: sugestao.active, loja: sugestao.loja }
          : null,
        nivel,
      });
    }
    return { candidatos: out, pendentes: out.length, exatos: out.filter((o) => o.nivel === 'exato').length };
  }

  /**
   * PAINEL INVERTIDO (pedido do dono 11/07): a REFERÊNCIA é a tabela do RH —
   * funcionárias em ordem ALFABÉTICA com nome/loja/CPF — e pra cada uma
   * mostramos os fornecedores JÁ associados + as SUGESTÕES de fornecedor
   * pendente (o inverso da fila por fornecedor). Uma pessoa pode ter VÁRIOS
   * cadastros de fornecedor ao longo dos anos — todos se associam a ela.
   */
  async painelPorFuncionaria() {
    const [{ candidatos }, lojaNome] = await Promise.all([this.candidatos(), this.mapaLojas()]);
    const sellers: any[] = await (this.prisma as any).seller.findMany({
      select: { id: true, name: true, cpf: true, active: true, storeCodeOrigin: true, cidade: true },
      orderBy: { name: 'asc' },
    });
    const sellersNorm = sellers.map((s) => ({
      ...s,
      norm: this.limparNome(s.name),
      toks: this.tokens(s.name),
      loja: this.lojaDisplay(s, lojaNome),
    }));

    // Já associados, agrupados por funcionária
    const assoc: any[] = await (this.prisma as any).contaPagarAssociacao.findMany({
      where: { sellerId: { not: null } },
      select: { sellerId: true, fornecedorGigaCodigo: true, fornecedorNome: true, contasConvertidas: true },
    });
    const assocBySeller = new Map<string, any[]>();
    for (const a of assoc) {
      if (!assocBySeller.has(a.sellerId)) assocBySeller.set(a.sellerId, []);
      assocBySeller.get(a.sellerId)!.push({
        codigo: a.fornecedorGigaCodigo, nome: a.fornecedorNome, contas: a.contasConvertidas,
      });
    }

    // Sugestões: cada fornecedor pendente vai pra MELHOR funcionária (mesmas
    // regras da fila: exato > contido/subset > parecido).
    const sugestoesBySeller = new Map<string, any[]>();
    for (const c of candidatos as any[]) {
      const norm = String(c.nomeLimpo || '');
      const toks = new Set<string>(norm.split(' ').filter((t: string) => t.length >= 3));
      let melhor: any = null; let nivel: string | null = null;
      const exato = sellersNorm.find((s) => s.norm === norm && norm.length > 5);
      if (exato) { melhor = exato; nivel = 'exato'; }
      if (!melhor) {
        const contido = sellersNorm.find((s) => norm.length > 8 && s.norm.length > 8 && (s.norm.includes(norm) || norm.includes(s.norm)));
        if (contido) { melhor = contido; nivel = 'contido'; }
      }
      if (!melhor && toks.size >= 2) {
        const subset = sellersNorm.find((s) => {
          if (s.toks.size < 2) return false;
          for (const t of s.toks) if (!toks.has(t)) return false;
          return true;
        });
        if (subset) { melhor = subset; nivel = 'contido'; }
      }
      if (!melhor && toks.size >= 2) {
        let best: any = null; let bestScore = 0;
        for (const s of sellersNorm) {
          if (s.toks.size < 2) continue;
          let comum = 0;
          for (const t of toks) if (s.toks.has(t)) comum++;
          const score = comum / Math.max(toks.size, s.toks.size);
          if (score > bestScore) { bestScore = score; best = s; }
        }
        if (best && bestScore >= 0.6) { melhor = best; nivel = 'parecido'; }
      }
      if (melhor) {
        if (!sugestoesBySeller.has(melhor.id)) sugestoesBySeller.set(melhor.id, []);
        sugestoesBySeller.get(melhor.id)!.push({
          codigo: c.codigo, nome: c.nome, totalContas: c.totalContas, somaCents: c.somaCents, nivel,
        });
      }
    }

    return {
      funcionarias: sellersNorm.map((s) => ({
        sellerId: s.id,
        nome: s.name,
        cpf: s.cpf,
        ativa: s.active,
        loja: s.loja,
        associados: assocBySeller.get(s.id) || [],
        sugestoes: (sugestoesBySeller.get(s.id) || []).sort((a, b) => b.totalContas - a.totalContas),
      })),
      pendentesTotal: (candidatos as any[]).length,
      semSugestao: (candidatos as any[]).length -
        Array.from(sugestoesBySeller.values()).reduce((s, arr) => s + arr.length, 0),
    };
  }

  /** Fornecedores PENDENTES por qualquer parte do nome (pro "Buscar fornecedor…"). */
  async pendentes(q?: string) {
    const { candidatos } = await this.candidatos();
    const words = this.limparNome(q || '').split(' ').filter((w) => w.length >= 2);
    let lista = candidatos as any[];
    if (words.length) {
      lista = lista.filter((c) => {
        const alvo = `${this.limparNome(c.nome || '')} ${c.codigo}`;
        return words.every((w) => alvo.includes(w));
      });
    }
    return lista.slice(0, 30);
  }

  /** Busca funcionária pra "escolher outra" (inclui INATIVAS/históricas) — com loja/cidade. */
  async buscarFuncionarias(q?: string) {
    const term = String(q || '').trim();
    const [rows, lojaNome] = await Promise.all([
      (this.prisma as any).seller.findMany({
        where: term ? { name: { contains: term, mode: 'insensitive' } } : {},
        select: { id: true, name: true, cpf: true, active: true, storeCodeOrigin: true, cidade: true },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        take: 30,
      }),
      this.mapaLojas(),
    ]);
    return (rows as any[]).map((s) => ({
      id: s.id,
      name: s.name,
      cpf: s.cpf,
      active: s.active,
      loja: this.lojaDisplay(s, lojaNome),
    }));
  }

  // ── 3. ASSOCIAR (converte TODAS as contas do fornecedor) ──────────────────
  async associar(
    input: { fornecedorGigaCodigo: number; sellerId?: string; criarHistorica?: boolean; storeCode?: string },
    usuario?: string,
  ) {
    const codigo = Number(input.fornecedorGigaCodigo);
    if (!codigo) throw new BadRequestException('Fornecedor inválido');
    const existente = await (this.prisma as any).contaPagarAssociacao.findUnique({
      where: { fornecedorGigaCodigo: codigo },
    });
    if (existente) throw new BadRequestException('Fornecedor já decidido — desfaça antes de reassociar');

    // Nome do fornecedor (das contas)
    const amostra = await (this.prisma as any).contaPagar.findFirst({
      where: { fornecedorGigaCodigo: codigo },
      select: { fornecedorNome: true },
    });
    const fornecedorNome = amostra?.fornecedorNome || `FAVORECIDO #${codigo}`;

    // Funcionária destino: existente OU criada como histórica (inativa)
    let seller: any = null;
    if (input.sellerId) {
      seller = await (this.prisma as any).seller.findUnique({ where: { id: input.sellerId } });
      if (!seller) throw new NotFoundException('Funcionária não encontrada');
    } else if (input.criarHistorica) {
      const nomeLimpo = this.limparNome(fornecedorNome);
      if (nomeLimpo.length < 5) throw new BadRequestException('Nome curto demais pra criar histórica');
      seller = await (this.prisma as any).seller.findFirst({
        where: { name: { equals: nomeLimpo, mode: 'insensitive' } },
      });
      if (!seller) {
        seller = await (this.prisma as any).seller.create({
          data: { name: nomeLimpo, active: false, cargo: 'VENDEDORA', storeCodeOrigin: input.storeCode || null },
        });
      }
    } else {
      throw new BadRequestException('Informe a funcionária ou peça pra criar histórica');
    }

    // Converte TODAS as contas do fornecedor (decisão do dono: pessoa é pessoa)
    const contas: any[] = await (this.prisma as any).contaPagar.findMany({
      where: { fornecedorGigaCodigo: codigo, deletedAt: null },
      select: { id: true },
    });
    await (this.prisma as any).contaPagar.updateMany({
      where: { fornecedorGigaCodigo: codigo, deletedAt: null },
      data: {
        beneficiarioTipo: 'funcionaria',
        sellerId: seller.id,
        sellerNome: seller.name,
        sellerCpf: seller.cpf ? String(seller.cpf).replace(/\D/g, '') : null,
        updatedBy: usuario || null,
      },
    });
    const logMsg = `fornecedor "${fornecedorNome}" → funcionária "${seller.name}"`.slice(0, 300);
    for (let i = 0; i < contas.length; i += 1000) {
      await (this.prisma as any).contaPagarLog.createMany({
        data: contas.slice(i, i + 1000).map((c) => ({
          contaId: c.id, campo: 'associacao', valorAntigo: fornecedorNome,
          valorNovo: seller.name, usuario: usuario || null, origem: 'associacao',
        })),
      });
    }
    await (this.prisma as any).contaPagarAssociacao.create({
      data: {
        fornecedorGigaCodigo: codigo,
        fornecedorNome,
        sellerId: seller.id,
        sellerNome: seller.name,
        contasConvertidas: contas.length,
        criadoPor: usuario || null,
      },
    });
    this.logger.log(`[associacao] ${logMsg} — ${contas.length} conta(s) por ${usuario}`);
    return { ok: true, contasConvertidas: contas.length, seller: { id: seller.id, nome: seller.name } };
  }

  /** Confirma EM LOTE todas as sugestões de nível EXATO. */
  async confirmarExatos(usuario?: string) {
    const { candidatos } = await this.candidatos();
    const exatos = candidatos.filter((c: any) => c.nivel === 'exato' && c.sugestao);
    let ok = 0, contas = 0;
    for (const c of exatos) {
      try {
        const r = await this.associar({ fornecedorGigaCodigo: c.codigo, sellerId: c.sugestao.sellerId }, usuario);
        ok++; contas += r.contasConvertidas;
      } catch (e) {
        this.logger.warn(`[associacao] exato ${c.codigo} falhou: ${(e as Error).message}`);
      }
    }
    return { ok: true, associados: ok, contasConvertidas: contas };
  }

  /** Marca "não é pessoa" (CONTABILIDADE, DESPESAS GERAIS…) — sai da fila. */
  async naoEhPessoa(fornecedorGigaCodigo: number, usuario?: string) {
    const codigo = Number(fornecedorGigaCodigo);
    const amostra = await (this.prisma as any).contaPagar.findFirst({
      where: { fornecedorGigaCodigo: codigo },
      select: { fornecedorNome: true },
    });
    await (this.prisma as any).contaPagarAssociacao.upsert({
      where: { fornecedorGigaCodigo: codigo },
      create: {
        fornecedorGigaCodigo: codigo,
        fornecedorNome: amostra?.fornecedorNome || null,
        naoEhPessoa: true,
        criadoPor: usuario || null,
      },
      update: { naoEhPessoa: true, sellerId: null, sellerNome: null },
    });
    return { ok: true };
  }

  /** Desfaz a associação: contas voltam a fornecedor (nome original preservado). */
  async desfazer(fornecedorGigaCodigo: number, usuario?: string) {
    const codigo = Number(fornecedorGigaCodigo);
    const assoc = await (this.prisma as any).contaPagarAssociacao.findUnique({
      where: { fornecedorGigaCodigo: codigo },
    });
    if (!assoc) throw new NotFoundException('Associação não encontrada');
    if (!assoc.naoEhPessoa) {
      await (this.prisma as any).contaPagar.updateMany({
        where: { fornecedorGigaCodigo: codigo, deletedAt: null, createdBy: 'migracao-giga' },
        data: { beneficiarioTipo: 'fornecedor', sellerId: null, sellerNome: null, sellerCpf: null, updatedBy: usuario || null },
      });
    }
    await (this.prisma as any).contaPagarAssociacao.delete({ where: { fornecedorGigaCodigo: codigo } });
    this.logger.log(`[associacao] desfeita fornecedor ${codigo} por ${usuario}`);
    return { ok: true };
  }

  /** Já decididos (associados + não-é-pessoa) — pra listar e desfazer. */
  decididos() {
    return (this.prisma as any).contaPagarAssociacao.findMany({ orderBy: { createdAt: 'desc' } });
  }
}
