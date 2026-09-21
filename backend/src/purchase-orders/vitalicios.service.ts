import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { refBaseOf } from '../common/ref-base';
import {
  ORIGEM_PEDIDO_VITALICIOS,
  PESO_SITUACAO,
  SituacaoCompra,
  codigoSemZeros,
  contaDaCompra,
  itemAindaAChegar,
  norm,
  ordenarTamanhos,
  pendenteDoItem,
  piorSituacao,
} from '../common/compra-vitalicios';

/**
 * ABA "VITALÍCIOS" DE PEDIDOS (21/09/2026) — régua em `common/compra-vitalicios.ts`.
 *
 * Lista as REFs marcadas como vitalícias com a grade de cada cor (TENHO ·
 * MÍNIMO · IDEAL · COMPRAR) e gera os pedidos de compra por marca até o IDEAL.
 * O pedido sai pelo MESMO `PurchaseOrdersService.create` do lançamento à mão —
 * cai na lista de PEDIDOS como rascunho, com o PDF de sempre.
 *
 * De onde vem cada número (nada é inventado aqui):
 *  - estoque: `wincred_estoque`, a mesma tabela que a Consulta, o site e o
 *    PDV leem — somado na REDE INTEIRA, franquias inclusive (decisão do dono);
 *  - trânsito: peça bipada em caixa `in_transit` sem pedido (a mesma régua do
 *    `LastroRedeService`: caixa de juntada leva peça JÁ VENDIDA e fica fora);
 *  - já pedido: item de pedido de compra ainda a chegar (`itemAindaAChegar`);
 *  - mínimo/ideal: `produto_reposicao`, a matriz de 24/08 (digitada).
 */

const SEM_MARCA = 'SEM MARCA';
const GRADE_DA_CASA = ['46', '48', '50', '52', '54', '56', '58', '60'];

const marcaDe = (v: unknown) => norm(v) || SEM_MARCA;
const kRef = (ref: string, marca: string) => `${ref}|${marca}`;
const kCor = (ref: string, marca: string, cor: string) => `${ref}|${marca}|${cor}`;
const kTam = (ref: string, marca: string, cor: string, tam: string) => `${ref}|${marca}|${cor}|${tam}`;

export interface CelulaVitalicio {
  tamanho: string;
  estoque: number;
  transito: number;
  emPedido: number;
  /** Pedidos que seguram este tamanho (número do pedido + quantas peças). */
  pedidos: Array<{ numero: number; qtd: number }>;
  minimo: number | null;
  ideal: number | null;
  tenho: number;
  comprar: number | null;
  situacao: SituacaoCompra;
}

export interface CorVitalicio {
  cor: string;
  situacao: SituacaoCompra;
  comprar: number;
  custoUnit: number | null;
  precoUnit: number | null;
  tamanhos: CelulaVitalicio[];
}

export interface RefVitalicio {
  ref: string;
  marca: string;
  descricao: string;
  grupo: string | null;
  marcadoPor: string | null;
  marcadoEm: Date;
  situacao: SituacaoCompra;
  comprar: number;
  custoComprar: number;
  cores: CorVitalicio[];
  /**
   * Cores da REF sem estoque, sem trânsito, sem pedido e sem mínimo/ideal —
   * com a grade delas, pra tela abrir a cor com os tamanhos certos quando a
   * compradora quiser configurar.
   */
  coresSemMovimento: Array<{ cor: string; tamanhos: string[]; custoUnit: number | null; precoUnit: number | null }>;
}

@Injectable()
export class VitaliciosService {
  private readonly logger = new Logger(VitaliciosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly pedidos: PurchaseOrdersService,
  ) {}

  /** A chave da ficha/matriz: REF-BASE + MARCA (vazia = SEM MARCA). */
  private chave(refRaw: unknown, marcaRaw: unknown) {
    const ref = refBaseOf(refRaw);
    if (!ref) throw new BadRequestException('REF obrigatória');
    return { ref, marca: marcaDe(marcaRaw) };
  }

  // ── Marcação ─────────────────────────────────────────────────────────

