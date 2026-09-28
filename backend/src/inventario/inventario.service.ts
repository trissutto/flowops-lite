import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { PecasExtraviadasService } from '../pecas-extraviadas/pecas-extraviadas.service';
import {
  classificarLinha,
  normalizarCodigo,
  ehCodigoDeBarras,
  MSG_SO_EAN13,
  ordenarPorDinheiro,
  planoDeAjuste,
  resumirContagem,
  sugereRecontagem,
  type LinhaClassificada,
} from '../common/inventario-contagem';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INVENTÁRIO DE LOJA — o motor
 *
 *  Três invariantes, e as três existem por um incidente conhecido:
 *
 *  1. BIPE NÃO TOCA ESTOQUE. A contagem é uma tabela paralela; o estoque só
 *     se move no "Aplicar" da matriz. É o que deixa a loja vender no meio.
 *
 *  2. O ESPERADO É CONGELADO NO PRIMEIRO BIPE de cada código, e sai da MESMA
 *     tabela que o delta usa como base (`giga_estoque`, o `previousStock` do
 *     `mirrorStockApplyDelta`). Esperado lido no fim do dia já viria
 *     descontado das vendas do dia: a peça vendida às 14h30 apareceria como
 *     sobra e o ajuste a devolveria ao estoque — peça fantasma na Consulta e
 *     no site, a mesma família do estorno que "devolvia" a peça nova (11/09).
 *
 *  3. O AJUSTE CONFERE `applied`, NUNCA `success`. Fora de transação, o erro
 *     de um item vira log e o item não entra no `applied` — mas o retorno
 *     continua `success: true`. Carimbar "ajustado" olhando o `success` é o
 *     bug do estorno master de 03/09 e o que ainda vive no
 *     `erpStepBaixarEstoque`. Aqui cada linha só é gravada como aplicada com
 *     o `antes`/`depois` que o estoque devolveu.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class InventarioService {
  private readonly logger = new Logger(InventarioService.name);

  /** Lock em memória por sessão — segura o duplo clique no "Aplicar" do mesmo
   *  processo. A trava que vale de verdade é a linha de `InventarioAjuste`
   *  aplicada: ela é conferida antes de cada movimento. */
  private aplicando = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly catalog: WincredCatalogService,
    private readonly extraviadas: PecasExtraviadasService,
  ) {}

  // ── helpers ───────────────────────────────────────────────────────────

  private loja2(code: string): string {
    const raw = String(code || '').trim().toUpperCase().replace(/^LJ/i, '');
    return /^\d{1,2}$/.test(raw) ? raw.padStart(2, '0') : raw;
  }

  /** As grafias de loja que aparecem nos espelhos ('8', '08'). Mesma régua do
   *  `mirrorStockApplyDelta` — ler por uma só devolve saldo zero pra loja que
   *  foi gravada na outra. */
  private lojaVariantes(code: string): string[] {
    const raw = String(code || '').trim().toUpperCase().replace(/^LJ/i, '');
    const dois = this.loja2(code);
    return Array.from(new Set([raw, dois, raw.replace(/^0+/, '') || raw].filter(Boolean)));
  }

  /**
   * Saldo da loja por código, em lote — lido de `wincred_estoque`, a MESMA
   * tabela que o PDV, o site e o roteamento leem (`STOCK_WINCRED_FIRST`).
   *
   * 🚨 Até 28/09 a base era a `giga_estoque` (tabela nativa do Postgres com
   * nome herdado). Ela não tem linha pra boa parte dos códigos antigos: na
   * loja 15 saíram 42 "diferenças" com Sistema 0 em peça que a vitrine
   * mostrava certinho — a loja contou certo e o inventário mentiu. Um clique
   * em "Ajustar" teria dobrado o saldo. Inventário lê o que a operação lê.
   */
  private async saldos(skus: string[], storeCode: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const alvo = Array.from(new Set(skus.map((s) => normalizarCodigo(s)).filter(Boolean)));
    if (!alvo.length) return out;

    const lojas = this.lojaVariantes(storeCode);
    const variantePorSku = new Map<string, string>();
    const todasVariantes: string[] = [];
    for (const sku of alvo) {
      for (const v of this.erp.skuVariants(sku)) {
        variantePorSku.set(v, sku);
        todasVariantes.push(v);
      }
    }

    const linhas = await (this.prisma as any).wincredEstoque.findMany({
      where: { codigo: { in: todasVariantes }, loja: { in: lojas } },
      select: { codigo: true, estoque: true },
    });
    for (const r of linhas) {
      const sku = variantePorSku.get(String(r.codigo));
      if (!sku) continue;
      // `mirrorStockApplyDelta` aplica no PRIMEIRO registro que encontra; com
      // linhas duplicadas (variante de loja), o maior é o que a operação vê.
      out.set(sku, Math.max(out.get(sku) ?? 0, Number(r.estoque) || 0));
    }
    return out;
  }

  private async exigirSessao(sessaoId: string) {
    const s = await (this.prisma as any).inventarioSessao.findUnique({ where: { id: sessaoId } });
    if (!s) throw new NotFoundException('Inventário não encontrado');
    return s;
  }

  // ── abrir / listar / encerrar ──────────────────────────────────────────

  /** Uma contagem aberta por loja. Duas ao mesmo tempo dividiriam o contado
   *  em duas sessões e cada uma acharia que faltou metade da loja. */
  async abrir(input: { storeCode: string; userName?: string | null; nota?: string | null }) {
    const storeCode = this.loja2(input.storeCode);
    if (!storeCode) throw new BadRequestException('Loja não identificada');

    const aberta = await (this.prisma as any).inventarioSessao.findFirst({
      where: { storeCode, status: { in: ['aberta', 'encerrada'] } },
      orderBy: { abertaEm: 'desc' },
    });
    if (aberta) {
      throw new ConflictException(
        `A loja ${storeCode} já tem um inventário ${aberta.status === 'aberta' ? 'em andamento' : 'encerrado esperando o ajuste'} (aberto em ${new Date(aberta.abertaEm).toLocaleDateString('pt-BR')})`,
      );
    }

    const sessao = await (this.prisma as any).inventarioSessao.create({
      data: { storeCode, abertaPor: input.userName ?? null, nota: input.nota ?? null },
    });
    this.logger.log(`[inventario] aberto ${sessao.id} loja ${storeCode} por ${input.userName || '?'}`);
    return sessao;
  }

  async listar(opts: { storeCode?: string; limit?: number } = {}) {
    const sessoes = await (this.prisma as any).inventarioSessao.findMany({
      where: opts.storeCode ? { storeCode: this.loja2(opts.storeCode) } : {},
      orderBy: { abertaEm: 'desc' },
      take: Math.min(200, Math.max(1, opts.limit ?? 50)),
    });
    if (!sessoes.length) return [];

    const ids = sessoes.map((s: any) => s.id);
    const [bipes, lojas] = await Promise.all([
      (this.prisma as any).inventarioBipe.groupBy({
        by: ['sessaoId'],
        where: { sessaoId: { in: ids } },
        _sum: { delta: true },
      }),
      this.prisma.store.findMany({ select: { code: true, name: true } }),
    ]);
    const pecasPorSessao = new Map<string, number>(
      bipes.map((b: any) => [String(b.sessaoId), Number(b._sum?.delta) || 0]),
    );
    const nomePorLoja = new Map<string, string>(lojas.map((l: any) => [this.loja2(l.code), l.name]));

    return sessoes.map((s: any) => ({
      ...s,
      storeName: nomePorLoja.get(s.storeCode) ?? null,
      pecasContadas: pecasPorSessao.get(s.id) ?? 0,
    }));
  }

  /** O que a tela da loja mostra. CEGA de propósito: nada de esperado aqui. */
  async painelLoja(storeCode: string) {
    const loja = this.loja2(storeCode);
    const sessao = await (this.prisma as any).inventarioSessao.findFirst({
      where: { storeCode: loja, status: { in: ['aberta', 'encerrada'] } },
      orderBy: { abertaEm: 'desc' },
    });
    if (!sessao) return { sessao: null };

    const [total, porSku, ultimos, recontar] = await Promise.all([
      (this.prisma as any).inventarioBipe.aggregate({
        where: { sessaoId: sessao.id },
        _sum: { delta: true },
      }),
      (this.prisma as any).inventarioBipe.groupBy({
        by: ['sku'],
        where: { sessaoId: sessao.id },
        _sum: { delta: true },
      }),
      (this.prisma as any).inventarioBipe.findMany({
        where: { sessaoId: sessao.id },
        orderBy: { bipadoEm: 'desc' },
        take: 30,
      }),
      (this.prisma as any).inventarioEsperado.findMany({
        where: { sessaoId: sessao.id, recontarEm: { not: null } },
        select: { sku: true, rotulo: true, rodada: true, recontarEm: true },
        orderBy: { recontarEm: 'desc' },
        take: 200,
      }),
    ]);

    /* Recontagem pedida: a loja precisa saber QUANTO já bipou na rodada nova,
     * senão reconta no escuro e não sabe se já passou por aquele código. */
    const recontarSkus = recontar.map((r: any) => r.sku);
    const bipesRodada = recontarSkus.length
      ? await (this.prisma as any).inventarioBipe.groupBy({
          by: ['sku', 'rodada'],
          where: { sessaoId: sessao.id, sku: { in: recontarSkus } },
          _sum: { delta: true },
        })
      : [];

    return {
      sessao,
      pecasContadas: Number(total._sum?.delta) || 0,
      codigosContados: porSku.filter((p: any) => (Number(p._sum?.delta) || 0) > 0).length,
      ultimos,
      recontar: recontar.map((r: any) => ({
        ...r,
        contadoNaRodada:
          Number(
            bipesRodada.find((b: any) => b.sku === r.sku && b.rodada === r.rodada)?._sum?.delta,
          ) || 0,
      })),
    };
  }

  // ── o bipe ────────────────────────────────────────────────────────────

  /**
   * Uma peça encostada no leitor.
   *
   * Devolve o rótulo pra pessoa conferir que leu a peça certa e o quanto já
   * bipou daquele código — nunca o esperado. Contagem cega não é capricho:
   * com o número do sistema na tela, a contagem vira conferência do sistema.
   */
  async bipar(input: {
    storeCode: string;
    codigo: string;
    clientId?: string | null;
    userName?: string | null;
    origem?: string | null;
  }) {
    const loja = this.loja2(input.storeCode);
    const sessao = await (this.prisma as any).inventarioSessao.findFirst({
      where: { storeCode: loja, status: 'aberta' },
      orderBy: { abertaEm: 'desc' },
    });
    if (!sessao) {
      throw new BadRequestException(
        'Nenhum inventário aberto pra esta loja. A matriz abre em Retaguarda → Inventário.',
      );
    }

    const digitado = String(input.codigo || '').trim();
    if (!digitado) throw new BadRequestException('Bipe vazio');
    /* Só o código de BARRAS entra. O leitor pega o QR code da etiqueta às
     * vezes, e isso viraria um "sem cadastro" fantasma na contagem. */
    if (!ehCodigoDeBarras(digitado)) throw new BadRequestException(MSG_SO_EAN13);

    /* Reenvio (rede caiu, botão clicado 2x) é no-op: a linha já existe. */
    if (input.clientId) {
      const jaTem = await (this.prisma as any).inventarioBipe.findFirst({
        where: { sessaoId: sessao.id, clientId: input.clientId },
      });
      if (jaTem) return this.respostaBipe(sessao.id, jaTem, { duplicado: true });
    }

    /* Mesmo caminho do bipe do PDV: resolve EAN legado e ERRO SOBE (500
     * honesto) em vez de virar "não existe" com a peça na mão. */
    const info = await this.catalog.getPdvProductInfo(digitado);
    const naoCadastrado = !info;
    const sku = normalizarCodigo(info?.sku || digitado);
    const rotulo = info
      ? [info.ref, info.cor, info.tamanho].filter(Boolean).join(' · ') || info.descricao || sku
      : null;

    /* ── O CONGELAMENTO ── primeiro bipe do código nesta sessão grava o saldo
     * de agora. É a âncora da conta e a razão de a loja poder vender. */
    let esperado = await (this.prisma as any).inventarioEsperado.findUnique({
      where: { sessaoId_sku: { sessaoId: sessao.id, sku } },
    });
    if (!esperado && !naoCadastrado) {
      const saldo = (await this.saldos([sku], loja)).get(sku) ?? 0;
      esperado = await (this.prisma as any).inventarioEsperado
        .create({
          data: {
            sessaoId: sessao.id,
            storeCode: loja,
            sku,
            esperado: saldo,
            esperadoVitrine: saldo,
            custo: info?.custo ?? null,
            rotulo,
          },
        })
        .catch(async () =>
          /* Duas pessoas bipando o mesmo código no mesmo instante: o unique
           * recusa a segunda e o congelamento que vale é o primeiro. */
          (this.prisma as any).inventarioEsperado.findUnique({
            where: { sessaoId_sku: { sessaoId: sessao.id, sku } },
          }),
        );
    }

    const bipe = await (this.prisma as any).inventarioBipe.create({
      data: {
        sessaoId: sessao.id,
        storeCode: loja,
        sku,
        delta: 1,
        rotulo,
        naoCadastrado,
        rodada: esperado?.rodada ?? 1,
        clientId: input.clientId ?? null,
        origem: input.origem ?? 'pc',
        bipadoPor: input.userName ?? null,
      },
    });

    return this.respostaBipe(sessao.id, bipe, {
      naoCadastrado,
      /* Código que a matriz mandou recontar: a tela avisa que este é dos que
       * ela está esperando de volta. */
      recontagem: !!esperado?.recontarEm && (esperado?.rodada ?? 1) > 1,
    });
  }

  private async respostaBipe(sessaoId: string, bipe: any, extra: Record<string, unknown> = {}) {
    const [doSku, total] = await Promise.all([
      (this.prisma as any).inventarioBipe.aggregate({
        where: { sessaoId, sku: bipe.sku, rodada: bipe.rodada },
        _sum: { delta: true },
      }),
      (this.prisma as any).inventarioBipe.aggregate({ where: { sessaoId }, _sum: { delta: true } }),
    ]);
    return {
      ok: true,
      bipe,
      sku: bipe.sku,
      rotulo: bipe.rotulo,
      contadoDesteCodigo: Number(doSku._sum?.delta) || 0,
      pecasContadas: Number(total._sum?.delta) || 0,
      ...extra,
    };
  }

  /** "Tirar 1" e "desfazer o último" entram como linha de −1: o histórico de
   *  quem contou o quê é o que explica a diferença depois. */
  async corrigir(input: { storeCode: string; sku?: string; userName?: string | null }) {
    const loja = this.loja2(input.storeCode);
    const sessao = await (this.prisma as any).inventarioSessao.findFirst({
      where: { storeCode: loja, status: 'aberta' },
      orderBy: { abertaEm: 'desc' },
    });
    if (!sessao) throw new BadRequestException('Nenhum inventário aberto pra esta loja');

    const alvo = input.sku
      ? await (this.prisma as any).inventarioBipe.findFirst({
          where: { sessaoId: sessao.id, sku: normalizarCodigo(input.sku), delta: 1 },
          orderBy: { bipadoEm: 'desc' },
        })
      : await (this.prisma as any).inventarioBipe.findFirst({
          where: { sessaoId: sessao.id, delta: 1 },
          orderBy: { bipadoEm: 'desc' },
        });
    if (!alvo) throw new BadRequestException('Não há bipe pra tirar');

    const contado = await (this.prisma as any).inventarioBipe.aggregate({
      where: { sessaoId: sessao.id, sku: alvo.sku, rodada: alvo.rodada },
      _sum: { delta: true },
    });
    if ((Number(contado._sum?.delta) || 0) <= 0) {
      throw new BadRequestException(`${alvo.rotulo || alvo.sku} já está em zero nesta contagem`);
    }

    const bipe = await (this.prisma as any).inventarioBipe.create({
      data: {
        sessaoId: sessao.id,
        storeCode: loja,
        sku: alvo.sku,
        delta: -1,
        rotulo: alvo.rotulo,
        naoCadastrado: alvo.naoCadastrado,
        rodada: alvo.rodada,
        origem: 'pc',
        bipadoPor: input.userName ?? null,
      },
    });
    return this.respostaBipe(sessao.id, bipe, { correcao: true });
  }

  async encerrar(sessaoId: string, userName?: string | null) {
    const s = await this.exigirSessao(sessaoId);
    if (s.status !== 'aberta') {
      throw new BadRequestException(`Este inventário está ${s.status}, não dá pra encerrar`);
    }
    const r = await (this.prisma as any).inventarioSessao.updateMany({
      where: { id: sessaoId, status: 'aberta' },
      data: { status: 'encerrada', encerradaEm: new Date(), encerradaPor: userName ?? null },
    });
    if (!r.count) throw new ConflictException('Alguém encerrou este inventário antes');
    this.logger.log(`[inventario] ${sessaoId} encerrado por ${userName || '?'}`);
    return this.exigirSessao(sessaoId);
  }

  /** Voltar a contar (faltou uma parte da loja, ou a matriz pediu recontagem). */
  async reabrir(sessaoId: string, userName?: string | null) {
    const s = await this.exigirSessao(sessaoId);
    if (s.status === 'aplicada') {
      throw new BadRequestException(
        'Este inventário já virou ajuste de estoque — abra um novo pra contar de novo',
      );
    }
    await (this.prisma as any).inventarioSessao.update({
      where: { id: sessaoId },
      data: { status: 'aberta', encerradaEm: null, encerradaPor: null },
    });
    this.logger.log(`[inventario] ${sessaoId} reaberto por ${userName || '?'}`);
    return this.exigirSessao(sessaoId);
  }

  async cancelar(sessaoId: string, userName?: string | null) {
    const s = await this.exigirSessao(sessaoId);
    if (s.status === 'aplicada') {
      throw new BadRequestException('Inventário já aplicado não se cancela — o ajuste já aconteceu');
    }
    await (this.prisma as any).inventarioSessao.update({
      where: { id: sessaoId },
      data: { status: 'cancelada', canceladaEm: new Date() },
    });
    this.logger.log(`[inventario] ${sessaoId} cancelado por ${userName || '?'}`);
    return this.exigirSessao(sessaoId);
  }

  // ── o relatório da matriz ─────────────────────────────────────────────

  /**
   * PEÇA QUE ESTÁ NA LOJA MAS FORA DO SALDO, DE PROPÓSITO.
   *
   * Três caminhos já tiraram a peça do saldo com ela ainda na arara: MARCADO
   * (baixa na marcação), card do site JÁ BIPADO e ainda não postado (a baixa
   * é no bipe) e caixa de remessa fechada esperando coleta. Contar essas
   * peças gera SOBRA — e aplicar a sobra devolve ao estoque peça que já é de
   * alguém. Só é consultado pros códigos que sobraram (lista curta).
   */
  private async motivosDeSobra(storeCode: string, skus: string[]) {
    const out = new Map<string, { marcado: number; cardBipado: number; remessa: number }>();
    if (!skus.length) return out;
    const lojas = this.lojaVariantes(storeCode);
    const variantePorSku = new Map<string, string>();
    const variantes: string[] = [];
    for (const sku of skus) {
      for (const v of this.erp.skuVariants(sku)) {
        variantePorSku.set(v, sku);
        variantes.push(v);
      }
    }
    const zero = () => ({ marcado: 0, cardBipado: 0, remessa: 0 });
    const soma = (sku: string, campo: 'marcado' | 'cardBipado' | 'remessa', qtd: number) => {
      const atual = out.get(sku) ?? zero();
      atual[campo] += qtd;
      out.set(sku, atual);
    };

    const [marcados, scans, remessas] = await Promise.all([
      (this.prisma as any).marcado.findMany({
        where: { storeCode: { in: lojas }, status: 'ativo', isTraining: false, sku: { in: variantes } },
        select: { sku: true, qty: true },
      }),
      (this.prisma as any).pickOrderScan.findMany({
        where: {
          storeCode: { in: lojas },
          sku: { in: variantes },
          stockDecreasedAt: { not: null },
          revertedAt: null,
        },
        select: { sku: true, pickOrderId: true },
      }),
      (this.prisma as any).realignmentShipment.findMany({
        where: { fromStoreCode: { in: lojas }, status: 'in_transit' },
        select: { id: true },
      }),
    ]);

    for (const m of marcados) {
      const sku = variantePorSku.get(String(m.sku));
      if (sku) soma(sku, 'marcado', Number(m.qty) || 1);
    }

    /* O scan não tem FK pro card (de propósito — linha órfã é evidência),
     * então o status do card vem numa segunda consulta. */
    const cardIds = Array.from(new Set(scans.map((s: any) => String(s.pickOrderId)).filter(Boolean)));
    if (cardIds.length) {
      const cards = await (this.prisma as any).pickOrder.findMany({
        where: { id: { in: cardIds }, status: { not: 'shipped' } },
        select: { id: true },
      });
      const naoPostados = new Set(cards.map((c: any) => String(c.id)));
      for (const s of scans) {
        if (!naoPostados.has(String(s.pickOrderId))) continue;
        const sku = variantePorSku.get(String(s.sku));
        if (sku) soma(sku, 'cardBipado', 1);
      }
    }

    if (remessas.length) {
      const itens = await (this.prisma as any).transferOrder.findMany({
        where: {
          shipmentId: { in: remessas.map((r: any) => r.id) },
          codigoBipado: { in: variantes },
        },
        select: { codigoBipado: true },
      });
      for (const i of itens) {
        const sku = variantePorSku.get(String(i.codigoBipado));
        if (sku) soma(sku, 'remessa', 1);
      }
    }
    return out;
  }

  /** Cadastro em lote pros códigos que ninguém bipou (rótulo e custo). */
  private async cadastro(skus: string[]) {
    const out = new Map<string, { rotulo: string | null; custo: number | null }>();
    if (!skus.length) return out;
    const lote = skus.slice(0, 6000);
    const campos = {
      codigo: true,
      ref: true,
      cor: true,
      tamanho: true,
      custo: true,
      descricaoCompleta: true,
      descricaoPdv: true,
    };
    const [nativa, espelho] = await Promise.all([
      (this.prisma as any).product
        .findMany({ where: { codigo: { in: lote } }, select: campos })
        .catch(() => [] as any[]),
      (this.prisma as any).wincredProduto
        .findMany({ where: { codigo: { in: lote } }, select: campos })
        .catch(() => [] as any[]),
    ]);
    for (const p of [...espelho, ...nativa]) {
      const rotulo =
        [p.ref, p.cor, p.tamanho].filter(Boolean).join(' · ') ||
        p.descricaoCompleta ||
        p.descricaoPdv ||
        null;
      out.set(String(p.codigo), {
        rotulo,
        custo: p.custo != null ? Number(p.custo) : null,
      });
    }
    return out;
  }

  /**
   * O relatório completo. Enquanto a contagem está ABERTA não calcula os
   * não-contados: naquele momento "não contado" é só "ainda não chegou lá", e
   * a lista seria a loja inteira.
   */
  async relatorio(sessaoId: string) {
    const sessao = await this.exigirSessao(sessaoId);
    const loja = sessao.storeCode;

    const [esperados, bipes, ajustes] = await Promise.all([
      (this.prisma as any).inventarioEsperado.findMany({ where: { sessaoId } }),
      (this.prisma as any).inventarioBipe.groupBy({
        by: ['sku', 'rodada', 'naoCadastrado'],
        where: { sessaoId },
        _sum: { delta: true },
        _min: { bipadoEm: true },
        _max: { bipadoEm: true },
      }),
      (this.prisma as any).inventarioAjuste.findMany({ where: { sessaoId } }),
    ]);

    const esperadoPorSku = new Map<string, any>(esperados.map((e: any) => [String(e.sku), e]));
    /* Horário do PRIMEIRO e do ÚLTIMO bipe do código (pedido do dono 28/09):
     * é o que diz em que arara a pessoa estava e se a peça foi bipada de novo
     * horas depois. Cada bipe individual continua em `inventario_bipe`. */
    const contadoPorSku = new Map<
      string,
      { qtd: number; rotulo: string | null; em: Date | null; primeiroEm: Date | null }
    >();
    const naoCadastrados: Array<{ sku: string; contado: number; ultimoBipeEm: Date | null }> = [];

    for (const b of bipes) {
      const sku = String(b.sku);
      const qtd = Number(b._sum?.delta) || 0;
      if (b.naoCadastrado) {
        if (qtd > 0) naoCadastrados.push({ sku, contado: qtd, ultimoBipeEm: b._max?.bipadoEm ?? null });
        continue;
      }
      /* O que vale é a rodada MAIS ALTA: recontagem substitui a contagem
       * anterior daquele código, não soma com ela. */
      const rodadaQueVale = esperadoPorSku.get(sku)?.rodada ?? 1;
      if (b.rodada !== rodadaQueVale) continue;
      contadoPorSku.set(sku, {
        qtd,
        rotulo: null,
        em: b._max?.bipadoEm ?? null,
        primeiroEm: b._min?.bipadoEm ?? null,
      });
    }

    const linhas: LinhaClassificada[] = esperados
      .filter((e: any) => contadoPorSku.has(String(e.sku)) || Number(e.esperado) !== 0)
      .map((e: any) =>
        classificarLinha({
          sku: String(e.sku),
          rotulo: e.rotulo,
          contado: contadoPorSku.get(String(e.sku))?.qtd ?? 0,
          esperado: Number(e.esperado) || 0,
          custo: e.custo,
        }),
      );

    /* Sessões congeladas ANTES de 28/09 leram a base errada (giga_estoque):
     * aqui a diferença fica visível pra matriz. Sessão nova grava o mesmo
     * número nas duas colunas e esta lista sai vazia. */
    const vistasDivergentes = esperados
      .filter(
        (e: any) => e.esperadoVitrine != null && Number(e.esperadoVitrine) !== Number(e.esperado),
      )
      .map((e: any) => ({
        sku: String(e.sku),
        rotulo: e.rotulo,
        base: Number(e.esperado),
        vitrine: Number(e.esperadoVitrine),
      }));

    const divergentes = linhas.filter((l) => l.delta !== 0);
    const motivos = await this.motivosDeSobra(
      loja,
      divergentes.filter((l) => l.delta > 0).map((l) => l.sku),
    );

    const comContexto = ordenarPorDinheiro(divergentes).map((l) => {
      const m = motivos.get(l.sku);
      const fora = (m?.marcado ?? 0) + (m?.cardBipado ?? 0) + (m?.remessa ?? 0);
      return {
        ...l,
        recontar: sugereRecontagem(l),
        recontarPedidoEm: esperadoPorSku.get(l.sku)?.recontarEm ?? null,
        rodada: esperadoPorSku.get(l.sku)?.rodada ?? 1,
        congeladoEm: esperadoPorSku.get(l.sku)?.congeladoEm ?? null,
        primeiroBipeEm: contadoPorSku.get(l.sku)?.primeiroEm ?? null,
        ultimoBipeEm: contadoPorSku.get(l.sku)?.em ?? null,
        jaAjustado: ajustes.some((a: any) => a.sku === l.sku && a.aplicado),
        /* Sobra explicada: a peça está na loja mas já é de alguém. */
        foraDoSaldo: fora ? m : null,
        sobraExplicada: l.delta > 0 && fora >= l.delta,
      };
    });

    /* ── "tinha saldo e não apareceu no bipe" ── lista separada, decisão da
     * matriz: zerar é a resposta certa só depois de garantir que a loja
     * passou por aquela arara. Zerar sozinho apagaria estoque bom de uma
     * loja que parou de contar no meio. */
    let naoContados: Array<{ sku: string; rotulo: string | null; saldo: number; custo: number | null; valor: number | null }> = [];
    if (sessao.status !== 'aberta') {
      const comSaldo: any[] = await (this.prisma as any).wincredEstoque.findMany({
        where: { loja: { in: this.lojaVariantes(loja) }, estoque: { gt: 0 } },
        select: { codigo: true, estoque: true },
      });
      const faltando = comSaldo.filter((r) => !esperadoPorSku.has(normalizarCodigo(r.codigo)));
      const cad = await this.cadastro(faltando.map((r) => String(r.codigo)));
      naoContados = faltando
        .map((r) => {
          const info = cad.get(String(r.codigo));
          const saldo = Number(r.estoque) || 0;
          const custo = info?.custo ?? null;
          return {
            sku: normalizarCodigo(r.codigo),
            rotulo: info?.rotulo ?? null,
            saldo,
            custo,
            valor: custo == null ? null : Math.round(saldo * custo * 100) / 100,
          };
        })
        .sort((a, b) => (b.valor ?? 0) - (a.valor ?? 0) || b.saldo - a.saldo);
    }

    const resumo = resumirContagem(linhas);
    return {
      sessao,
      resumo: {
        ...resumo,
        naoContadosSkus: naoContados.length,
        naoContadosPecas: naoContados.reduce((s, n) => s + n.saldo, 0),
        naoContadosValor:
          Math.round(naoContados.reduce((s, n) => s + (n.valor ?? 0), 0) * 100) / 100,
        naoCadastrados: naoCadastrados.length,
        pedidosDeRecontagem: esperados.filter((e: any) => e.recontarEm).length,
      },
      divergencias: comContexto,
      naoContados,
      naoCadastrados,
      vistasDivergentes,
      ajustes,
    };
  }

  // ── recontagem ────────────────────────────────────────────────────────

  /**
   * "Conta este de novo." Re-congela o esperado (a contagem nova acontece
   * AGORA, contra o saldo de agora), sobe a rodada e reabre a sessão — sem
   * reabrir, a loja não tem onde bipar o que a matriz pediu.
   */
  async pedirRecontagem(input: { sessaoId: string; skus: string[]; userName?: string | null }) {
    const sessao = await this.exigirSessao(input.sessaoId);
    if (sessao.status === 'aplicada' || sessao.status === 'cancelada') {
      throw new BadRequestException(`Inventário ${sessao.status} não aceita recontagem`);
    }
    const skus = Array.from(new Set((input.skus || []).map(normalizarCodigo).filter(Boolean)));
    if (!skus.length) throw new BadRequestException('Nenhum código pra recontar');

    const saldos = await this.saldos(skus, sessao.storeCode);
    let pedidos = 0;
    for (const sku of skus) {
      const atual = await (this.prisma as any).inventarioEsperado.findUnique({
        where: { sessaoId_sku: { sessaoId: sessao.id, sku } },
      });
      if (!atual) continue;
      const saldo = saldos.get(sku) ?? 0;
      await (this.prisma as any).inventarioEsperado.update({
        where: { id: atual.id },
        data: {
          rodada: Number(atual.rodada || 1) + 1,
          esperado: saldo,
          esperadoVitrine: saldo,
          congeladoEm: new Date(),
          recontarEm: new Date(),
          recontarPor: input.userName ?? null,
        },
      });
      pedidos++;
    }

    if (pedidos && sessao.status === 'encerrada') {
      await (this.prisma as any).inventarioSessao.update({
        where: { id: sessao.id },
        data: { status: 'aberta', encerradaEm: null, encerradaPor: null },
      });
    }
    this.logger.log(`[inventario] ${sessao.id}: recontagem pedida pra ${pedidos} código(s)`);
    return { ok: true, pedidos, reaberta: pedidos > 0 && sessao.status === 'encerrada' };
  }

  // ── o ajuste ──────────────────────────────────────────────────────────

  /**
   * APLICAR: a contagem vira estoque.
   *
   * Idempotente POR LINHA — o que já tem `InventarioAjuste` aplicado nunca é
   * reprocessado. Movimento que não voltou no `applied` fica gravado com
   * `aplicado: false` e o erro, e o mesmo botão pode ser clicado de novo pra
   * tentar só os que falharam. Nada aqui carimba "feito" olhando o `success`.
   */
  async aplicar(input: { sessaoId: string; userName?: string | null; userId?: string | null }) {
    const sessao = await this.exigirSessao(input.sessaoId);
    if (sessao.status === 'cancelada') throw new BadRequestException('Inventário cancelado');
    if (sessao.status === 'aberta') {
      throw new BadRequestException('Encerre a contagem antes de aplicar o ajuste');
    }
    if (this.aplicando.has(sessao.id)) {
      throw new ConflictException('O ajuste deste inventário já está rodando');
    }
    this.aplicando.add(sessao.id);
    try {
      const rel = await this.relatorio(sessao.id);
      const candidatas = rel.divergencias.filter((l: any) => !l.jaAjustado && l.delta !== 0);

      /**
       * RECONTAGEM PEDIDA E NÃO FEITA NÃO VIRA AJUSTE.
       *
       * Pedir recontagem sobe a rodada do código e o contado passa a sair da
       * rodada NOVA — que nasce vazia. Enquanto a loja não recontar, a linha
       * aparece como "contou 0, sistema tem 5": aplicar isso ZERARIA a peça
       * por causa de um pedido de conferência. Fica de fora, com o número na
       * resposta pra tela dizer por quê.
       */
      const pulados = candidatas.filter((l: any) => l.recontarPedidoEm && l.contado === 0);
      const pendentes = candidatas.filter((l: any) => !(l.recontarPedidoEm && l.contado === 0));

      if (!pendentes.length) {
        return {
          ok: true,
          aplicados: 0,
          total: 0,
          pulados: pulados.length,
          mensagem: pulados.length
            ? `Nada aplicado: ${pulados.length} código(s) estão esperando recontagem da loja`
            : 'Nada pra ajustar — tudo já aplicado',
        };
      }

      const plano = planoDeAjuste(pendentes as LinhaClassificada[]);
      const loja = sessao.storeCode;
      const aplicadoPorSku = new Map<string, { previousStock: number; newStock: number }>();
      let erroGeral: string | null = null;

      try {
        if (plano.entradas.length) {
          const r = await this.erp.increaseStock(
            plano.entradas.map((e) => ({ sku: e.sku, qty: e.qty, storeCode: loja })),
          );
          /* `applied`, nunca `success` — ver o cabeçalho da classe. */
          for (const a of r.applied || []) {
            aplicadoPorSku.set(normalizarCodigo(a.sku), a);
          }
          if (!r.success) erroGeral = r.error || 'falha na entrada';
        }
        if (plano.saidas.length) {
          /* `allowNegative: false` é de propósito: se o saldo caiu mais que o
           * delta entre a contagem e o ajuste (vendeu no meio), a saída para
           * em ZERO em vez de deixar saldo negativo na loja. O `antes`/`depois`
           * gravado mostra o que aconteceu de verdade. */
          const r = await this.erp.decreaseStock(
            plano.saidas.map((e) => ({ sku: e.sku, qty: e.qty, storeCode: loja })),
            { allowNegative: false },
          );
          for (const a of r.applied || []) {
            aplicadoPorSku.set(normalizarCodigo(a.sku), a);
          }
          if (!r.success) erroGeral = erroGeral || r.error || 'falha na saída';
        }
      } catch (e) {
        erroGeral = (e as Error).message;
      }

      const batchId = randomUUID();
      const agora = new Date();
      const linhasAjuste = pendentes.map((l: any) => {
        const ap = aplicadoPorSku.get(l.sku);
        return {
          sessaoId: sessao.id,
          storeCode: loja,
          sku: l.sku,
          contado: l.contado,
          esperado: l.esperado,
          delta: l.delta,
          tipo: l.delta > 0 ? 'entrada' : 'saida',
          antes: ap ? ap.previousStock : null,
          depois: ap ? ap.newStock : null,
          aplicado: !!ap,
          erro: ap ? null : erroGeral || 'não aplicado',
          custo: l.custo ?? null,
          rotulo: l.rotulo ?? null,
          criadoPor: input.userName ?? null,
        };
      });
      await (this.prisma as any).inventarioAjuste.createMany({ data: linhasAjuste });

      const aplicadas = linhasAjuste.filter((l: any) => l.aplicado);

      /* Histórico da peça e auditoria do editor — só o que ENTROU de fato. */
      if (aplicadas.length) {
        await (this.prisma as any).stockMovement
          .createMany({
            data: aplicadas.map((l: any) => ({
              storeCode: loja,
              sku: l.sku,
              delta: l.delta,
              qtyBefore: l.antes,
              qtyAfter: l.depois,
              reason: 'inventario',
              refId: sessao.id,
              note: `inventário: contou ${l.contado}, sistema tinha ${l.esperado}`,
              userId: input.userName ?? null,
            })),
          })
          .catch((e: any) =>
            this.logger.warn(`[inventario] histórico não gravou: ${e?.message || e}`),
          );
        await (this.prisma as any).productEditAudit
          .createMany({
            data: aplicadas.map((l: any) => ({
              batchId,
              codigo: l.sku,
              ref: null,
              field: l.delta > 0 ? 'ESTOQUE_ENTRADA' : 'ESTOQUE_SAIDA',
              oldValue: `loja ${loja}: ${l.antes}`,
              newValue: `${l.depois} (inventário ${sessao.id.slice(0, 8)})`,
              userName: input.userName ?? null,
              applied: true,
            })),
          })
          .catch(() => null);

        /* Peça contada é peça achada: a loja que reportou "não achei" volta a
         * entrar no roteamento pra aquele código. O service já tinha o método
         * esperando exatamente este chamador. */
        for (const l of aplicadas) {
          if (l.contado > 0) {
            await this.extraviadas
              .marcarAchadaPorSku(loja, l.sku, input.userId ?? null)
              .catch(() => null);
          }
        }
      }

      const falhas = linhasAjuste.length - aplicadas.length;
      await (this.prisma as any).inventarioSessao.updateMany({
        where: { id: sessao.id, aplicadaEm: null },
        data: {
          status: aplicadas.length ? 'aplicada' : 'encerrada',
          aplicadaEm: aplicadas.length ? agora : null,
          aplicadaPor: aplicadas.length ? input.userName ?? null : null,
        },
      });

      this.logger.log(
        `[inventario] ${sessao.id}: ${aplicadas.length}/${linhasAjuste.length} ajuste(s) aplicado(s)` +
          (falhas ? ` — ${falhas} falha(s): ${erroGeral || 'não aplicado'}` : ''),
      );
      if (!aplicadas.length) {
        /* Nada entrou: erro HONESTO. Dizer "ajustado" com o estoque parado é o
         * bug do estorno master. */
        throw new BadRequestException(
          `Nenhum ajuste foi aplicado${erroGeral ? `: ${erroGeral}` : ''}. O estoque não mudou.`,
        );
      }
      return {
        ok: true,
        aplicados: aplicadas.length,
        total: linhasAjuste.length,
        falhas,
        pulados: pulados.length,
        erro: falhas ? erroGeral : null,
        batchId,
      };
    } finally {
      this.aplicando.delete(sessao.id);
    }
  }

  /**
   * ZERAR os códigos que ninguém bipou — a decisão que a matriz toma depois de
   * conferir a lista. Sempre por lista explícita de códigos: não existe
   * "zerar tudo" implícito, porque arara que ninguém contou tem exatamente a
   * mesma cara de peça que sumiu.
   */
  async zerarNaoContados(input: {
    sessaoId: string;
    skus: string[];
    motivo?: string | null;
    userName?: string | null;
  }) {
    const sessao = await this.exigirSessao(input.sessaoId);
    if (sessao.status === 'aberta') {
      throw new BadRequestException('Encerre a contagem antes de zerar os não contados');
    }
    const skus = Array.from(new Set((input.skus || []).map(normalizarCodigo).filter(Boolean)));
    if (!skus.length) throw new BadRequestException('Nenhum código informado');
    if (skus.length > 500) throw new BadRequestException('Máximo de 500 códigos por vez');

    /* Trava: código que foi CONTADO não entra aqui de jeito nenhum — o ajuste
     * dele é o delta da contagem, e zerar por cima apagaria a peça contada. */
    const contados = await (this.prisma as any).inventarioEsperado.findMany({
      where: { sessaoId: sessao.id, sku: { in: skus } },
      select: { sku: true },
    });
    if (contados.length) {
      throw new BadRequestException(
        `${contados.length} código(s) desta lista FORAM contados (ex.: ${contados[0].sku}) — esses saem pelo ajuste da contagem, não por aqui`,
      );
    }

    const loja = sessao.storeCode;
    const saldos = await this.saldos(skus, loja);
    const aZerar = skus
      .map((sku) => ({ sku, saldo: saldos.get(sku) ?? 0 }))
      .filter((s) => s.saldo > 0);
    if (!aZerar.length) return { ok: true, zerados: 0, mensagem: 'Nenhum deles tem saldo' };

    const r = await this.erp.decreaseStock(
      aZerar.map((s) => ({ sku: s.sku, qty: s.saldo, storeCode: loja })),
      { allowNegative: false },
    );
    const aplicado = new Map<string, any>(
      (r.applied || []).map((a: any) => [normalizarCodigo(a.sku), a]),
    );

    const linhas = aZerar.map((s) => {
      const ap = aplicado.get(s.sku);
      return {
        sessaoId: sessao.id,
        storeCode: loja,
        sku: s.sku,
        contado: 0,
        esperado: s.saldo,
        delta: -s.saldo,
        tipo: 'zerado_nao_contado',
        antes: ap ? ap.previousStock : null,
        depois: ap ? ap.newStock : null,
        aplicado: !!ap,
        erro: ap ? null : r.error || 'não aplicado',
        rotulo: null,
        criadoPor: input.userName ?? null,
      };
    });
    await (this.prisma as any).inventarioAjuste.createMany({ data: linhas });

    const ok = linhas.filter((l) => l.aplicado);
    if (ok.length) {
      await (this.prisma as any).stockMovement
        .createMany({
          data: ok.map((l) => ({
            storeCode: loja,
            sku: l.sku,
            delta: l.delta,
            qtyBefore: l.antes,
            qtyAfter: l.depois,
            reason: 'inventario_nao_contado',
            refId: sessao.id,
            note: input.motivo?.slice(0, 160) || 'não apareceu na contagem',
            userId: input.userName ?? null,
          })),
        })
        .catch(() => null);
    }
    this.logger.log(
      `[inventario] ${sessao.id}: ${ok.length}/${linhas.length} código(s) não contado(s) zerado(s)`,
    );
    if (!ok.length) {
      throw new BadRequestException(
        `Nenhum código foi zerado${r.error ? `: ${r.error}` : ''}. O estoque não mudou.`,
      );
    }
    return { ok: true, zerados: ok.length, total: linhas.length, falhas: linhas.length - ok.length };
  }
}
