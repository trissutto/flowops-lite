import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';

/**
 * DEFEITOS — peça avariada sai do estoque da loja e vai pra matriz (CD).
 *
 * ── POR QUE NÃO É MARCADO ──
 *
 * Até 14/08/2026 o defeito virava um `Marcado` com status='baixado' (o
 * próprio schema descreve: "write-off SEM financeiro/estoque — defeito,
 * furto, perda"). Só que marcado é DÍVIDA DE CLIENTE: entra no
 * LIMITECOMPRAS, aparece na lista de marcados ativos e é validado contra a
 * avaliação do cliente. Defeito é PERDA DE MERCADORIA e não tem cliente.
 * Misturar os dois sujava os dois controles e tornava impossível um
 * relatório de perdas confiável.
 *
 * ── A REGRA CENTRAL ──
 *
 * A peça baixa do estoque UMA vez, no registro na loja, e nunca reentra.
 * Como ela não volta pra vitrine (vai pro fornecedor ou pro lixo), a matriz
 * ao receber a caixa NÃO movimenta estoque: só confirma a chegada. É isso
 * que impede peça defeituosa de voltar a ser vendida — e dispensa qualquer
 * "depósito de defeitos" com estoque paralelo.
 *
 * A baixa usa `decreaseStockAsync`: aplica no Flow (fonte do estoque desde
 * 14/07) e enfileira a réplica pro Giga no outbox, sem pendurar a tela no
 * MySQL lento da KingHost. Idempotência por `stockDecreasedAt`.
 */

/** Motivos aprovados pelo dono em 14/08. OUTRO exige observação. */
export const MOTIVOS_DEFEITO = [
  'FURO_RASGO',
  'MANCHA',
  'COSTURA_SOLTA',
  'ZIPER_BOTAO',
  'DESBOTADO',
  'FALTA_PECA',
  'MODELAGEM_ERRADA',
  'OUTRO',
] as const;
export type MotivoDefeito = (typeof MOTIVOS_DEFEITO)[number];

export const STATUS_DEFEITO = {
  EM_TRANSITO: 'EM_TRANSITO',
  RECEBIDO: 'RECEBIDO',
  DEVOLVIDO_FORNECEDOR: 'DEVOLVIDO_FORNECEDOR',
  DESCARTADO: 'DESCARTADO',
} as const;

@Injectable()
export class DefeitosService {
  private readonly logger = new Logger(DefeitosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly catalog: WincredCatalogService,
  ) {}

  /** Loja que recebe todos os defeitos (centro de distribuição). */
  private get lojaMatriz(): string {
    return process.env.PRIMARY_STORE_CODE || '01';
  }

  // ── Códigos humanos ─────────────────────────────────────────────────

