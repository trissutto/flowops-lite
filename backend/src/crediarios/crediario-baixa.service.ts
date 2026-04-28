/**
 * CrediarioBaixaService — fluxo de RECEBIMENTO de parcelas no PDV.
 *
 * Diferente do CrediariosService (que faz cobrança WhatsApp em massa),
 * aqui o foco é: cliente vai ATÉ a loja, vendedora busca, seleciona N
 * parcelas, recebe via PIX/dinheiro e gera recibo.
 *
 * Fluxo PIX:
 *   1. createPendingBaixa → cria header + items local com status='pending'
 *   2. Pagar.me createPixCharge → QR pro cliente
 *   3. Webhook/polling confirma → executePaidBaixa → UPDATE no Giga
 *      (PAGO='S', DATA_PAGAMENTO=NOW()) + status='paid'
 *
 * Fluxo dinheiro:
 *   1. createPaidBaixa → cria header já com status='paid' + UPDATE no Giga
 *      direto (sem ciclo PIX).
 *
 * Cálculo de juros:
 *   - Lê CrediarioConfig (diasCarencia + taxaMensalPercent + enabled)
 *   - Pra cada parcela: diasAtraso = floor((hoje - vencimento) / dia)
 *     se diasAtraso > diasCarencia E enabled:
 *       jurosDia = (taxaMensal / 30) / 100
 *       juros = valorParcela * jurosDia * (diasAtraso - diasCarencia)
 */

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from './crediarios.service';
import { PagarmeService } from '../pagarme/pagarme.service';

export interface JurosConfig {
  diasCarencia: number;
  taxaMensalPercent: number;
  enabled: boolean;
}

export interface OpenInstallment {
  registro: string;
  controle: string;
  numeroCompra: string | null;
  parcela: number | null;
  totalParcelas: number | null;
  vencimento: string;
  valorParcela: number;
  diasAtraso: number;
  jurosCalculado: number;
  valorComJuros: number;
  // Cliente (denormalizado)
  codCliente: string;
  nome: string | null;
  telefone: string | null;
}

@Injectable()
export class CrediarioBaixaService {
  private readonly logger = new Logger(CrediarioBaixaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly crediarios: CrediariosService,
    private readonly pagarme: PagarmeService,
  ) {}

  // ── Config (juros) ─────────────────────────────────────────────────

  async getConfig(): Promise<JurosConfig> {
    let cfg = await (this.prisma as any).crediarioConfig.findUnique({
      where: { id: 'singleton' },
    });
    if (!cfg) {
      cfg = await (this.prisma as any).crediarioConfig.create({
        data: { id: 'singleton' },
      });
    }
    return {
      diasCarencia: cfg.diasCarencia,
      taxaMensalPercent: cfg.taxaMensalPercent,
      enabled: cfg.enabled,
    };
  }