  async status(refRaw: string, marcaRaw: string) {
    const { ref, marca } = this.chave(refRaw, marcaRaw);
    const v: any = await (this.prisma as any).produtoVitalicio.findUnique({
      where: { ref_marca: { ref, marca } },
    });
    return {
      ref,
      marca,
      vitalicio: !!v,
      marcadoPor: v?.marcadoPor ?? null,
      marcadoEm: v?.createdAt ?? null,
    };
  }

  async marcar(itens: Array<{ ref?: string; marca?: string }>, quem: string) {
    if (!Array.isArray(itens) || !itens.length) throw new BadRequestException('Nenhuma REF informada');
    if (itens.length > 500) throw new BadRequestException('No máximo 500 REFs por vez');
    const chaves = itens.map((i) => this.chave(i?.ref, i?.marca));

    // Só REF que EXISTE no catálogo: marcar REF digitada errada criaria uma
    // linha que nunca aparece na tela (não há peça pra somar) e ninguém acha.
    const produtos = await this.produtosDasRefs(chaves);
    const existentes = new Set(produtos.map((p) => kRef(p.refBase, p.marcaN)));
    const faltando = chaves.filter((c) => !existentes.has(kRef(c.ref, c.marca)));
    if (faltando.length) {
      throw new BadRequestException(
        `REF sem peça no catálogo: ${faltando.map((c) => `${c.ref} (${c.marca})`).join(', ')}`,
      );
    }

    for (const c of chaves) {
      await (this.prisma as any).produtoVitalicio.upsert({
        where: { ref_marca: { ref: c.ref, marca: c.marca } },
        create: { ref: c.ref, marca: c.marca, marcadoPor: quem || null },
        update: {},
      });
    }
    this.logger.log(`[vitalicios] ${quem || '?'} marcou ${chaves.map((c) => `${c.ref}/${c.marca}`).join(', ')}`);
    return { ok: true, marcadas: chaves.length };
  }

  async desmarcar(itens: Array<{ ref?: string; marca?: string }>, quem: string) {
    if (!Array.isArray(itens) || !itens.length) throw new BadRequestException('Nenhuma REF informada');
    let n = 0;
    for (const i of itens) {
      const c = this.chave(i?.ref, i?.marca);
      const r = await (this.prisma as any).produtoVitalicio.deleteMany({ where: { ref: c.ref, marca: c.marca } });
      n += Number(r?.count || 0);
    }
    this.logger.log(`[vitalicios] ${quem || '?'} desmarcou ${n} REF(s)`);
    return { ok: true, desmarcadas: n };
  }