  /**
   * `DEF-2026-000123` / `CX-2026-000045`, sequenciais por ano.
   *
   * Calcula pelo MAIOR código existente do ano, nunca por `count()` — se uma
   * linha for removida, o count repetiria um número já usado e o INSERT
   * quebraria no unique. Mesmo algoritmo do `generateShipmentCode` do
   * realinhamento. O padding de 6 zeros faz ordenação alfabética == numérica.
   */
  private async gerarCodigo(
    tabela: 'defectItem' | 'defectBatch',
    prefixo: 'DEF' | 'CX',
    suffix = 0,
  ): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `${prefixo}-${year}-`;
    const last = await (this.prisma as any)[tabela].findFirst({
      where: { code: { startsWith: prefix } },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    let lastNum = 0;
    if (last?.code) {
      const m = String(last.code).match(/-(\d+)$/);
      if (m) lastNum = parseInt(m[1], 10) || 0;
    }
    return `${prefix}${String(lastNum + 1 + suffix).padStart(6, '0')}`;
  }

  // ── Caixa (DefectBatch) ─────────────────────────────────────────────

  /**
   * Caixa ABERTA da loja, criando se não existir. Uma por loja de cada vez:
   * o registro de defeito cai nela sem a vendedora precisar pensar em caixa.
   * Retry por sufixo cobre duas vendedoras registrando ao mesmo tempo.
   */
  private async caixaAbertaDaLoja(storeCode: string, storeName?: string | null) {
    const existente = await (this.prisma as any).defectBatch.findFirst({
      where: { storeCodeOrigem: storeCode, status: 'aberta' },
      orderBy: { createdAt: 'desc' },
    });
    if (existente) return existente;

    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await (this.prisma as any).defectBatch.create({
          data: {
            code: await this.gerarCodigo('defectBatch', 'CX', attempt),
            storeCodeOrigem: storeCode,
            storeNameOrigem: storeName || null,
            status: 'aberta',
          },
        });
      } catch (e: any) {
        lastErr = e;
        // P2002 = corrida no unique do code; qualquer outro erro é real.
        if (e?.code !== 'P2002') throw e;
        // Outra vendedora pode ter criado a caixa entre o find e o create.
        const agora = await (this.prisma as any).defectBatch.findFirst({
          where: { storeCodeOrigem: storeCode, status: 'aberta' },
        });
        if (agora) return agora;
      }
    }
    throw lastErr;
  }

  // ── Registro do defeito ─────────────────────────────────────────────

  /**
   * Resolve a peça pelo código bipado. Usa o mesmo caminho do bipe do PDV
   * (espelho primeiro, Giga ao vivo como fallback) e completa com fornecedor
   * e marca — que só existem no espelho e são o eixo do agrupamento da
   * devolução.
   */
  private async resolverPeca(skuOuEan: string) {
    const info = await this.catalog.getPdvProductInfo(skuOuEan);
    if (!info) return null;

    let fornecedorCnpj: string | null = null;
    let marca: string | null = null;
    try {
      const p: any = await (this.prisma as any).wincredProduto.findUnique({
        where: { codigo: String(info.sku).replace(/^0+/, '') },
        select: { fornecedor: true, marca: true },
      });
      fornecedorCnpj = p?.fornecedor ? String(p.fornecedor).trim() : null;
      marca = p?.marca ? String(p.marca).trim() : null;
    } catch {
      // Espelho indisponível não impede registrar o defeito — sem fornecedor
      // a peça cai no grupo "sem fornecedor" da fila de decisão.
    }
    return { ...info, fornecedorCnpj, marca };
  }

  /** Cache CNPJ (só dígitos) → nome. Fornecedor muda raramente; recarrega a cada 1h. */
  private fornecedorCache: Map<string, string> | null = null;
  private fornecedorCacheAt = 0;

  /**
   * Nome do fornecedor pelo CNPJ, pra fila de decisão não mostrar só número.
   *
   * Lê do ESPELHO (`wincred_fornecedores`), nunca do Giga ao vivo: isto roda
   * a cada peça bipada e o MySQL da KingHost não pode entrar no caminho do
   * bipe. Em cache de 1h porque são ~2 mil fornecedores e varrer a tabela a
   * cada peça registrada seria desperdício puro.
   *
   * A chave é só os DÍGITOS: o CNPJ vem formatado numa tabela e cru na
   * outra, e comparar a string literal devolveria vazio sempre.
   *
   * Sem espelho, o registro segue só com o CNPJ — a fila agrupa igual.
   */
  private async nomeFornecedor(cnpj: string | null): Promise<string | null> {
    const digitos = String(cnpj || '').replace(/\D/g, '');
    if (!digitos) return null;

    const UMA_HORA = 3600_000;
    if (!this.fornecedorCache || Date.now() - this.fornecedorCacheAt > UMA_HORA) {
      try {
        const todos: any[] = await (this.prisma as any).wincredFornecedor.findMany({
          select: { cnpj: true, razaoSocial: true, fantasia: true },
        });
        const mapa = new Map<string, string>();
        for (const f of todos) {
          const d = String(f.cnpj || '').replace(/\D/g, '');
          const nome = (f.fantasia || f.razaoSocial || '').trim();
          if (d && nome) mapa.set(d, nome);
        }
        this.fornecedorCache = mapa;
        this.fornecedorCacheAt = Date.now();
      } catch {
        return null; // espelho fora — segue sem o nome
      }
    }
    return this.fornecedorCache.get(digitos) || null;
  }

  /**
   * REGISTRA a peça com defeito: baixa o estoque da loja e devolve o número
   * de controle.
   *
   * Ordem importa: cria o registro, baixa o estoque e só então marca
   * `stockDecreasedAt`. Se a baixa falhar, o registro é apagado — não existe
   * defeito "meio registrado" com estoque intacto, que é o que faria a peça
   * continuar vendável.
   *
   * `origem='MATRIZ'` nasce RECEBIDO e sem caixa: não há transporte.
   */
  async registrar(input: {
    sku: string;
    motivo: string;
    observacao?: string | null;
    fotoUrl?: string | null;
    storeCode: string;
    storeName?: string | null;
    origem?: 'LOJA' | 'DEVOLUCAO_CLIENTE' | 'MATRIZ';
    returnId?: string | null;
    userId?: string | null;
    userName?: string | null;
    isTraining?: boolean;
  }) {
    const sku = String(input.sku || '').trim();
    if (!sku) throw new BadRequestException('Código da peça obrigatório');
    if (!input.storeCode) throw new BadRequestException('Loja obrigatória');

    const motivo = String(input.motivo || '').trim().toUpperCase();
    if (!(MOTIVOS_DEFEITO as readonly string[]).includes(motivo)) {
      throw new BadRequestException(`Motivo inválido: ${motivo}`);
    }
    const observacao = String(input.observacao || '').trim();
    if (motivo === 'OUTRO' && observacao.length < 3) {
      throw new BadRequestException('Motivo OUTRO exige descrever o defeito');
    }

    // Peça inexistente não pode virar defeito: estragaria o relatório de
    // perdas e a devolução ao fornecedor.
    const peca = await this.resolverPeca(sku);
    if (!peca) {
      throw new BadRequestException(
        `Peça ${sku} não encontrada no cadastro. Confira o código da etiqueta.`,
      );
    }

    const origem = input.origem || 'LOJA';
    const naMatriz = origem === 'MATRIZ' || input.storeCode === this.lojaMatriz;

    // Caixa só existe pra peça que precisa viajar.
    const caixa = naMatriz
      ? null
      : await this.caixaAbertaDaLoja(input.storeCode, input.storeName);

    const criado = await this.criarComRetry({
      sku: peca.sku,
      ref: peca.ref,
      descricao: peca.descricao,
      cor: peca.cor,
      tamanho: peca.tamanho,
      fornecedorCnpj: peca.fornecedorCnpj,
      fornecedorNome: await this.nomeFornecedor(peca.fornecedorCnpj),
      marca: peca.marca,
      custoUnitCents: Math.round(Number(peca.custo || 0) * 100),
      precoUnitCents: Math.round(Number(peca.preco || 0) * 100),
      storeCodeOrigem: input.storeCode,
      storeNameOrigem: input.storeName || null,
      origem,
      motivo,
      observacao: observacao || null,
      fotoUrl: input.fotoUrl || null,
      status: naMatriz ? STATUS_DEFEITO.RECEBIDO : STATUS_DEFEITO.EM_TRANSITO,
      recebidoAt: naMatriz ? new Date() : null,
      recebidoPorNome: naMatriz ? input.userName || null : null,
      registradoPorUserId: input.userId || null,
      registradoPorNome: input.userName || null,
      batchId: caixa?.id || null,
      returnId: input.returnId || null,
      isTraining: !!input.isTraining,
    });

    // ── Baixa de estoque ──
    // Treino NUNCA toca estoque real (mesma trava do PDV e do recebimento).
    if (input.isTraining) {
      this.logger.log(`[defeitos] ${criado.code} é TREINO — pulando baixa de estoque`);
    } else {
      try {
        // allowNegative: peça com defeito real precisa sair mesmo com o
        // estoque desencontrado — a divergência aparece no relatório em vez
        // de travar a loja com a peça na mão.
        const r = await (this.erp as any).decreaseStockAsync?.(
          [{ sku: peca.sku, qty: 1, storeCode: input.storeCode }],
          { allowNegative: true, skipNotFound: true },
        );
        if (r && r.success === false) throw new Error(r.error || 'baixa recusada');
        await (this.prisma as any).defectItem.update({
          where: { id: criado.id },
          data: { stockDecreasedAt: new Date() },
        });
      } catch (e: any) {
        // Sem baixa não existe defeito registrado — senão a peça continuaria
        // vendável com um número de controle dizendo que saiu.
        await (this.prisma as any).defectItem.delete({ where: { id: criado.id } }).catch(() => {});
        this.logger.error(`[defeitos] baixa de estoque falhou (${sku}): ${e?.message || e}`);
        throw new BadRequestException(
          `Não consegui baixar a peça do estoque: ${e?.message || e}. Nada foi registrado — tente de novo.`,
        );
      }
    }

    if (caixa) await this.recalcularCaixa(caixa.id);

    this.logger.log(
      `[defeitos] ${criado.code}: ${peca.ref || sku} ${peca.cor || ''} ${peca.tamanho || ''} ` +
        `· ${motivo} · loja ${input.storeCode}${caixa ? ` · caixa ${caixa.code}` : ' · na matriz'}`,
    );
    return this.buscarPorId(criado.id);
  }

  /** Cria com retry por sufixo — duas vendedoras registrando ao mesmo tempo. */
  private async criarComRetry(data: any) {
    let lastErr: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await (this.prisma as any).defectItem.create({
          data: { ...data, code: await this.gerarCodigo('defectItem', 'DEF', attempt) },
        });
      } catch (e: any) {
        lastErr = e;
        if (e?.code !== 'P2002') throw e;
      }
    }
    throw lastErr;
  }

  /** Congela contagem e valor da caixa a cada mudança. */
  private async recalcularCaixa(batchId: string) {
    const itens = await (this.prisma as any).defectItem.findMany({
      where: { batchId },
      select: { custoUnitCents: true },
    });
    await (this.prisma as any).defectBatch.update({
      where: { id: batchId },
      data: {
        totalPecas: itens.length,
        totalCustoCents: itens.reduce((s: number, i: any) => s + (i.custoUnitCents || 0), 0),
      },
    });
  }

  // ── Consultas ───────────────────────────────────────────────────────

  async buscarPorId(id: string) {
    const item = await (this.prisma as any).defectItem.findUnique({
      where: { id },
      include: { batch: true },
    });
    if (!item) throw new NotFoundException('Defeito não encontrado');
    return item;
  }

  /** Caixa aberta da loja + itens — é a tela da vendedora. */
  async caixaAtual(storeCode: string) {
    const caixa = await (this.prisma as any).defectBatch.findFirst({
      where: { storeCodeOrigem: storeCode, status: 'aberta' },
      orderBy: { createdAt: 'desc' },
    });
    if (!caixa) return { caixa: null, itens: [] };
    const itens = await (this.prisma as any).defectItem.findMany({
      where: { batchId: caixa.id },
      orderBy: { registradoAt: 'desc' },
    });
    return { caixa, itens };
  }

  /**
   * FECHA a caixa: status vira 'enviada' e os totais congelam. A partir daí
   * o próximo defeito da loja abre uma caixa nova.
   */
  async fecharCaixa(batchId: string, userName?: string | null) {
    const caixa = await (this.prisma as any).defectBatch.findUnique({ where: { id: batchId } });
    if (!caixa) throw new NotFoundException('Caixa não encontrada');
    if (caixa.status !== 'aberta') {
      throw new BadRequestException(`Caixa ${caixa.code} já está ${caixa.status}`);
    }
    const total = await (this.prisma as any).defectItem.count({ where: { batchId } });
    if (total === 0) throw new BadRequestException('Caixa vazia — registre ao menos uma peça');

    await this.recalcularCaixa(batchId);
    const fechada = await (this.prisma as any).defectBatch.update({
      where: { id: batchId },
      data: { status: 'enviada', fechadaAt: new Date(), fechadaPorNome: userName || null },
    });
    this.logger.log(`[defeitos] caixa ${fechada.code} fechada com ${total} peça(s)`);
    return fechada;
  }

  /** Romaneio da caixa — a lista impressa que vai colada por fora. */
  async romaneio(batchId: string) {
    const caixa = await (this.prisma as any).defectBatch.findUnique({ where: { id: batchId } });
    if (!caixa) throw new NotFoundException('Caixa não encontrada');
    const itens = await (this.prisma as any).defectItem.findMany({
      where: { batchId },
      orderBy: { code: 'asc' },
    });
    return { caixa, itens };
  }
}
