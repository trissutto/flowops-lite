import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from '../crediarios/crediarios.service';
import { PrismaService } from '../prisma/prisma.service';
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
    /** true = marcado válido no Flow, réplica pro Giga ainda na fila. */
    gigaPendente?: boolean;
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
    // Kill-switch: MARCADOS_FLOW_FIRST=0 volta o Giga pra frente (comportamento
    // antigo, incluindo o throw).
    const flowFirst = String(process.env.MARCADOS_FLOW_FIRST ?? '1') !== '0';
    const lojaCode = String(input.storeCode || '').trim().toUpperCase().replace(/^LJ/i, '').padStart(2, '0');

    let controleGiga: number | null = null;
    let gigaEnfileirado = false;

    if (!flowFirst) {
      const insertResult = await this.erp.insertCaixaMarcado({
        items: itensGiga,
        cliente: codCliente,
        loja: input.storeCode,
      });
      if (!insertResult.success) {
        throw new BadRequestException(`Falha ao inserir marcados no Giga: ${insertResult.error}`);
      }
      controleGiga = Number(insertResult.controle) || null;
      await this.gravarMarcadosNativos({
        sale, info, codCliente, lojaCode, controle: controleGiga,
      }).catch((e) =>
        this.logger.warn(`[marcados] nativo não gravado (sync horário pega): ${e?.message}`),
      );
    } else {
      // 3a. O Flow é a fonte: se ESTA gravação falhar, aí sim aborta — não há
      // onde registrar o marcado, e deixar a peça sair sem registro é pior que
      // recusar a operação.
      const idsCriados = await this.gravarMarcadosNativos({
        sale, info, codCliente, lojaCode, controle: null,
      });

      // 3b. Réplica pro Giga: tenta inline (o caso comum, milissegundos) e cai
      // pra fila se falhar. Nunca derruba a operação.
      const rep = await this.replicarMarcadoNoGiga({
        idsCriados, itensGiga, codCliente, loja: input.storeCode, saleId: input.saleId,
      });
      controleGiga = rep.controle;
      gigaEnfileirado = rep.enfileirado;
    }

    // 4. Baixa estoque Giga (igual venda — peças saem do estoque físico)
    if (this.erp.isWriteEnabled) {
      const stockItems = sale.items.map((it: any) => ({
        sku: String(it.sku || it.ref || '').trim(),
        qty: Number(it.qty) || 1,
        storeCode: input.storeCode,
      }));
      const stockResult = await this.erp.decreaseStockAsync(stockItems);
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
      `controle=${controleGiga ?? '(pendente no Giga)'} total=R$${Number(sale.total).toFixed(2)} ` +
      `items=${sale.items.length}${gigaEnfileirado ? ' · réplica na fila' : ''}`,
    );

    // `controle` é o comprovante que a vendedora vê. Com o Giga na fila ele
    // ainda não existe, então cai pro final do código da venda — que identifica
    // o marcado do mesmo jeito na consulta e não deixa a tela sem referência.
    return {
      ok: true,
      controle: controleGiga ?? `V-${String(input.saleId).slice(-6).toUpperCase()}`,
      gigaPendente: gigaEnfileirado,
      totalItems: sale.items.length,
      totalValor: Number(sale.total),
      forced: Number(sale.total) > info.limiteDisponivel,
    };
  }

  /**
   * Cria as linhas NATIVAS do marcado (a fonte). Uma por item da venda.
   *
   * `controle` só vem preenchido no caminho legado (Giga primeiro), onde os
   * REGISTROs já podem ser capturados na hora. No caminho Flow-primeiro nasce
   * nulo e é preenchido depois, quando a réplica confirma.
   *
   * Devolve os ids criados — a réplica precisa deles pra saber quais linhas
   * carimbar.
   */
  private async gravarMarcadosNativos(input: {
    sale: any;
    info: any;
    codCliente: number;
    lojaCode: string;
    controle: number | null;
  }): Promise<string[]> {
    const { sale, info, codCliente, lojaCode, controle } = input;

    // No caminho legado dá pra casar REGISTRO com SKU lendo de volta a caixa.
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
      } catch { /* segue sem registro — a réplica ou o sync casam depois */ }
    }

    const ids: string[] = [];
    for (const it of sale.items) {
      const sku = String(it.sku || it.ref || '').trim();
      const fila = regPorSku.get(sku);
      const reg = fila && fila.length ? fila.shift()! : null;
      const criado = await (this.prisma as any).marcado.create({
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
          saleId: sale.id,
        },
        select: { id: true },
      });
      ids.push(criado.id);
    }
    return ids;
  }

  /**
   * Réplica do marcado no Giga. Tenta inline; se falhar, enfileira e segue.
   *
   * NUNCA lança: o marcado já está gravado no Flow quando isto roda, e derrubar
   * a operação aqui só apagaria da tela algo que já é verdade.
   */
  private async replicarMarcadoNoGiga(input: {
    idsCriados: string[];
    itensGiga: any[];
    codCliente: number;
    loja: string;
    saleId: string;
  }): Promise<{ controle: number | null; enfileirado: boolean }> {
    const { idsCriados, itensGiga, codCliente, loja, saleId } = input;

    try {
      const r = await this.erp.insertCaixaMarcado({ items: itensGiga, cliente: codCliente, loja });
      if (r.success) {
        const controle = Number(r.controle) || null;
        await this.carimbarRetornoDoGiga(idsCriados, controle, codCliente);
        return { controle, enfileirado: false };
      }
      await this.enfileirarMarcado(input, r.error || 'insertCaixaMarcado sem sucesso');
      return { controle: null, enfileirado: true };
    } catch (e: any) {
      await this.enfileirarMarcado(input, e?.message || String(e));
      return { controle: null, enfileirado: true };
    }
  }

  private async enfileirarMarcado(
    input: { idsCriados: string[]; itensGiga: any[]; codCliente: number; loja: string; saleId: string },
    erro: string,
  ): Promise<void> {
    try {
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'marcado_criar',
          // `saleId` do outbox é chave de correlação genérica; o prefixo evita
          // colidir com o job 'venda' da MESMA venda (unique [kind, saleId]).
          saleId: `marcado-${input.saleId}`,
          payload: {
            idsCriados: input.idsCriados,
            itensGiga: input.itensGiga,
            codCliente: input.codCliente,
            loja: input.loja,
          },
          status: 'pending',
        },
      });
      this.logger.warn(
        `[marcados] Giga indisponível (${erro}) — marcado gravado no Flow e réplica enfileirada ` +
        `(venda ${input.saleId}, ${input.idsCriados.length} peça(s))`,
      );
    } catch (e: any) {
      // Fila indisponível é grave: o Giga vai ficar sem a linha e ninguém avisa.
      // O marcado no Flow continua válido — a loja cobra e a retaguarda concilia.
      this.logger.error(
        `[marcados] NÃO consegui enfileirar a réplica do marcado da venda ${input.saleId}: ${e?.message}. ` +
        `O marcado VALE no Flow; a caixa do Giga vai ficar sem essa linha até alguém reconciliar.`,
      );
    }
  }

  /**
   * Enfileira a REMOÇÃO da linha da caixa do Giga quando o DELETE inline falha.
   *
   * O marcado já está devolvido no Flow quando isto roda. A linha órfã no Giga
   * faria a cliente aparecer devendo uma peça que ela já trouxe de volta — por
   * isso a fila insiste, em vez de mandar a vendedora "resolver no Wincred".
   */
  private async enfileirarRemocaoMarcado(registro: number, erro: string): Promise<void> {
    try {
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'marcado_remover',
          // Chave por REGISTRO: se a mesma remoção for enfileirada duas vezes,
          // o unique [kind, saleId] recusa a segunda em vez de duplicar o job.
          saleId: `marcrem-${registro}`,
          payload: { registro },
          status: 'pending',
        },
      });
      this.logger.warn(
        `[marcados.devolver] DELETE da caixa REGISTRO=${registro} falhou (${erro}) — ` +
        `devolução VALE no Flow, remoção no Giga enfileirada`,
      );
    } catch (e: any) {
      const jaExiste = String(e?.code) === 'P2002';
      if (jaExiste) return; // já tem job pendente pro mesmo registro
      this.logger.error(
        `[marcados.devolver] não consegui enfileirar a remoção do REGISTRO=${registro}: ${e?.message}. ` +
        `A linha vai ficar na caixa do Giga até alguém reconciliar.`,
      );
    }
  }

  /**
   * Carimba nas linhas nativas o NUMERO e os REGISTROs que o Giga devolveu.
   * Público porque o cron do outbox chama isto quando a réplica atrasada
   * finalmente passa.
   */
  async carimbarRetornoDoGiga(ids: string[], controle: number | null, codCliente: number): Promise<void> {
    if (!ids.length) return;
    try {
      if (controle) {
        await (this.prisma as any).marcado.updateMany({
          where: { id: { in: ids } },
          data: { numero: controle },
        });
      }
      if (!controle) return;

      const cap = await this.erp.runReadOnly(
        `SELECT REGISTRO, CODIGO FROM caixa
          WHERE NUMERO = ${controle} AND CLIENTE = ${codCliente} AND UPPER(MARCADO) = 'SIM'`,
        { maxRows: 100, timeoutMs: 8000 },
      );
      const regPorSku = new Map<string, number[]>();
      for (const row of cap.rows || []) {
        const k = String(row.CODIGO || '').trim();
        if (!regPorSku.has(k)) regPorSku.set(k, []);
        regPorSku.get(k)!.push(Number(row.REGISTRO));
      }
      const linhas: any[] = await (this.prisma as any).marcado.findMany({
        where: { id: { in: ids } },
        select: { id: true, sku: true },
      });
      for (const l of linhas) {
        const fila = regPorSku.get(String(l.sku).trim());
        const reg = fila && fila.length ? fila.shift() : null;
        if (reg) {
          await (this.prisma as any).marcado
            .update({ where: { id: l.id }, data: { registroGiga: BigInt(reg) } })
            .catch(() => { /* unique de registroGiga: já carimbado, ignora */ });
        }
      }
    } catch (e: any) {
      // Carimbo é conveniência: sem ele o sync horário casa por NUMERO+loja+sku.
      this.logger.warn(`[marcados] carimbo do retorno do Giga falhou: ${e?.message}`);
    }
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
    /** Todas as fichas da MESMA pessoa (o cadastro é POR LOJA) — usadas pra
     *  somar os marcados dela sem pegar os de um xará de outra loja. */
    let fichasPessoa: any[] = [];
    try {
      const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
        where: { OR: [{ personKey: `cpf:${safeCpf}` }, { cpf: safeCpf }, { cpf: formattedCpf }] },
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
    //
    // ESCOPO POR PESSOA, não por número (04/08): o código do cliente REPETE
    // entre lojas — cód. 5967 existe em várias. Casar só por `codCliente`
    // somava o marcado de uma XARÁ de outra loja e comia o limite de quem não
    // devia nada (mesma família de bug do JOIN sem LOJA em `listAll` e da
    // comissão resolvida no mapa global). Agora casa por CPF **ou** pelo par
    // loja+código de cada ficha dela.
    let marcadosAtivos: any[] | null = null;
    if (await this.useNative()) {
      const escopoPessoa: any[] = [
        ...(safeCpf ? [{ cpf: safeCpf }] : []),
        ...fichasPessoa
          .filter((f) => f?.codigo)
          .map((f) => ({
            codCliente: { in: this.codVariants(f.codigo) },
            storeCode: String(f.loja ?? '').replace(/\D/g, '').padStart(2, '0'),
          })),
        // Ficha só no Giga (recém-cadastrada): sem par loja+código no espelho,
        // vale o código da ficha escolhida — melhor conferir demais que de menos.
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
      // REDE DE SEGURANÇA: espelho SEM linhas pra este cliente NÃO é resposta —
      // é possível mismatch/sync parcial. Cai pro Giga (a autoridade). Sem isso,
      // o cliente aparece "sem marcado" e o PDV libera marcação acima do limite.
      if (nativos.length > 0) marcadosAtivos = nativos.map((n) => this.toGigaShape(n));
    }
    if (marcadosAtivos == null) {
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
      // ASSÍNCRONO (31/07): aplica no Flow (a fonte do estoque desde 14/07) e
      // enfileira a réplica pro Giga. Antes era `increaseStock` inline e o
      // retorno de erro travava a devolução — a cliente estava com a peça na
      // mão, no balcão, e a vendedora não conseguia concluir porque um MySQL
      // em outro servidor não respondeu.
      const stockResult = await this.erp.increaseStockAsync([
        { sku: input.sku, qty: input.qty, storeCode: input.loja },
      ]);
      appliedCount = stockResult.applied?.length || 0;
      if (appliedCount === 0) {
        // Zero aplicado é problema de CADASTRO (SKU não existe naquela loja),
        // não de disponibilidade do Giga — este continua bloqueando de
        // propósito, senão a peça "volta" pra um lugar que não existe.
        return {
          ok: false,
          error: `Estoque não aplicado em nenhum SKU. Confira se "${input.sku}" existe na loja ${input.loja}.`,
        };
      }
    }

    // 2. DELETE da linha caixa (tira do nome da pessoa marcada)
    const deleteResult = await this.erp.deleteCaixaMarcadoRow({ registro: reg });
    if (!deleteResult.success) {
      // Antes isto devolvia ERRO e a devolução falhava pela metade: o estoque
      // já tinha voltado e a vendedora via "remova manualmente no Wincred" —
      // num Wincred que ninguém mais usa. Agora o Flow marca como devolvido
      // (é a fonte) e a remoção no Giga vai pra fila com retry.
      await this.enfileirarRemocaoMarcado(reg, deleteResult.error || 'falha no DELETE');
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
        if (m.registroGiga != null) {
          // Devolve de verdade: retorna estoque + remove linha no Giga + nativo.
          const r = await this.devolverItemMarcado({
            registro: Number(m.registroGiga),
            sku: m.sku,
            qty: Number(m.qty) || 1,
            loja: m.storeCode,
          });
          if (r.ok) estoqueDevolvido += Number(m.qty) || 1;
          else falhas.push(`REGISTRO ${m.registroGiga} (${m.sku}): ${r.error}`);
        } else {
          // Fantasma sem linha no Giga → só fecha o nativo (quem baixou estoque
          // foi a marcação com Giga; este registro nunca tocou o estoque).
          await (this.prisma as any).marcado.update({
            where: { id: m.id },
            data: { status: 'fechado', fechadoAt: new Date() },
          });
        }
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
   * A baixa remove a marcação do Giga (DELETE, só linha MARCADO='SIM') e
   * marca o nativo como 'baixado' — SEM venda, SEM caixa, SEM devolver
   * estoque (peça com defeito/furtada não volta pro estoque).
   * Auditável: motivo + quem autorizou (senha GERENTE no controller).
   */
  async baixarMarcados(input: {
    registros: Array<number | string>;
    codCliente?: string;
    loja?: string;
    motivo: string;
    autorizadoPor: string;
  }): Promise<{ ok: boolean; baixados: number; falhas: string[] }> {
    const motivo = String(input.motivo || '').trim().toUpperCase().slice(0, 160);
    if (!motivo) throw new BadRequestException('Informe o motivo da baixa');
    const regs = (input.registros || [])
      .map((r) => Number(r))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!regs.length && !input.codCliente) {
      throw new BadRequestException('Nada pra baixar');
    }
    if (!this.erp.isWriteEnabled) {
      throw new BadRequestException('ERP_WRITE_ENABLED desabilitado — baixa não removeria do Giga');
    }

    let baixados = 0;
    const falhas: string[] = [];
    const agora = new Date();
    const dadosBaixa = {
      status: 'baixado',
      baixadoAt: agora,
      baixaMotivo: motivo,
      baixaPor: String(input.autorizadoPor || '').slice(0, 120),
    };

    for (const reg of regs) {
      const r = await this.erp.deleteCaixaMarcadoRow({ registro: reg });
      if (!r.success && !/Nenhuma linha/i.test(r.error || '')) {
        falhas.push(`REG ${reg}: ${r.error || 'falha'}`);
        continue;
      }
      await (this.prisma as any).marcado.updateMany({
        where: { registroGiga: BigInt(reg), status: 'ativo' },
        data: dadosBaixa,
      }).catch(() => { /* sync reconcilia */ });
      baixados++;
    }

    // Linhas nativas do cliente SEM registroGiga (flow recém-criado) — baixa
    // direto no nativo (não existem no Giga ainda; o sync não vai recriar).
    if (input.codCliente) {
      const loja = String(input.loja || '').replace(/\D/g, '').padStart(2, '0');
      const r = await (this.prisma as any).marcado.updateMany({
        where: {
          status: 'ativo', registroGiga: null,
          codCliente: String(input.codCliente),
          ...(input.loja ? { storeCode: loja } : {}),
        },
        data: dadosBaixa,
      });
      baixados += Number(r?.count) || 0;
    }

    this.logger.log(
      `[marcados.baixa] ${baixados} baixado(s) SEM financeiro · motivo="${motivo}" · por=${input.autorizadoPor}` +
      (falhas.length ? ` · falhas=${falhas.length}` : ''),
    );
    return { ok: falhas.length === 0, baixados, falhas };
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
    /** ativo (default) | fechado | devolvido | baixado | fechado_giga | todos — só no NATIVO */
    status?: string;
  } = {}): Promise<any> {
    // Teto: nativo aguenta MUITO mais (Postgres indexado); o cap de 500 valia
    // pro full-scan do Giga e escondia clientes antigos (caso Itanhaém 21/07).
    const limitGiga = Math.min(500, input.limit || 100);
    const limit = Math.min(10000, input.limit || 100);

    // NATIVO primeiro — a versão Giga era full-scan da caixa POR REQUEST.
    //
    // ⚠️ AQUI o espelho vale MESMO com `MARCADOS_NATIVE_READS` desligada (04/08).
    // A flag protege a DECISÃO DE VENDA no PDV (liberar marcado acima do
    // limite); esta tela é consulta da retaguarda. Com a flag off, toda a lista
    // dependia do Giga — e quando ele cai, como caiu hoje, a tela mostra ZERO
    // marcado na rede inteira, que é pior que mostrar o espelho com a fonte
    // declarada. Se o espelho nunca foi importado, segue pro Giga como antes.
    const usarEspelho =
      (await this.useNative()) ||
      (await this.mirror.hasMirror().catch(() => false));
    if (usarEspelho) {
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
        LIMIT ${limitGiga}
      `;
      const r = await this.erp.runReadOnly(sql, { maxRows: limitGiga, timeoutMs: 15000 });
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

    // TIRA da tela de Marcados JÁ (status 'puxado') — peça não pode ficar nas
    // DUAS telas ao mesmo tempo. Cancelar a venda devolve pra 'ativo'
    // (pdv.cancel); finalizar fecha de vez (erpStepFecharMarcados). Treino não
    // grava marcadosRegistros, então nem entra aqui.
    if (!input.isTraining) {
      const regsPuxados = rows
        .map((x: any) => Number(x.REGISTRO))
        .filter((n: number) => Number.isFinite(n) && n > 0);
      if (regsPuxados.length) {
        try {
          await (this.prisma as any).marcado.updateMany({
            where: { registroGiga: { in: regsPuxados.map((n) => BigInt(n)) }, status: 'ativo' },
            data: { status: 'puxado', saleId: sale.id },
          });
        } catch (e: any) {
          this.logger.warn(`[marcados/puxar] não marcou como 'puxado': ${e?.message}`);
        }
      }
    }

    return { saleId: sale.id, itemsAdded, total };
  }
}
