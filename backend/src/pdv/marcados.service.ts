import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from '../crediarios/crediarios.service';
import { PrismaService } from '../prisma/prisma.service';
import { MarcadosMirrorService } from './marcados-mirror.service';

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
  ) {}

  /** Kill-switch: MARCADOS_NATIVE_READS=0 volta as consultas pro Giga ao vivo. */
  private get nativeReads(): boolean {
    return String(process.env.MARCADOS_NATIVE_READS ?? '').trim() !== '0';
  }

  /** Leituras nativas valem se a flag está ligada E o espelho já foi importado. */
  private async useNative(): Promise<boolean> {
    if (!this.nativeReads) return false;
    try { return await this.mirror.hasMirror(); } catch { return false; }
  }

  /** Converte a linha nativa pro shape UPPERCASE que as telas já consomem. */
  private toGigaShape(m: any): any {
    return {
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

    // Grava o NATIVO na hora (a consulta já lê daqui). Best-effort: captura
    // os REGISTROs recém-inseridos pelo CONTROLE; se o Giga demorar, cria sem
    // registroGiga e o sync horário casa por NUMERO+loja+sku.
    try {
      const lojaCode = String(input.storeCode || '').trim().toUpperCase().replace(/^LJ/i, '').padStart(2, '0');
      const controle = Number(insertResult.controle) || null;
      const regPorSku = new Map<string, number[]>();
      if (controle) {
        try {
          const cap = await this.erp.runReadOnly(
            `SELECT REGISTRO, CODIGO FROM caixa
              WHERE NUMERO = ${controle} AND CLIENTE = ${codCliente} AND UPPER(MARCADO) = 'SIM'`,
            { maxRows: 100, timeoutMs: 8000 },
          );
          for (const row of cap.rows || []) {
            const k = String(row.CODIGO || '').trim();
            if (!regPorSku.has(k)) regPorSku.set(k, []);
            regPorSku.get(k)!.push(Number(row.REGISTRO));
          }
        } catch { /* segue sem registro — sync casa depois */ }
      }
      for (const it of sale.items) {
        const sku = String(it.sku || it.ref || '').trim();
        const fila = regPorSku.get(sku);
        const reg = fila && fila.length ? fila.shift()! : null;
        await (this.prisma as any).marcado.create({
          data: {
            registroGiga: reg ? BigInt(reg) : null,
            storeCode: lojaCode,
            codCliente: String(codCliente),
            clienteNome: info.cliente?.nome || null,
            cpf: String(sale.customerCpf || '').replace(/\D/g, '') || null,
            numero: controle,
            sku: sku.slice(0, 60),
            descricao: String(it.descricao || '').slice(0, 160) || null,
            qty: Number(it.qty) || 1,
            valorUnit: Number(it.precoUnit) || 0,
            valorTotal: Number(it.total) || 0,
            dataMarcacao: new Date(),
            status: 'ativo',
            origem: 'flow',
          },
        });
      }
    } catch (e: any) {
      this.logger.warn(`[marcados] nativo não gravado na criação (sync horário pega): ${e?.message}`);
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
    const formattedCpf = safeCpf.length === 11
      ? `${safeCpf.slice(0,3)}.${safeCpf.slice(3,6)}.${safeCpf.slice(6,9)}-${safeCpf.slice(9)}`
      : safeCpf;

    // 2. Busca cliente — ESPELHO Postgres primeiro (giga_clientes, importado).
    // O caminho antigo batia no Giga ao vivo e pendurava a tela quando o pool
    // travava. Giga só entra como fallback (recém-cadastrado que o sync ainda
    // não trouxe). Se a pessoa tem ficha em várias lojas, vale a com
    // classificação 'A' e maior limite (o antigo LIMIT 1 pegava uma qualquer).
    let row: any = null;
    try {
      const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
        where: { OR: [{ personKey: `cpf:${safeCpf}` }, { cpf: safeCpf }, { cpf: formattedCpf }] },
      });
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
      const sql = `
        SELECT * FROM \`${cm.table}\`
        WHERE \`CPF\` = '${safeCpf}'
           OR \`CPF\` = '${formattedCpf}'
           OR REPLACE(REPLACE(REPLACE(\`CPF\`,'.',''),'-',''),'/','') = '${safeCpf}'
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
        motivo: 'Cliente não encontrado (nem no espelho, nem no Giga — precisa cadastrar antes)',
        cliente: null,
        marcadosAtivos: [],
        totalMarcadosAtivos: 0,
        limiteDisponivel: 0,
      };
    }

    const codCliente = String(row.CODIGO ?? '').trim();
    const classificacao = String(row.AVALIACAO || row.avaliacao || '').trim().toUpperCase();
    const limiteTotal = Number(row.LIMITECOMPRAS || row.limitecompras || 0);

    // 3. Busca marcados ativos do cliente — NATIVO primeiro (tabela marcados
    // no Postgres, "CHEGA DE GIGA" 21/07); Giga só se o espelho nunca rodou
    // ou com MARCADOS_NATIVE_READS=0.
    let marcadosAtivos: any[];
    if (await this.useNative()) {
      const nativos: any[] = await (this.prisma as any).marcado.findMany({
        where: {
          status: 'ativo',
          isTraining: false,
          OR: [
            ...(safeCpf ? [{ cpf: safeCpf }] : []),
            ...(codCliente ? [{ codCliente: String(codCliente) }] : []),
          ],
        },
        orderBy: [{ dataMarcacao: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      });
      marcadosAtivos = nativos.map((n) => this.toGigaShape(n));
    } else {
      const marcadosSql = `
        SELECT REGISTRO, NUMERO, CODIGO, DATA, DESCRICAO, QUANTIDADE, VALOR, VALORTOTAL, VENDEDOR, OPERADOR, LOJA
        FROM caixa
        WHERE UPPER(MARCADO) = 'SIM' AND CLIENTE = ${Number(codCliente) || 0}
        ORDER BY DATA DESC, REGISTRO DESC
        LIMIT 200
      `;
      const m = await this.erp.runReadOnly(marcadosSql, { maxRows: 200, timeoutMs: 10000 });
      marcadosAtivos = m.rows;
    }
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
    const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
      where: isCpfLike
        ? { OR: [{ personKey: { contains: onlyDigits } }, { cpf: { contains: onlyDigits } }] }
        : { nome: { contains: q, mode: 'insensitive' } },
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

    // 2) Badge "em marca" — NATIVO quando o espelho de marcados existe
    //    (zero Giga na busca); senão cai na agregada Giga com teto de 6s.
    let agg = new Map<string, { qtd: number; total: number }>();
    let aggOk = false;
    if (await this.useNative()) {
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
        aggOk = true;
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
        this.logger.warn(`[marcados] agregada nativa falhou: ${e?.message}`);
        aggOk = false;
      }
    }
    if (!aggOk) try {
      const codes = Array.from(new Set(
        lista.map((m) => Number(m.codigo)).filter((n) => Number.isFinite(n) && n > 0),
      ));
      if (codes.length) {
        const p = this.erp.runReadOnly(
          `SELECT CLIENTE, COUNT(*) AS qtd, COALESCE(SUM(VALORTOTAL),0) AS total
             FROM caixa
            WHERE UPPER(MARCADO) = 'SIM' AND CLIENTE IN (${codes.join(',')})
            GROUP BY CLIENTE`,
          { maxRows: 100, timeoutMs: 5000 },
        );
        const r: any = await Promise.race([
          p.catch(() => null),
          new Promise((res) => setTimeout(res, 6000, null)),
        ]);
        if (r?.rows) {
          aggOk = true;
          agg = new Map(r.rows.map((x: any) => [
            String(Number(x.CLIENTE)),
            { qtd: Number(x.qtd) || 0, total: Number(x.total) || 0 },
          ]));
        }
      }
    } catch (e: any) {
      this.logger.warn(`[marcados] agregada de marcados falhou (segue sem badge): ${e?.message}`);
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
        qtdMarcados: aggOk ? (a?.qtd ?? 0) : null,
        totalMarcados: aggOk ? Math.round((a?.total ?? 0) * 100) / 100 : null,
      };
    });
    out.sort((a, b) => (b.totalMarcados || 0) - (a.totalMarcados || 0));
    return out;
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

    // 1. Estorna estoque Giga (peça volta pra loja).
    // Item AVULSO (sku MANUAL-...) não existe no estoque do Giga — pula o
    // estorno e só remove a marcação (senão o increaseStock devolvia 0
    // aplicados e travava a devolução do item de teste/avulso).
    const isAvulso = String(input.sku).trim().toUpperCase().startsWith('MANUAL-');
    let appliedCount = 0;
    if (!isAvulso) {
      const stockResult = await this.erp.increaseStock([
        { sku: input.sku, qty: input.qty, storeCode: input.loja },
      ]);
      if (!stockResult.success) {
        return {
          ok: false,
          error: `Falha ao estornar estoque Giga: ${stockResult.error}`,
        };
      }
      appliedCount = stockResult.applied?.length || 0;
      if (appliedCount === 0) {
        return {
          ok: false,
          error: `increaseStock retornou success mas 0 SKUs aplicados. Possível mismatch storeCode "${input.loja}" vs LOJA Giga.`,
        };
      }
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

    // Atualiza o NATIVO na hora (a tela reflete sem esperar o sync horário)
    try {
      await (this.prisma as any).marcado.updateMany({
        where: { registroGiga: BigInt(reg), status: 'ativo' },
        data: { status: 'devolvido', devolvidoAt: new Date() },
      });
    } catch (e: any) {
      this.logger.warn(`[marcados.devolver] nativo não atualizado (sync pega): ${e?.message}`);
    }

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

    // NATIVO primeiro — a versão Giga era full-scan da caixa POR REQUEST.
    if (await this.useNative()) {
      const where: any = { status: 'ativo', isTraining: false };
      if (input.loja) where.storeCode = String(input.loja).replace(/[^0-9]/g, '').padStart(2, '0');
      if (input.dataInicial || input.dataFinal) {
        where.dataMarcacao = {
          ...(input.dataInicial ? { gte: new Date(`${input.dataInicial}T00:00:00.000Z`) } : {}),
          ...(input.dataFinal ? { lte: new Date(`${input.dataFinal}T23:59:59.999Z`) } : {}),
        };
      }
      const nativos: any[] = await (this.prisma as any).marcado.findMany({
        where,
        orderBy: [{ dataMarcacao: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      });
      // Nome na HORA pros que o sync ainda não enriqueceu (casamento
      // normalizado com giga_clientes — padding de zeros varia no Giga)
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
      }));
      return { rows, total: rows.length, fonte: 'flow' };
    }
    // Fallback GIGA ao vivo (espelho vazio / MARCADOS_NATIVE_READS=0)
    const where: string[] = [`UPPER(c.MARCADO) = 'SIM'`];
    if (input.loja) where.push(`c.LOJA = '${input.loja.replace(/[^0-9]/g, '').padStart(2, '0')}'`);
    if (input.dataInicial) where.push(`c.DATA >= '${input.dataInicial.replace(/[^0-9-]/g, '')}'`);
    if (input.dataFinal) where.push(`c.DATA <= '${input.dataFinal.replace(/[^0-9-]/g, '')}'`);

    try {
      const cm = await this.crediarios.detectClientesTable();
      // BUG FIX (21/07): o JOIN era só por CÓDIGO — como o código de cliente
      // REPETE em cada loja (cód 2 existe em todas), cada linha da caixa
      // multiplicava com o nome do cliente de OUTRAS lojas (aparecia "VISA
      // ELECTRON"/"CIELO" como cliente). JOIN agora casa LOJA também.
      // CAST dos dois lados: padding de zeros da LOJA é inconsistente no Giga
      // ('1' × '01') — igualdade direta anulava o nome (LEFT JOIN sem match).
      const joinClientes = cm
        ? `LEFT JOIN \`${cm.table}\` cli ON cli.\`${cm.codCliente}\` = c.CLIENTE AND CAST(cli.LOJA AS UNSIGNED) = CAST(c.LOJA AS UNSIGNED)`
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
      return { rows: r.rows, total: r.rows.length, fonte: 'giga' };
    } catch (e: any) {
      // NUNCA 500 na tela — devolve vazio com aviso acionável.
      this.logger.warn(`[marcados] listAll (Giga ao vivo) falhou: ${e?.message}`);
      return {
        rows: [], total: 0, fonte: 'giga',
        error: 'Giga demorou/caiu nessa consulta. Rode "Importar marcados do Giga" na tela do espelho Wincred — aí essa tela lê o Flow e responde na hora.',
      };
    }
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

    // NATIVO primeiro; se o espelho não tiver os REGISTROs (defasado), cai
    // pro Giga ao vivo — puxar pra venda não pode falhar por espelho velho.
    let rows: any[] = [];
    if (await this.useNative()) {
      const nativos: any[] = await (this.prisma as any).marcado.findMany({
        where: { status: 'ativo', registroGiga: { in: regsCsv.map((n) => BigInt(n)) } },
      });
      rows = nativos.map((n) => this.toGigaShape(n));
    }
    if (rows.length === 0) {
      const sql = `
        SELECT REGISTRO, CODIGO, DESCRICAO, QUANTIDADE, VALOR, VALORTOTAL, LOJA
        FROM caixa
        WHERE REGISTRO IN (${regsCsv.join(',')})
          AND UPPER(MARCADO) = 'SIM'
      `;
      const r = await this.erp.runReadOnly(sql, { maxRows: 100, timeoutMs: 15000 });
      rows = r.rows || [];
    }
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
