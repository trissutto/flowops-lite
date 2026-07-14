import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { ProductSearchService } from '../product-search/product-search.service';
import { generateEan13Batch } from './ean.util';

/**
 * Service do Cadastro Dinâmico de Produtos.
 *
 * Pipeline:
 *  1. Frontend monta o form (grupo, subgrupo, ref, fornecedor, custo, preço,
 *     plus_size, NCM, CFOP, etc.) + lista de cores e tamanhos.
 *  2. /preview: gera matriz cor×tamanho com EANs (sem gravar).
 *  3. /processar: reserva range de EAN-13 (transação na EanSequence),
 *     insere todos no Wincred via ErpService.inserirProdutosBatch.
 */
@Injectable()
export class ProductRegistrationService {
  private readonly logger = new Logger(ProductRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /**
   * Devolve catálogo completo (grupos, subgrupos não — o user escolhe grupo
   * primeiro, daí carrega subgrupos), cores, tamanhos e fornecedores.
   */
  async catalogo() {
    const [grupos, cores, tamanhos, fornecedores] = await Promise.all([
      this.erp.listarGrupos(),
      this.erp.listarCoresDistintas(300),
      this.erp.listarTamanhosDistintos(200),
      this.erp.listarFornecedores(500),
    ]);
    return { grupos, cores, tamanhos, fornecedores };
  }

  async subgruposDoGrupo(grupoCodigo: number) {
    return this.erp.listarSubgrupos(grupoCodigo);
  }

  /** Cria um grupo novo no Wincred (tabela grupos). */
  async criarGrupo(nome: string) {
    return this.erp.inserirGrupo(nome);
  }

  /** Cria um subgrupo novo no Wincred (tabela subgrupos), associado a um grupo. */
  async criarSubgrupo(grupoCodigo: number, nome: string) {
    return this.erp.inserirSubgrupo(grupoCodigo, nome);
  }

  /**
   * Monta a matriz cor×tamanho gerando descrições e EANs PROVISÓRIOS.
   * Não consume nenhum EAN da sequência — os EANs definitivos são gerados
   * só no /processar dentro da transação.
   *
   * Aqui usamos o "próximo seq" só pra exibir uma prévia realista.
   */
  async preview(input: PreviewInput) {
    this.validarInput(input);
    const seq = await this.proximoSeqAtual();
    const linhas = this.expandirCombinacoes(input);
    const eans = generateEan13Batch(seq, linhas.length);
    return {
      seqInicial: seq.toString(),
      total: linhas.length,
      itens: linhas.map((l, i) => ({
        codigo: eans[i],
        descricaoCompleta: this.montarDescricao(input, l.cor, l.tamanho),
        descricaoPdv: this.montarDescricaoPdv(input, l.cor, l.tamanho),
        cor: l.cor,
        tamanho: l.tamanho,
        custo: input.custo,
        precoVenda: input.precoVenda,
        margem: this.calcMargem(input.custo, input.precoVenda),
        ref: input.ref,
      })),
    };
  }

  /**
   * Processa o cadastro: reserva EANs (transação na EanSequence), insere
   * todos os produtos no Wincred numa transação MySQL. Idempotente por
   * CODIGO (INSERT IGNORE).
   */
  async processar(input: ProcessarInput) {
    this.validarInput(input);
    const linhas = this.expandirCombinacoes(input);
    if (!linhas.length) throw new BadRequestException('Nenhuma combinação cor×tamanho gerada.');

    // 1) Reserva o range de EANs em transação (atualiza last_seq atomicamente)
    const seq = await this.reservarRangeSeq(linhas.length);
    const eans = generateEan13Batch(seq, linhas.length);

    // 2) Monta payload pro INSERT no Wincred
    const produtos = linhas.map((l, i) => ({
      codigo: eans[i],
      grupo: input.grupoCodigo,
      nomeGrupo: input.grupoNome,
      subgrupo: input.subgrupoCodigo ?? undefined,
      descricaoCompleta: this.montarDescricao(input, l.cor, l.tamanho),
      descricaoPdv: this.montarDescricaoPdv(input, l.cor, l.tamanho),
      custo: input.custo,
      precoVenda: input.precoVenda,
      margem: this.calcMargem(input.custo, input.precoVenda),
      fornecedor: input.fornecedorCnpj,
      cor: l.cor,
      tamanho: l.tamanho,
      ref: input.ref,
      plusSize: !!input.plusSize,
      ncm: input.ncm,
      cfop: input.cfop,
      tributo: input.tributo,
      marca: input.marca,
      estoqueInicial: 0,
    }));

    // 3) FLOW PRIMEIRO (incidente da live 14/07: produto cadastrado não
    //    aparecia na separação porque só existia no Giga e os espelhos
    //    demoravam 10min-6h). Grava na `product` nativa + espelho
    //    `wincred_produtos` NA HORA — grade da live, bipe e separação
    //    enxergam em segundos, e o cadastro não depende do Giga estar vivo.
    await this.gravarNoFlow(produtos);

    // 4) Réplica pro Giga: tenta inline (best effort); se o Giga estiver
    //    pendurado/fora, enfileira no erp_outbox (kind produto_cadastro,
    //    INSERT IGNORE = retry idempotente) e o cadastro NÃO trava.
    let inseridos = produtos.length;
    let ignorados = 0;
    let gigaEnfileirado = false;
    try {
      const result = await this.erp.inserirProdutosBatch(produtos);
      inseridos = result.inseridos;
      ignorados = result.ignorados;
    } catch (e) {
      gigaEnfileirado = true;
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'produto_cadastro',
          saleId: `cad-${randomUUID()}`,
          payload: { produtos },
          status: 'pending',
        },
      });
      this.logger.warn(
        `Cadastro Dinâmico: Giga indisponível (${(e as Error).message}) — réplica enfileirada no outbox (ref=${input.ref})`,
      );
    }
    this.logger.log(
      `Cadastro Dinâmico: ref=${input.ref} grupo=${input.grupoCodigo} → ${produtos.length} no Flow` +
        (gigaEnfileirado ? ' + Giga via outbox' : ` + ${inseridos} no Giga`),
    );

    // 4) ESPELHO IMEDIATO (14/07, caso VOGUE BEGE na live): sem isso, a peça
    // recém-cadastrada só aparecia na busca da live/PDV depois da corrente de
    // syncs (espelho 10min → nativa no minuto 38 — até ~1h de espera). Semeia
    // as três cópias do Postgres AGORA; os syncs seguintes só confirmam.
    // Falha aqui NUNCA desfaz o cadastro (o Giga é a fonte) — só loga.
    try {
      await this.espelhoImediato(produtos);
      this.logger.log(`Cadastro Dinâmico: ${produtos.length} produto(s) espelhados na hora (wincred+giga+nativa)`);
    } catch (e) {
      this.logger.warn(`Cadastro Dinâmico: espelho imediato falhou (syncs normais cobrem): ${(e as Error).message}`);
    }
    return {
      inseridos,
      ignorados,
      total: produtos.length,
      seqInicial: seq.toString(),
      seqFinal: (seq + BigInt(produtos.length - 1)).toString(),
      gigaEnfileirado,
      itens: produtos.map((p) => ({
        codigo: p.codigo,
        descricaoCompleta: p.descricaoCompleta,
        cor: p.cor,
        tamanho: p.tamanho,
      })),
    };
  }

  /**
   * Write-through do cadastro no Flow: `product` nativa (flowIsSource — o sync
   * nunca sobrescreve) + espelho `wincred_produtos` (bipe/busca/separação leem
   * daqui). O EAN prefixo 8 É o próprio código.
   */
  private async gravarNoFlow(
    produtos: Array<{
      codigo: string; grupo: number; nomeGrupo: string; subgrupo?: number;
      descricaoCompleta: string; descricaoPdv?: string; custo: number;
      precoVenda: number; margem: number; fornecedor: string; cor: string;
      tamanho: string; ref: string; plusSize: boolean; ncm?: string;
      cfop?: number; tributo?: string; marca?: string;
    }>,
  ): Promise<void> {
    const hoje = new Date();
    for (const p of produtos) {
      const base = {
        grupo: p.grupo,
        nomeGrupo: p.nomeGrupo?.slice(0, 30) || null,
        descricaoPdv: p.descricaoPdv?.slice(0, 50) || null,
        descricaoCompleta: p.descricaoCompleta?.slice(0, 100) || null,
        custo: p.custo,
        vendaUn: p.precoVenda,
        fornecedor: p.fornecedor?.slice(0, 18) || null,
        estoque: 0,
        margem: p.margem,
        dataAlt: hoje,
        subgrupo: p.subgrupo ?? null,
        cor: p.cor?.slice(0, 15) || null,
        tamanho: p.tamanho?.slice(0, 20) || null,
        marca: p.marca?.slice(0, 30) || null,
        ref: p.ref?.slice(0, 10) || null,
        ncm: p.ncm?.slice(0, 8) || null,
        tributo: p.tributo?.slice(0, 4) || null,
        plusSize: p.plusSize ? 1 : 0,
        ean: p.codigo,
      };
      await (this.prisma as any).product.upsert({
        where: { codigo: p.codigo },
        create: {
          codigo: p.codigo, ...base, cfop: p.cfop ?? null,
          liveOk: !!p.plusSize, ativo: true,
          flowIsSource: true, editedAt: hoje,
        },
        update: { ...base, cfop: p.cfop ?? null, flowIsSource: true, editedAt: hoje },
      }).catch((e: any) => this.logger.warn(`gravarNoFlow product ${p.codigo}: ${e?.message}`));
      await (this.prisma as any).wincredProduto.upsert({
        where: { codigo: p.codigo },
        create: { codigo: p.codigo, ...base },
        update: base,
      }).catch((e: any) => this.logger.warn(`gravarNoFlow espelho ${p.codigo}: ${e?.message}`));
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers privados
  // ───────────────────────────────────────────────────────────────────────

  /** Tamanhos aceitos na live — mesma whitelist do LivePdvService/nativa. */
  private static readonly LIVE_TAMANHOS = new Set([
    '46', '48', '50', '52', '54', '56', '58', '60', '46/48', '50/52',
  ]);

  /**
   * ESPELHO IMEDIATO (14/07): grava o cadastro novo nas TRÊS cópias do
   * Postgres (wincred_produtos, giga_produto e a nativa `product`), com as
   * MESMAS regras de curadoria do ProductNativeService (genero/liveOk). A
   * peça recém-cadastrada aparece na busca da live/PDV na hora, sem esperar
   * a corrente de syncs. Idempotente: upsert por codigo; linha nativa com
   * flowIsSource=true nunca é sobrescrita.
   */
  private async espelhoImediato(
    produtos: Array<{
      codigo: string;
      grupo: number;
      nomeGrupo: string;
      subgrupo?: number;
      descricaoCompleta: string;
      descricaoPdv: string;
      custo: number;
      precoVenda: number;
      margem: number;
      fornecedor: string;
      cor: string;
      tamanho: string;
      ref: string;
      plusSize: boolean;
      ncm?: string;
      cfop?: number | string;
      tributo?: string;
      marca?: string;
    }>,
  ) {
    const p: any = this.prisma;
    const hoje = new Date();
    for (const item of produtos) {
      const codigo = String(item.codigo).trim();
      const desc = item.descricaoCompleta || '';
      const plus = item.plusSize ? 1 : 0;
      const cfop = item.cfop != null && String(item.cfop).trim() !== '' ? Number(item.cfop) : null;
      const tam = String(item.tamanho || '').trim();
      const mascInf = /MASCULIN|INFANTIL/i.test(desc);
      const liveOk =
        plus === 1 && !mascInf && (!tam || ProductRegistrationService.LIVE_TAMANHOS.has(tam));

      const base = {
        grupo: item.grupo ?? null,
        nomeGrupo: item.nomeGrupo || null,
        descricaoPdv: item.descricaoPdv || null,
        descricaoCompleta: desc || null,
        custo: item.custo ?? null,
        vendaUn: item.precoVenda ?? null,
        fornecedor: item.fornecedor || null,
        estoque: 0,
        margem: item.margem ?? null,
        dataAlt: hoje,
        subgrupo: item.subgrupo ?? null,
        cor: item.cor || null,
        tamanho: tam || null,
        marca: item.marca || null,
        ref: item.ref || null,
        ncm: item.ncm || null,
        tributo: item.tributo || null,
        plusSize: plus,
      };

      // 1) Espelho Wincred (PK codigo) — upsert direto.
      await p.wincredProduto.upsert({
        where: { codigo },
        create: { codigo, ...base },
        update: base,
      });

      // 2) Espelho giga_produto (sem unique em codigo) — delete + create.
      await p.gigaProduto.deleteMany({ where: { codigo } });
      await p.gigaProduto.create({
        data: {
          codigo,
          ref: item.ref || null,
          refBase: item.ref ? ProductSearchService.refBaseOf(item.ref) : null,
          descricao: desc || null,
          cor: item.cor || null,
          tamanho: tam || null,
          grupo: item.nomeGrupo || null,
          ncm: item.ncm || null,
          vendaUn: item.precoVenda ?? null,
        },
      });

      // 3) Tabela NATIVA `product` — respeita flowIsSource (nunca sobrescreve).
      const existente = await p.product.findUnique({ where: { codigo }, select: { flowIsSource: true } });
      const nativa = {
        ...base,
        cfop,
        ean: null,
        genero: mascInf ? (/MASCULIN/i.test(desc) ? 'MASCULINO' : 'INFANTIL') : plus === 1 ? 'FEMININO' : null,
        liveOk,
        ativo: true,
      };
      if (!existente) {
        await p.product.create({ data: { codigo, ...nativa } });
      } else if (!existente.flowIsSource) {
        await p.product.update({ where: { codigo }, data: nativa });
      }
    }
  }

  private validarInput(input: PreviewInput) {
    if (!input.grupoCodigo) throw new BadRequestException('Grupo é obrigatório.');
    if (!input.grupoNome) throw new BadRequestException('Nome do grupo é obrigatório.');
    if (!input.ref) throw new BadRequestException('Referência é obrigatória.');
    if (!input.fornecedorCnpj) throw new BadRequestException('Fornecedor é obrigatório.');
    if (!input.custo || input.custo <= 0) throw new BadRequestException('Custo inválido.');
    if (!input.precoVenda || input.precoVenda <= 0) throw new BadRequestException('Preço de venda inválido.');
    if (!input.cores?.length) throw new BadRequestException('Selecione ao menos 1 cor.');
    if (!input.tamanhos?.length) throw new BadRequestException('Selecione ao menos 1 tamanho.');
  }

  private expandirCombinacoes(input: PreviewInput): Array<{ cor: string; tamanho: string }> {
    const out: Array<{ cor: string; tamanho: string }> = [];
    for (const cor of input.cores) {
      const c = String(cor || '').trim();
      if (!c) continue;
      for (const tamanho of input.tamanhos) {
        const t = String(tamanho || '').trim();
        if (!t) continue;
        out.push({ cor: c, tamanho: t });
      }
    }
    return out;
  }

  private montarDescricao(input: PreviewInput, cor: string, tamanho: string): string {
    // Formato igual ao Wincred: GRUPO + SUBGRUPO + PLUS_SIZE + REF + COR + TAMANHO + FORNECEDOR
    // Ex: VESTIDO LONGO MANGA 3/4 PLUS SIZE 13050 PRETO 46 PREDILECTS
    const partes = [
      input.grupoNome,
      input.subgrupoNome,
      input.plusSize ? 'PLUS SIZE' : '',
      input.ref,
      cor,
      tamanho,
      input.fornecedorNome,
    ];
    return partes.filter((p) => p && String(p).trim()).join(' ').toUpperCase().slice(0, 100);
  }

  private montarDescricaoPdv(input: PreviewInput, cor: string, tamanho: string): string {
    // Versão curta pra PDV (max 50 chars)
    const partes = [input.grupoNome, input.ref, cor, tamanho];
    return partes.filter((p) => p && String(p).trim()).join(' ').toUpperCase().slice(0, 50);
  }

  private calcMargem(custo: number, preco: number): number {
    if (!custo || custo <= 0) return 0;
    return Math.round(((preco - custo) / custo) * 10000) / 100;
  }

  /**
   * Lê o lastSeq atual sem incrementar. Usado pelo /preview pra mostrar
   * EANs realistas, mas SEM consumir.
   */
  private async proximoSeqAtual(): Promise<bigint> {
    const row = await (this.prisma as any).eanSequence.findFirst({ where: { id: 1 } });
    const last = row?.lastSeq ? BigInt(row.lastSeq) : 0n;
    return last + 1n;
  }

  /**
   * Reserva um range de N seqs atomicamente. Usa upsert + retorno do
   * lastSeq antigo. Todas inserções pegam seqs distintos mesmo se rodar
   * em paralelo.
   */
  private async reservarRangeSeq(n: number): Promise<bigint> {
    if (n <= 0) throw new Error('reservarRangeSeq: n precisa ser > 0');
    const row = await (this.prisma as any).$transaction(async (tx: any) => {
      const cur = await tx.eanSequence.findFirst({ where: { id: 1 } });
      const lastBefore = cur?.lastSeq ? BigInt(cur.lastSeq) : 0n;
      const lastAfter = lastBefore + BigInt(n);
      if (cur) {
        await tx.eanSequence.update({
          where: { id: cur.id },
          data: { lastSeq: lastAfter },
        });
      } else {
        await tx.eanSequence.create({
          data: { prefix: '8', lastSeq: lastAfter },
        });
      }
      return { startSeq: lastBefore + 1n };
    });
    return row.startSeq;
  }
}

// ════════════════════════════════════════════════════════════════════════
// Tipos do contrato HTTP
// ════════════════════════════════════════════════════════════════════════

export interface PreviewInput {
  grupoCodigo: number;
  grupoNome: string;
  subgrupoCodigo?: number;
  subgrupoNome?: string;
  ref: string;
  fornecedorCnpj: string;
  fornecedorNome?: string;
  custo: number;
  precoVenda: number;
  plusSize?: boolean;
  ncm?: string;
  cfop?: number;
  tributo?: string;
  marca?: string;
  cores: string[];
  tamanhos: string[];
}

export type ProcessarInput = PreviewInput;
