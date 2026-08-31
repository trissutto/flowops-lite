import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from '../crediarios/crediarios.service';
import { PrismaService } from '../prisma/prisma.service';
import { escritaGigaBloqueada } from '../common/replica-giga';
import { MarcadosMirrorService } from './marcados-mirror.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';

/**
 * MARCADOS — sistema de "leva pra provar em casa" da Lurd's.
 *
 * Como funciona no Giga (descoberto na inspeção do schema):
 *  - A tabela `caixa` tem coluna **MARCADO varchar(3)** (valores: 'SIM' / 'NAO').
 *  - Quando vendedora "marca" peça, grava linha em `caixa` com MARCADO='SIM'.
 *  - Estoque já é baixado (linha em caixa = baixa de estoque).
 *  - Cliente leva pra casa, prova, traz devolução do que não quis.
 *  - Vendedora abre o marcado, marca o que VOLTOU:
 *      - Voltou: DELETE FROM caixa + increaseStock (peça volta pro estoque)
 *      - Ficou:  UPDATE caixa SET MARCADO='NAO' (vira venda)
 *
 * Validação de quem pode marcar:
 *  - Tabela `clientes` tem coluna AVALIACAO varchar(2) (A=top cliente)
 *  - LIMITECOMPRAS decimal(10,2) = teto total de marcados ativos
 *  - Cliente só pode marcar se AVALIACAO='A' E (totalMarcadosAtivos + valorVenda) <= LIMITECOMPRAS
 */
@Injectable()
export class MarcadosService {
  private readonly logger = new Logger(MarcadosService.name);

  constructor(
    private readonly erp: ErpService,
    private readonly crediarios: CrediariosService,
    private readonly prisma: PrismaService,
    private readonly mirror: MarcadosMirrorService,
    private readonly catalog: WincredCatalogService,
  ) {}

  /**
   * MARCADOS_NATIVE_READS=1 liga as consultas pelo espelho nativo.
   *
   * DEFAULT OFF (26/07). Era `?? '' !== '0'` — ou seja, LIGADO quando a
   * variável não existe no ambiente. Foi exatamente assim que o crediário
   * sumiu do PDV em 25/07: a flag nunca foi criada no Railway e o deploy
   * ativou a migração de leitura sozinho. Migração de leitura se liga por
   * decisão, nunca por omissão.
   */
  private get nativeReads(): boolean {
    return String(process.env.MARCADOS_NATIVE_READS ?? '0').trim() === '1';
  }

  /** Leituras nativas valem se a flag está ligada E o espelho já foi importado. */
  private async useNative(): Promise<boolean> {
    if (!this.nativeReads) return false;
    try { return await this.mirror.hasMirror(); } catch { return false; }
  }

  /**
   * Código do cliente no Giga tem padding de zero inconsistente ('01234' e
   * '1234' são a MESMA pessoa). Comparar string crua contra o espelho devolve
   * vazio e o marcado "some" — foi uma das causas do incidente do crediário.
   */
  private codVariants(cod: string | number): string[] {
    const c = String(cod ?? '').trim();
    const set = new Set<string>();
    if (c) set.add(c);
    const noZeros = c.replace(/^0+/, '');
    if (noZeros) set.add(noZeros);
    if (/^\d+$/.test(c)) set.add(String(Number(c)));
    return [...set];
  }

  /**
   * Converte a linha nativa pro shape UPPERCASE que as telas já consomem.
   *
   * `id` é o identificador REAL agora (07/08, regra do dono: nunca mais
   * depender do Giga pra marcado). `REGISTRO` continua no shape só de
   * referência/exibição — pode vir `null` pra sempre num marcado 100% Flow,
   * e isso é esperado, não um erro a corrigir.
   */
  private toGigaShape(m: any): any {
    return {
      id: m.id,
      REGISTRO: m.registroGiga != null ? Number(m.registroGiga) : null,
      NUMERO: m.numero ?? null,
      CODIGO: m.sku,
      DATA: m.dataMarcacao,
      DESCRICAO: m.descricao || '',
      QUANTIDADE: m.qty,
      VALOR: Number(m.valorUnit) || 0,
      VALORTOTAL: Number(m.valorTotal) || 0,
      VENDEDOR: m.vendedor ?? null,
      OPERADOR: 0,
      LOJA: m.storeCode,
    };
  }

  /**
   * Cria UM marcado a partir de uma venda PDV existente.
   *
   * Steps:
   *  1. Carrega venda + items + customer
   *  2. Valida: cliente identificado + classe A + limite suficiente
   *  3. Pra cada item: INSERT em `caixa` do Giga com MARCADO='SIM'
   *  4. Baixa estoque Giga (decreaseStock — peças saem do estoque físico)
   *  5. Atualiza PdvSale: status='finalized', paymentMethod='MARCADO'
   *
   * Retorno: { ok, controle, totalItems, totalValor }
   */
  async criarMarcadoFromSale(input: {
    saleId: string;
    storeCode: string;
    userId?: string;
    userName?: string;
    /**
     * Quando true, pula a validação de limite de marcação (gerente forçou
     * pela UI sabendo que o cliente tem marcações antigas acumuladas).
     * Ainda valida classe A e CPF identificado — só relaxa o limite.
     */
    force?: boolean;
    /**
     * MODO TREINAMENTO — sessão com header x-training-mode. Em treino NÃO
     * insere em caixa do Giga e NÃO baixa estoque; só fecha a venda local
     * (isTraining=true) e retorna sucesso simulado.
     */
    trainingRequest?: boolean;
  }): Promise<{
    ok: boolean;
    controle?: number | string;
    totalItems?: number;
    totalValor?: number;
    forced?: boolean;
    training?: boolean;
    error?: string;
  }> {
    // 1. Carrega venda
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') {
      throw new BadRequestException(`Venda já está ${sale.status} — não dá pra marcar`);
    }
    if (!sale.items || sale.items.length === 0) {
      throw new BadRequestException('Venda sem items');
    }
    // TRAVA ANTI-DUPLICAÇÃO: venda que veio de "Puxar pra venda" já tem as peças
    // EM MARCA (marcadosRegistros). Marcar de novo re-insere tudo e duplica (o
    // que aconteceu na Leticia). Pra vender é só finalizar — não re-marcar.
    if (sale.marcadosRegistros) {
      throw new BadRequestException(
        'Essa venda foi PUXADA de marcados — as peças já estão em marca. Pra concluir, ' +
        'FINALIZE a venda (vender). Não dá pra marcar de novo (evita duplicar).',
      );
    }

    // ── MODO TREINAMENTO ──
    // União: venda já criada em treino OU sessão atual em treino (header).
    // NÃO insere em caixa do Giga, NÃO baixa estoque (regra ouro do
    // training.util) — só fecha a venda local como treino e simula sucesso.
    const isTraining = !!(sale as any).isTraining || !!input.trainingRequest;
    if (isTraining) {
      await (this.prisma as any).pdvSale.update({
        where: { id: input.saleId },
        data: {
          status: 'finalized',
          paymentMethod: 'MARCADO',
          finalizedAt: new Date(),
          isTraining: true,
        },
      });
      this.logger.log(
        `[marcados→TREINO] marcado simulado — skip insertCaixaMarcado/decreaseStock · ` +
        `saleId=${input.saleId} items=${sale.items.length} total=R$${Number(sale.total).toFixed(2)}`,
      );
      return {
        ok: true,
        training: true,
        controle: 'TREINO',
        totalItems: sale.items.length,
        totalValor: Number(sale.total),
      };
    }

