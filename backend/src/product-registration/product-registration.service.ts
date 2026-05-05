import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
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

  /**
   * Reserva um próximo código de grupo (não persiste no Wincred — o grupo
   * só "nasce" quando entra um produto com aquele GRUPO+NOMEGRUPO).
   */
  async reservarGrupo() {
    const codigo = await this.erp.reservarCodigoGrupo();
    return { codigo };
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

    // 3) Insere no Wincred (transação MySQL)
    const result = await this.erp.inserirProdutosBatch(produtos);
    this.logger.log(
      `Cadastro Dinâmico: ref=${input.ref} grupo=${input.grupoCodigo} → ${result.inseridos}/${produtos.length} produtos inseridos`,
    );
    return {
      inseridos: result.inseridos,
      ignorados: result.ignorados,
      total: produtos.length,
      seqInicial: seq.toString(),
      seqFinal: (seq + BigInt(produtos.length - 1)).toString(),
      itens: produtos.map((p) => ({
        codigo: p.codigo,
        descricaoCompleta: p.descricaoCompleta,
        cor: p.cor,
        tamanho: p.tamanho,
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers privados
  // ───────────────────────────────────────────────────────────────────────

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
