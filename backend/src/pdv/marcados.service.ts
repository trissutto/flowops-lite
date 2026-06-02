import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from '../crediarios/crediarios.service';
import { PrismaService } from '../prisma/prisma.service';

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
  ) {}

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
  }): Promise<{
    ok: boolean;
    controle?: number;
    totalItems?: number;
    totalValor?: number;
    forced?: boolean;
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

    // 3. INSERT linhas em caixa do Giga
    const codCliente = Number(info.cliente.codCliente) || 0;
    if (!codCliente) {
      throw new BadRequestException('Código do cliente não encontrado');
    }

    const insertResult = await this.erp.insertCaixaMarcado({
      items: sale.items.map((it: any) => ({
        codigo: String(it.sku || it.ref || '').trim(),
        descricao: String(it.descricao || '').slice(0, 100),
        quantidade: Number(it.qty) || 1,
        valor: Number(it.precoUnit) || 0,
        valorTotal: Number(it.total) || 0,
        vendedor: 0, // TODO: mapear sellerId pro código numérico do vendedor Giga
        operador: 0,
      })),
      cliente: codCliente,
      loja: input.storeCode,
    });

    if (!insertResult.success) {
      throw new BadRequestException(`Falha ao inserir marcados no Giga: ${insertResult.error}`);
    }

    // 4. Baixa estoque Giga (igual venda — peças saem do estoque físico)
    if (this.erp.isWriteEnabled) {
      const stockItems = sale.items.map((it: any) => ({
        sku: String(it.sku || it.ref || '').trim(),
        qty: Number(it.qty) || 1,
        storeCode: input.storeCode,
      }));
      const stockResult = await this.erp.decreaseStock(stockItems);
      if (!stockResult.success) {
        this.logger.error(
          `[marcados] INSERT em caixa OK, mas falha ao baixar estoque: ${stockResult.error}. ` +
          `Pode ter divergência ERP×físico. Investigar manualmente.`,
        );
        // Não rollback — peças marcadas no Giga, retaguarda decide
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
      `controle=${insertResult.controle} total=R$${Number(sale.total).toFixed(2)} ` +
      `items=${sale.items.length}`,
    );

    return {
      ok: true,
      controle: insertResult.controle,
      totalItems: sale.items.length,
      totalValor: Number(sale.total),
      forced: Number(sale.total) > info.limiteDisponivel,
    };
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
  async getClienteMarcadorInfo(cpf: string): Promise<{
    permitido: boolean;
    motivo?: string;
    cliente: any;
    marcadosAtivos: any[];
    totalMarcadosAtivos: number;
    limiteDisponivel: number;
  }> {
    if (!cpf) throw new BadRequestException('CPF obrigatório');
    const safeCpf = String(cpf).replace(/\D/g, '');

    // 1. Detecta tabela de clientes (já existe esse helper no crediarios)
    const cm = await this.crediarios.detectClientesTable();
    if (!cm) {
      throw new BadRequestException('Tabela de clientes não detectada no Giga');
    }

    // 2. Busca cliente — UMA query so com OR cobrindo 3 formatos possiveis
    // (digito puro, formatado XXX.XXX.XXX-XX, e qualquer formato no banco
    // via REPLACE). Antes eram 3 queries serial — agora 1 round-trip so.
    // Economiza ~300-500ms na busca por cliente.
    const formattedCpf = safeCpf.length === 11
      ? `${safeCpf.slice(0,3)}.${safeCpf.slice(3,6)}.${safeCpf.slice(6,9)}-${safeCpf.slice(9)}`
      : safeCpf;

    const sql = `
      SELECT * FROM \`${cm.table}\`
      WHERE \`CPF\` = '${safeCpf}'
         OR \`CPF\` = '${formattedCpf}'
         OR REPLACE(REPLACE(REPLACE(\`CPF\`,'.',''),'-',''),'/','') = '${safeCpf}'
      LIMIT 1
    `;
    const r = await this.erp.runReadOnly(sql, { maxRows: 1, timeoutMs: 10000 });
    const row: any = r.rows[0] || null;
    if (!row) {
      return {
        permitido: false,
        motivo: 'Cliente não encontrado no Giga (precisa cadastrar antes)',
        cliente: null,
        marcadosAtivos: [],
        totalMarcadosAtivos: 0,
        limiteDisponivel: 0,
      };
    }

    const codCliente = String(
      cm.codCliente ? row[cm.codCliente] : (row.CODCLIENTE ?? row.CODIGO ?? ''),
    ).trim();
    const classificacao = String(row.AVALIACAO || row.avaliacao || '').trim().toUpperCase();
    const limiteTotal = Number(row.LIMITECOMPRAS || row.limitecompras || 0);

    // 3. Busca marcados ativos do cliente na tabela `caixa`
    const marcadosSql = `
      SELECT REGISTRO, NUMERO, CODIGO, DATA, DESCRICAO, QUANTIDADE, VALOR, VALORTOTAL, VENDEDOR, OPERADOR, LOJA
      FROM caixa
      WHERE UPPER(MARCADO) = 'SIM' AND CLIENTE = ${Number(codCliente) || 0}
      ORDER BY DATA DESC, REGISTRO DESC
      LIMIT 200
    `;
    const m = await this.erp.runReadOnly(marcadosSql, { maxRows: 200, timeoutMs: 10000 });
    const marcadosAtivos = m.rows;
    const totalMarcadosAtivos = marcadosAtivos.reduce(
      (s: number, r: any) => s + (Number(r.VALORTOTAL) || Number(r.VALOR) || 0),
      0,
    );

    // 4. Validação
    let permitido = true;
    let motivo: string | undefined = undefined;
    if (classificacao !== 'A') {
      permitido = false;
      motivo = `Cliente classificação "${classificacao || '—'}" — só clientes "A" podem marcar`;
    } else if (limiteTotal <= 0) {
      permitido = false;
      motivo = `Cliente sem limite de marcação configurado no Giga (LIMITECOMPRAS=0)`;
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
   * Busca clientes por nome OU CPF parcial. Retorna ate 20 matches pra
   * vendedora escolher. Filtro: clientes que TEM pelo menos 1 marcado
   * ativo (status='SIM' na tabela `caixa`).
   *
   * Usado na tela /pdv/marcados quando vendedora nao tem o CPF em maos
   * e quer pesquisar pelo nome (ex: "MARIA SILVA").
   */
  async searchClientesByNameOrCpf(query: string): Promise<Array<{
    codCliente: string;
    nome: string;
    cpf: string;
    classificacao: string;
    limiteTotal: number;
    qtdMarcados: number;
    totalMarcados: number;
  }>> {
    const q = String(query || '').trim();
    if (q.length < 2) return [];

    const cm = await this.crediarios.detectClientesTable();
    if (!cm) return [];

    // Detecta se eh CPF (so digitos, 5+ chars) ou nome (com letras)
    const onlyDigits = q.replace(/\D/g, '');
    const isCpfLike = onlyDigits.length >= 5 && /^\d+$/.test(q.replace(/[.\-]/g, ''));

    // Escapa aspas simples pra evitar injection. SQL com LIKE.
    const safeQ = q.replace(/'/g, "''");
    const safeDigits = onlyDigits.replace(/'/g, "''");
    const nomeCol = cm.nome || 'NOME';
    const cpfCol = cm.cpf || 'CPF';
    const codCol = cm.codCliente || 'CODIGO';

    // Busca clientes que tem MARCADOS ATIVOS (JOIN com caixa)
    // 1) Lista candidatos por nome/cpf (LIMIT 50)
    // 2) Filtra so quem tem >=1 linha em caixa com MARCADO='SIM'
    let where: string;
    if (isCpfLike) {
      // Busca por CPF parcial (tolera com ou sem formatacao)
      where = `(REPLACE(REPLACE(REPLACE(\`${cpfCol}\`,'.',''),'-',''),'/','') LIKE '%${safeDigits}%')`;
    } else {
      // Busca por nome (case-insensitive via UPPER)
      where = `(UPPER(\`${nomeCol}\`) LIKE UPPER('%${safeQ}%'))`;
    }

    const sql = `
      SELECT c.\`${codCol}\` AS codCliente,
             c.\`${nomeCol}\` AS nome,
             c.\`${cpfCol}\` AS cpf,
             c.AVALIACAO AS classificacao,
             c.LIMITECOMPRAS AS limiteTotal,
             COUNT(cx.REGISTRO) AS qtdMarcados,
             COALESCE(SUM(cx.VALORTOTAL), 0) AS totalMarcados
        FROM \`${cm.table}\` c
        INNER JOIN caixa cx ON cx.CLIENTE = c.\`${codCol}\` AND UPPER(cx.MARCADO) = 'SIM'
       WHERE ${where}
       GROUP BY c.\`${codCol}\`, c.\`${nomeCol}\`, c.\`${cpfCol}\`, c.AVALIACAO, c.LIMITECOMPRAS
       ORDER BY MAX(cx.DATA) DESC
       LIMIT 20
    `;

    try {
      const r = await this.erp.runReadOnly(sql, { maxRows: 20, timeoutMs: 10000 });
      return (r.rows || []).map((row: any) => ({
        codCliente: String(row.codCliente || '').trim(),
        nome: String(row.nome || '').trim(),
        cpf: String(row.cpf || '').trim(),
        classificacao: String(row.classificacao || '').trim().toUpperCase(),
        limiteTotal: Number(row.limiteTotal) || 0,
        qtdMarcados: Number(row.qtdMarcados) || 0,
        totalMarcados: Math.round((Number(row.totalMarcados) || 0) * 100) / 100,
      }));
    } catch (e: any) {
      this.logger.warn(`[marcados] searchClientesByNameOrCpf falhou: ${e?.message}`);
      return [];
    }
  }

  /**
   * DEVOLVE 1 peça marcada — o cliente trouxe de volta.
   *  - DELETE FROM caixa WHERE REGISTRO + CONTROLE (chave composta)
   *  - increaseStock(SKU, qty, loja) — peça volta pro estoque Giga
   *
   * Usado no fluxo "Processar marcados" quando vendedora marca itens
   * como "voltou".
   *
   * Body: { registro: number, controle: number, sku: string, qty: number, loja: string }
   */
  async devolverItemMarcado(input: {
    registro: number | string;
    sku: string;
    qty: number;
    loja: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const reg = Number(input.registro);
    if (!reg) throw new BadRequestException('REGISTRO inválido');
    if (!input.sku) throw new BadRequestException('SKU obrigatório');
    if (!input.qty || input.qty < 1) throw new BadRequestException('QTY inválida');
    if (!input.loja) throw new BadRequestException('LOJA obrigatória');

    // Bloqueia se ERP_WRITE não habilitado — não fica em half-state silencioso
    if (!this.erp.isWriteEnabled) {
      return {
        ok: false,
        error: 'ERP_WRITE_ENABLED desabilitado no Railway. Operação seria SHADOW (não persistiria).',
      };
    }

    // 1. Estorna estoque Giga (peça volta pra loja)
    const stockResult = await this.erp.increaseStock([
      { sku: input.sku, qty: input.qty, storeCode: input.loja },
    ]);
    if (!stockResult.success) {
      return {
        ok: false,
        error: `Falha ao estornar estoque Giga: ${stockResult.error}`,
      };
    }
    const appliedCount = stockResult.applied?.length || 0;
    if (appliedCount === 0) {
      return {
        ok: false,
        error: `increaseStock retornou success mas 0 SKUs aplicados. Possível mismatch storeCode "${input.loja}" vs LOJA Giga.`,
      };
    }

    // 2. DELETE da linha caixa (tira do nome da pessoa marcada)
    const deleteResult = await this.erp.deleteCaixaMarcadoRow({ registro: reg });
    if (!deleteResult.success) {
      // Estoque já voltou, mas remoção da marcação falhou.
      // Loga AVISO e retorna ERRO pra admin investigar — meio-caminho é pior que falhar limpo.
      this.logger.error(
        `[marcados.devolver] estoque OK porém DELETE caixa REGISTRO=${reg} falhou: ${deleteResult.error}`,
      );
      return {
        ok: false,
        error: `Estoque voltou mas marcação não foi removida do nome do cliente: ${deleteResult.error}. Remova manualmente no Wincred.`,
      };
    }

    this.logger.log(
      `[marcados.devolver] REGISTRO=${reg} OK · estoque +${appliedCount}/${input.qty} em ${input.loja} · caixa.MARCADO removido`,
    );

    return { ok: true };
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
  } = {}): Promise<any> {
    const limit = Math.min(500, input.limit || 100);
    const where: string[] = [`UPPER(c.MARCADO) = 'SIM'`];
    if (input.loja) where.push(`c.LOJA = '${input.loja.replace(/[^0-9]/g, '')}'`);
    if (input.dataInicial) where.push(`c.DATA >= '${input.dataInicial}'`);
    if (input.dataFinal) where.push(`c.DATA <= '${input.dataFinal}'`);

    const cm = await this.crediarios.detectClientesTable();
    const joinClientes = cm
      ? `LEFT JOIN \`${cm.table}\` cli ON cli.\`${cm.codCliente}\` = c.CLIENTE`
      : '';
    const selectNome = cm?.nome ? `cli.\`${cm.nome}\` AS clienteNome,` : '';

    const sql = `
      SELECT
        c.REGISTRO, c.NUMERO, c.CODIGO, c.DATA, c.DESCRICAO,
        c.QUANTIDADE, c.VALOR, c.VALORTOTAL, c.VENDEDOR, c.LOJA,
        c.CLIENTE AS codCliente,
        ${selectNome}
        cli.AVALIACAO AS classificacao
      FROM caixa c
      ${joinClientes}
      WHERE ${where.join(' AND ')}
      ORDER BY c.DATA DESC, c.REGISTRO DESC
      LIMIT ${limit}
    `;
    const r = await this.erp.runReadOnly(sql, { maxRows: limit, timeoutMs: 15000 });
    return { rows: r.rows, total: r.rows.length };
  }

  // ── PUXAR MARCADOS PRA VENDA NO PDV ──────────────────────────────
  // Vendedora seleciona N pecas marcadas que o cliente vai pagar.
  // Backend cria uma PdvSale aberta, adiciona cada peca como item
  // (manual, sem decrementar estoque — ja saiu quando foi marcado),
  // guarda os REGISTROs no campo marcadosRegistros pra rastreio.
  //
  // Vendedora retoma essa venda no PDV, cobra (PIX/cartao/etc) e finaliza.
  // No finalize, o backend dispara "fechar marcado" no Wincred
  // (UPDATE MARCADO='NAO' nas linhas correspondentes — vira venda final).
  async puxarParaVenda(input: {
    registros: number[];
    storeCode: string;
    customerCpf?: string;
    customerName?: string;
    customerPhone?: string;
    vendedorUserId?: string;
    vendedorName?: string;
    /** MODO TREINAMENTO — venda criada não é "vendida de verdade" */
    isTraining?: boolean;
  }): Promise<{ saleId: string; itemsAdded: number; total: number }> {
    if (!input.registros || input.registros.length === 0) {
      throw new BadRequestException('Nenhum REGISTRO informado');
    }
    if (!input.storeCode) {
      throw new BadRequestException('storeCode obrigatorio');
    }

    const regsCsv = input.registros.map((r) => Number(r)).filter((r) => Number.isFinite(r) && r > 0);
    if (regsCsv.length === 0) throw new BadRequestException('REGISTROs invalidos');

    const sql = `
      SELECT REGISTRO, CODIGO, DESCRICAO, QUANTIDADE, VALOR, VALORTOTAL, LOJA
      FROM caixa
      WHERE REGISTRO IN (${regsCsv.join(',')})
        AND UPPER(MARCADO) = 'SIM'
    `;
    const r = await this.erp.runReadOnly(sql, { maxRows: 100, timeoutMs: 15000 });
    const rows: any[] = r.rows || [];
    if (rows.length === 0) {
      throw new BadRequestException('Nenhum marcado ativo encontrado pros REGISTROs informados');
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
    // tocar nos REGISTROs reais do Giga). Venda fica como treino e não impacta.
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
        marcadosRegistros: input.isTraining ? null : rows.map((x) => Number(x.REGISTRO)).join(','),
      },
    });

    let total = 0;
    let itemsAdded = 0;
    for (const row of rows) {
      const qty = Math.max(1, Number(row.QUANTIDADE) || 1);
      const valorTotal = Number(row.VALORTOTAL) || (Number(row.VALOR) || 0) * qty;
      const precoUnit = qty > 0 ? Math.round((valorTotal / qty) * 100) / 100 : Number(row.VALOR) || 0;
      const descricao = String(row.DESCRICAO || row.CODIGO || 'Item marcado').slice(0, 80);
      const sku = String(row.CODIGO || `MARCADO-${row.REGISTRO}`);
      try {
        await (this.prisma as any).pdvSaleItem.create({
          data: {
            saleId: sale.id,
            sku,
            ean: null,
            ref: 'MARCADO',
            cor: null,
            tamanho: null,
            descricao,
            ncm: null,
            cfop: null,
            dataCadastro: null,
            qty,
            precoUnit,
            desconto: 0,
            total: precoUnit * qty,
            promoTag: 'MARCADO',
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

    return { saleId: sale.id, itemsAdded, total };
  }
}