    // 2. Valida cliente
    if (!sale.customerCpf) {
      throw new BadRequestException('Cliente precisa estar identificado pra marcar');
    }
    const info = await this.getClienteMarcadorInfo(sale.customerCpf);
    if (!info.permitido) {
      throw new BadRequestException(info.motivo || 'Cliente não pode marcar');
    }
    // Validação de limite: gerente pode forçar via force=true quando sabe
    // que tem marcações antigas (MARCADO=SIM no Giga nunca limpo). Loga
    // quem forçou pra auditoria.
    if (Number(sale.total) > info.limiteDisponivel) {
      if (!input.force) {
        throw new BadRequestException(
          `Valor da venda (R$ ${Number(sale.total).toFixed(2)}) maior que limite disponível ` +
          `(R$ ${info.limiteDisponivel.toFixed(2)}). Cliente já tem R$ ${info.totalMarcadosAtivos.toFixed(2)} em marca`,
        );
      }
      this.logger.warn(
        `[marcados/FORCE] ${input.userName || input.userId || 'user'} forçou marcação ` +
        `de R$${Number(sale.total).toFixed(2)} pra cliente ${info.cliente.nome} ` +
        `(limite R$${info.cliente.limiteTotal.toFixed(2)}, já em marca R$${info.totalMarcadosAtivos.toFixed(2)}, ` +
        `disponível R$${info.limiteDisponivel.toFixed(2)})`,
      );
    }

    // 3. Grava o marcado — FLOW PRIMEIRO, Giga é réplica
    const codCliente = Number(info.cliente.codCliente) || 0;
    if (!codCliente) {
      throw new BadRequestException('Código do cliente não encontrado');
    }

    const itensGiga = sale.items.map((it: any) => ({
      codigo: String(it.sku || it.ref || '').trim(),
      descricao: String(it.descricao || '').slice(0, 100),
      quantidade: Number(it.qty) || 1,
      valor: Number(it.precoUnit) || 0,
      valorTotal: Number(it.total) || 0,
      vendedor: 0, // TODO: mapear sellerId pro código numérico do vendedor Giga
      operador: 0,
    }));

    // ORDEM INVERTIDA (31/07). Antes o INSERT no Giga vinha primeiro e um
    // `throw` derrubava a operação inteira — era a ÚNICA escrita do sistema que
    // fazia isso; todas as outras degradam pra fila ou log. Com o Giga
    // pendurado (o firewall da KingHost derruba o IP do Railway e o MySQL trava
    // sem dar erro), a peça saía com a cliente e não ficava registrada em lugar
    // nenhum — nem no Flow, porque a gravação nativa vinha DEPOIS do throw.
    //
    // A identidade do marcado é `Marcado.id` (cuid do Flow). `numero` e
    // `registroGiga` são detalhe da réplica: nascem nulos e são preenchidos
    // quando o Giga confirma. O schema já os declara opcionais e as leituras já
    // tratam a ausência.
    //
    // Por que não dar um número do Flow pro `numero`: ele vai pra `caixa.NUMERO`,
    // que é FLOAT de precisão simples no Giga — inteiro só é exato até
    // 16.777.216. Uma faixa alta (900.000.001, 900.000.002) colapsaria no MESMO
    // valor e fundiria marcados diferentes. Medido em
    // `scripts/giga-etl/medir-numero-caixa.js`.
    //
    // 🔴 SEM GIGA (07/08, regra do dono: "nunca marque ou puxe nada do Giga").
    // O marcado nasce e vive 100% no Flow. Sem INSERT em `caixa`, sem réplica,
    // sem fila de escrita — `registroGiga`/`numero` continuam existindo no
    // schema só como HISTÓRICO do que já veio de lá (ver `MarcadosMirrorService`
    // e o botão "Restos dos marcados do Giga"), nunca mais preenchidos por
    // marcado NOVO. A identidade é `Marcado.id`, ponto final.
    const lojaCode = String(input.storeCode || '').trim().toUpperCase().replace(/^LJ/i, '').padStart(2, '0');
    await this.gravarMarcadosNativos({ sale, info, codCliente, lojaCode, controle: null });

    // 4. Baixa estoque (igual venda — peças saem do estoque; isto é o outbox
    // GERAL de inventário, não o mecanismo de marcado — fora do escopo desta
    // regra, segue como já era).
    // A peça marcada sai do estoque do FLOW — não depende da escrita no Giga.
    if (!escritaGigaBloqueada(this.erp.isWriteEnabled)) {
      const stockItems = sale.items.map((it: any) => ({
        sku: String(it.sku || it.ref || '').trim(),
        qty: Number(it.qty) || 1,
        storeCode: input.storeCode,
      }));
      const stockResult = await this.erp.decreaseStockAsync(stockItems);
      if (!stockResult.success) {
        this.logger.error(
          `[marcados] marcado gravado no Flow, mas falha ao baixar estoque: ${stockResult.error}. ` +
          `Pode ter divergência ERP×físico. Investigar manualmente.`,
        );
        // Não rollback — peça marcada no Flow, retaguarda decide
      }
    }

    // 5. Atualiza venda PDV — vira "finalized" com paymentMethod='MARCADO'
    await (this.prisma as any).pdvSale.update({
      where: { id: input.saleId },
      data: {
        status: 'finalized',
        paymentMethod: 'MARCADO',
        finalizedAt: new Date(),
      },
    });

    this.logger.log(
      `[marcados] Marcado criado: cliente=${info.cliente.nome} (cod ${codCliente}) ` +
      `total=R$${Number(sale.total).toFixed(2)} items=${sale.items.length}`,
    );

