import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PdvService } from './pdv.service';
import { ErpService } from '../erp/erp.service';
import { PixService } from './pix.service';
import { NfceService } from './nfce.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { CrediariosService } from '../crediarios/crediarios.service';
import { CrediarioBaixaService } from '../crediarios/crediario-baixa.service';
import { CrediarioPrintService } from './crediario-print.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';

/**
 * /pdv — frente de caixa.
 * Acessível por role 'store' (vendedora) e 'admin'.
 */
@UseGuards(JwtAuthGuard)
@Controller('pdv')
export class PdvController {
  constructor(
    private readonly svc: PdvService,
    private readonly erp: ErpService,
    private readonly pix: PixService,
    private readonly nfce: NfceService,
    private readonly pagarme: PagarmeService,
    private readonly crediarios: CrediariosService,
    private readonly crediarioBaixa: CrediarioBaixaService,
    private readonly crediarioPrint: CrediarioPrintService,
    private readonly woo: WooCommerceService,
  ) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  /**
   * GET /pdv/product-image?sku=XXX
   * Retorna URL da foto do produto no WooCommerce (cache 1h em memória).
   * Usado pela tabela do carrinho do PDV pra mostrar miniatura ao lado do item.
   */
  @Get('product-image')
  async getProductImage(@Req() req: any, @Query('sku') sku: string) {
    this.requireRole(req);
    if (!sku) return { url: null };
    const url = await this.woo.getProductImageBySku(String(sku).trim());
    return { url };
  }

  /**
   * GET /pdv/product?sku=5358427
   * Busca produto Giga pra pré-visualização (sem adicionar ao carrinho).
   * Útil pra consulta de preço.
   */
  @Get('product')
  product(@Req() req: any, @Query('sku') sku: string) {
    this.requireRole(req);
    if (!sku) throw new BadRequestException('sku obrigatório');
    return this.erp.getPdvProductInfo(sku);
  }

  /**
   * POST /pdv/sales { storeCode }
   * Abre nova venda OPEN.
   */
  @Post('sales')
  createSale(@Req() req: any, @Body() body: { storeCode: string; sellerId?: string; sellerName?: string }) {
    this.requireRole(req);
    return this.svc.createSale({
      storeCode: body?.storeCode,
      vendedorUserId: req?.user?.id || req?.user?.sub,
      vendedorName: req?.user?.name || null,
      sellerId: body?.sellerId,
      sellerName: body?.sellerName,
    });
  }

  /**
   * PATCH /pdv/sales/:id/seller
   * Body: { sellerId: string | null }
   * Atribui ou remove a vendedora (Seller) responsável pela venda.
   */
  @Patch('sales/:id/seller')
  setSeller(@Req() req: any, @Param('id') saleId: string, @Body() body: { sellerId: string | null }) {
    this.requireRole(req);
    return this.svc.setSeller({ saleId, sellerId: body?.sellerId ?? null });
  }

  /**
   * POST /pdv/sales/:id/nfce — emite NFC-e da venda finalizada.
   * Em modo stub (sem certificado A1) retorna XML preview + chave válida.
   */
  @Post('sales/:id/nfce')
  emitNfce(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.nfce.emit(id);
  }

  /**
   * POST /pdv/sales/:id/nfce/cancel { justificativa }
   * Cancela NFC-e autorizada via evento 110111. Janela: 30min após autorização.
   * Justificativa: 15-255 chars (regra SEFAZ).
   */
  @Post('sales/:id/nfce/cancel')
  cancelNfce(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { justificativa: string },
  ) {
    this.requireRole(req);
    if (!body?.justificativa || String(body.justificativa).trim().length < 15) {
      throw new BadRequestException(
        'Justificativa do cancelamento deve ter pelo menos 15 caracteres',
      );
    }
    return this.nfce.cancel(id, body.justificativa);
  }