  async setConfig(input: Partial<JurosConfig>): Promise<JurosConfig> {
    const data: any = {};
    if (input.diasCarencia != null) {
      const d = Math.max(0, Math.min(365, Math.floor(Number(input.diasCarencia))));
      data.diasCarencia = d;
    }
    if (input.taxaMensalPercent != null) {
      const t = Math.max(0, Math.min(100, Number(input.taxaMensalPercent)));
      data.taxaMensalPercent = t;
    }
    if (input.enabled != null) data.enabled = !!input.enabled;
    await (this.prisma as any).crediarioConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    });
    return this.getConfig();
  }

  /**
   * Calcula juros pra uma parcela específica.
   * Retorna { diasAtraso, juros } — juros = 0 se enabled=false ou não atrasada.
   */
  calcJuros(
    vencimento: Date,
    valorParcela: number,
    cfg: JurosConfig,
    today = new Date(),
  ): { diasAtraso: number; juros: number } {
    const oneDay = 86400000;
    const venc = new Date(
      vencimento.getFullYear(),
      vencimento.getMonth(),
      vencimento.getDate(),
    );
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diasAtraso = Math.max(0, Math.floor((t.getTime() - venc.getTime()) / oneDay));

    if (!cfg.enabled) return { diasAtraso, juros: 0 };
    if (diasAtraso <= cfg.diasCarencia) return { diasAtraso, juros: 0 };

    const diasComJuros = diasAtraso - cfg.diasCarencia;
    const jurosDia = (cfg.taxaMensalPercent / 30) / 100;
    const juros = Math.round(valorParcela * jurosDia * diasComJuros * 100) / 100;
    return { diasAtraso, juros };
  }

  // ── Busca parcelas em aberto de UM cliente ────────────────────────

  /**
   * Busca por CPF, nome, codCliente ou telefone.
   * Retorna parcelas com PAGO='N' do cliente, com juros já calculados.
   *
   * Args:
   *   - busca: string (livre — tenta como CPF, codCliente, depois LIKE nome)
   *   - storeCode: opcional — filtra parcelas só daquela loja (default: todas)
   */
  async listOpenInstallmentsByCustomer(input: {
    busca: string;
    storeCode?: string;
  }): Promise<OpenInstallment[]> {
    const busca = String(input.busca || '').trim();
    if (busca.length < 2) {
      throw new BadRequestException('Informe pelo menos 2 caracteres pra buscar');
    }

    const map = await this.crediarios.detectColumns();
    if (!map.vencimento || !map.valorParcela || !map.codCliente) {
      throw new BadRequestException('Colunas essenciais não detectadas no Giga');
    }

    // Heurística: se busca é só números → tenta codCliente + telefone.
    // Senão → busca LIKE pelo nome.
    const onlyDigits = /^\d+$/.test(busca);
    const safeBusca = busca.replace(/['"\\]/g, '').slice(0, 100);
    const safeStore = input.storeCode
      ? String(input.storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
      : null;

    // Resolve codClientes que batem
    let codClientes: string[] = [];

    if (onlyDigits) {
      // Tenta como codCliente direto
      codClientes = [safeBusca];
      // Se tem tabela de clientes, também tenta como CPF/telefone
      try {
        const cm = await this.crediarios.detectClientesTable();
        if (cm) {
          const orParts: string[] = [`\`${cm.codCliente}\` = '${safeBusca}'`];
          // Procura por colunas tipo cpf/cnpj/telefone
          // Heurística simples: tenta nome de coluna comum
          const sql = `SELECT \`${cm.codCliente}\` AS cod FROM \`${cm.table}\` WHERE ${orParts.join(' OR ')} LIMIT 50`;
          const r = await this.erp.runReadOnly(sql, { maxRows: 50, timeoutMs: 10000 });
          for (const row of r.rows) codClientes.push(String(row.cod));
        }
      } catch {/* ignora — usa só o codCliente direto */}
    } else {
      // Busca por nome
      const cm = await this.crediarios.detectClientesTable();
      if (cm && cm.nome) {
        const sql = `SELECT \`${cm.codCliente}\` AS cod FROM \`${cm.table}\` WHERE \`${cm.nome}\` LIKE '%${safeBusca}%' LIMIT 50`;
        const r = await this.erp.runReadOnly(sql, { maxRows: 50, timeoutMs: 10000 });
        codClientes = r.rows.map((row) => String(row.cod));
      }
      // Fallback: nome desnormalizado em movimento.NOME
      if (codClientes.length === 0 && map.nome && map.codCliente) {
        const sql = `SELECT DISTINCT \`${map.codCliente}\` AS cod FROM \`movimento\` WHERE \`${map.nome}\` LIKE '%${safeBusca}%' LIMIT 50`;
        const r = await this.erp.runReadOnly(sql, { maxRows: 50, timeoutMs: 10000 });
        codClientes = r.rows.map((row) => String(row.cod));
      }
    }

    codClientes = Array.from(new Set(codClientes.filter((c) => c && c !== '0')));
    if (codClientes.length === 0) return [];

    // Lista parcelas em aberto desses codClientes
    const select: string[] = [];
    const addCol = (logical: keyof typeof map, alias: string) => {
      const col = map[logical];
      if (col) select.push(`\`${col}\` AS ${alias}`);
    };
    addCol('registro', 'registro');
    addCol('controle', 'controle');
    addCol('numeroCompra', 'numeroCompra');
    addCol('loja', 'loja');
    addCol('codCliente', 'codCliente');
    addCol('nome', 'nome');
    addCol('parcela', 'parcela');
    addCol('totalParcelas', 'totalParcelas');
    addCol('vencimento', 'vencimento');
    addCol('valorParcela', 'valorParcela');

    const inList = codClientes.map((c) => `'${c}'`).join(',');
    const where: string[] = [`\`${map.codCliente}\` IN (${inList})`];
    if (map.pago) {
      where.push(`(\`${map.pago}\` = 'N' OR \`${map.pago}\` = 'n')`);
    } else if (map.dataPagamento) {
      where.push(
        `(\`${map.dataPagamento}\` IS NULL OR \`${map.dataPagamento}\` = '0000-00-00')`,
      );
    }
    if (safeStore && map.loja) {
      where.push(`\`${map.loja}\` = '${safeStore}'`);
    }

    const sql = `SELECT ${select.join(', ')} FROM \`movimento\` WHERE ${where.join(' AND ')} ORDER BY \`${map.vencimento}\` ASC, \`${map.codCliente}\` ASC LIMIT 500`;
    const result = await this.erp.runReadOnly(sql, { maxRows: 500, timeoutMs: 30000 });

    // Enriquece com telefone
    const phones = await this.crediarios.fetchPhonesByClienteIds(codClientes);

    const cfg = await this.getConfig();
    const out: OpenInstallment[] = [];
    for (const row of result.rows) {
      const valor = Number(row.valorParcela || 0);
      if (!row.vencimento || !valor) continue;
      const venc = new Date(row.vencimento);
      const { diasAtraso, juros } = this.calcJuros(venc, valor, cfg);
      const codCliente = String(row.codCliente);
      const phoneInfo = phones.get(codCliente) || null;
      out.push({
        registro: String(row.registro),
        controle: String(row.controle),
        numeroCompra: row.numeroCompra ? String(row.numeroCompra) : null,
        parcela: row.parcela != null ? Number(row.parcela) : null,
        totalParcelas: row.totalParcelas != null ? Number(row.totalParcelas) : null,
        vencimento: venc.toISOString().slice(0, 10),
        valorParcela: valor,
        diasAtraso,
        jurosCalculado: juros,
        valorComJuros: Math.round((valor + juros) * 100) / 100,
        codCliente,
        nome: row.nome ? String(row.nome) : phoneInfo?.nome || null,
        telefone: phoneInfo?.telefone || null,
      });
    }
    return out;
  }

  // ── Preview ────────────────────────────────────────────────────────

  async previewBaixa(input: {
    parcelas: Array<{ registro: string; controle: string }>;
    storeCode?: string;
  }): Promise<{
    parcelas: OpenInstallment[];
    totalPrincipal: number;
    totalJuros: number;
    totalPago: number;
  }> {
    const map = await this.crediarios.detectColumns();
    if (!map.registro || !map.controle) {
      throw new BadRequestException('Coluna REGISTRO/CONTROLE não detectada');
    }
    if (!input.parcelas?.length) throw new BadRequestException('Selecione pelo menos 1 parcela');

    const cfg = await this.getConfig();

    // Busca cada parcela no Giga
    const result: OpenInstallment[] = [];
    for (const p of input.parcelas) {
      const safeReg = String(p.registro).replace(/['"\\]/g, '');
      const safeCtl = String(p.controle).replace(/['"\\]/g, '');

      const select: string[] = [];
      const addCol = (logical: keyof typeof map, alias: string) => {
        const col = map[logical];
        if (col) select.push(`\`${col}\` AS ${alias}`);
      };
      addCol('registro', 'registro');
      addCol('controle', 'controle');
      addCol('numeroCompra', 'numeroCompra');
      addCol('codCliente', 'codCliente');
      addCol('nome', 'nome');
      addCol('parcela', 'parcela');
      addCol('totalParcelas', 'totalParcelas');
      addCol('vencimento', 'vencimento');
      addCol('valorParcela', 'valorParcela');
      addCol('pago', 'pago');

      const sql = `SELECT ${select.join(', ')} FROM \`movimento\` WHERE \`${map.registro}\` = '${safeReg}' AND \`${map.controle}\` = '${safeCtl}' LIMIT 1`;
      const r = await this.erp.runReadOnly(sql, { maxRows: 1, timeoutMs: 10000 });
      if (!r.rows.length) {
        throw new BadRequestException(`Parcela não encontrada: ${safeReg}/${safeCtl}`);
      }
      const row = r.rows[0];
      const isPaid = String(row.pago || '').toUpperCase() === 'S';
      if (isPaid) {
        throw new BadRequestException(`Parcela ${safeReg}/${safeCtl} já está paga no Giga`);
      }
      const valor = Number(row.valorParcela || 0);
      const venc = new Date(row.vencimento);
      const { diasAtraso, juros } = this.calcJuros(venc, valor, cfg);
      result.push({
        registro: String(row.registro),
        controle: String(row.controle),
        numeroCompra: row.numeroCompra ? String(row.numeroCompra) : null,
        parcela: row.parcela != null ? Number(row.parcela) : null,
        totalParcelas: row.totalParcelas != null ? Number(row.totalParcelas) : null,
        vencimento: venc.toISOString().slice(0, 10),
        valorParcela: valor,
        diasAtraso,
        jurosCalculado: juros,
        valorComJuros: Math.round((valor + juros) * 100) / 100,
        codCliente: String(row.codCliente),
        nome: row.nome ? String(row.nome) : null,
        telefone: null,
      });
    }

    const totalPrincipal = Math.round(result.reduce((a, p) => a + p.valorParcela, 0) * 100) / 100;
    const totalJuros = Math.round(result.reduce((a, p) => a + p.jurosCalculado, 0) * 100) / 100;
    const totalPago = Math.round((totalPrincipal + totalJuros) * 100) / 100;

    return { parcelas: result, totalPrincipal, totalJuros, totalPago };
  }

  // ── Aplicar baixa (DINHEIRO — direto) ─────────────────────────────

  async applyBaixaDinheiro(input: {
    parcelas: Array<{ registro: string; controle: string }>;
    lojaCode: string;
    lojaName?: string;
    userId?: string;
    userName?: string;
  }): Promise<{ baixaId: string }> {
    const preview = await this.previewBaixa({ parcelas: input.parcelas });
    const baixaId = await this.persistBaixa({
      preview,
      formaPagamento: 'dinheiro',
      status: 'paid',
      paidAt: new Date(),
      lojaCode: input.lojaCode,
      lojaName: input.lojaName,
      userId: input.userId,
      userName: input.userName,
    });
    // Executa UPDATE no Giga
    await this.executeGigaUpdates(baixaId);
    return { baixaId };
  }

  // ── Aplicar baixa (PIX — gera Pagar.me) ───────────────────────────

  async createPendingBaixaPix(input: {
    parcelas: Array<{ registro: string; controle: string }>;
    lojaCode: string;
    lojaName?: string;
    userId?: string;
    userName?: string;
    customerName?: string;
    customerCpf?: string;
    customerPhone?: string;
    customerEmail?: string;
  }): Promise<{
    baixaId: string;
    pagarmeOrderId: string;
    qrCodeText: string;
    qrCodeImageUrl: string;
    valor: number;
  }> {
    const preview = await this.previewBaixa({ parcelas: input.parcelas });
    if (preview.totalPago <= 0) {
      throw new BadRequestException('Total da baixa deve ser > 0');
    }
    const baixaId = await this.persistBaixa({
      preview,
      formaPagamento: 'pix',
      status: 'pending',
      paidAt: null,
      lojaCode: input.lojaCode,
      lojaName: input.lojaName,
      userId: input.userId,
      userName: input.userName,
      customerName: input.customerName,
      customerCpf: input.customerCpf,
      customerPhone: input.customerPhone,
    });

    // Gera PIX no Pagar.me — usa o baixaId como saleId pra rastreio
    const pix = await this.pagarme.createPixCharge({
      saleId: baixaId,
      valor: preview.totalPago,
      storeCode: input.lojaCode,
      customerName: input.customerName || preview.parcelas[0]?.nome || 'Consumidor Final',
      customerCpf: input.customerCpf,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      expiresInMinutes: 15,
    });

    // Vincula a order Pagar.me ao header da baixa
    await (this.prisma as any).crediarioBaixa.update({
      where: { id: baixaId },
      data: { pagarmeOrderId: pix.pagarmeOrderId },
    });

    return {
      baixaId,
      pagarmeOrderId: pix.pagarmeOrderId,
      qrCodeText: pix.qrCodeText,
      qrCodeImageUrl: pix.qrCodeImageUrl,
      valor: preview.totalPago,
    };
  }

  /**
   * Confirma uma baixa PIX que foi paga (chamado pelo polling/webhook).
   * Idempotente — se já tá paid, não faz nada.
   */
  async confirmBaixaPix(baixaId: string): Promise<{ confirmed: boolean }> {
    const baixa = await (this.prisma as any).crediarioBaixa.findUnique({
      where: { id: baixaId },
    });
    if (!baixa) throw new NotFoundException('Baixa não encontrada');
    if (baixa.status === 'paid') return { confirmed: false };

    // Verifica status real na Pagar.me
    if (!baixa.pagarmeOrderId) throw new BadRequestException('Baixa sem order Pagar.me vinculada');
    const live = await this.pagarme.checkOrderStatus(baixa.pagarmeOrderId);
    if (!live.isPaid) {
      return { confirmed: false };
    }

    await (this.prisma as any).crediarioBaixa.update({
      where: { id: baixaId },
      data: { status: 'paid', paidAt: new Date() },
    });

    // Executa UPDATE no Giga
    await this.executeGigaUpdates(baixaId);
    return { confirmed: true };
  }

  /**
   * Status de uma baixa (pra polling do PDV).
   */
  async getBaixaStatus(baixaId: string): Promise<{
    found: boolean;
    status?: string;
    isPaid?: boolean;
  }> {
    const baixa = await (this.prisma as any).crediarioBaixa.findUnique({
      where: { id: baixaId },
    });
    if (!baixa) return { found: false };

    let status = baixa.status;
    // Se PIX pendente, consulta Pagar.me ao vivo + auto-confirma
    if (status === 'pending' && baixa.pagarmeOrderId && baixa.formaPagamento === 'pix') {
      try {
        const live = await this.pagarme.checkOrderStatus(baixa.pagarmeOrderId);
        if (live.isPaid) {
          await this.confirmBaixaPix(baixaId);
          status = 'paid';
        }
      } catch {/* mantém pending */}
    }

    return { found: true, status, isPaid: status === 'paid' };
  }

  // ── Helpers privados ──────────────────────────────────────────────

  private async persistBaixa(input: {
    preview: Awaited<ReturnType<CrediarioBaixaService['previewBaixa']>>;
    formaPagamento: string;
    status: string;
    paidAt: Date | null;
    lojaCode: string;
    lojaName?: string;
    userId?: string;
    userName?: string;
    customerName?: string;
    customerCpf?: string;
    customerPhone?: string;
  }): Promise<string> {
    const cliente = input.preview.parcelas[0] || null;
    const baixa = await (this.prisma as any).crediarioBaixa.create({
      data: {
        codCliente: cliente?.codCliente || null,
        customerName: input.customerName || cliente?.nome || null,
        customerCpf: input.customerCpf || null,
        customerPhone: input.customerPhone || cliente?.telefone || null,
        lojaCode: input.lojaCode,
        lojaName: input.lojaName || null,
        userId: input.userId || null,
        userName: input.userName || null,
        totalParcelas: input.preview.parcelas.length,
        totalPrincipal: input.preview.totalPrincipal,
        totalJuros: input.preview.totalJuros,
        totalPago: input.preview.totalPago,
        formaPagamento: input.formaPagamento,
        status: input.status,
        paidAt: input.paidAt,
        items: {
          create: input.preview.parcelas.map((p) => ({
            registro: p.registro,
            controle: p.controle,
            numeroPromis: p.numeroCompra
              ? `${p.numeroCompra}/${p.parcela}`
              : null,
            parcelaNum: p.parcela,
            totalParcelas: p.totalParcelas,
            vencimento: new Date(p.vencimento),
            valorParcela: p.valorParcela,
            jurosCalculado: p.jurosCalculado,
            diasAtraso: p.diasAtraso,
            valorPago: p.valorComJuros,
          })),
        },
      },
    });
    return baixa.id;
  }

  /**
   * Executa UPDATE no Giga pra todos os items de uma baixa.
   * Idempotente — pula items que já tem gigaUpdateOk=true.
   * Marca cada item com sucesso/erro pra auditoria.
   */
  private async executeGigaUpdates(baixaId: string): Promise<void> {
    const items = await (this.prisma as any).crediarioBaixaItem.findMany({
      where: { baixaId, gigaUpdateOk: false },
    });
    if (!items.length) return;

    const map = await this.crediarios.detectColumns();
    const cols = {
      registro: map.registro,
      controle: map.controle,
      pago: map.pago,
      dataPagamento: map.dataPagamento,
      valorPago: map.valorPago,
    };

    for (const it of items) {
      const result = await this.erp.markCrediarioParcelaPaid({
        registro: it.registro,
        controle: it.controle,
        valorPago: it.valorPago,
        dataPagamento: new Date(),
        columns: cols,
      });
      await (this.prisma as any).crediarioBaixaItem.update({
        where: { id: it.id },
        data: {
          gigaUpdateOk: result.success,
          gigaError: result.error || null,
        },
      });
      if (!result.success) {
        this.logger.error(
          `[crediario-baixa] item ${it.id} (REGISTRO=${it.registro} CONTROLE=${it.controle}) falhou: ${result.error}`,
        );
      }
    }
  }

  // ── Detalhe (recibo) ──────────────────────────────────────────────

  async getBaixaDetail(baixaId: string): Promise<any> {
    const baixa = await (this.prisma as any).crediarioBaixa.findUnique({
      where: { id: baixaId },
      include: {
        items: { orderBy: { vencimento: 'asc' } },
      },
    });
    if (!baixa) throw new NotFoundException('Baixa não encontrada');
    return baixa;
  }
}
