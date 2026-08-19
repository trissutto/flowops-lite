import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { refBaseOf, refsDeBusca } from '../common/ref-base';
import { AvaliacoesConfig, AvaliacoesConfigService } from './avaliacoes-config.service';

/** Uma peça comprada esperando avaliação. */
export interface ItemAvaliavel {
  orderItemId: string;
  orderId: string;
  pedidoNumero: string | null;
  data: Date | null;
  ref: string | null;
  refBase: string;
  cor: string | null;
  tamanho: string | null;
  nome: string;
  foto: string | null;
  slug: string | null;
  /** Quanto ela leva se preencher tudo — é o "Ganhe até N pontos" da tela. */
  pontosPossiveis: number;
}

const CAIMENTOS = ['pequeno', 'fiel', 'grande'];

/**
 * AVALIAÇÃO DE PEÇA — prova social de quem comprou de verdade.
 *
 * Três regras que não se negociam:
 *
 * 1. **Só avalia quem comprou.** O direito nasce de um `OrderItem` da própria
 *    conta, entregue (ou passado o prazo do config). Não existe caminho pra
 *    avaliar peça que a pessoa não levou — é o que separa isto do depoimento
 *    inventado que saiu do ar em 06/08.
 * 2. **Uma avaliação por peça comprada.** A trava é `(accountId, orderItemId)`
 *    no banco: reenviar EDITA, nunca duplica — e ponto se paga uma vez só.
 * 3. **Os pontos saem do config**, nunca do código. Ver
 *    `AvaliacoesConfigService` e a tela /retaguarda/avaliacoes.
 */
@Injectable()
export class AvaliacoesService {
  private readonly logger = new Logger(AvaliacoesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfgSvc: AvaliacoesConfigService,
  ) {}

  /* ───────────────────────────── infra ───────────────────────────── */