  /**
   * Busca pra "Adicionar vitalício": REF (começo) ou pedaço da descrição,
   * agrupado por REF-BASE + MARCA — é assim que a peça vira vitalícia.
   */
  async buscar(qRaw: string) {
    const q = String(qRaw || '').trim();
    if (q.length < 2) return [];
    const linhas: any[] = await (this.prisma as any).product.findMany({
      where: {
        OR: [
          { ref: { startsWith: q, mode: 'insensitive' } },
          { descricaoPdv: { contains: q, mode: 'insensitive' } },
          { descricaoCompleta: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { ref: true, marca: true, cor: true, descricaoPdv: true, descricaoCompleta: true },
      take: 600,
    });
    const grupos = new Map<string, { ref: string; marca: string; descricao: string; cores: Set<string> }>();
    for (const l of linhas) {
      const ref = refBaseOf(l.ref);
      if (!ref) continue;
      const marca = marcaDe(l.marca);
      const k = kRef(ref, marca);
      const g = grupos.get(k) || { ref, marca, descricao: '', cores: new Set<string>() };
      if (!g.descricao) g.descricao = String(l.descricaoPdv || l.descricaoCompleta || '').trim();
      if (l.cor) g.cores.add(norm(l.cor));
      grupos.set(k, g);
    }
    const lista = [...grupos.values()].slice(0, 40);
    const ja: any[] = lista.length
      ? await (this.prisma as any).produtoVitalicio.findMany({
          where: { OR: lista.map((g) => ({ ref: g.ref, marca: g.marca })) },
          select: { ref: true, marca: true },
        })
      : [];
    const jaSet = new Set(ja.map((j) => kRef(j.ref, j.marca)));
    return lista.map((g) => ({
      ref: g.ref,
      marca: g.marca,
      descricao: g.descricao,
      cores: [...g.cores].sort(),
      vitalicio: jaSet.has(kRef(g.ref, g.marca)),
    }));
  }

  // ── A tela ──────────────────────────────────────────────────────────

  async listar(filtro: { marca?: string; busca?: string } = {}) {
    const marcaFiltro = norm(filtro.marca);
    const busca = norm(filtro.busca);

    let vitalicios: any[] = await (this.prisma as any).produtoVitalicio.findMany({
      orderBy: [{ marca: 'asc' }, { ref: 'asc' }],
    });
    const marcasTodas = [...new Set(vitalicios.map((v) => v.marca))].sort();
    if (marcaFiltro) vitalicios = vitalicios.filter((v) => v.marca === marcaFiltro);
    if (!vitalicios.length) return { refs: [], marcas: marcasTodas, geradoEm: new Date() };

    const chaves = vitalicios.map((v) => ({ ref: v.ref, marca: v.marca }));
    const produtos = await this.produtosDasRefs(chaves);

    const codigos = [...new Set(produtos.map((p) => p.codigoN))];
    const [estoque, transito, emPedido, reposicao, ultimos] = await Promise.all([
      this.estoquePorCodigo(produtos.map((p) => String(p.codigo || '').trim())),
      this.transitoPorCodigo(codigos),
      this.pedidosACaminho(chaves),
      this.minimoIdeal(chaves),
      this.ultimosItensComprados(produtos),
    ]);

    // Índice SKU → célula (REF+MARCA+COR+TAM).
    const porRef = new Map<string, { produtos: any[] }>();
    for (const p of produtos) {
      const k = kRef(p.refBase, p.marcaN);
      const g = porRef.get(k) || { produtos: [] };
      g.produtos.push(p);
      porRef.set(k, g);
    }

    const refs: RefVitalicio[] = [];
    for (const v of vitalicios) {
      const k = kRef(v.ref, v.marca);
      const prods = porRef.get(k)?.produtos || [];

      // Descrição e grupo: o que a maioria das peças da REF diz.
      const descricao = maisFrequente(prods.map((p) => String(p.descricaoPdv || p.descricaoCompleta || '').trim()))
        || `REF ${v.ref}`;
      if (busca && !`${v.ref} ${v.marca} ${descricao}`.toUpperCase().includes(busca)) continue;
      const grupo = maisFrequente(prods.map((p) => String(p.nomeGrupo || '').trim())) || null;

      // As cores: as do catálogo + qualquer uma com mínimo/ideal, pedido ou trânsito.
      const cores = new Set<string>(prods.map((p) => p.corN).filter(Boolean));
      for (const kk of [...reposicao.keys(), ...emPedido.keys()]) {
        const [r, m, c] = kk.split('|');
        if (r === v.ref && m === v.marca && c) cores.add(c);
      }
      const usaGradeDaCasa = prods.some((p) => GRADE_DA_CASA.includes(p.tamN));

      const linhasCor: CorVitalicio[] = [];
      const semMovimento: RefVitalicio['coresSemMovimento'] = [];
      for (const cor of [...cores].sort()) {
        const skus = prods.filter((p) => p.corN === cor);
        const tams = new Set<string>(skus.map((p) => p.tamN).filter(Boolean));
        for (const kk of [...reposicao.keys(), ...emPedido.keys()]) {
          const [r, m, c, t] = kk.split('|');
          if (r === v.ref && m === v.marca && c === cor && t) tams.add(t);
        }
        if (usaGradeDaCasa) for (const t of GRADE_DA_CASA) tams.add(t);

        const celulas: CelulaVitalicio[] = [];
        for (const tam of ordenarTamanhos([...tams])) {
          const doTam = skus.filter((p) => p.tamN === tam);
          const est = doTam.reduce((s, p) => s + (estoque.get(p.codigoN) || 0), 0);
          const tra = doTam.reduce((s, p) => s + (transito.get(p.codigoN) || 0), 0);
          const ped = emPedido.get(kTam(v.ref, v.marca, cor, tam));
          const rep = reposicao.get(kTam(v.ref, v.marca, cor, tam));
          const conta = contaDaCompra({
            estoque: est,
            transito: tra,
            emPedido: ped?.qtd || 0,
            minimo: rep?.minimo ?? null,
            ideal: rep?.ideal ?? null,
          });
          celulas.push({
            tamanho: tam,
            estoque: est,
            transito: tra,
            emPedido: ped?.qtd || 0,
            pedidos: ped?.pedidos || [],
            minimo: rep?.minimo ?? null,
            ideal: rep?.ideal ?? null,
            ...conta,
          });
        }

        const ult = ultimos.get(kCor(v.ref, v.marca, cor)) || ultimos.get(kRef(v.ref, v.marca));
        // Custo = o último PAGO; preço = o de venda de hoje (decisão do dono).
        const { custo, preco } = valoresDaLinha(ult, skus, prods);
        const movimento = celulas.some(
          (c) => c.estoque > 0 || c.transito > 0 || c.emPedido > 0 || c.minimo !== null || c.ideal !== null,
        );
        if (!movimento) {
          semMovimento.push({ cor, tamanhos: celulas.map((c) => c.tamanho), custoUnit: custo, precoUnit: preco });
          continue;
        }
        linhasCor.push({
          cor,
          situacao: piorSituacao(celulas.map((c) => c.situacao)),
          comprar: celulas.reduce((s, c) => s + (c.comprar || 0), 0),
          custoUnit: custo,
          precoUnit: preco,
          tamanhos: celulas,
        });
      }

      linhasCor.sort(
        (a, b) => PESO_SITUACAO[a.situacao] - PESO_SITUACAO[b.situacao] || b.comprar - a.comprar || a.cor.localeCompare(b.cor),
      );
      refs.push({
        ref: v.ref,
        marca: v.marca,
        descricao,
        grupo,
        marcadoPor: v.marcadoPor ?? null,
        marcadoEm: v.createdAt,
        situacao: piorSituacao(linhasCor.map((c) => c.situacao)),
        comprar: linhasCor.reduce((s, c) => s + c.comprar, 0),
        custoComprar: arred(linhasCor.reduce((s, c) => s + c.comprar * (c.custoUnit || 0), 0)),
        cores: linhasCor,
        coresSemMovimento: semMovimento,
      });
    }

    refs.sort(
      (a, b) =>
        PESO_SITUACAO[a.situacao] - PESO_SITUACAO[b.situacao] ||
        b.comprar - a.comprar ||
        a.marca.localeCompare(b.marca) ||
        a.ref.localeCompare(b.ref),
    );
    return { refs, marcas: marcasTodas, geradoEm: new Date() };
  }

  // ── Gerar pedidos ───────────────────────────────────────────────────

  /**
   * UM PEDIDO POR MARCA, como RASCUNHO, pelo MESMO create do lançamento à mão.
   *
   * As quantidades vêm da TELA (a compradora pode ter ajustado o COMPRAR de
   * uma célula), mas cada REF+MARCA é conferida como vitalícia aqui — o
   * servidor não gera pedido de peça que não está na aba.
   */
  async gerarPedidos(
    itensRaw: Array<{ ref?: string; marca?: string; cor?: string; tamanhos?: Record<string, number> }>,
    userId: string | null,
    quem: string,
  ) {
    if (!Array.isArray(itensRaw) || !itensRaw.length) throw new BadRequestException('Nada pra pedir');
    if (itensRaw.length > 800) throw new BadRequestException('Pedido grande demais — gere por marca');

    type Item = { ref: string; marca: string; cor: string; tamanhos: Record<string, number> };
    const itens: Item[] = [];
    for (const i of itensRaw) {
      const { ref, marca } = this.chave(i?.ref, i?.marca);
      const cor = norm(i?.cor);
      if (!cor) throw new BadRequestException(`REF ${ref}: COR obrigatória`);
      const tamanhos: Record<string, number> = {};
      for (const [t, q] of Object.entries(i?.tamanhos || {})) {
        const n = Math.floor(Number(q));
        const tam = norm(t);
        if (!tam || !Number.isFinite(n) || n <= 0) continue;
        if (n > 999) throw new BadRequestException(`REF ${ref} ${cor} ${tam}: ${n} peças é dedo escorregado`);
        tamanhos[tam] = (tamanhos[tam] || 0) + n;
      }
      if (Object.keys(tamanhos).length) itens.push({ ref, marca, cor, tamanhos });
    }
    if (!itens.length) throw new BadRequestException('Nenhum tamanho com quantidade pra pedir');

    const refsUnicas = [...new Map(itens.map((i) => [kRef(i.ref, i.marca), { ref: i.ref, marca: i.marca }])).values()];
    const vit: any[] = await (this.prisma as any).produtoVitalicio.findMany({
      where: { OR: refsUnicas.map((r) => ({ ref: r.ref, marca: r.marca })) },
      select: { ref: true, marca: true },
    });
    const vitSet = new Set(vit.map((v) => kRef(v.ref, v.marca)));
    const naoVit = refsUnicas.filter((r) => !vitSet.has(kRef(r.ref, r.marca)));
    if (naoVit.length) {
      throw new BadRequestException(
        `Estas REFs não estão marcadas como vitalícias: ${naoVit.map((r) => `${r.ref} (${r.marca})`).join(', ')}`,
      );
    }

    const produtos = await this.produtosDasRefs(refsUnicas);
    const ultimos = await this.ultimosItensComprados(produtos);
    const dataTxt = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    const porMarca = new Map<string, Item[]>();
    for (const i of itens) porMarca.set(i.marca, [...(porMarca.get(i.marca) || []), i]);

    const pedidos: Array<{ id: string; numero: number; marca: string; fornecedorNome: string; pecas: number; totalCusto: number; semCnpj: boolean }> = [];
    const ignorados: Array<{ ref: string; marca: string; cor: string; motivo: string }> = [];
    const erros: Array<{ marca: string; erro: string }> = [];

    for (const [marca, lista] of porMarca) {
      const prodsMarca = produtos.filter((p) => p.marcaN === marca);
      const itensPedido: any[] = [];
      for (const i of lista) {
        const skus = prodsMarca.filter((p) => p.refBase === i.ref && p.corN === i.cor);
        const daRef = prodsMarca.filter((p) => p.refBase === i.ref);
        const ult = ultimos.get(kCor(i.ref, marca, i.cor)) || ultimos.get(kRef(i.ref, marca));
        const { custo, preco } = valoresDaLinha(ult, skus, daRef);
        if (custo === null || preco === null) {
          ignorados.push({
            ref: i.ref,
            marca,
            cor: i.cor,
            motivo: custo === null ? 'sem custo cadastrado — lance à mão no pedido' : 'sem preço de venda — lance à mão no pedido',
          });
          continue;
        }
        const base = skus[0] || daRef[0] || null;
        itensPedido.push({
          // A REF que o fornecedor conhece: a do último pedido, senão a do catálogo.
          ref: String(ult?.ref || base?.refRaw || i.ref),
          descricaoBase: String(ult?.descricaoBase || base?.descricaoPdv || base?.descricaoCompleta || `REF ${i.ref}`).slice(0, 120),
          cor: i.cor,
          grupoCode: ult?.grupoCode ?? (base?.grupo || undefined),
          grupoNome: ult?.grupoNome ?? (base?.nomeGrupo || undefined),
          subgrupoCode: ult?.subgrupoCode ?? (base?.subgrupo || undefined),
          subgrupoNome: ult?.subgrupoNome ?? undefined,
          ncm: ult?.ncm || base?.ncm || undefined,
          custoUnit: arred(custo),
          precoUnit: arred(preco),
          tamanhosQty: i.tamanhos,
        });
      }
      if (!itensPedido.length) continue;

      try {
        const forn = await this.fornecedorDaMarca(marca, prodsMarca);
        const o = await this.pedidos.create(
          {
            fornecedorNome: forn.nome,
            fornecedorCnpj: forn.cnpj || undefined,
            marca,
            origem: ORIGEM_PEDIDO_VITALICIOS,
            observacoes: `Pedido automático — Vitalícios (${dataTxt}) · gerado por ${quem || 'retaguarda'}.`,
            items: itensPedido,
          },
          userId || undefined,
        );
        pedidos.push({
          id: o.id,
          numero: o.numero,
          marca,
          fornecedorNome: o.fornecedorNome,
          pecas: Number(o.totalPecas) || 0,
          totalCusto: Number(o.totalCusto) || 0,
          semCnpj: !o.fornecedorCnpj,
        });
        this.logger.log(
          `[vitalicios] ${quem || '?'} gerou o pedido #${o.numero} (${marca}): ${o.totalPecas} peça(s), R$${Number(o.totalCusto || 0).toFixed(2)}`,
        );
      } catch (e: any) {
        this.logger.warn(`[vitalicios] pedido da marca ${marca} falhou: ${e?.message || e}`);
        erros.push({ marca, erro: String(e?.message || e).slice(0, 300) });
      }
    }

    if (!pedidos.length && erros.length) {
      throw new BadRequestException(`Nenhum pedido gerado: ${erros.map((e) => `${e.marca}: ${e.erro}`).join(' · ')}`);
    }
    return { pedidos, ignorados, erros };
  }

  // ── Fontes ──────────────────────────────────────────────────────────

  /**
   * As peças do catálogo (tabela nativa `product`) das REFs pedidas.
   * O filtro do banco é largo (REF COMEÇA com a base, sem caixa) e o corte
   * exato é aqui, pela MESMA `refBaseOf` da ficha — senão a base "703"
   * puxaria a família "7031".
   */
  private async produtosDasRefs(chaves: Array<{ ref: string; marca: string }>) {
    if (!chaves.length) return [];
    const bases = [...new Set(chaves.map((c) => c.ref))];
    const alvo = new Set(chaves.map((c) => kRef(c.ref, c.marca)));
    const linhas: any[] = [];
    for (let i = 0; i < bases.length; i += 150) {
      const lote = bases.slice(i, i + 150);
      const r: any[] = await (this.prisma as any).product.findMany({
        where: { OR: lote.map((b) => ({ ref: { startsWith: b, mode: 'insensitive' } })) },
        select: {
          codigo: true,
          ref: true,
          marca: true,
          cor: true,
          tamanho: true,
          custo: true,
          vendaUn: true,
          descricaoPdv: true,
          descricaoCompleta: true,
          grupo: true,
          nomeGrupo: true,
          subgrupo: true,
          ncm: true,
          fornecedor: true,
        },
      });
      linhas.push(...r);
    }
    return linhas
      .map((p) => ({
        ...p,
        refRaw: norm(p.ref),
        refBase: refBaseOf(p.ref),
        marcaN: marcaDe(p.marca),
        corN: norm(p.cor),
        tamN: norm(p.tamanho),
        codigoN: codigoSemZeros(p.codigo),
      }))
      .filter((p) => alvo.has(kRef(p.refBase, p.marcaN)));
  }

  /** Estoque da REDE INTEIRA por SKU (loja negativa conta zero). */
  private async estoquePorCodigo(codigos: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!codigos.length) return out;
    // O espelho e o catálogo nascem do mesmo cadastro, mas o código já veio
    // com e sem zero à esquerda na história da casa: pergunta pelos dois.
    const variantes = [
      ...new Set(
        codigos
          .filter(Boolean)
          .flatMap((c) => [c, codigoSemZeros(c), codigoSemZeros(c).padStart(14, '0')])
          .filter((c) => c && c.length <= 14),
      ),
    ];
    for (let i = 0; i < variantes.length; i += 4000) {
      const lote = variantes.slice(i, i + 4000);
      const linhas: any[] = await (this.prisma as any).wincredEstoque.findMany({
        where: { codigo: { in: lote } },
        select: { codigo: true, loja: true, estoque: true },
      });
      for (const l of linhas) {
        const k = codigoSemZeros(l.codigo);
        out.set(k, (out.get(k) || 0) + Math.max(0, Number(l.estoque) || 0));
      }
    }
    return out;
  }

  /**
   * Peça DENTRO de caixa em trânsito entre lojas — saiu da origem, não entrou
   * no destino, e não está no estoque de ninguém. A MESMA régua do
   * `LastroRedeService`: 1 linha de TransferOrder = 1 peça bipada; caixa de
   * juntada (`orderId`) leva peça já VENDIDA e fica fora.
   */
  private async transitoPorCodigo(codigos: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!codigos.length) return out;
    const alvo = new Set(codigos);
    const caixas: any[] = await (this.prisma as any).realignmentShipment.findMany({
      where: { status: 'in_transit', orderId: null },
      select: { id: true },
    });
    if (!caixas.length) return out;
    const pecas: any[] = await (this.prisma as any).transferOrder.findMany({
      where: { shipmentId: { in: caixas.map((c) => c.id) }, codigoBipado: { not: null } },
      select: { codigoBipado: true },
    });
    for (const p of pecas) {
      const k = codigoSemZeros(p.codigoBipado);
      if (alvo.has(k)) out.set(k, (out.get(k) || 0) + 1);
    }
    return out;
  }

  /**
   * O que já foi pedido às marcas e ainda não chegou, por REF+MARCA+COR+TAM.
   * Pedido sem MARCA preenchida casa pela REF quando só UMA marca vitalícia
   * tem aquela REF-base (senão seria chute).
   */
  private async pedidosACaminho(
    chaves: Array<{ ref: string; marca: string }>,
  ): Promise<Map<string, { qtd: number; pedidos: Array<{ numero: number; qtd: number }> }>> {
    const out = new Map<string, { qtd: number; pedidos: Array<{ numero: number; qtd: number }> }>();
    if (!chaves.length) return out;
    const alvo = new Set(chaves.map((c) => kRef(c.ref, c.marca)));
    const marcasPorBase = new Map<string, string[]>();
    for (const c of chaves) marcasPorBase.set(c.ref, [...(marcasPorBase.get(c.ref) || []), c.marca]);

    const itens: any[] = await (this.prisma as any).purchaseOrderItem.findMany({
      where: {
        itemStatus: { in: ['pendente', 'parcial'] },
        order: { status: { not: 'cancelado' } },
      },
      select: {
        ref: true,
        cor: true,
        tamanhosQty: true,
        tamanhosQtyRecebida: true,
        itemStatus: true,
        order: { select: { numero: true, status: true, origem: true, marca: true } },
      },
    });
    for (const it of itens) {
      if (!itemAindaAChegar(it.order?.status, it.order?.origem, it.itemStatus)) continue;
      const ref = refBaseOf(it.ref);
      let marca = norm(it.order?.marca);
      if (!marca) {
        const cands = marcasPorBase.get(ref) || [];
        if (cands.length !== 1) continue;
        marca = cands[0];
      }
      if (!alvo.has(kRef(ref, marca))) continue;
      const cor = norm(it.cor);
      for (const [tam, qtd] of Object.entries(pendenteDoItem(it.tamanhosQty, it.tamanhosQtyRecebida))) {
        const k = kTam(ref, marca, cor, tam);
        const cur = out.get(k) || { qtd: 0, pedidos: [] };
        cur.qtd += qtd;
        cur.pedidos.push({ numero: Number(it.order?.numero) || 0, qtd });
        out.set(k, cur);
      }
    }
    return out;
  }

  /** Mínimo e IDEAL digitados (a matriz de 24/08), por REF+MARCA+COR+TAM. */
  private async minimoIdeal(
    chaves: Array<{ ref: string; marca: string }>,
  ): Promise<Map<string, { minimo: number | null; ideal: number | null }>> {
    const out = new Map<string, { minimo: number | null; ideal: number | null }>();
    for (let i = 0; i < chaves.length; i += 200) {
      const lote = chaves.slice(i, i + 200);
      const linhas: any[] = await (this.prisma as any).produtoReposicao.findMany({
        where: { OR: lote.map((c) => ({ ref: c.ref, marca: c.marca })) },
        select: { ref: true, marca: true, cor: true, tamanho: true, minimoTotal: true, idealTotal: true },
      });
      for (const l of linhas) {
        // Linha com os dois nulos é resíduo (ver `reposicao()` da ficha).
        if (l.minimoTotal === null && l.idealTotal === null) continue;
        out.set(kTam(l.ref, l.marca, norm(l.cor), norm(l.tamanho)), {
          minimo: l.minimoTotal,
          ideal: l.idealTotal,
        });
      }
    }
    return out;
  }

  /**
   * O ÚLTIMO item comprado de cada REF+COR (e de cada REF, pra cor que nunca
   * foi pedida): é de onde saem o custo pago, a descrição do fornecedor, o
   * grupo e o NCM do pedido novo. Casa pela REF crua do catálogo.
   */
  private async ultimosItensComprados(produtos: any[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    const refsCruas = [...new Set(produtos.map((p) => p.refRaw).filter(Boolean))];
    if (!refsCruas.length) return out;
    const itens: any[] = [];
    for (let i = 0; i < refsCruas.length; i += 500) {
      const r: any[] = await (this.prisma as any).purchaseOrderItem.findMany({
        where: { ref: { in: refsCruas.slice(i, i + 500) }, order: { status: { not: 'cancelado' } } },
        orderBy: { createdAt: 'desc' },
        select: {
          ref: true,
          cor: true,
          descricaoBase: true,
          grupoCode: true,
          grupoNome: true,
          subgrupoCode: true,
          subgrupoNome: true,
          ncm: true,
          custoUnit: true,
          precoUnit: true,
          createdAt: true,
          order: { select: { marca: true } },
        },
      });
      itens.push(...r);
    }
    itens.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    const marcasDaRef = new Map<string, Set<string>>();
    for (const p of produtos) {
      marcasDaRef.set(p.refBase, (marcasDaRef.get(p.refBase) || new Set()).add(p.marcaN));
    }
    for (const it of itens) {
      const ref = refBaseOf(it.ref);
      const marcas = it.order?.marca ? [norm(it.order.marca)] : [...(marcasDaRef.get(ref) || [])];
      for (const marca of marcas) {
        const kc = kCor(ref, marca, norm(it.cor));
        if (!out.has(kc)) out.set(kc, it);
        const kr = kRef(ref, marca);
        if (!out.has(kr)) out.set(kr, it);
      }
    }
    return out;
  }

  /**
   * Fornecedor do pedido: o do último pedido daquela marca (é quem a
   * compradora já usou); senão o CNPJ que as peças da marca carregam, com o
   * nome do cadastro de fornecedores; senão a própria marca (o pedido nasce e
   * a compradora corrige o fornecedor no cabeçalho, como já faz hoje).
   */
  private async fornecedorDaMarca(marca: string, prods: any[]): Promise<{ nome: string; cnpj: string | null }> {
    const ultimo: any = await (this.prisma as any).purchaseOrder.findFirst({
      where: { marca, status: { not: 'cancelado' } },
      orderBy: { dataPedido: 'desc' },
      select: { fornecedorNome: true, fornecedorCnpj: true },
    });
    if (ultimo?.fornecedorNome) {
      return { nome: ultimo.fornecedorNome, cnpj: ultimo.fornecedorCnpj || null };
    }
    const cnpj = maisFrequente(prods.map((p) => String(p.fornecedor || '').replace(/\D/g, '')).filter((c) => c.length >= 11));
    if (cnpj) {
      try {
        const lista = await this.erp.listarFornecedores(5000);
        const f = lista.find((x) => String(x.cnpj || '').replace(/\D/g, '') === cnpj);
        if (f?.nome) return { nome: f.nome, cnpj };
      } catch (e: any) {
        this.logger.warn(`[vitalicios] cadastro de fornecedores indisponível: ${e?.message || e}`);
      }
      return { nome: marca, cnpj };
    }
    return { nome: marca, cnpj: null };
  }
}

function maisFrequente(valores: string[]): string {
  const conta = new Map<string, number>();
  for (const v of valores) if (v) conta.set(v, (conta.get(v) || 0) + 1);
  let melhor = '';
  let n = 0;
  for (const [v, c] of conta) {
    if (c > n) {
      melhor = v;
      n = c;
    }
  }
  return melhor;
}

function maior(valores: number[]): number {
  return valores.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0);
}

/**
 * Custo e preço de uma linha do pedido — a MESMA régua na tela e no gerar,
 * senão a tela avisaria "fica fora" de uma cor que o pedido leva (ou o
 * contrário). Custo = o do último pedido PAGO da REF/cor (decisão do dono),
 * senão o do cadastro; preço = o de venda de hoje, senão o do último pedido.
 * Cor sem peça no catálogo usa as peças da REF.
 */
function valoresDaLinha(ult: any, skusDaCor: any[], skusDaRef: any[]): { custo: number | null; preco: number | null } {
  const base = skusDaCor.length ? skusDaCor : skusDaRef;
  const custoUlt = Number(ult?.custoUnit) || 0;
  const precoUlt = Number(ult?.precoUnit) || 0;
  const custo = custoUlt > 0 ? custoUlt : maior(base.map((p) => Number(p.custo) || 0));
  const preco = maior(base.map((p) => Number(p.vendaUn) || 0)) || precoUlt;
  return { custo: custo > 0 ? custo : null, preco: preco > 0 ? preco : null };
}

function arred(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100;
}