  /**
   * GET /pdv/nfce/config?storeCode=01 — leitura da config NFC-e da loja.
   */
  @Get('nfce/config')
  async getNfceConfig(@Req() req: any, @Query('storeCode') storeCode: string) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.nfce.getConfig(storeCode);
  }

  /**
   * GET /pdv/nfce/status — status NFC-e de TODAS as lojas (dashboard).
   */
  @Get('nfce/status')
  async listNfceStatus(@Req() req: any) {
    this.requireRole(req);
    return this.nfce.listAllStatus();
  }

  /**
   * POST /pdv/nfce/config — salva config (admin only).
   * Body: { storeCode, ambiente, cnpj, ie, csc..., certPfxB64?, certPfxPass? }
   */
  /**
   * POST /pdv/nfce/test/:storeCode — emite NFC-e fictícia pra testar
   * config + cert + transmissão SEFAZ. Não afeta vendas reais.
   * Admin only.
   */
  @Post('nfce/test/:storeCode')
  testNfce(@Req() req: any, @Param('storeCode') storeCode: string) {
    if (req?.user?.role !== 'admin')
      throw new ForbiddenException('Apenas admin');
    return this.nfce.testEmit(storeCode);
  }

  @Post('nfce/config')
  async setNfceConfig(@Req() req: any, @Body() body: any) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode editar config NFC-e');
    }
    if (!body?.storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.nfce.setConfig(body.storeCode, body);
  }

  /**
   * GET /pdv/stats/today?storeCode=01
   * Vendas finalizadas hoje da loja, total vendido e ticket médio.
   */
  @Get('stats/today')
  statsToday(@Req() req: any, @Query('storeCode') storeCode: string) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.statsToday(storeCode);
  }

  /**
   * GET /pdv/sales?storeCode=01&status=open&limit=20
   */
  @Get('sales')
  listSales(
    @Req() req: any,
    @Query('storeCode') storeCode: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.listSales({
      storeCode,
      status,
      limit: limit ? Number(limit) : 20,
    });
  }

  /**
   * GET /pdv/sales/:id
   */
  @Get('sales/:id')
  getSale(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getSale(id);
  }

  /**
   * POST /pdv/sales/:id/items { skuOrEan, qty? }
   */
  @Post('sales/:id/items')
  addItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { skuOrEan: string; qty?: number },
  ) {
    this.requireRole(req);
    return this.svc.addItem({
      saleId: id,
      skuOrEan: body?.skuOrEan,
      qty: body?.qty,
    });
  }

  /**
   * POST /pdv/sales/:id/items/manual { descricao, valor, qty? }
   * Adiciona item MANUAL — usado quando o produto não passa pelo bipe.
   * Vendedora digita descrição + valor livres pra não travar o caixa.
   */
  @Post('sales/:id/items/manual')
  addManualItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { descricao: string; valor: number; qty?: number },
  ) {
    this.requireRole(req);
    return this.svc.addManualItem({
      saleId: id,
      descricao: body?.descricao,
      valor: body?.valor,
      qty: body?.qty,
    });
  }

  /**
   * PATCH /pdv/sales/:id/items/:itemId { qty?, desconto? }
   * Atualiza qty e/ou desconto do item.
   */
  @Patch('sales/:id/items/:itemId')
  updateItem(
    @Req() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { qty?: number; desconto?: number },
  ) {
    this.requireRole(req);
    return this.svc.updateItem({
      saleId: id,
      itemId,
      qty: body?.qty,
      desconto: body?.desconto,
    });
  }

  /**
   * PATCH /pdv/sales/:id/discount { desconto }
   * Aplica desconto na venda inteira (em R$, não percentual).
   */
  @Patch('sales/:id/discount')
  setDiscount(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { desconto: number },
  ) {
    this.requireRole(req);
    return this.svc.setSaleDiscount({ saleId: id, desconto: body?.desconto || 0 });
  }

  /**
   * PATCH /pdv/sales/:id/promotion { promotion }
   * Define campanha promocional ATIVA (exclusiva).
   * Valores: 'YEAR_BASED' | 'FOUR_FOR_THREE' | 'NONE' | null
   */
  @Patch('sales/:id/promotion')
  setPromotion(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { promotion: string | null },
  ) {
    this.requireRole(req);
    return this.svc.setPromotion({ saleId: id, promotion: body?.promotion ?? null });
  }

  /**
   * DELETE /pdv/sales/:id/items/:itemId
   */
  @Delete('sales/:id/items/:itemId')
  removeItem(
    @Req() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    this.requireRole(req);
    return this.svc.removeItem({ saleId: id, itemId });
  }

  /**
   * PATCH /pdv/sales/:id/customer { cpf, name, email, phone }
   */
  @Patch('sales/:id/customer')
  setCustomer(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { cpf?: string; name?: string; email?: string; phone?: string },
  ) {
    this.requireRole(req);
    return this.svc.setCustomer({ saleId: id, ...body });
  }

  /**
   * POST /pdv/sales/:id/finalize { paymentMethod, paymentDetails? }
   */
  @Post('sales/:id/finalize')
  finalize(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { paymentMethod: string; paymentDetails?: any },
  ) {
    this.requireRole(req);
    return this.svc.finalize({
      saleId: id,
      paymentMethod: body?.paymentMethod,
      paymentDetails: body?.paymentDetails,
      // Passa storeCode do JWT pra reconciliação automática quando a
      // venda foi criada com loja diferente do caixa atual.
      userStoreCode: req?.user?.storeCode,
    });
  }

  /**
   * POST /pdv/sales/:id/payments { method, valor, details? }
   * Adiciona pagamento parcial à venda (split payment).
   */
  @Post('sales/:id/payments')
  addPayment(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { method: string; valor: number; details?: any },
  ) {
    this.requireRole(req);
    return this.svc.addPayment({
      saleId: id,
      method: body?.method,
      valor: body?.valor,
      details: body?.details,
    });
  }

  /**
   * DELETE /pdv/sales/:id/payments/:paymentId
   */
  @Delete('sales/:id/payments/:paymentId')
  removePayment(
    @Req() req: any,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
  ) {
    this.requireRole(req);
    return this.svc.removePayment({ saleId: id, paymentId });
  }

  /**
   * POST /pdv/sales/:id/pix-charge
   * Gera BR Code PIX (QR Code com valor cravado) pra pagamento.
   * Não chama API de banco — gera localmente. Cai direto na conta da chave.
   * Vendedora confirma manualmente após ver o pagamento no app do banco.
   */
  /**
   * POST /pdv/sales/:id/pix-charge
   * Gera cobrança PIX dinâmica via Pagar.me (Stone) — usa a integração já
   * configurada em /config/pagarme. Retorna QR Code + BR Code real.
   */
  @Post('sales/:id/pix-charge')
  async pixCharge(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    const sale = await this.svc.getSale(id);
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda já está ${sale.status}`);
    if (sale.total <= 0) throw new BadRequestException('Total da venda deve ser > 0');

    const r = await this.pagarme.createPixCharge({
      saleId: id,
      valor: sale.total,
      storeCode: sale.storeCode,
      customerName: sale.customerName || undefined,
      customerCpf: sale.customerCpf || undefined,
      customerEmail: sale.customerEmail || undefined,
      customerPhone: sale.customerPhone || undefined,
    });

    // Mantém os mesmos nomes de campo que o frontend já espera
    // (qrCodeDataUrl + payload), pra não quebrar o modal.
    return {
      txid: r.pagarmeOrderId,
      valor: r.valor,
      qrCodeDataUrl: r.qrCodeImageUrl,
      payload: r.qrCodeText,
      expiresAt: r.expiresAt,
    };
  }

  /**
   * POST /pdv/sales/:id/cancel { reason? }
   */
  @Post('sales/:id/cancel')
  cancel(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    this.requireRole(req);
    return this.svc.cancel({ saleId: id, reason: body?.reason });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CREDIÁRIO — busca cliente + pendências, e gera N parcelas no Giga
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * GET /pdv/customer-info?cpf=12345678900
   * Busca cliente no Giga pelo CPF + retorna pendências (parcelas em aberto).
   * Usado pelo PaymentModal aba crediário pra mostrar banner de inadimplência.
   * Não bloqueia venda — só avisa.
   */
  @Get('customer-info')
  async getCustomerInfo(@Req() req: any, @Query('cpf') cpf: string) {
    this.requireRole(req);
    if (!cpf) {
      throw new BadRequestException('CPF ou código do cliente obrigatório');
    }
    const cleanCpf = cpf.replace(/\D/g, '');
    if (cleanCpf.length < 3) {
      throw new BadRequestException('Mínimo 3 dígitos');
    }

    // Busca cliente no Giga (tabela clientes detectada dinamicamente)
    const cm = await this.crediarios.detectClientesTable();
    if (!cm) {
      return { found: false, message: 'Tabela de clientes do Giga não detectada' };
    }

    // Procura por CPF (coluna detectada dinamicamente — pode chamar CPF, cpf, CPFCGC, etc).
    // BUG FIX: CPF no Giga pode estar FORMATADO (108.458.788-24), só dígitos,
    // ter espaços invisíveis, ou outros caracteres. Normalizamos AMBOS os lados
    // antes de comparar usando REPLACE recursivo + TRIM.
    const safeCpf = cleanCpf.replace(/[^0-9]/g, '').slice(0, 14);
    const cpfCol = cm.cpf || 'CPF';
    // Helper SQL que normaliza coluna CPF: tira pontos, traços, barras, espaços e TRIM
    const normalizeSql = `TRIM(REPLACE(REPLACE(REPLACE(REPLACE(\`${cpfCol}\`, '.', ''), '-', ''), '/', ''), ' ', ''))`;
    let cliente: any = null;

    // Tentativa 1: CPF normalizado igual exato
    try {
      const sql = `SELECT * FROM \`${cm.table}\` WHERE ${normalizeSql} = '${safeCpf}' LIMIT 1`;
      const r = await this.erp.runReadOnly(sql, { maxRows: 1, timeoutMs: 10000 });
      cliente = r.rows[0] || null;
    } catch (e: any) {
      console.warn('[customer-info] erro buscando CPF normalizado:', e?.message);
    }

    // Tentativa 2: codCliente direto (caso passou um código em vez de CPF)
    if (!cliente) {
      try {
        const sql2 = `SELECT * FROM \`${cm.table}\` WHERE CONCAT('', \`${cm.codCliente}\`) = '${safeCpf}' LIMIT 1`;
        const r2 = await this.erp.runReadOnly(sql2, { maxRows: 1, timeoutMs: 10000 });
        cliente = r2.rows[0] || null;
      } catch {/* ignora */}
    }

    // Tentativa 3: CPF como LIKE — pega mesmo se tem outros chars escondidos
    // (zero-width space, BOM, tabs, etc). Mais permissivo, último recurso.
    if (!cliente && safeCpf.length >= 11) {
      try {
        const sql3 = `SELECT * FROM \`${cm.table}\` WHERE ${normalizeSql} LIKE '%${safeCpf}%' LIMIT 1`;
        const r3 = await this.erp.runReadOnly(sql3, { maxRows: 1, timeoutMs: 10000 });
        cliente = r3.rows[0] || null;
        if (cliente) {
          console.log(`[customer-info] cliente achado via LIKE fallback: cpf=${safeCpf}`);
        }
      } catch {/* ignora */}
    }

    if (!cliente) {
      console.log(`[customer-info] NÃO ACHOU: tabela=${cm.table} cpfCol=${cpfCol} cpfBusca=${safeCpf}`);
    }

    if (!cliente) {
      return { found: false, message: 'Cliente não encontrado no Giga — cadastre antes de fazer crediário' };
    }

    const codCliente = String(cliente[cm.codCliente] || '').trim();
    const nome = cm.nome ? String(cliente[cm.nome] || '').trim() : null;

    // Lista pendências (parcelas em aberto)
    let pendencias: any[] = [];
    let totalDevido = 0;
    let totalAtraso = 0;
    try {
      pendencias = await this.crediarioBaixa.listOpenInstallmentsByCustomer({
        busca: codCliente,
      });
      totalDevido = pendencias.reduce((s, p) => s + (p.valorParcela || 0), 0);
      totalAtraso = pendencias.filter((p) => p.diasAtraso > 0).reduce((s, p) => s + (p.valorParcela || 0), 0);
    } catch (e: any) {
      // Se falhar a busca de pendências, ainda retorna o cliente
      console.warn('[pdv/customer-info] erro ao listar pendências:', e?.message);
    }

    return {
      found: true,
      cliente: {
        codCliente,
        nome,
        cpf: cleanCpf,
        raw: cliente, // dados completos pra preencher form de cadastro se precisar
      },
      pendencias: pendencias.map((p) => ({
        registro: p.registro,
        controle: p.controle,
        parcela: p.parcela,
        totalParcelas: p.totalParcelas,
        vencimento: p.vencimento,
        valor: p.valorParcela,
        diasAtraso: p.diasAtraso,
      })),
      totalDevido: Math.round(totalDevido * 100) / 100,
      totalAtraso: Math.round(totalAtraso * 100) / 100,
      qtdPendencias: pendencias.length,
      qtdAtrasadas: pendencias.filter((p) => p.diasAtraso > 0).length,
    };
  }

  /**
   * GET /pdv/customer-search?q=texto&limit=20
   * Typeahead pra aba crediário do PaymentModal — busca cliente por:
   *  - CPF (se q tiver só dígitos)
   *  - codCliente (se q tiver só dígitos)
   *  - Nome (LIKE %q% case-insensitive)
   *
   * Retorna lista de até `limit` clientes ordenados por nome. NÃO retorna
   * dados sensíveis completos (sem RG, endereço completo) — só o suficiente
   * pra escolher na lista. Pra pegar tudo, usa /customer-info?cpf=XXX.
   */
  @Get('customer-search')
  async searchCustomers(
    @Req() req: any,
    @Query('q') q: string,
    @Query('limit') limitStr?: string,
  ) {
    this.requireRole(req);
    const term = String(q || '').trim();
    if (term.length < 2) {
      return { results: [] };
    }
    const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 50);

    const cm = await this.crediarios.detectClientesTable();
    if (!cm) return { results: [] };

    // Detecta se é busca numérica (CPF/cod) ou texto (nome)
    const onlyDigits = term.replace(/\D/g, '');
    const isNumeric = onlyDigits.length >= 3 && /^\d+$/.test(term.replace(/[\s.\-]/g, ''));

    // Sanitiza pra evitar SQL injection (LIKE com escape)
    const safeText = term.replace(/['"\\;%_]/g, '').slice(0, 80);
    const safeNum = onlyDigits.slice(0, 14);

    // Monta SELECT — só colunas que detectClientesTable confirmou existir
    const selectCols: string[] = [`\`${cm.codCliente}\``];
    if (cm.nome) selectCols.push(`\`${cm.nome}\``);
    if (cm.cpf) selectCols.push(`\`${cm.cpf}\``);
    if (cm.cidade) selectCols.push(`\`${cm.cidade}\``);
    if (cm.telefone) selectCols.push(`\`${cm.telefone}\``);

    // WHERE: combina busca por CPF (normalizado), codCliente e nome (OR)
    const wheres: string[] = [];
    if (isNumeric) {
      if (cm.cpf) {
        // CPF no Giga pode estar formatado — comparar normalizado (só dígitos)
        wheres.push(`REPLACE(REPLACE(REPLACE(\`${cm.cpf}\`, '.', ''), '-', ''), '/', '') LIKE '${safeNum}%'`);
      }
      wheres.push(`CONCAT('', \`${cm.codCliente}\`) = '${safeNum}'`);
    }
    if (cm.nome) {
      wheres.push(`UPPER(\`${cm.nome}\`) LIKE UPPER('%${safeText}%')`);
    }
    if (wheres.length === 0) return { results: [] };

    const orderBy = cm.nome ? `ORDER BY \`${cm.nome}\` ASC` : `ORDER BY \`${cm.codCliente}\` ASC`;
    const sql = `SELECT ${selectCols.join(', ')} FROM \`${cm.table}\` WHERE ${wheres.join(' OR ')} ${orderBy} LIMIT ${limit}`;

    let rows: any[] = [];
    try {
      const r = await this.erp.runReadOnly(sql, { maxRows: limit, timeoutMs: 8000 });
      rows = r.rows || [];
    } catch (e: any) {
      console.warn('[customer-search] erro:', e?.message);
    }

    return {
      results: rows.map((r) => ({
        codCliente: String(r[cm.codCliente] ?? '').trim(),
        nome: cm.nome ? String(r[cm.nome] ?? '').trim() : '',
        cpf: cm.cpf ? String(r[cm.cpf] ?? '').replace(/\D/g, '').trim() : '',
        cidade: cm.cidade ? String(r[cm.cidade] ?? '').trim() : '',
        telefone: cm.telefone ? String(r[cm.telefone] ?? '').replace(/\D/g, '').trim() : '',
      })),
    };
  }

  /**
   * GET /pdv/funcionarios-search?q=texto&limit=20
   * Busca funcionária na tabela `funcionarios` do Giga (vendedora).
   * Usado pelo modal de identificação no início da venda.
   */
  @Get('funcionarios-search')
  async searchFuncionarios(
    @Req() req: any,
    @Query('q') q: string,
    @Query('limit') limitStr?: string,
  ) {
    this.requireRole(req);
    const term = String(q || '').trim();
    const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 50);

    // Tenta tabelas comuns: funcionarios, vendedores, usuarios
    const candidates = ['funcionarios', 'funcionario', 'vendedores', 'vendedor', 'usuarios'];
    let table: string | null = null;
    let codigoCol: string | null = null;
    let nomeCol: string | null = null;

    for (const tbl of candidates) {
      try {
        const schema = await this.erp.getTableSchema(tbl, 1);
        if (!schema) continue;
        const cols = schema.columns.map((c: any) => c.field);
        const nome = cols.find((c: string) => /^nome$/i.test(c) || /^razao$/i.test(c) || /^funcionario$/i.test(c));
        const codigo = cols.find((c: string) => /^codigo$/i.test(c) || /^cod_?func/i.test(c) || /^id_?func/i.test(c) || /^id$/i.test(c));
        if (!nome || !codigo) continue;
        table = tbl;
        codigoCol = codigo;
        nomeCol = nome;
        break;
      } catch {/* tabela não existe — tenta próxima */}
    }

    if (!table || !codigoCol || !nomeCol) {
      return { results: [], message: 'Tabela de funcionários não encontrada no Giga' };
    }

    const safeText = term.replace(/['"\\;%_]/g, '').slice(0, 80);
    const where = term.length >= 2
      ? `WHERE UPPER(\`${nomeCol}\`) LIKE UPPER('%${safeText}%')`
      : ''; // sem filtro = lista tudo (limite ainda aplica)

    const sql = `SELECT \`${codigoCol}\` AS codigo, \`${nomeCol}\` AS nome FROM \`${table}\` ${where} ORDER BY \`${nomeCol}\` ASC LIMIT ${limit}`;
    let rows: any[] = [];
    try {
      const r = await this.erp.runReadOnly(sql, { maxRows: limit, timeoutMs: 8000 });
      rows = r.rows || [];
    } catch (e: any) {
      console.warn('[funcionarios-search] erro:', e?.message);
    }

    return {
      table,
      results: rows.map((r) => ({
        codigo: String(r.codigo ?? '').trim(),
        nome: String(r.nome ?? '').trim(),
      })).filter((r) => r.nome),
    };
  }

  /**
   * PATCH /pdv/sales/:id/vendedora — atribui vendedora à venda.
   * Aceita codigo+nome direto do Giga (sem precisar do Seller cadastrado no Postgres).
   */
  @Patch('sales/:id/vendedora')
  async setVendedora(
    @Req() req: any,
    @Param('id') saleId: string,
    @Body() body: { codigo?: string; nome: string },
  ) {
    this.requireRole(req);
    if (!body?.nome) throw new BadRequestException('Nome da vendedora obrigatório');
    const sale = await (this.svc as any).prisma.pdvSale.findUnique({ where: { id: saleId } });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    return (this.svc as any).prisma.pdvSale.update({
      where: { id: saleId },
      data: {
        sellerName: body.nome.trim(),
        // Guarda o código do Giga em sellerId (string livre — não é FK física aqui)
        sellerId: body.codigo?.trim() || null,
      },
    });
  }

  /**
   * POST /pdv/sales/:id/crediario
   * Gera N parcelas no Giga (tabela movimento) pra uma venda do PDV.
   *
   * Recebe:
   *   - parcelas: número (1-24)
   *   - primeiroVencimento: 'YYYY-MM-DD'
   *   - entrada (opcional): valor descontado do total antes de dividir
   *   - observacao (opcional): texto livre
   *
   * Pré-condições: venda OPEN com customerCpf preenchido.
   * O cliente DEVE existir no Giga (use /pdv/customer-info pra validar antes).
   */
  @Post('sales/:id/crediario')
  async createCrediario(
    @Req() req: any,
    @Param('id') saleId: string,
    @Body() body: {
      parcelas: number;
      primeiroVencimento: string; // 'YYYY-MM-DD'
      entrada?: number;
      observacao?: string;
    },
  ) {
    this.requireRole(req);
    const sale = await this.svc.getSale(saleId);
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');
    if (!sale.customerCpf) throw new BadRequestException('Cliente sem CPF — identifique antes');
    if (!body?.parcelas || body.parcelas < 1 || body.parcelas > 24) {
      throw new BadRequestException('Parcelas deve estar entre 1 e 24');
    }
    if (!body?.primeiroVencimento || !/^\d{4}-\d{2}-\d{2}$/.test(body.primeiroVencimento)) {
      throw new BadRequestException('primeiroVencimento inválido (formato YYYY-MM-DD)');
    }
    const entrada = Math.max(0, Math.round((body.entrada || 0) * 100) / 100);
    const valorFinanciado = Math.round((sale.total - entrada) * 100) / 100;
    if (valorFinanciado <= 0) {
      throw new BadRequestException('Entrada não pode ser maior ou igual ao total da venda');
    }

    // Busca cliente no Giga pra pegar codCliente
    const info = await this.getCustomerInfo(req, sale.customerCpf);
    if (!info.found || !info.cliente) {
      throw new BadRequestException(
        'Cliente não encontrado no Giga. Cadastre o cliente antes de fazer crediário.',
      );
    }

    const cols = await this.crediarios.detectColumns();
    if (!cols.registro || !cols.controle || !cols.codCliente || !cols.vencimento || !cols.valorParcela || !cols.parcela) {
      throw new BadRequestException(
        'Colunas obrigatórias da tabela movimento não detectadas — contate suporte',
      );
    }

    const result = await this.erp.createCrediarioParcelas({
      codCliente: info.cliente.codCliente,
      nomeCliente: info.cliente.nome || sale.customerName || '',
      valorTotal: valorFinanciado,
      parcelas: body.parcelas,
      primeiroVencimento: new Date(`${body.primeiroVencimento}T00:00:00.000Z`),
      dataCompra: new Date(),
      loja: sale.storeCode,
      observacao: body.observacao || `PDV venda #${sale.id.slice(-6).toUpperCase()}`,
      columns: cols,
    });

    if (!result.success) {
      throw new BadRequestException(`Erro ao criar parcelas: ${result.error}`);
    }

    return {
      ok: true,
      parcelas: result.parcelas,
      controle: result.controleUsado,
      registroInicial: result.registroInicial,
      valorFinanciado,
      entrada,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // IMPRESSÃO — Promissórias e Carnê pré-impressos da Lurd's
  // ═══════════════════════════════════════════════════════════════════════

  /** GET /pdv/sales/:id/promissorias-pdf — N folhas A4, 3 promissórias por folha */
  @Get('sales/:id/promissorias-pdf')
  async getPromissoriasPdf(
    @Req() req: any,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generatePromissorias(id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/promissorias-pdf] FALHA', id, '\n', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF', detail: e?.message });
    }
  }

  /** GET /pdv/sales/:id/carne-pdf — 1 folha A4, 2 carnês iguais */
  @Get('sales/:id/carne-pdf')
  async getCarnePdf(
    @Req() req: any,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generateCarne(id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/carne-pdf] FALHA', id, '\n', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF', detail: e?.message });
    }
  }

  /**
   * GET /pdv/sales/:id/credprint-pdf — combinado: promissórias + carnê na ordem
   * que a vendedora carrega na impressora (folhas brancas primeiro, azul por último).
   */
  @Get('sales/:id/credprint-pdf')
  async getCredPrintCompleto(
    @Req() req: any,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generateImpressaoCompleta(id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/credprint-pdf] FALHA', id, '\n', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF', detail: e?.message });
    }
  }

  /**
   * GET /pdv/regua-calibracao — RÉGUA pra calibrar coordenadas da promissória.
   * Imprime em folha BRANCA, sobrepõe na pré-impressa contra a janela e
   * reporta em que Y caem cada label do form.
   */
  @Get('regua-calibracao')
  async getReguaCalibracao(@Req() req: any, @Res() res: Response) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generateRegua();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/regua-calibracao] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar régua' });
    }
  }
}