  private async conta(accountId: string): Promise<{ id: string; cpf: string }> {
    const acc = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { id: true, cpf: true },
    });
    if (!acc) throw new UnauthorizedException('Conta não encontrada');
    return { id: acc.id, cpf: acc.cpf };
  }

  private lerFotos(raw: any): string[] {
    if (!raw) return [];
    try {
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(v) ? v.filter((u) => typeof u === 'string' && u) : [];
    } catch {
      return [];
    }
  }

  /** Quanto vale uma avaliação completa, com a régua de hoje. */
  private tetoDePontos(cfg: AvaliacoesConfig): number {
    return cfg.pontosEnvio + cfg.pontosTexto + cfg.pontosFoto + cfg.pontosMedidas;
  }

  private contarPalavras(texto?: string | null): number {
    return String(texto || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
  }

  /**
   * Capa da peça pra ilustrar a lista. Procura na COR comprada primeiro: a
   * cliente reconhece a peça pela cor que chegou na casa dela, e mostrar outra
   * faz ela achar que é o pedido de outra pessoa.
   */
  private async fotosPorRef(
    itens: Array<{ refBase: string; cor: string | null }>,
  ): Promise<Map<string, string>> {
    const refs = new Set<string>();
    for (const i of itens) for (const r of refsDeBusca(i.refBase)) refs.add(r);
    if (!refs.size) return new Map();

    const fotos: Array<{ ref: string; cor: string | null; url: string; ordem: number }> = await (
      this.prisma as any
    ).productPhoto.findMany({
      where: { ref: { in: [...refs] } },
      orderBy: { ordem: 'asc' },
      select: { ref: true, cor: true, url: true, ordem: true },
    });

    const mapa = new Map<string, string>();
    for (const item of itens) {
      const chave = `${item.refBase}|${item.cor || ''}`;
      if (mapa.has(chave)) continue;
      const daFamilia = fotos.filter((f) => refsDeBusca(item.refBase).includes(f.ref));
      const corUp = (item.cor || '').trim().toUpperCase();
      const escolhida =
        (corUp && daFamilia.find((f) => (f.cor || '').toUpperCase() === corUp)) ||
        daFamilia.find((f) => !f.cor) ||
        daFamilia[0];
      if (escolhida?.url) mapa.set(chave, escolhida.url);
    }
    return mapa;
  }

  /** REF-BASE → slug do site, pra avaliação linkar de volta pra peça. */
  private async slugsPorRef(refsBase: string[]): Promise<Map<string, string>> {
    const unicas = [...new Set(refsBase.filter(Boolean))];
    if (!unicas.length) return new Map();
    const todas = new Set<string>();
    for (const r of unicas) for (const v of refsDeBusca(r)) todas.add(v);

    const linhas: Array<{ ref: string; slug: string }> = await (this.prisma as any).siteProduto
      .findMany({ where: { ref: { in: [...todas] } }, select: { ref: true, slug: true } })
      .catch(() => []);

    const mapa = new Map<string, string>();
    for (const base of unicas) {
      const achou = linhas.find((l) => refsDeBusca(base).includes(l.ref));
      // Sem curadoria a PDP ainda abre pela REF (`porSlug` aceita `ref-XXX`).
      mapa.set(base, achou?.slug || `ref-${base.toLowerCase()}`);
    }
    return mapa;
  }

  /* ─────────────────── o que está esperando avaliação ─────────────────── */

  /**
   * A peça libera quando a ENTREGA é confirmada — e, se ela nunca for
   * confirmada, no prazo alternativo do config.
   *
   * O prazo alternativo não é preciosismo: rastreio de outro contrato volta
   * sem evento nenhum e retirada em loja nunca tem rastreio. Sem ele, um
   * pedaço das clientes jamais poderia avaliar.
   */
  private liberadoEm(
    pedido: {
      status: string | null;
      paidAt: Date | null;
      deliveredAt: Date | null;
      data: Date | null;
    },
    cfg: AvaliacoesConfig,
  ): Date | null {
    if (!pedido.paidAt) return null;
    const s = String(pedido.status || '').toLowerCase();
    if (s === 'cancelled' || s === 'canceled') return null;

    const dia = 24 * 60 * 60 * 1000;
    if (s === 'delivered') {
      const base = pedido.deliveredAt || pedido.paidAt;
      return new Date(base.getTime() + cfg.diasAposEntrega * dia);
    }
    const base = pedido.data || pedido.paidAt;
    return new Date(base.getTime() + cfg.diasAposPedido * dia);
  }

  /**
   * A peça está avaliável AGORA: já abriu e ainda não fechou.
   *
   * O fechamento existe porque fila que não acaba ninguém começa — quem compra
   * há dois anos abriria a tela com o histórico inteiro esperando resposta.
   */
  private podeAvaliar(
    pedido: {
      status: string | null;
      paidAt: Date | null;
      deliveredAt: Date | null;
      data: Date | null;
    },
    cfg: AvaliacoesConfig,
    agora = Date.now(),
  ): boolean {
    const abre = this.liberadoEm(pedido, cfg);
    if (!abre || abre.getTime() > agora) return false;

    const inicio = pedido.data || pedido.paidAt;
    if (!inicio) return false;
    const fecha = inicio.getTime() + cfg.janelaDias * 24 * 60 * 60 * 1000;
    return agora <= fecha;
  }

  /**
   * Centro de avaliação: o que falta avaliar, o que já foi, e o saldo.
   *
   * Uma chamada só de propósito — a tela tem duas abas e um placar, e três
   * requisições pra montar uma tela é como se perde a aba no celular.
   */
  async centro(accountId: string) {
    const cfg = await this.cfgSvc.get();
    const [pendentes, avaliadas, pontos] = await Promise.all([
      this.pendentes(accountId, cfg),
      this.minhas(accountId),
      this.pontos(accountId),
    ]);
    return {
      ativo: cfg.ativo,
      pontos,
      regras: {
        pontosEnvio: cfg.pontosEnvio,
        pontosTexto: cfg.pontosTexto,
        pontosFoto: cfg.pontosFoto,
        pontosMedidas: cfg.pontosMedidas,
        minPalavras: cfg.minPalavras,
        maxFotos: cfg.maxFotos,
        teto: this.tetoDePontos(cfg),
        diasAposPedido: cfg.diasAposPedido,
        janelaDias: cfg.janelaDias,
        moderacao: cfg.moderacao,
      },
      pendentes,
      avaliadas,
    };
  }

  async pendentes(accountId: string, cfgIn?: AvaliacoesConfig): Promise<ItemAvaliavel[]> {
    const cfg = cfgIn ?? (await this.cfgSvc.get());
    if (!cfg.ativo) return [];
    const acc = await this.conta(accountId);

    const pedidos = await this.prisma.order.findMany({
      where: { customerCpf: acc.cpf, paidAt: { not: null } },
      orderBy: { wcDateCreated: 'desc' },
      take: 50,
      select: {
        id: true,
        wcOrderNumber: true,
        status: true,
        paidAt: true,
        deliveredAt: true,
        wcDateCreated: true,
        items: {
          select: {
            id: true,
            ref: true,
            cor: true,
            tamanho: true,
            productName: true,
            sku: true,
          },
        },
      },
    });

    const agora = Date.now();
    const liberados = pedidos.filter((p) =>
      this.podeAvaliar(
        {
          status: p.status,
          paidAt: p.paidAt,
          deliveredAt: p.deliveredAt,
          data: p.wcDateCreated,
        },
        cfg,
        agora,
      ),
    );
    if (!liberados.length) return [];

    const itemIds = liberados.flatMap((p) => p.items.map((i) => i.id));
    const jaAvaliados: Array<{ orderItemId: string | null }> = await (
      this.prisma as any
    ).productReview.findMany({
      where: { accountId, orderItemId: { in: itemIds } },
      select: { orderItemId: true },
    });
    const avaliados = new Set(jaAvaliados.map((r) => r.orderItemId));

    const crus = liberados.flatMap((p) =>
      p.items
        .filter((i) => !avaliados.has(i.id))
        // Linha sem REF é frete/ajuste que entrou como item — não é peça.
        .filter((i) => !!refBaseOf(i.ref || i.sku))
        .map((i) => ({
          orderItemId: i.id,
          orderId: p.id,
          pedidoNumero: p.wcOrderNumber,
          data: p.wcDateCreated,
          ref: i.ref,
          refBase: refBaseOf(i.ref || i.sku),
          cor: i.cor,
          tamanho: i.tamanho,
          nome: i.productName || i.ref || 'Peça',
        })),
    );

    const [fotos, slugs] = await Promise.all([
      this.fotosPorRef(crus),
      this.slugsPorRef(crus.map((c) => c.refBase)),
    ]);
    const teto = this.tetoDePontos(cfg);

    return crus.map((c) => ({
      ...c,
      foto: fotos.get(`${c.refBase}|${c.cor || ''}`) ?? null,
      slug: slugs.get(c.refBase) ?? null,
      pontosPossiveis: teto,
    }));
  }

  /** O que a cliente já avaliou (aba "Avaliado"). */
  async minhas(accountId: string) {
    const linhas: any[] = await (this.prisma as any).productReview.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const slugs = await this.slugsPorRef(linhas.map((l) => l.refBase));
    return linhas.map((l) => ({
      id: l.id,
      refBase: l.refBase,
      slug: slugs.get(l.refBase) ?? null,
      nome: l.produtoNome,
      cor: l.cor,
      tamanho: l.tamanho,
      nota: l.nota,
      texto: l.texto,
      fotos: this.lerFotos(l.fotos),
      caimento: l.caimento,
      pontos: l.pontos,
      status: l.status,
      data: l.createdAt,
    }));
  }

  /** Só o número, pro contador da barra de "Minha conta". */
  async contarPendentes(accountId: string): Promise<number> {
    try {
      return (await this.pendentes(accountId)).length;
    } catch (e: any) {
      // A barra inteira não pode cair por causa de um contador.
      this.logger.warn(`[avaliacoes] contarPendentes falhou: ${e?.message}`);
      return 0;
    }
  }

  /* ──────────────────────────── enviar ──────────────────────────── */

  async criar(
    accountId: string,
    dto: {
      orderItemId?: string;
      nota?: number;
      texto?: string | null;
      fotos?: string[];
      caimento?: string | null;
      alturaCm?: number | null;
      pesoKg?: number | null;
      publicarMedidas?: boolean;
    },
  ) {
    const cfg = await this.cfgSvc.get();
    if (!cfg.ativo) {
      throw new BadRequestException('O programa de avaliação está desativado no momento.');
    }

    const nota = Math.round(Number(dto.nota));
    if (!Number.isFinite(nota) || nota < 1 || nota > 5) {
      throw new BadRequestException('Escolha de 1 a 5 estrelas.');
    }
    const orderItemId = String(dto.orderItemId || '').trim();
    if (!orderItemId) throw new BadRequestException('Peça não informada.');

    const caimento = dto.caimento ? String(dto.caimento).toLowerCase() : null;
    if (caimento && !CAIMENTOS.includes(caimento)) {
      throw new BadRequestException(`caimento inválido (use: ${CAIMENTOS.join(', ')})`);
    }

    // O item precisa ser DELA e estar liberado. Conferir na fonte (e não no
    // que o navegador mandou) é o que impede avaliar peça de outra pessoa.
    const acc = await this.conta(accountId);
    const item = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      select: {
        id: true,
        ref: true,
        sku: true,
        cor: true,
        tamanho: true,
        productName: true,
        order: {
          select: {
            id: true,
            customerCpf: true,
            status: true,
            paidAt: true,
            deliveredAt: true,
            wcDateCreated: true,
          },
        },
      },
    });
    if (!item || !item.order || item.order.customerCpf !== acc.cpf) {
      throw new ForbiddenException('Essa peça não está nos seus pedidos.');
    }
    const liberado = this.podeAvaliar(
      {
        status: item.order.status,
        paidAt: item.order.paidAt,
        deliveredAt: item.order.deliveredAt,
        data: item.order.wcDateCreated,
      },
      cfg,
    );
    if (!liberado) {
      throw new BadRequestException('Esta peça não está no prazo de avaliação.');
    }

    const fotos = this.validarFotos(dto.fotos, cfg);
    const texto = String(dto.texto || '').trim() || null;
    const altura = this.numeroOuNulo(dto.alturaCm, 120, 220);
    const peso = this.numeroOuNulo(dto.pesoKg, 30, 250);

    const dados = {
      accountId,
      orderId: item.order.id,
      orderItemId: item.id,
      refBase: refBaseOf(item.ref || item.sku),
      ref: item.ref,
      cor: item.cor,
      tamanho: item.tamanho,
      produtoNome: item.productName,
      nota,
      texto,
      fotos: fotos.length ? JSON.stringify(fotos) : null,
      caimento,
      alturaCm: altura,
      pesoKg: peso,
      publicarMedidas: !!dto.publicarMedidas,
      status: cfg.moderacao ? 'oculta' : 'publicada',
    };

    const existente = await (this.prisma as any).productReview.findFirst({
      where: { accountId, orderItemId: item.id },
      select: { id: true, pontos: true },
    });

    // Reenvio EDITA e não paga de novo: ponto por avaliação se ganha uma vez,
    // senão bastaria salvar dez vezes a mesma peça pra virar saldo.
    if (existente) {
      const atualizada = await (this.prisma as any).productReview.update({
        where: { id: existente.id },
        data: dados,
      });
      return { ok: true, id: atualizada.id, pontosGanhos: 0, jaAvaliada: true };
    }

    const pontos = this.calcularPontos({ texto, fotos, altura, peso }, cfg);
    const criada = await (this.prisma as any).productReview.create({
      data: { ...dados, pontos },
    });

    if (pontos > 0) {
      await (this.prisma as any).customerPointsTx.create({
        data: {
          accountId,
          pontos,
          motivo: 'avaliacao',
          refId: criada.id,
          descricao: `Avaliação de ${dados.produtoNome || dados.refBase}`,
        },
      });
    }

    this.logger.log(
      `[avaliacoes] conta=${accountId.slice(0, 8)} ref=${dados.refBase} nota=${nota} ` +
        `fotos=${fotos.length} caimento=${caimento || '-'} -> ${pontos} pontos`,
    );

    return { ok: true, id: criada.id, pontosGanhos: pontos, jaAvaliada: false };
  }

  /**
   * Foto só vale se veio do NOSSO upload. Sem esta trava o campo aceitaria
   * qualquer URL — e a página de produto viraria vitrine de imagem hospedada
   * fora, fora do nosso controle.
   */
  private validarFotos(fotos: unknown, cfg: AvaliacoesConfig): string[] {
    const lista = Array.isArray(fotos) ? fotos : [];
    const base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    const limpas = lista
      .map((f) => String(f || '').trim())
      .filter((f) => f && (!base || f.startsWith(base)));
    if (limpas.length > cfg.maxFotos) {
      throw new BadRequestException(`No máximo ${cfg.maxFotos} fotos por avaliação.`);
    }
    return limpas;
  }

  private numeroOuNulo(v: unknown, min: number, max: number): number | null {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return n;
  }

  /**
   * PREMIA QUEM AVALIA, NÃO QUEM ELOGIA (decisão de 12/08).
   *
   * Nenhuma parcela olha a NOTA: se 5 estrelas pagasse mais que 2, o programa
   * compraria elogio e a avaliação perderia justamente o valor que a fez
   * existir. O que paga é o trabalho — escrever, fotografar, informar medida.
   */
  private calcularPontos(
    entrada: {
      texto: string | null;
      fotos: string[];
      altura: number | null;
      peso: number | null;
    },
    cfg: AvaliacoesConfig,
  ): number {
    let total = cfg.pontosEnvio;
    if (this.contarPalavras(entrada.texto) >= cfg.minPalavras) total += cfg.pontosTexto;
    if (entrada.fotos.length > 0) total += cfg.pontosFoto;
    if (entrada.altura && entrada.peso) total += cfg.pontosMedidas;
    return total;
  }

  /* ──────────────────────────── pontos ──────────────────────────── */

  async pontos(accountId: string) {
    const cfg = await this.cfgSvc.get();
    const linhas: Array<{
      pontos: number;
      motivo: string;
      descricao: string | null;
      createdAt: Date;
    }> = await (this.prisma as any).customerPointsTx.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    /**
     * ⚠️ O SALDO SOMA O BANCO, NÃO A PÁGINA.
     *
     * O `take: 50` acima é do EXTRATO — é quanto a tela mostra. Somar essas 50
     * linhas dava o saldo certo só até a 51ª movimentação; da 51ª em diante a
     * cliente perderia pontos em silêncio (as linhas mais antigas caem fora da
     * página e somem da conta). Enquanto não havia resgate isso era um número
     * errado na tela; com resgate no ar, vira dinheiro.
     */
    const total = await (this.prisma as any).customerPointsTx.aggregate({
      where: { accountId },
      _sum: { pontos: true },
    });
    const saldo = Number(total?._sum?.pontos ?? 0);

    return {
      saldo,
      pontosPorReal: cfg.pontosPorReal,
      minimoResgate: cfg.minimoResgate,
      /** Quanto o saldo vale hoje — a conta feita pra ela, sem calculadora. */
      equivaleReais: cfg.pontosPorReal > 0 ? Math.floor(saldo / cfg.pontosPorReal) : 0,
      extrato: linhas.map((l) => ({
        pontos: l.pontos,
        motivo: l.motivo,
        descricao: l.descricao,
        data: l.createdAt,
      })),
    };
  }

  /**
   * RESGATE — os pontos viram um cupom NOMINAL, do CPF dela e de mais ninguém.
   *
   * Reaproveita a máquina do vale-troca (`site_cupons` com `cpf` preenchido),
   * que o `CupomService` já confere no carrinho E no fechamento — quem cobra é
   * quem recalcula. Inventar um segundo tipo de desconto seria criar uma
   * segunda regra de dinheiro pra manter em dia.
   *
   * ── A ORDEM IMPORTA ──
   *
   * O cupom nasce ANTES do débito. Se a criação falhar, ela não perde ponto; o
   * contrário — debitar e não conseguir criar — deixaria a cliente sem saldo E
   * sem desconto, que é o pior dos dois lados.
   */
  async resgatar(accountId: string, pontosPedidos: number) {
    const cfg = await this.cfgSvc.get();
    const acc = await this.conta(accountId);

    const pedidos = Math.trunc(Number(pontosPedidos) || 0);
    if (pedidos < cfg.minimoResgate) {
      throw new BadRequestException(`O resgate mínimo é de ${cfg.minimoResgate} pontos.`);
    }
    // Múltiplos exatos: ninguém perde fração de ponto no arredondamento.
    if (pedidos % cfg.pontosPorReal !== 0) {
      throw new BadRequestException(`Resgate em múltiplos de ${cfg.pontosPorReal} pontos.`);
    }

    const { saldo } = await this.pontos(accountId);
    if (saldo < pedidos) throw new BadRequestException('Saldo insuficiente.');

    const valor = Math.floor(pedidos / cfg.pontosPorReal);
    const code = `PONTOS${acc.cpf.slice(-4)}${Date.now().toString(36).toUpperCase().slice(-5)}`;

    await (this.prisma as any).siteCupom.create({
      data: {
        code,
        label: `Seus pontos: R$ ${valor},00 de desconto`,
        tipo: 'fixed',
        valor,
        cpf: acc.cpf,
        origem: 'pontos',
        usoMaximo: 1,
        ativo: true,
        // 90 dias: prazo curto vira reclamação, eterno vira passivo esquecido.
        fimEm: new Date(Date.now() + 90 * 86_400_000),
      },
    });

    await (this.prisma as any).customerPointsTx.create({
      data: {
        accountId,
        pontos: -pedidos,
        motivo: 'resgate',
        descricao: `Cupom ${code} — R$ ${valor},00`,
      },
    });

    this.logger.log(`[avaliacoes] resgate ${pedidos} pontos -> ${code} (R$ ${valor})`);
    return { ok: true, code, valor, saldo: saldo - pedidos };
  }

  /* ────────────────────── o que o site mostra ────────────────────── */

  /**
   * Avaliações de uma peça (família), pra PDP.
   *
   * Nome abreviado ("Maria S."): a avaliação é pública e o CRM tem o nome
   * inteiro — publicar sobrenome de cliente é dado pessoal exposto por
   * conveniência de layout.
   */
  async doProduto(refOuSlug: string, limite = 20) {
    const chave = String(refOuSlug || '').trim();
    if (!chave) return this.vazioDoProduto();

    let refBase = refBaseOf(chave.replace(/^ref-/i, ''));
    const porSlug = await (this.prisma as any).siteProduto
      .findUnique({ where: { slug: chave }, select: { ref: true } })
      .catch(() => null);
    if (porSlug?.ref) refBase = refBaseOf(porSlug.ref);

    const linhas: any[] = await (this.prisma as any).productReview.findMany({
      where: { refBase, status: 'publicada' },
      orderBy: [{ createdAt: 'desc' }],
      take: Math.min(Math.max(Number(limite) || 20, 1), 50),
    });
    if (!linhas.length) return this.vazioDoProduto();

    const contas = await this.prisma.customerAccount.findMany({
      where: { id: { in: [...new Set(linhas.map((l) => l.accountId))] } },
      select: { id: true, name: true },
    });
    const nomes = new Map(contas.map((c) => [c.id, this.nomeCurto(c.name)]));

    const total = linhas.length;
    const soma = linhas.reduce((s, l) => s + (Number(l.nota) || 0), 0);
    const distribuicao = [5, 4, 3, 2, 1].map((estrelas) => ({
      estrelas,
      quantas: linhas.filter((l) => Number(l.nota) === estrelas).length,
    }));
    const comCaimento = linhas.filter((l) => CAIMENTOS.includes(String(l.caimento || '')));

    return {
      total,
      media: Math.round((soma / total) * 10) / 10,
      distribuicao,
      caimento: {
        total: comCaimento.length,
        pequeno: comCaimento.filter((l) => l.caimento === 'pequeno').length,
        fiel: comCaimento.filter((l) => l.caimento === 'fiel').length,
        grande: comCaimento.filter((l) => l.caimento === 'grande').length,
      },
      avaliacoes: linhas.map((l) => ({
        id: l.id,
        nome: nomes.get(l.accountId) || 'Cliente',
        nota: l.nota,
        texto: l.texto,
        fotos: this.lerFotos(l.fotos),
        cor: l.cor,
        tamanho: l.tamanho,
        caimento: l.caimento,
        // Altura e peso só saem se a cliente marcou que podia.
        alturaCm: l.publicarMedidas ? l.alturaCm : null,
        pesoKg: l.publicarMedidas ? l.pesoKg : null,
        data: l.createdAt,
      })),
    };
  }

  private vazioDoProduto() {
    return {
      total: 0,
      media: 0,
      distribuicao: [5, 4, 3, 2, 1].map((estrelas) => ({ estrelas, quantas: 0 })),
      caimento: { total: 0, pequeno: 0, fiel: 0, grande: 0 },
      avaliacoes: [] as any[],
    };
  }

  private nomeCurto(nome?: string | null): string {
    const partes = String(nome || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!partes.length) return 'Cliente';
    const primeiro = partes[0];
    const inicial = partes.length > 1 ? ` ${partes[partes.length - 1][0].toUpperCase()}.` : '';
    return `${primeiro}${inicial}`;
  }

  /* ──────────────────────────── matriz ──────────────────────────── */

  async listarAdmin(filtros: { status?: string; ref?: string; limite?: number }) {
    const where: any = {};
    if (filtros.status && filtros.status !== 'todas') where.status = filtros.status;
    if (filtros.ref) where.refBase = refBaseOf(filtros.ref);

    const linhas: any[] = await (this.prisma as any).productReview.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(filtros.limite) || 100, 1), 300),
    });
    const contas = await this.prisma.customerAccount.findMany({
      where: { id: { in: [...new Set(linhas.map((l) => l.accountId))] } },
      select: { id: true, name: true, cpf: true },
    });
    const mapa = new Map(contas.map((c) => [c.id, c]));

    return {
      total: linhas.length,
      avaliacoes: linhas.map((l) => ({
        id: l.id,
        cliente: mapa.get(l.accountId)?.name || null,
        cpf: mapa.get(l.accountId)?.cpf || null,
        refBase: l.refBase,
        produtoNome: l.produtoNome,
        cor: l.cor,
        tamanho: l.tamanho,
        nota: l.nota,
        texto: l.texto,
        fotos: this.lerFotos(l.fotos),
        caimento: l.caimento,
        alturaCm: l.alturaCm,
        pesoKg: l.pesoKg,
        publicarMedidas: l.publicarMedidas,
        pontos: l.pontos,
        status: l.status,
        data: l.createdAt,
      })),
    };
  }

  async moderar(id: string, status: string) {
    const alvo = status === 'oculta' ? 'oculta' : 'publicada';
    await (this.prisma as any).productReview.update({
      where: { id },
      data: { status: alvo },
    });
    return { ok: true, id, status: alvo };
  }

  /** Painel da matriz: o tamanho do programa em números. */
  async resumoAdmin() {
    const linhas: any[] = await (this.prisma as any).productReview.findMany({
      select: { nota: true, status: true, fotos: true, pontos: true, createdAt: true },
    });
    const trintaDias = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const publicadas = linhas.filter((l) => l.status === 'publicada');
    return {
      total: linhas.length,
      publicadas: publicadas.length,
      ocultas: linhas.length - publicadas.length,
      comFoto: linhas.filter((l) => this.lerFotos(l.fotos).length > 0).length,
      media: publicadas.length
        ? Math.round(
            (publicadas.reduce((s, l) => s + (Number(l.nota) || 0), 0) / publicadas.length) * 10,
          ) / 10
        : 0,
      ultimos30: linhas.filter((l) => new Date(l.createdAt).getTime() >= trintaDias).length,
      pontosDistribuidos: linhas.reduce((s, l) => s + (Number(l.pontos) || 0), 0),
    };
  }
}
