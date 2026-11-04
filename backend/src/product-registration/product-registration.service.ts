import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { ProductSearchService } from '../product-search/product-search.service';
import { generateEan13Batch } from './ean.util';
import {
  codigoDoCadastroPeloCodigoDeBarras,
  mesmaPeca,
  normalizarCodigoBarras,
} from '../common/codigo-barras-fornecedor';

/**
 * Service do Cadastro Dinâmico de Produtos.
 *
 * Pipeline:
 *  1. Frontend monta o form (grupo, subgrupo, ref, fornecedor, custo, preço,
 *     plus_size, NCM, CFOP, etc.) + lista de cores e tamanhos.
 *  2. /preview: gera matriz cor×tamanho com EANs (sem gravar).
 *  3. /processar: reserva range de EAN-13 (transação na EanSequence) pra
 *     cada SKU que NÃO trouxe código de barras lido, grava na `product`
 *     nativa + espelho `wincred_produtos` (o Flow é a fonte) e enfileira a
 *     réplica do ERP morto no outbox (descartada com motivo).
 *
 * CÓDIGO DE BARRAS LIDO = CÓDIGO (04/11/2026, dono): quando a compra entra
 * com "código de barras próprio", o SKU nasce com o código LIDO como
 * `codigo` (e `ean`) — não mais EAN-13 do Flow + lido só no `ean`, que fazia
 * o editor mostrar o 8000… e o dono trocar peça por peça. Régua em
 * `common/codigo-barras-fornecedor.ts` (`codigoDoCadastroPeloCodigoDeBarras`);
 * a conferência contra o banco é `conferirCodigosLidos`, abaixo.
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
  async processar(input: ProcessarInput, opts?: { gigaAsync?: boolean }) {
    this.validarInput(input);
    const linhas = this.expandirCombinacoes(input);
    if (!linhas.length) throw new BadRequestException('Nenhuma combinação cor×tamanho gerada.');

    // 1) CÓDIGO DE BARRAS LIDO = CÓDIGO (04/11/2026, dono). Cada linha que
    //    trouxe um código lido que serve de CÓDIGO nasce com ele; as outras
    //    recebem EAN-13 do Flow. Confere no banco ANTES de reservar sequência
    //    ou escrever: código de OUTRA peça é recusa honesta (nunca upsert por
    //    cima de cadastro alheio); código da MESMA peça (segunda compra) é
    //    reaproveitado — volta em `itens` sem regravar.
    const linhasComCodigo = linhas.map((l) => {
      const lido = normalizarCodigoBarras(input.eans?.[`${l.cor}|${l.tamanho}`]) || null;
      return { ...l, lido, codigoLido: lido ? codigoDoCadastroPeloCodigoDeBarras(lido) : null };
    });
    const reaproveitados = await this.conferirCodigosLidos(linhasComCodigo, input);

    // 2) Reserva o range de EANs do Flow SÓ pra quem não trouxe código
    //    (atualiza last_seq atomicamente). Sem ninguém, não consome sequência.
    const semCodigo = linhasComCodigo.filter((l) => !l.codigoLido).length;
    const seq = semCodigo > 0 ? await this.reservarRangeSeq(semCodigo) : null;
    const eans = seq != null ? generateEan13Batch(seq, semCodigo) : [];
    let proximoEan = 0;

    // 3) Monta payload do cadastro
    const todos = linhasComCodigo.map((l) => ({
      codigo: l.codigoLido ?? eans[proximoEan++],
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
      // Código de barras lido (se a compra pediu): é o próprio CÓDIGO quando
      // serve de código; senão (15+ caracteres) fica só no `ean`, como antes.
      ean: l.lido || undefined,
      codigoLido: !!l.codigoLido,
      reaproveitado: !!l.codigoLido && reaproveitados.has(l.codigoLido),
    }));
    // Peça que JÁ existe com esse código (segunda compra) não é regravada —
    // o cadastro dela é do editor. Só entra na resposta.
    const produtos = todos.filter((p) => !p.reaproveitado);

    // 4) FLOW PRIMEIRO (incidente da live 14/07: produto cadastrado não
    //    aparecia na separação porque só existia no Giga e os espelhos
    //    demoravam 10min-6h). Grava na `product` nativa + espelho
    //    `wincred_produtos` NA HORA — grade da live, bipe e separação
    //    enxergam em segundos, e o cadastro não depende do Giga estar vivo.
    await this.gravarNoFlow(produtos);

    // 5) Réplica pro Giga: tenta inline (best effort); se o Giga estiver
    //    pendurado/fora, enfileira no erp_outbox (kind produto_cadastro,
    //    INSERT IGNORE = retry idempotente) e o cadastro NÃO trava.
    //    gigaAsync=true (fluxo em LOTE, ex: recebimento de compra): NÃO tenta
    //    inline — enfileira direto pra não pendurar a tela no Giga lento.
    let inseridos = produtos.length;
    let ignorados = reaproveitados.size;
    let gigaEnfileirado = false;
    if (!produtos.length) {
      // Tudo reaproveitado (a peça já existia com o código lido): nada a
      // gravar, nada a replicar.
    } else if (opts?.gigaAsync) {
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'produto_cadastro',
          saleId: `cad-${randomUUID()}`,
          payload: { produtos },
          status: 'pending',
        },
      });
      gigaEnfileirado = true;
      this.logger.log(
        `Cadastro Dinâmico: ref=${input.ref} — réplica Giga enfileirada no outbox (modo assíncrono/lote)`,
      );
    } else {
      try {
        const result = await this.erp.inserirProdutosBatch(produtos);
        inseridos = result.inseridos;
        ignorados += result.ignorados;
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
    }
    const nascidosComLido = produtos.filter((p) => p.codigoLido).length;
    this.logger.log(
      `Cadastro Dinâmico: ref=${input.ref} grupo=${input.grupoCodigo} → ${produtos.length} no Flow` +
        (nascidosComLido ? ` (${nascidosComLido} com o código de barras lido como CÓDIGO)` : '') +
        (reaproveitados.size ? ` + ${reaproveitados.size} já existia(m) com o código lido` : '') +
        (gigaEnfileirado ? ' + Giga via outbox' : produtos.length ? ` + ${inseridos} no Giga` : ''),
    );

    // 6) ESPELHO IMEDIATO (14/07, caso VOGUE BEGE na live): sem isso, a peça
    // recém-cadastrada só aparecia na busca da live/PDV depois da corrente de
    // syncs (espelho 10min → nativa no minuto 38 — até ~1h de espera). Semeia
    // as três cópias do Postgres AGORA; os syncs seguintes só confirmam.
    // Falha aqui NUNCA desfaz o cadastro (o Giga é a fonte) — só loga.
    if (produtos.length) {
      try {
        await this.espelhoImediato(produtos);
        this.logger.log(`Cadastro Dinâmico: ${produtos.length} produto(s) espelhados na hora (wincred+giga+nativa)`);
      } catch (e) {
        this.logger.warn(`Cadastro Dinâmico: espelho imediato falhou (syncs normais cobrem): ${(e as Error).message}`);
      }
    }
    return {
      inseridos,
      ignorados,
      total: todos.length,
      // null quando nenhuma linha precisou de EAN do Flow (todas com código lido)
      seqInicial: seq != null ? seq.toString() : null,
      seqFinal: seq != null ? (seq + BigInt(semCodigo - 1)).toString() : null,
      gigaEnfileirado,
      itens: todos.map((p) => ({
        codigo: p.codigo,
        descricaoCompleta: p.reaproveitado
          ? reaproveitados.get(p.codigo)?.descricaoCompleta || p.descricaoCompleta
          : p.descricaoCompleta,
        cor: p.cor,
        tamanho: p.tamanho,
        ean: p.ean || p.codigo,
        /** true = a peça já existia com o código lido e entrou nela, sem cadastro novo */
        reaproveitado: p.reaproveitado,
      })),
    };
  }

  /**
   * CÓDIGO LIDO VIRA CÓDIGO — a conferência no banco, ANTES de qualquer
   * escrita (04/11/2026). O `gravarNoFlow` é upsert por código: com EAN-13 do
   * Flow o código é sempre novo, mas o lido pode já existir — e upsert por
   * cima de cadastro alheio fundiria duas peças (a família que o
   * `trocarCodigo` recusa). Regra de ouro: erro honesto que SOBE.
   *
   *  - o mesmo código lido em duas linhas deste lote → recusa;
   *  - código já no cadastro (`product`/`wincred_produtos`) da MESMA peça
   *    (REF+COR+TAM, `mesmaPeca`) → reaproveita: não regrava (o cadastro dela
   *    é do editor), mas entra na resposta — segunda compra: estoque e
   *    etiqueta seguem no código que existe;
   *  - código já no cadastro de OUTRA peça → recusa com o nome dela;
   *  - código sem cadastro mas com saldo (giga_estoque, wincred_estoque,
   *    stock) → recusa: cadastrar nele adotaria saldo de peça desconhecida.
   *
   * Devolve os códigos reaproveitados (código → o cadastro que existe).
   */
  private async conferirCodigosLidos(
    linhas: Array<{ cor: string; tamanho: string; lido: string | null; codigoLido: string | null }>,
    input: PreviewInput,
  ): Promise<Map<string, { descricaoCompleta: string }>> {
    const p: any = this.prisma;
    const reaproveitados = new Map<string, { descricaoCompleta: string }>();
    const vistos = new Map<string, string>();
    const select = { codigo: true, ref: true, cor: true, tamanho: true, descricaoCompleta: true };
    for (const l of linhas) {
      if (!l.codigoLido) continue;
      const onde = `${input.ref} ${l.cor} ${l.tamanho}`;
      const dono = vistos.get(l.codigoLido);
      if (dono) {
        throw new BadRequestException(
          `${onde}: o código de barras ${l.lido} já foi lido em ${dono} neste cadastro — cada tamanho tem o seu`,
        );
      }
      vistos.set(l.codigoLido, onde);

      const existente =
        (await p.product.findUnique({ where: { codigo: l.codigoLido }, select })) ??
        (await p.wincredProduto.findUnique({ where: { codigo: l.codigoLido }, select }));
      if (existente) {
        if (mesmaPeca(existente, { ref: input.ref, cor: l.cor, tamanho: l.tamanho })) {
          reaproveitados.set(l.codigoLido, { descricaoCompleta: String(existente.descricaoCompleta || '') });
          continue;
        }
        const nome = String(existente.descricaoCompleta || '').trim();
        throw new BadRequestException(
          `${onde}: o código de barras ${l.lido} já é o código da peça ${existente.codigo}` +
            (nome ? ` (${nome})` : '') +
            ` — bipe a etiqueta certa`,
        );
      }

      const [ge, we, st] = await Promise.all([
        p.gigaEstoque.count({ where: { codigo: l.codigoLido } }),
        p.wincredEstoque.count({ where: { codigo: l.codigoLido } }),
        p.stock.count({ where: { sku: l.codigoLido } }),
      ]);
      if (ge + we + st > 0) {
        throw new BadRequestException(
          `${onde}: o código ${l.codigoLido} não tem cadastro mas já tem estoque de outra peça — não dá pra cadastrar por cima`,
        );
      }
    }
    return reaproveitados;
  }

  /**
   * Write-through do cadastro no Flow: `product` nativa (flowIsSource — o sync
   * nunca sobrescreve) + espelho `wincred_produtos` (bipe/busca/separação leem
   * daqui). O EAN prefixo 8 É o próprio código. Com código de barras lido
   * (`ean` no payload) o normal desde 04/11 é `codigo` = `ean` = o lido; só o
   * lido que não cabe na coluna `codigo` fica apenas no `ean`, e nesse caso é
   * por ela que o bipe acha a peça.
   */
  private async gravarNoFlow(
    produtos: Array<{
      codigo: string; grupo: number; nomeGrupo: string; subgrupo?: number;
      descricaoCompleta: string; descricaoPdv?: string; custo: number;
      precoVenda: number; margem: number; fornecedor: string; cor: string;
      tamanho: string; ref: string; plusSize: boolean; ncm?: string;
      cfop?: number; tributo?: string; marca?: string; ean?: string;
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
        ean: p.ean || p.codigo,
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
  /**
   * CÓDIGO DE BARRAS DO FORNECEDOR por SKU, chave `COR|TAMANHO` (15/10/2026,
   * compra com "código de barras próprio"). Quando vem, a peça NASCE COM ELE
   * COMO CÓDIGO (e `ean`) — ordem do dono de 04/11/2026; antes o CÓDIGO era o
   * EAN-13 do Flow e o lido ficava só no `ean`, e o editor mostrava o 8000….
   * Lido que não serve de código (15–20 caracteres) ainda cai nesse modo
   * antigo. Sem `eans`, `ean` = o próprio código, como sempre. Quem confere o
   * que o leitor mandou é `common/codigo-barras-fornecedor.ts`, ANTES de
   * chegar aqui; quem confere que o código não é de OUTRA peça é o
   * `processar`, no banco (`conferirCodigosLidos`).
   */
  eans?: Record<string, string>;
}

export type ProcessarInput = PreviewInput;