    // `controle` é o comprovante que a vendedora vê. Sem Giga não existe
    // número dele — cai pro final do código da venda, que identifica o
    // marcado do mesmo jeito na consulta e não deixa a tela sem referência.
    return {
      ok: true,
      controle: `V-${String(input.saleId).slice(-6).toUpperCase()}`,
      totalItems: sale.items.length,
      totalValor: Number(sale.total),
      forced: Number(sale.total) > info.limiteDisponivel,
    };
  }

  /**
   * Cria as linhas NATIVAS do marcado — a ÚNICA gravação que existe agora
   * (07/08). `controle`/`registroGiga` continuam no schema como campo
   * histórico (marcado antigo, de origem Giga, ainda os tem) mas todo
   * marcado NOVO nasce e fica com os dois nulos pra sempre — não há mais
   * réplica que os preencha depois.
   */
  private async gravarMarcadosNativos(input: {
    sale: any;
    info: any;
    codCliente: number;
    lojaCode: string;
    controle: number | null;
  }): Promise<string[]> {
    const { sale, info, codCliente, lojaCode } = input;

    const ids: string[] = [];
    for (const it of sale.items) {
      const sku = String(it.sku || it.ref || '').trim();
      const criado = await (this.prisma as any).marcado.create({
        data: {
          registroGiga: null,
          storeCode: lojaCode,
          codCliente: String(codCliente),
          clienteNome: info.cliente?.nome || null,
          cpf: String(sale.customerCpf || '').replace(/\D/g, '') || null,
          numero: null,
          sku: sku.slice(0, 60),
          descricao: String(it.descricao || '').slice(0, 160) || null,
          qty: Number(it.qty) || 1,
          valorUnit: Number(it.precoUnit) || 0,
          valorTotal: Number(it.total) || 0,
          dataMarcacao: new Date(),
          status: 'ativo',
          origem: 'flow',
          saleId: sale.id,
        },
        select: { id: true },
      });
      ids.push(criado.id);
    }
    return ids;
  }

  /**
   * Enfileira a REMOÇÃO da linha da caixa do Giga quando o DELETE inline falha.
   *
   * O marcado já está devolvido no Flow quando isto roda. A linha órfã no Giga
   * faria a cliente aparecer devendo uma peça que ela já trouxe de volta — por
   * isso a fila insiste, em vez de mandar a vendedora "resolver no Wincred".
   */
  /**
   * DIAGNÓSTICO — estado cru dos marcados de um cliente (07/08, caso Eliana).
   * Read-only. Mostra exatamente onde cada linha travou: sem `saleId` nunca
   * foi puxada; com `saleId` mas ainda 'ativo' quer dizer que a tentativa de
   * puxar não conseguiu casar a linha (provável: `registroGiga`/`numero`
   * nulos — marcado 'flow' cuja réplica pro Giga nunca confirmou).
   */
  async diagnosticarCliente(loja: string, codCliente: string) {
    const lojaNorm = String(loja).replace(/\D/g, '').padStart(2, '0');
    const rows: any[] = await (this.prisma as any).marcado.findMany({
      where: { storeCode: lojaNorm, codCliente: String(codCliente).trim() },
      select: {
        id: true, sku: true, descricao: true, status: true, saleId: true,
        registroGiga: true, numero: true, origem: true, dataMarcacao: true,
      },
      orderBy: { dataMarcacao: 'desc' },
    });
    const saleIds = [...new Set(rows.map((r) => r.saleId).filter(Boolean))];
    const vendas: any[] = saleIds.length
      ? await (this.prisma as any).pdvSale.findMany({
          where: { id: { in: saleIds } },
          select: { id: true, status: true, paymentMethod: true, total: true, marcadosRegistros: true },
        })
      : [];
    return {
      marcados: rows.map((r) => ({
        ...r, registroGiga: r.registroGiga != null ? Number(r.registroGiga) : null,
      })),
      vendasEnvolvidas: vendas,
    };
  }

  /**
   * RECONCILIAÇÃO — fecha os marcados que ficaram "puxado" presos de uma
   * venda que JÁ FINALIZOU (07/08, caso Limeira). Existiam porque
   * `erpStepFecharMarcados` (antes do conserto de hoje) só fechava o status
   * nativo se a escrita no Giga também acontecesse — venda 100% ok, marcado
   * preso pra sempre. Isto é o remendo pro que já ficou preso; o conserto da
   * causa é em `PdvService.erpStepFecharMarcados`.
   *
   * Escopo: `status='puxado'` cuja `PdvSale` já terminou.
   *   venda `finalized` → 'fechado' (a peça foi vendida mesmo);
   *   venda `cancelled` → 'ativo' de volta pra tela (31/08).
   * Venda `open` NUNCA é tocada — ali 'puxado' ainda é legítimo.
   *
   * O ramo `cancelled` nasceu do bug do `PdvService.cancel`, que fazia
   * `Number()` no `marcadosRegistros` (cuid desde 07/08 → NaN) e por isso não
   * devolvia peça NENHUMA ao cancelar. A causa está consertada lá; isto limpa
   * o que já ficou preso. A peça volta pra 'ativo' e não pra estoque: ela
   * nunca saiu do estoque — quem baixa é a marcação, não o "puxar".
   *
   * 100% Flow — sem nenhuma tentativa de tocar o Giga (07/08).
   */
  async reconciliarPuxadosOrfaos(): Promise<{
    verificados: number;
    fechados: number;
    devolvidosPraTela: number;
    erros: string[];
  }> {
    const presos: any[] = await (this.prisma as any).marcado.findMany({
      where: { status: 'puxado', saleId: { not: null } },
      select: { id: true, saleId: true },
      take: 500,
    });
    if (!presos.length) return { verificados: 0, fechados: 0, devolvidosPraTela: 0, erros: [] };

    const saleIds = [...new Set(presos.map((p) => p.saleId).filter(Boolean))];
    const vendas: any[] = await (this.prisma as any).pdvSale.findMany({
      where: { id: { in: saleIds } },
      select: { id: true, status: true },
    });
    const statusPorVenda = new Map(vendas.map((v) => [v.id, v.status]));

    let fechados = 0;
    let devolvidosPraTela = 0;
    const erros: string[] = [];
    for (const m of presos) {
      const st = statusPorVenda.get(m.saleId);
      if (st !== 'finalized' && st !== 'cancelled') continue;
      try {
        await (this.prisma as any).marcado.update({
          where: { id: m.id },
          data:
            st === 'finalized'
              ? { status: 'fechado', fechadoAt: new Date() }
              : { status: 'ativo', saleId: null },
        });
        if (st === 'finalized') fechados++;
        else devolvidosPraTela++;
      } catch (e: any) {
        erros.push(`marcado ${m.id} (venda ${m.saleId}): ${e?.message || e}`);
      }
    }
    this.logger.log(
      `[marcados.reconciliar] ${presos.length} preso(s) verificado(s), ${fechados} fechado(s), ${devolvidosPraTela} devolvido(s) pra tela`,
    );
    return { verificados: presos.length, fechados, devolvidosPraTela, erros };
  }

  /**
   * Busca info do cliente + lista de marcados ativos + valida se pode marcar.
   *
   * Retorno:
   *  - permitido: bool — pode marcar?
   *  - motivo: string — se não pode, explica
   *  - cliente: { codCliente, nome, classificacao, limiteTotal }
   *  - marcadosAtivos: [{ registro, data, descricao, qty, valor }]
   *  - totalMarcadosAtivos: soma do que já está em aberto
   *  - limiteDisponivel: limiteTotal - totalMarcadosAtivos
   */
  async getClienteMarcadorInfo(input: string | {
    cpf?: string | null;
    codCliente?: string | null;
    loja?: string | null;
  }): Promise<{
    permitido: boolean;
    motivo?: string;
    cliente: any;
    marcadosAtivos: any[];
    totalMarcadosAtivos: number;
    limiteDisponivel: number;
  }> {
    /**
     * ABRE POR CPF **OU** POR loja+código (dono 05/08).
     *
     * 25% das fichas do Wincred (1.911 de 7.492) NUNCA tiveram CPF preenchido.
     * A tela exigia CPF pra abrir e recusava o cliente — caso real: DAIANA
     * RUFINO (loja 01, cód 6086), 48 peças e R$ 3.323,80 em marca que a busca
     * JÁ mostrava na lista, mas que a loja não conseguia abrir pra fechar.
     * O código do cliente é a chave real do Giga (loja+codigo); CPF é opcional
     * lá desde sempre. Então ele deixa de ser obrigatório aqui.
     */
    const arg = typeof input === 'string' ? { cpf: input } : (input || {});
    const safeCpf = String(arg.cpf ?? '').replace(/\D/g, '');
    const codArg = String(arg.codCliente ?? '').trim();
    const lojaArg = String(arg.loja ?? '').replace(/\D/g, '').padStart(2, '0');
    const temLoja = !!String(arg.loja ?? '').trim();
    if (!safeCpf && !codArg) {
      throw new BadRequestException('Informe o CPF ou o código do cliente');
    }
    const cpf = safeCpf;
    const formattedCpf = safeCpf.length === 11
      ? `${safeCpf.slice(0,3)}.${safeCpf.slice(3,6)}.${safeCpf.slice(6,9)}-${safeCpf.slice(9)}`
      : safeCpf;

    // 2. Busca cliente — ESPELHO Postgres primeiro (giga_clientes, importado).
    // O caminho antigo batia no Giga ao vivo e pendurava a tela quando o pool
    // travava. Giga só entra como fallback (recém-cadastrado que o sync ainda
    // não trouxe). Se a pessoa tem ficha em várias lojas, vale a com
    // classificação 'A' e maior limite (o antigo LIMIT 1 pegava uma qualquer).
    let row: any = null;
    /** Todas as fichas da MESMA pessoa (o cadastro é POR LOJA) — usadas pra
     *  somar os marcados dela sem pegar os de um xará de outra loja. */
    let fichasPessoa: any[] = [];
    try {
      // Sem CPF, a chave é a do próprio Giga: loja + código (com as variantes
      // de zero à esquerda, que lá são inconsistentes).
      const whereFicha: any = safeCpf
        ? { OR: [{ personKey: `cpf:${safeCpf}` }, { cpf: safeCpf }, { cpf: formattedCpf }] }
        : { codigo: { in: this.codVariants(codArg) }, ...(temLoja ? { loja: lojaArg } : {}) };
      const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
        // Ficha arquivada (painel de Limpeza) não conta pra marcado.
        where: { ...whereFicha, arquivadoEm: null },
      });
      fichasPessoa = fichas;
      if (fichas.length) {
        const f = fichas.slice().sort((a, b) => {
          const aA = String(a.avaliacao || '').trim().toUpperCase() === 'A' ? 1 : 0;
          const bA = String(b.avaliacao || '').trim().toUpperCase() === 'A' ? 1 : 0;
          if (aA !== bA) return bA - aA;
          return Number(b.limiteCompras || 0) - Number(a.limiteCompras || 0);
        })[0];
        row = {
          CODIGO: f.codigo,
          NOME: f.nome,
          CPF: f.cpf || safeCpf,
          AVALIACAO: f.avaliacao || '',
          LIMITECOMPRAS: Number(f.limiteCompras || 0),
          ULTCOMPRA: (f.rawJson as any)?.ULTCOMPRA ?? null,
        };
      }
    } catch (e: any) {
      this.logger.warn(`[marcados] espelho giga_clientes falhou, caindo pro Giga: ${e?.message}`);
    }

    if (!row) {
      const cm = await this.crediarios.detectClientesTable();
      if (!cm) {
        throw new BadRequestException('Tabela de clientes não detectada no Giga');
      }
      const codNum = Number(String(codArg).replace(/\D/g, '')) || 0;
      const sql = safeCpf
        ? `
        SELECT * FROM \`${cm.table}\`
        WHERE \`CPF\` = '${safeCpf}'
           OR \`CPF\` = '${formattedCpf}'
           OR REPLACE(REPLACE(REPLACE(\`CPF\`,'.',''),'-',''),'/','') = '${safeCpf}'
        LIMIT 1
      `
        : `
        SELECT * FROM \`${cm.table}\`
        WHERE CAST(\`${cm.codCliente || 'CODIGO'}\` AS UNSIGNED) = ${codNum}
        ${temLoja ? `AND \`LOJA\` = '${lojaArg}'` : ''}
        LIMIT 1
      `;
      const r = await this.erp.runReadOnly(sql, { maxRows: 1, timeoutMs: 10000 });
      const giga: any = r.rows[0] || null;
      if (giga) {
        row = {
          ...giga,
          CODIGO: cm.codCliente ? giga[cm.codCliente] : (giga.CODCLIENTE ?? giga.CODIGO ?? ''),
        };
      }
    }

    if (!row) {
      return {
        permitido: false,
        motivo: safeCpf
          ? 'Cliente não encontrado (nem no espelho, nem no Giga — precisa cadastrar antes)'
          : `Ficha ${codArg}${temLoja ? `/loja ${lojaArg}` : ''} não encontrada (nem no espelho, nem no Giga)`,
        cliente: null,
        marcadosAtivos: [],
        totalMarcadosAtivos: 0,
        limiteDisponivel: 0,
      };
    }

    const codCliente = String(row.CODIGO ?? '').trim();
    const classificacao = String(row.AVALIACAO || row.avaliacao || '').trim().toUpperCase();
    const limiteTotal = Number(row.LIMITECOMPRAS || row.limitecompras || 0);

    /**
     * 3. Busca marcados ativos do cliente — SÓ NO FLOW (07/08, regra do
     * dono: nunca mais ler Giga ao vivo pra marcado). Zero linha aqui É a
     * resposta — não existe mais fallback "pode ser que o espelho esteja
     * atrasado, deixa eu conferir no Giga"; o Flow é a única fonte e nasce
     * atualizado na hora (marcar e puxar já gravam nele direto).
     *
     * ESCOPO POR PESSOA, não por número (04/08): o código do cliente REPETE
     * entre lojas — cód. 5967 existe em várias. Casar só por `codCliente`
     * somava o marcado de uma XARÁ de outra loja e comia o limite de quem não
     * devia nada (mesma família de bug do JOIN sem LOJA em `listAll` e da
     * comissão resolvida no mapa global). Agora casa por CPF **ou** pelo par
     * loja+código de cada ficha dela.
     */
    const escopoPessoa: any[] = [
      ...(safeCpf ? [{ cpf: safeCpf }] : []),
      ...fichasPessoa
        .filter((f) => f?.codigo)
        .map((f) => ({
          codCliente: { in: this.codVariants(f.codigo) },
          storeCode: String(f.loja ?? '').replace(/\D/g, '').padStart(2, '0'),
        })),
      ...(!fichasPessoa.length && codCliente
        ? [{ codCliente: { in: this.codVariants(codCliente) } }]
        : []),
    ];
    const nativos: any[] = escopoPessoa.length
      ? await (this.prisma as any).marcado.findMany({
          where: { status: 'ativo', isTraining: false, OR: escopoPessoa },
          orderBy: [{ dataMarcacao: 'desc' }, { createdAt: 'desc' }],
          take: 200,
        })
      : [];
    const marcadosAtivos: any[] = nativos.map((n) => this.toGigaShape(n));
    const totalMarcadosAtivos = marcadosAtivos.reduce(
      (s: number, r: any) => s + (Number(r.VALORTOTAL) || Number(r.VALOR) || 0),
      0,
    );

    // 4. Validação — marcado exige classe A **E** limite. São dois campos
    // separados da ficha, e é fácil ter um sem o outro: a AVALIACAO vinha do
    // Giga (fora desde 02/08), então ficha nova do Flow nasce sem ela e
    // `copiarParaLoja` de propósito não copia nenhum dos dois. O gerente dá
    // limite, acha que liberou, e a peça é negada no balcão. A mensagem
    // precisa dizer O QUE FAZER, não só qual campo está torto.
    const ONDE_AJUSTAR = 'Um gerente ajusta em Retaguarda → Clientes → ficha da cliente → campos restritos.';
    let permitido = true;
    let motivo: string | undefined = undefined;
    if (classificacao !== 'A') {
      permitido = false;
      motivo = limiteTotal > 0
        ? `Ficha tem limite de R$ ${limiteTotal.toFixed(2)}, mas está sem Avaliação "A" ` +
          `(hoje: "${classificacao || '—'}"). Limite sozinho NÃO libera marcado — precisa dos dois. ${ONDE_AJUSTAR}`
        : `Ficha sem Avaliação "A" (hoje: "${classificacao || '—'}") e sem limite. ` +
          `Marcado exige as duas coisas. ${ONDE_AJUSTAR}`;
    } else if (limiteTotal <= 0) {
      permitido = false;
      motivo = `Cliente é classe "A" mas está sem limite de compras na ficha desta loja. ${ONDE_AJUSTAR}`;
    }

    return {
      permitido,
      motivo,
      cliente: {
        codCliente,
        nome: row.NOME || row.nome || row.CLIENTE,
        cpf: row.CPF || cpf,
        classificacao,
        limiteTotal,
        ultimaCompra: row.ULTCOMPRA || row.ultcompra || null,
      },
      marcadosAtivos,
      totalMarcadosAtivos: Math.round(totalMarcadosAtivos * 100) / 100,
      limiteDisponivel: Math.round((limiteTotal - totalMarcadosAtivos) * 100) / 100,
    };
  }

  /**
   * LIMPA DUPLICADOS de marcação de um cliente. Fecha (status='fechado') as
   * linhas-FANTASMA: registros nativos EXATAMENTE iguais (mesma loja+numero+sku+
   * qty+valorTotal) que o sync criou por não casar o órfão do Flow. Mantém 1 por
   * peça — de preferência a ligada ao Giga (registroGiga != null).
   * `dryRun` (default true): só mostra o que FECHARIA, sem tocar em nada.
   * NÃO mexe em marcações com numero diferente (marcação separada de verdade).
   */
  async dedupMarcadosCliente(input: {
    codCliente?: string;
    cpf?: string;
    dryRun?: boolean;
  }): Promise<{ grupos: number; duplicados: number; dryRun: boolean; fechados: any[] }> {
    const or: any[] = [];
    if (input.cpf) or.push({ cpf: String(input.cpf).replace(/\D/g, '') });
    if (input.codCliente) or.push({ codCliente: String(input.codCliente).trim() });
    if (!or.length) throw new BadRequestException('Informe codCliente ou cpf');
    const dryRun = input.dryRun !== false; // default TRUE (seguro)

    const rows: any[] = await (this.prisma as any).marcado.findMany({
      where: { status: 'ativo', isTraining: false, OR: or },
      orderBy: [{ registroGiga: 'asc' }, { createdAt: 'asc' }],
    });

    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = `${r.storeCode}|${r.sku}|${r.numero ?? ''}|${r.qty}|${Number(r.valorTotal)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }

    const fechados: any[] = [];
    for (const g of groups.values()) {
      if (g.length <= 1) continue; // sem duplicata exata
      const keep = g.find((x) => x.registroGiga != null) || g[0];
      for (const x of g) {
        if (x.id === keep.id) continue;
        fechados.push({
          id: x.id,
          sku: x.sku,
          descricao: x.descricao,
          valorTotal: Number(x.valorTotal),
          numero: x.numero,
          registroGiga: x.registroGiga != null ? String(x.registroGiga) : null,
          mantido: keep.id,
        });
      }
    }

    if (!dryRun && fechados.length) {
      await (this.prisma as any).marcado.updateMany({
        where: { id: { in: fechados.map((f) => f.id) } },
        data: { status: 'fechado', fechadoAt: new Date() },
      });
      this.logger.warn(`[marcados/dedup] ${fechados.length} duplicado(s) fechado(s) pra ${input.cpf || input.codCliente}`);
    }

    return { grupos: groups.size, duplicados: fechados.length, dryRun, fechados };
  }

  /**
   * Busca clientes por nome OU CPF parcial. Retorna ate 20 matches pra
   * vendedora escolher. Filtro: clientes que TEM pelo menos 1 marcado
   * ativo (status='SIM' na tabela `caixa`).
   *
   * Usado na tela /pdv/marcados quando vendedora nao tem o CPF em maos
   * e quer pesquisar pelo nome (ex: "MARIA SILVA").
   */
  async searchClientesByNameOrCpf(query: string, lojaScope?: string): Promise<Array<{
    codCliente: string;
    loja?: string;
    nome: string;
    cpf: string;
    classificacao: string;
    limiteTotal: number;
    qtdMarcados: number | null;
    totalMarcados: number | null;
  }>> {
    const q = String(query || '').trim();
    if (q.length < 2) return [];

    // Detecta se eh CPF (so digitos, 5+ chars) ou nome (com letras)
    const onlyDigits = q.replace(/\D/g, '');
    const isCpfLike = onlyDigits.length >= 5 && /^\d+$/.test(q.replace(/[.\-\s/]/g, ''));

    // 1) ESPELHO Postgres (giga_clientes) — a versão antiga batia no Giga ao
    //    vivo com INNER JOIN na caixa INTEIRA (full scan sem índice em
    //    MARCADO) e PENDURAVA a busca por nome (caso ELISA 21/07, Indaiatuba).
    //    O espelho responde na hora e não depende do Giga estar de pé.
    // ESCOPO POR LOJA (23/07): PDV só enxerga fichas da própria loja —
    // cadastros repetem por loja (RESERVAS etc). Sem lojaScope (retaguarda),
    // segue rede toda.
    const lojaFiltro = lojaScope ? String(lojaScope).replace(/\D/g, '').padStart(2, '0') : null;
    const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
      where: {
        arquivadoEm: null,
        ...(lojaFiltro ? { loja: lojaFiltro } : {}),
        ...(isCpfLike
          ? { OR: [{ personKey: { contains: onlyDigits } }, { cpf: { contains: onlyDigits } }] }
          : { nome: { contains: q, mode: 'insensitive' } }),
      },
      select: {
        loja: true, codigo: true, nome: true, cpf: true,
        avaliacao: true, limiteCompras: true, personKey: true,
      },
      orderBy: [{ nome: 'asc' }],
      take: 80,
    });

    // Dedup por PESSOA (mesma cliente tem ficha em várias lojas):
    // vale a ficha com classificação 'A' / maior limite.
    const porPessoa = new Map<string, any>();
    for (const f of fichas) {
      const key = f.personKey || `${f.loja}:${f.codigo}`;
      const atual = porPessoa.get(key);
      if (!atual) { porPessoa.set(key, { ...f }); continue; }
      const novoA = String(f.avaliacao || '').trim().toUpperCase() === 'A';
      const atualA = String(atual.avaliacao || '').trim().toUpperCase() === 'A';
      const trocar = (novoA && !atualA) ||
        (novoA === atualA && Number(f.limiteCompras || 0) > Number(atual.limiteCompras || 0));
      if (trocar) porPessoa.set(key, { ...f, cpf: atual.cpf || f.cpf });
      else if (!atual.cpf && f.cpf) atual.cpf = f.cpf;
    }
    const lista = Array.from(porPessoa.values()).slice(0, 20);
    if (!lista.length) return [];

    // 2) Badge "em marca" — SÓ FLOW (07/08). Sem fallback pro Giga: se a
    // agregada nativa falhar, o badge fica sem número — nunca cai pra uma
    // consulta ao vivo na caixa.
    const agg = new Map<string, { qtd: number; total: number }>();
    try {
      const cpfs = lista.map((m) => String(m.cpf || '').replace(/\D/g, '')).filter((c) => c.length === 11);
      const codes = lista.map((m) => String(m.codigo || '').trim()).filter(Boolean);
      const [porCpf, porCod]: any[][] = await Promise.all([
        cpfs.length
          ? (this.prisma as any).marcado.groupBy({
              by: ['cpf'], _count: { _all: true }, _sum: { valorTotal: true },
              where: { status: 'ativo', isTraining: false, cpf: { in: cpfs } },
            })
          : [],
        codes.length
          ? (this.prisma as any).marcado.groupBy({
              by: ['codCliente'], _count: { _all: true }, _sum: { valorTotal: true },
              where: { status: 'ativo', isTraining: false, codCliente: { in: codes } },
            })
          : [],
      ]);
      const byCpf = new Map(porCpf.map((x: any) => [x.cpf, x]));
      const byCod = new Map(porCod.map((x: any) => [x.codCliente, x]));
      for (const m of lista) {
        const hit = byCpf.get(String(m.cpf || '').replace(/\D/g, '')) || byCod.get(String(m.codigo || '').trim());
        if (hit) {
          agg.set(String(Number(m.codigo)), {
            qtd: Number(hit._count?._all) || 0,
            total: Number(hit._sum?.valorTotal) || 0,
          });
        }
      }
    } catch (e: any) {
      this.logger.warn(`[marcados] agregada nativa falhou (segue sem badge): ${e?.message}`);
    }

    // Quem tem marcado aparece primeiro (era o filtro da versão antiga)
    const out = lista.map((m) => {
      const a = agg.get(String(Number(m.codigo)));
      return {
        codCliente: String(m.codigo || '').trim(),
        loja: String(m.loja || ''),
        nome: String(m.nome || '').trim(),
        cpf: String(m.cpf || '').trim(),
        classificacao: String(m.avaliacao || '').trim().toUpperCase(),
        limiteTotal: Number(m.limiteCompras) || 0,
        qtdMarcados: a?.qtd ?? 0,
        totalMarcados: Math.round((a?.total ?? 0) * 100) / 100,
      };
    });
    out.sort((a, b) => (b.totalMarcados || 0) - (a.totalMarcados || 0));
    return out;
  }

  /**
   * DIAGNÓSTICO read-only: agrupa os marcados ATIVOS de um cliente por NUMERO
   * (cada "marcar" gera um NUMERO/controle). Serve pra enxergar a duplicação
   * (ex.: 4 grupos ~iguais = marcaram 4× a mesma peça). NÃO altera nada.
   */
  async analisarMarcadosCliente(input: { cpf?: string; codCliente?: string }): Promise<{
    totalPecas: number;
    totalValor: number;
    grupos: Array<{ numero: number | null; pecas: number; qtd: number; valor: number; comGiga: number; semGiga: number; data: any }>;
  }> {
    const or: any[] = [];
    if (input.cpf) or.push({ cpf: String(input.cpf).replace(/\D/g, '') });
    if (input.codCliente) or.push({ codCliente: String(input.codCliente).trim() });
    if (!or.length) throw new BadRequestException('Informe codCliente ou cpf');

    const rows: any[] = await (this.prisma as any).marcado.findMany({
      where: { status: 'ativo', isTraining: false, OR: or },
      orderBy: [{ dataMarcacao: 'asc' }, { createdAt: 'asc' }],
    });

    const byNumero = new Map<string, any>();
    for (const r of rows) {
      const k = r.numero != null ? String(r.numero) : 'sem-numero';
      if (!byNumero.has(k)) {
        byNumero.set(k, { numero: r.numero ?? null, pecas: 0, qtd: 0, valor: 0, comGiga: 0, semGiga: 0, data: r.dataMarcacao });
      }
      const g = byNumero.get(k);
      g.pecas++;
      g.qtd += Number(r.qty) || 0;
      g.valor += Number(r.valorTotal) || 0;
      if (r.registroGiga != null) g.comGiga++; else g.semGiga++;
    }
    const grupos = Array.from(byNumero.values())
      .map((g) => ({ ...g, valor: Math.round(g.valor * 100) / 100 }))
      .sort((a, b) => b.valor - a.valor);
    const totalValor = Math.round(rows.reduce((s, r) => s + (Number(r.valorTotal) || 0), 0) * 100) / 100;
    return { totalPecas: rows.length, totalValor, grupos };
  }

  /**
   * DEVOLVER AO ESTOQUE — 100% Flow, sem Giga (07/08). Chave por `id` nativo
   * (era por `registro` do Giga, que fica nulo pra sempre num marcado
   * Flow-first e tornava a devolução IMPOSSÍVEL pra essas peças — a mesma
   * classe de bug do caso Eliana, só que em "devolver" em vez de "puxar").
   */
  async devolverItemMarcado(input: {
    id: string;
    sku: string;
    qty: number;
    loja: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const id = String(input.id || '').trim();
    if (!id) throw new BadRequestException('Peça inválida');
    if (!input.sku) throw new BadRequestException('SKU obrigatório');
    if (!input.qty || input.qty < 1) throw new BadRequestException('QTY inválida');
    if (!input.loja) throw new BadRequestException('LOJA obrigatória');

    // 1. Estorna estoque (Flow — a fonte desde 14/07; réplica pro Giga é
    // infraestrutura geral de inventário, não o mecanismo de marcado).
    // Item AVULSO (sku MANUAL-...) não existe no estoque — pula o estorno e
    // só remove a marcação (senão o increaseStock devolvia 0 aplicados e
    // travava a devolução do item de teste/avulso).
    const isAvulso = String(input.sku).trim().toUpperCase().startsWith('MANUAL-');
    let appliedCount = 0;
    if (!isAvulso) {
      const stockResult = await this.erp.increaseStockAsync([
        { sku: input.sku, qty: input.qty, storeCode: input.loja },
      ]);
      appliedCount = stockResult.applied?.length || 0;
      if (appliedCount === 0) {
        return {
          ok: false,
          error: `Estoque não aplicado em nenhum SKU. Confira se "${input.sku}" existe na loja ${input.loja}.`,
        };
      }
    }

    // 2. Fecha o marcado no Flow — ponto final, sem Giga.
    const r = await (this.prisma as any).marcado.updateMany({
      where: { id, status: 'ativo' },
      data: { status: 'devolvido', devolvidoAt: new Date() },
    });
    if (r.count === 0) {
      return { ok: false, error: 'Marcado não encontrado ou já não estava ativo.' };
    }

    this.logger.log(
      `[marcados.devolver] ${id} OK · estoque +${appliedCount}/${input.qty} em ${input.loja}`,
    );
    return { ok: true };
  }

  /**
   * DESDUPLICA por PRODUTO (SKU): o cliente teve a MESMA peça marcada várias
   * vezes (marcação repetida no PDV). Mantém 1 marcado de cada SKU (o ligado ao
   * Giga / mais antigo) e DEVOLVE o resto ao estoque via devolverItemMarcado
   * (increaseStock). Estoque é delta: as devoluções compensam as baixas extras.
   * Peça sem linha no Giga (registroGiga null = fantasma do sync) só fecha o
   * nativo (não mexe estoque). `dryRun` (default true): só mostra o plano.
   */
  async desduplicarMarcadosCliente(input: {
    cpf?: string;
    codCliente?: string;
    dryRun?: boolean;
  }): Promise<{
    dryRun: boolean;
    produtosMantidos: number;
    valorMantido: number;
    pecasRemovidas: number;
    valorRemovido: number;
    estoqueDevolvido: number;
    falhas: string[];
  }> {
    const or: any[] = [];
    if (input.cpf) or.push({ cpf: String(input.cpf).replace(/\D/g, '') });
    if (input.codCliente) or.push({ codCliente: String(input.codCliente).trim() });
    if (!or.length) throw new BadRequestException('Informe codCliente ou cpf');
    const dryRun = input.dryRun !== false;

    const rows: any[] = await (this.prisma as any).marcado.findMany({
      where: { status: 'ativo', isTraining: false, OR: or },
      orderBy: [{ dataMarcacao: 'asc' }, { createdAt: 'asc' }],
    });
    if (!rows.length) throw new BadRequestException('Cliente sem marcados ativos');

    // Agrupa por SKU (mesmo produto = duplicidade). Mantém 1 por SKU.
    const bySku = new Map<string, any[]>();
    for (const r of rows) {
      const k = String(r.sku || '').trim().toUpperCase() || `sem-sku-${r.id}`;
      if (!bySku.has(k)) bySku.set(k, []);
      bySku.get(k)!.push(r);
    }

    const remover: any[] = [];
    let valorMantido = 0;
    for (const g of bySku.values()) {
      // Ordena: com registroGiga primeiro (real), depois mais antigo → mantém g[0].
      g.sort((a, b) => {
        const ga = a.registroGiga != null ? 0 : 1;
        const gb = b.registroGiga != null ? 0 : 1;
        if (ga !== gb) return ga - gb;
        return new Date(a.dataMarcacao || 0).getTime() - new Date(b.dataMarcacao || 0).getTime();
      });
      valorMantido += Number(g[0].valorTotal) || 0;
      for (let i = 1; i < g.length; i++) remover.push(g[i]);
    }

    const falhas: string[] = [];
    let pecasRemovidas = 0;
    let valorRemovido = 0;
    let estoqueDevolvido = 0;

    for (const m of remover) {
      pecasRemovidas++;
      valorRemovido += Number(m.valorTotal) || 0;
      if (dryRun) continue;
      try {
        // Devolve de verdade: retorna estoque + fecha o nativo. `id` sempre
        // existe (07/08) — não depende mais de ter linha no Giga ou não.
        const r = await this.devolverItemMarcado({
          id: m.id,
          sku: m.sku,
          qty: Number(m.qty) || 1,
          loja: m.storeCode,
        });
        if (r.ok) estoqueDevolvido += Number(m.qty) || 1;
        else falhas.push(`${m.sku}: ${r.error}`);
      } catch (e: any) {
        falhas.push(`${m.sku}: ${e?.message || e}`);
      }
    }

    if (!dryRun) {
      this.logger.warn(
        `[marcados/desdup] cliente ${input.cpf || input.codCliente}: manteve ${bySku.size} produto(s) único(s) ` +
        `(R$${Math.round(valorMantido * 100) / 100}), removeu ${pecasRemovidas} peça(s) duplicada(s), ` +
        `estoque devolvido=${estoqueDevolvido}, falhas=${falhas.length}`,
      );
    }

    return {
      dryRun,
      produtosMantidos: bySku.size,
      valorMantido: Math.round(valorMantido * 100) / 100,
      pecasRemovidas,
      valorRemovido: Math.round(valorRemovido * 100) / 100,
      estoqueDevolvido,
      falhas,
    };
  }

  /**
   * BAIXA SEM FINANCEIRO (dono 21/07): clientes-bin (DEFEITOS, FURTO, PEÇAS
   * NÃO ENCONTRADAS, reservas...) acumulam marcado que NUNCA vira venda.
   * A baixa marca o nativo como 'baixado' — SEM venda, SEM caixa, SEM
   * devolver estoque (peça com defeito/furtada não volta pro estoque).
   * Auditável: motivo + quem autorizou (senha GERENTE no controller).
   *
   * 100% Flow, sem Giga (07/08) — por `id` nativo, não `registro`. O caminho
   * antigo filtrava por `Number(REGISTRO) > 0`, que descarta TODO marcado
   * Flow-first (nasce com `registroGiga: null`) — pra peça assim, "baixar"
   * simplesmente não tinha como funcionar.
   */
  async baixarMarcados(input: {
    ids: string[];
    motivo: string;
    autorizadoPor: string;
  }): Promise<{ ok: boolean; baixados: number; falhas: string[] }> {
    const motivo = String(input.motivo || '').trim().toUpperCase().slice(0, 160);
    if (!motivo) throw new BadRequestException('Informe o motivo da baixa');
    const ids = (input.ids || []).map((s) => String(s || '').trim()).filter(Boolean);
    if (!ids.length) throw new BadRequestException('Nada pra baixar');

    const dadosBaixa = {
      status: 'baixado',
      baixadoAt: new Date(),
      baixaMotivo: motivo,
      baixaPor: String(input.autorizadoPor || '').slice(0, 120),
    };
    const r = await (this.prisma as any).marcado.updateMany({
      where: { id: { in: ids }, status: 'ativo' },
      data: dadosBaixa,
    });
    const baixados = Number(r?.count) || 0;

    this.logger.log(
      `[marcados.baixa] ${baixados} baixado(s) SEM financeiro · motivo="${motivo}" · por=${input.autorizadoPor}`,
    );
    return { ok: true, baixados, falhas: [] };
  }

  /**
   * Lista marcados ativos de TODOS os clientes (visão geral pra retaguarda).
   * Filtros opcionais: loja, classificacao, dataInicial, dataFinal.
   */
  async listAllMarcados(input: {
    loja?: string;
    dataInicial?: string;
    dataFinal?: string;
    limit?: number;
    /** ativo (default) | fechado | devolvido | baixado | fechado_giga | todos */
    status?: string;
  } = {}): Promise<any> {
    // SÓ FLOW (07/08) — sem fallback pro Giga ao vivo. Zero linha aqui É a
    // resposta certa: o Flow grava marcado na hora (criar e puxar já são
    // Flow-first), não existe mais "espelho atrasado" pra justificar cair
    // pro Giga.
    const limit = Math.min(10000, input.limit || 100);
    const st = String(input.status || 'ativo').trim();
    const where: any = { isTraining: false };
    if (st !== 'todos') where.status = st;
    if (input.loja) where.storeCode = String(input.loja).replace(/[^0-9]/g, '').padStart(2, '0');
    if (input.dataInicial || input.dataFinal) {
      where.dataMarcacao = {
        ...(input.dataInicial ? { gte: new Date(`${input.dataInicial}T00:00:00.000Z`) } : {}),
        ...(input.dataFinal ? { lte: new Date(`${input.dataFinal}T23:59:59.999Z`) } : {}),
      };
    }
    const [nativos, totalCount]: [any[], number] = await Promise.all([
      (this.prisma as any).marcado.findMany({
        where,
        orderBy: [{ dataMarcacao: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      }),
      (this.prisma as any).marcado.count({ where }),
    ]);
    // Nome na HORA pros que ainda não têm — casa com o ESPELHO giga_clientes
    // no nosso próprio Postgres (não é leitura do Giga ao vivo).
    let nomes: Map<string, { nome: string | null; cpf: string | null }> | null = null;
    const semNome = nativos.filter((n) => !n.clienteNome);
    if (semNome.length) {
      try {
        nomes = await this.mirror.lookupNomes(
          semNome.map((n) => ({ storeCode: n.storeCode, codCliente: n.codCliente })),
        );
      } catch { /* segue sem nome */ }
    }
    const normNum = (s: any) => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '') || '0';
    const rows = nativos.map((n) => ({
      ...this.toGigaShape(n),
      codCliente: n.codCliente,
      clienteNome: n.clienteNome
        || nomes?.get(`${normNum(n.storeCode)}|${normNum(n.codCliente)}`)?.nome
        || null,
      classificacao: null,
      // Histórico: além dos ativos, a tela mostra o que aconteceu com cada peça
      status: n.status,
      fechadoAt: n.fechadoAt,
      devolvidoAt: n.devolvidoAt,
      baixadoAt: n.baixadoAt,
      baixaMotivo: n.baixaMotivo,
      baixaPor: n.baixaPor,
      saleId: n.saleId,
    }));
    return { rows, total: totalCount, truncado: totalCount > rows.length, fonte: 'flow' };
  }

  /**
   * PUXAR MARCADOS PRA VENDA NO PDV.
   *
   * Vendedora seleciona N peças marcadas que a cliente vai pagar. Backend
   * cria uma PdvSale aberta, adiciona cada peça como item (manual, sem
   * decrementar estoque — já saiu quando foi marcado), guarda os `Marcado.id`
   * nativos em `marcadosRegistros` (nome antigo do campo — o CONTEÚDO agora é
   * id do Flow, não REGISTRO do Giga) pra rastreio.
   *
   * Vendedora retoma essa venda no PDV, cobra (PIX/cartão/crediário/etc) e
   * finaliza. No finalize, `PdvService.erpStepFecharMarcados` fecha essas
   * linhas no Flow — 100%, sem Giga (07/08, regra do dono).
   *
   * SELECIONA POR `id` NATIVO, nunca por REGISTRO (07/08). Antes, um marcado
   * criado sem réplica confirmada no Giga nascia com `registroGiga: null` — e
   * como a seleção casava só por esse número, essa peça ficava
   * ESTRUTURALMENTE impossível de puxar (achado no caso Eliana/Limeira,
   * 10 peças presas em "ativo" pra sempre). `id` sempre existe.
   */
  async puxarParaVenda(input: {
    marcadoIds: string[];
    storeCode: string;
    customerCpf?: string;
    customerName?: string;
    customerPhone?: string;
    vendedorUserId?: string;
    vendedorName?: string;
    /** MODO TREINAMENTO — venda criada não é "vendida de verdade" */
    isTraining?: boolean;
  }): Promise<{ saleId: string; itemsAdded: number; total: number }> {
    const ids = (input.marcadoIds || []).map((s) => String(s || '').trim()).filter(Boolean);
    if (!ids.length) {
      throw new BadRequestException('Nenhuma peça informada');
    }
    if (!input.storeCode) {
      throw new BadRequestException('storeCode obrigatorio');
    }

    const nativos: any[] = await (this.prisma as any).marcado.findMany({
      where: { id: { in: ids }, status: 'ativo' },
    });
    const rows = nativos.map((n) => this.toGigaShape(n));
    if (rows.length === 0) {
      throw new BadRequestException('Nenhum marcado ativo encontrado pras peças informadas');
    }

    const store = await this.prisma.store.findUnique({
      where: { code: input.storeCode },
      select: { code: true, name: true },
    });
    if (!store) throw new BadRequestException(`Loja ${input.storeCode} nao cadastrada`);

    let cashSessionId: string | null = null;
    try {
      const s = await (this.prisma as any).pdvCashSession.findFirst({
        where: { storeCode: store.code, status: 'open' },
        select: { id: true },
      });
      cashSessionId = s?.id || null;
    } catch { /* segue sem caixa */ }

    // ── MODO TREINAMENTO ──
    // Em treino NÃO grava marcadosRegistros (senão finalize/cancel tentaria
    // fechar peça de marcado DE VERDADE). Venda fica como treino e não impacta.
    //
    // `marcadosRegistros` guarda os `Marcado.id` nativos (nome do campo é
    // histórico — o conteúdo deixou de ser REGISTRO do Giga em 07/08).
    const sale = await (this.prisma as any).pdvSale.create({
      data: {
        storeCode: store.code,
        storeName: store.name,
        cashSessionId,
        vendedorUserId: input.vendedorUserId || null,
        vendedorName: input.vendedorName || null,
        customerCpf: input.customerCpf || null,
        customerName: input.customerName || null,
        customerPhone: input.customerPhone || null,
        status: 'open',
        isTraining: !!input.isTraining,
        marcadosRegistros: input.isTraining ? null : rows.map((x) => x.id).join(','),
      },
    });

    let total = 0;
    let itemsAdded = 0;
    for (const row of rows) {
      const qty = Math.max(1, Number(row.QUANTIDADE) || 1);
      const valorTotal = Number(row.VALORTOTAL) || (Number(row.VALOR) || 0) * qty;
      /**
       * PEÇA MARCADA COM DESCONTO VOLTAVA SEM O DESCONTO APARECER (31/08).
       *
       * Na marcação, `VALOR` guarda o preço CHEIO e `VALORTOTAL` o que a
       * cliente vai pagar (já com o desconto embutido). O retorno usava o
       * LÍQUIDO como preço unitário e gravava `desconto: 0` — então a peça
       * de R$ 80 marcada por R$ 40 voltava como se R$ 40 fosse o preço de
       * tabela: sem riscado, sem "economizou", sem nada na tela que
       * denunciasse o desconto já concedido.
       *
       * Pior que o visual: com `desconto: 0` a campanha do dia enxergava
       * uma peça "sem desconto" e aplicava os 50% EM CIMA do preço já pela
       * metade (R$ 80 → 40 → 20) assim que a vendedora bipasse qualquer
       * outra peça — o recálculo automático roda a venda inteira.
       *
       * Agora o preço volta CHEIO com o desconto explícito na linha, que é
       * o que a tela sabe mostrar (riscado + economia) e o que a trava do
       * recálculo sabe respeitar.
       */
      const brutoUnit = Math.round((Number(row.VALOR) || 0) * 100) / 100;
      const liquidoUnit = qty > 0 ? Math.round((valorTotal / qty) * 100) / 100 : brutoUnit;
      // Só confia no bruto quando ele é coerente (>= líquido). Marcado antigo
      // ou vindo do Giga sem VALOR cai no comportamento de antes.
      const temBruto = brutoUnit > 0 && brutoUnit * qty >= valorTotal - 0.01;
      const precoUnit = temBruto ? brutoUnit : liquidoUnit;
      const descontoMarcado = temBruto
        ? Math.max(0, Math.round((brutoUnit * qty - valorTotal) * 100) / 100)
        : 0;
      const descricao = String(row.DESCRICAO || row.CODIGO || 'Item marcado').slice(0, 80);
      const sku = String(row.CODIGO || `MARCADO-${row.id}`);
      // Resolve REF real + dataCadastro (+cor/tam/ncm/cfop/ean) pelo catálogo,
      // igual ao bipe. SEM isso a campanha (liquida antigos por data / coleção
      // -INV/-VER por REF) não consegue avaliar a peça e o desconto não aplica.
      // precoUnit fica o da marcação (a campanha aplica o % em cima dele).
      let info: any = null;
      try { info = await this.catalog.getPdvProductInfo(sku); } catch { /* mantém básico */ }
      try {
        await (this.prisma as any).pdvSaleItem.create({
          data: {
            saleId: sale.id,
            sku,
            ean: info?.ean ?? null,
            ref: info?.ref || 'MARCADO',
            cor: info?.cor ?? null,
            tamanho: info?.tamanho ?? null,
            descricao,
            ncm: info?.ncm ?? null,
            cfop: info?.cfop ?? null,
            dataCadastro: info?.dataCadastro ?? null,
            qty,
            precoUnit,
            desconto: descontoMarcado,
            total: Math.round((precoUnit * qty - descontoMarcado) * 100) / 100,
            promoTag: 'MARCADO',
            // Ancora o "de/por" riscado na linha — o mesmo campo que o bipe
            // usa pra mostrar quanto a cliente economizou.
            precoDeCents: descontoMarcado > 0 ? Math.round(brutoUnit * 100) : null,
          },
        });
        total += precoUnit * qty;
        itemsAdded++;
      } catch (e: any) {
        this.logger.warn(`[marcados/puxar] falha ao add item REGISTRO=${row.REGISTRO}: ${e?.message}`);
      }
    }

    await (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        subtotal: total,
        total,
      },
    });

    // TIRA da tela de Marcados JÁ (status 'puxado') — peça não pode ficar nas
    // DUAS telas ao mesmo tempo. Cancelar a venda devolve pra 'ativo'
    // (pdv.cancel); finalizar fecha de vez (erpStepFecharMarcados). Treino não
    // grava marcadosRegistros, então nem entra aqui.
    //
    // Por `id` nativo (07/08) — é a chave que SEMPRE existe, ao contrário de
    // `registroGiga` (era exatamente esta trava, batendo em `registroGiga`
    // nulo, que deixava a peça presa em 'ativo' pra sempre no caso Eliana).
    if (!input.isTraining) {
      try {
        await (this.prisma as any).marcado.updateMany({
          where: { id: { in: rows.map((x: any) => x.id) }, status: 'ativo' },
          data: { status: 'puxado', saleId: sale.id },
        });
      } catch (e: any) {
        this.logger.warn(`[marcados/puxar] não marcou como 'puxado': ${e?.message}`);
      }
    }

    return { saleId: sale.id, itemsAdded, total };
  }
}
