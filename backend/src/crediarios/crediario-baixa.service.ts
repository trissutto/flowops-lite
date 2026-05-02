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
  // Observação livre da promissória (movimento.OBS no Giga)
  obs: string | null;
}

@Injectable()
export class CrediarioBaixaService {
  private readonly logger = new Logger(CrediarioBaixaService.name);

  // Cache da listagem completa por 5 minutos pra não saturar o pool MySQL
  // (a query é cara — varre toda a tabela movimento). Key = storeCode || 'all'.
  private listCache = new Map<string, { data: any; expiresAt: number }>();
  private readonly LIST_CACHE_TTL_MS = 5 * 60 * 1000;

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

  // ── LISTA TUDO (todos clientes com parcelas em aberto) ───────────
  //
  // Usado pelo PDV de RECEBIMENTOS — carrega tudo 1x, frontend filtra local.
  // Inclui parcelas vencidas E a vencer (diferente de listOverdue que só lista
  // vencidas). Filtro por loja é OPCIONAL — cliente pode pagar em qualquer filial.

  async listAllOpenInstallments(input: { storeCode?: string }): Promise<{
    parcelas: OpenInstallment[];
    clientes: Array<{
      codCliente: string;
      nome: string;
      telefone: string | null;
      qtdParcelas: number;
      total: number;
    }>;
  }> {
    // CACHE — protege o pool MySQL Giga. Query é cara (varre toda tabela
    // movimento). Sem cache, cada open de tela RECEBIMENTOS por uma vendedora
    // diferente derruba o sistema inteiro (consulta estoque, PDV, etc).
    const cacheKey = input.storeCode || 'all';
    const cached = this.listCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      this.logger.log(`[crediario-baixa] cache HIT (${cacheKey})`);
      return cached.data;
    }
    this.logger.log(`[crediario-baixa] cache MISS (${cacheKey}) — vai bater no Giga`);
    // Sempre força refresh do detectColumns aqui — algumas instâncias do Giga
    // têm timeouts intermitentes na primeira chamada que cacheiam EMPTY_MAP.
    let map = await this.crediarios.detectColumns(true);
    if (!map.codCliente || !map.vencimento || !map.valorParcela) {
      // Tenta de novo após 500ms (rede pode estar lenta)
      await new Promise((r) => setTimeout(r, 500));
      map = await this.crediarios.detectColumns(true);
    }
    if (!map.codCliente || !map.vencimento || !map.valorParcela) {
      const detectadas = Object.entries(map)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      const faltam = ['codCliente', 'vencimento', 'valorParcela']
        .filter((k) => !(map as any)[k])
        .join(', ');
      this.logger.error(
        `[crediario-baixa] detectColumns FALHOU. Faltam: ${faltam}. Detectadas: ${detectadas || '(nenhuma)'}`,
      );
      throw new BadRequestException(
        `Falha ao ler estrutura do Giga (faltam: ${faltam}). ` +
          `Detectadas: ${detectadas || '(nenhuma — problema de conexão MySQL)'}. Tente novamente.`,
      );
    }

    const safeStore = input.storeCode
      ? String(input.storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
      : null;

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

    const where: string[] = [];
    // PAGO em aberto — aceita: N, n, NAO, nao, NÃO, vazio ou NULL.
    // Lurd's usa SIM/NAO (varchar3). Outras instalações usam S/N (char1).
    if (map.pago) {
      where.push(
        `(\`${map.pago}\` IS NULL OR \`${map.pago}\` = '' ` +
        `OR UPPER(\`${map.pago}\`) IN ('N','NAO','NÃO'))`,
      );
    } else if (map.dataPagamento) {
      where.push(`(\`${map.dataPagamento}\` IS NULL OR \`${map.dataPagamento}\` = '0000-00-00')`);
    }
    // Filtro por loja (opcional)
    if (safeStore && map.loja) {
      where.push(`\`${map.loja}\` = '${safeStore}'`);
    }
    // Exclui null/vazio (cód 0-3 são filtrados depois no JS pra evitar
    // CAST UNSIGNED que pode falhar dependendo do tipo da coluna)
    where.push(`\`${map.codCliente}\` IS NOT NULL`);
    where.push(`\`${map.codCliente}\` <> ''`);
    where.push(`\`${map.codCliente}\` <> '0'`);

    // LIMIT conservador pra não saturar o pool MySQL.
    // 5000 cobre uns 800-1500 clientes em aberto — suficiente pra Lurd's.
    const sql = `SELECT ${select.join(', ')} FROM \`movimento\` WHERE ${where.join(' AND ')} ORDER BY \`${map.vencimento}\` ASC LIMIT 5000`;
    this.logger.log(`[crediario-baixa] listAllOpen SQL: ${sql.slice(0, 500)}`);
    const t0 = Date.now();
    const result = await this.erp.runReadOnly(sql, { maxRows: 5000, timeoutMs: 30000 });
    this.logger.log(`[crediario-baixa] listAllOpen retornou ${result.rows.length} linhas em ${Date.now() - t0}ms`);

    // Filtra códigos 0-3 (cartões clássicos: CREDICARD, REDESHOP, AMEX, etc)
    const filteredRows = result.rows.filter((r: any) => {
      const cod = String(r.codCliente || '').replace(/\D/g, '');
      const n = parseInt(cod, 10);
      return !isNaN(n) && n > 3;
    });

    // Enriquece com telefone + filtra clientes-cartão
    const codClientes = Array.from(new Set(filteredRows.map((r: any) => String(r.codCliente))));
    const phones = await this.crediarios.fetchPhonesByClienteIds(codClientes);

    // Filtra cartões pelo nome
    const cardRegex = /^(VISANET|VISA|MASTER(CARD)?|AMEX|HIPER(CARD)?|REDESHOP|REDE\s|CREDICARD|CREDI[\s-]?CARD|ELO|DINERS|CABAL|TICKET|SODEXO|VR\s|BANRICOMPRAS|GETNET|CIELO|STONE|PAGSEGURO|MERCADO\s?PAGO|PIC\s?PAY|AVULSO|BALC[ÃA]O|CART[ÃA]O)$/i;
    const cardCodes = new Set<string>();
    const cm = await this.crediarios.detectClientesTable();
    if (cm && cm.nome && codClientes.length > 0) {
      const inList = codClientes.map((c) => `'${c.replace(/'/g, '')}'`).join(',');
      const sqlCli = `SELECT \`${cm.codCliente}\` AS cod, \`${cm.nome}\` AS nome FROM \`${cm.table}\` WHERE \`${cm.codCliente}\` IN (${inList}) LIMIT ${codClientes.length + 100}`;
      try {
        const r = await this.erp.runReadOnly(sqlCli, {
          maxRows: codClientes.length + 100,
          timeoutMs: 30000,
        });
        for (const row of r.rows as any[]) {
          if (cardRegex.test(String(row.nome || '').trim())) {
            cardCodes.add(String(row.cod));
          }
        }
      } catch (e: any) {
        this.logger.warn(`Filtro cartões: ${e?.message}`);
      }
    }

    const cfg = await this.getConfig();
    const out: OpenInstallment[] = [];
    for (const row of filteredRows) {
      const codCli = String(row.codCliente);
      if (cardCodes.has(codCli)) continue;
      const valor = Number(row.valorParcela || 0);
      if (!row.vencimento || !valor) continue;
      const venc = new Date(row.vencimento);
      const { diasAtraso, juros } = this.calcJuros(venc, valor, cfg);
      const phoneInfo = phones.get(codCli) || null;
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
        codCliente: codCli,
        nome: row.nome ? String(row.nome) : phoneInfo?.nome || null,
        telefone: phoneInfo?.telefone || null,
        obs: row.obs ? String(row.obs).trim() : null,
      });
    }

    // Resumo agrupado por cliente
    const byCliente = new Map<string, {
      codCliente: string;
      nome: string;
      telefone: string | null;
      qtdParcelas: number;
      total: number;
    }>();
    for (const p of out) {
      const ex = byCliente.get(p.codCliente);
      if (ex) {
        ex.qtdParcelas += 1;
        ex.total += p.valorComJuros;
      } else {
        byCliente.set(p.codCliente, {
          codCliente: p.codCliente,
          nome: p.nome || `Cód. ${p.codCliente}`,
          telefone: p.telefone,
          qtdParcelas: 1,
          total: p.valorComJuros,
        });
      }
    }

    const response = {
      parcelas: out,
      clientes: Array.from(byCliente.values())
        .sort((a, b) => a.nome.localeCompare(b.nome)),
    };

    // Cacheia 5 min — evita matar o pool com requests repetidas
    this.listCache.set(cacheKey, {
      data: response,
      expiresAt: Date.now() + this.LIST_CACHE_TTL_MS,
    });

    return response;
  }

  /** Limpa cache (chamado após cada baixa pra refletir parcelas pagas) */
  clearListCache() {
    this.listCache.clear();
  }

  // ── LISTA TODOS CLIENTES DO GIGA (com ou sem parcelas) ────────────
  //
  // Query LEVE — só lê a tabela `clientes` (1 SELECT simples) sem mexer
  // em `movimento`. Cobre TODA a base de clientes da rede Lurd's.
  //
  // Frontend filtra local em JS. Quando clica num cliente, faz request
  // separado pras parcelas DELE específico (também rápido).
  //
  // Cache 30min — já que mudanças em clientes (cadastro novo) são raras.

  private clientesCache: { data: any[]; expiresAt: number } | null = null;
  private readonly CLIENTES_CACHE_TTL_MS = 30 * 60 * 1000;

  // Lock anti-stampede: se múltiplas vendedoras abrem RECEBIMENTOS ao mesmo
  // tempo (cache vazio), só 1 query roda — as demais aguardam o resultado.
  private clientesPromise: Promise<Array<{ codCliente: string; nome: string; telefone: string | null }>> | null = null;

  // Circuit breaker: se Giga falhar 3x seguidas, bloqueia por 5min
  // (evita rebloquear o IP por excesso de erros).
  private breakerFailCount = 0;
  private breakerOpenUntil = 0;

  async listAllClientesGiga(): Promise<Array<{
    codCliente: string;
    nome: string;
    telefone: string | null;
  }>> {
    if (this.clientesCache && Date.now() < this.clientesCache.expiresAt) {
      return this.clientesCache.data;
    }

    // Circuit breaker aberto?
    if (Date.now() < this.breakerOpenUntil) {
      throw new BadRequestException(
        `Giga temporariamente indisponível. Tente em ${Math.ceil((this.breakerOpenUntil - Date.now()) / 1000)}s.`,
      );
    }

    // Já tem outra request rodando? Espera ela.
    if (this.clientesPromise) {
      return this.clientesPromise;
    }

    // Encadeia: cria a promise UNA, todas as chamadas concorrentes pegam a mesma
    this.clientesPromise = this._doListAllClientesGiga()
      .then((data) => {
        this.breakerFailCount = 0;
        this.clientesPromise = null;
        return data;
      })
      .catch((err) => {
        this.breakerFailCount++;
        this.clientesPromise = null;
        if (this.breakerFailCount >= 3) {
          this.breakerOpenUntil = Date.now() + 5 * 60 * 1000;
          this.logger.error(`[crediario-baixa] CIRCUIT BREAKER aberto por 5min — ${this.breakerFailCount} falhas seguidas`);
        }
        throw err;
      });

    return this.clientesPromise;
  }

  private async _doListAllClientesGiga(): Promise<Array<{ codCliente: string; nome: string; telefone: string | null }>> {

    const cm = await this.crediarios.detectClientesTable();
    if (!cm || !cm.nome) {
      throw new BadRequestException(
        'Tabela de clientes do Giga não detectada',
      );
    }

    const cols: string[] = [`\`${cm.codCliente}\` AS cod`, `\`${cm.nome}\` AS nome`];
    if (cm.telefone) cols.push(`\`${cm.telefone}\` AS tel`);
    if (cm.telefone2) cols.push(`\`${cm.telefone2}\` AS tel2`);

    // LIMIT conservador — 15000 cobre Lurd's (7k clientes hoje, espaço pra crescer)
    // sem segurar conexão MySQL por muito tempo.
    const sql = `SELECT ${cols.join(', ')} FROM \`${cm.table}\` WHERE \`${cm.nome}\` IS NOT NULL AND \`${cm.nome}\` <> '' ORDER BY \`${cm.nome}\` ASC LIMIT 15000`;
    this.logger.log(`[crediario-baixa] listAllClientes SQL: ${sql.slice(0, 300)}`);
    const t0 = Date.now();
    const result = await this.erp.runReadOnly(sql, { maxRows: 15000, timeoutMs: 20000 });
    this.logger.log(`[crediario-baixa] listAllClientes retornou ${result.rows.length} em ${Date.now() - t0}ms`);

    const cardRegex = /^(VISANET|VISA|MASTER(CARD)?|AMEX|HIPER(CARD)?|REDESHOP|REDE\s|CREDICARD|CREDI[\s-]?CARD|ELO|DINERS|CABAL|TICKET|SODEXO|VR\s|BANRICOMPRAS|GETNET|CIELO|STONE|PAGSEGURO|MERCADO\s?PAGO|PIC\s?PAY|AVULSO|BALC[ÃA]O|CART[ÃA]O)$/i;

    // DEDUP: tabela `clientes` do Giga pode ter linhas duplicadas pelo
    // mesmo codCliente (cadastro repetido por compra antiga, etc).
    // Mantemos só a 1ª ocorrência de cada codCliente.
    const seen = new Set<string>();
    const out: Array<{ codCliente: string; nome: string; telefone: string | null }> = [];
    for (const row of result.rows as any[]) {
      const cod = String(row.cod || '').trim();
      if (!cod || seen.has(cod)) continue;
      const codNum = parseInt(cod.replace(/\D/g, ''), 10);
      if (isNaN(codNum) || codNum <= 3) continue; // exclui cartões 0-3
      const nome = String(row.nome || '').trim();
      if (!nome) continue;
      if (cardRegex.test(nome)) continue; // exclui cartões pelo nome
      const tel = (String(row.tel || '').trim()) || (String(row.tel2 || '').trim()) || null;
      seen.add(cod);
      out.push({ codCliente: cod, nome, telefone: tel });
    }
    this.logger.log(`[crediario-baixa] após dedup: ${out.length} clientes únicos (de ${result.rows.length} linhas)`);

    this.clientesCache = {
      data: out,
      expiresAt: Date.now() + this.CLIENTES_CACHE_TTL_MS,
    };
    return out;
  }

  /** Limpa cache (chamado após cada baixa) */
  clearClientesCache() {
    this.clientesCache = null;
  }

  // ── Autocomplete: busca rápida de clientes ────────────────────────

  /**
   * Busca rápida na tabela `clientes` do Giga — só nomes/códigos.
   * Usado pelo autocomplete do frontend. Não retorna parcelas.
   *
   * Filtra clientes-cartão (VISANET, MASTERCARD, etc) e cód <= 3.
   */
  async searchClientes(input: { q: string }): Promise<Array<{
    codCliente: string;
    nome: string;
    telefone: string | null;
  }>> {
    const q = String(input.q || '').trim();
    if (q.length < 2) return [];

    const cm = await this.crediarios.detectClientesTable();
    if (!cm || !cm.nome) {
      throw new BadRequestException(
        'Tabela de clientes do Giga não detectada — não dá pra buscar por nome.',
      );
    }

    const safe = q.replace(/['"\\;]/g, '').slice(0, 100);
    const onlyDigits = /^\d+$/.test(safe);

    // Monta SELECT
    const cols: string[] = [`\`${cm.codCliente}\` AS cod`];
    if (cm.nome) cols.push(`\`${cm.nome}\` AS nome`);
    if (cm.telefone) cols.push(`\`${cm.telefone}\` AS tel`);
    if (cm.telefone2) cols.push(`\`${cm.telefone2}\` AS tel2`);

    let where: string;
    if (onlyDigits) {
      where = `\`${cm.codCliente}\` = '${safe}'`;
    } else {
      // Busca insensitive a case + acentos via UPPER + REPLACE básico
      // (cobre caso comum de ÁÉÍÓÚÇ no nome cadastrado)
      where = `UPPER(\`${cm.nome}\`) LIKE UPPER('%${safe}%')`;
    }

    const sql = `SELECT ${cols.join(', ')} FROM \`${cm.table}\` WHERE ${where} ORDER BY \`${cm.nome}\` ASC LIMIT 30`;
    const r = await this.erp.runReadOnly(sql, { maxRows: 30, timeoutMs: 8000 });

    // Regex pra excluir clientes-cartão
    const cardRegex = /^(VISANET|VISA|MASTER(CARD)?|AMEX|HIPER(CARD)?|REDESHOP|REDE\s|CREDICARD|CREDI[\s-]?CARD|ELO|DINERS|CABAL|TICKET|SODEXO|VR\s|BANRICOMPRAS|GETNET|CIELO|STONE|PAGSEGURO|MERCADO\s?PAGO|PIC\s?PAY|AVULSO|BALC[ÃA]O|CART[ÃA]O)$/i;

    const out: Array<{ codCliente: string; nome: string; telefone: string | null }> = [];
    for (const row of r.rows as any[]) {
      const cod = String(row.cod || '');
      const n = parseInt(cod.replace(/\D/g, ''), 10);
      if (isNaN(n) || n <= 3) continue;
      const nome = String(row.nome || '').trim();
      if (cardRegex.test(nome)) continue;
      const tel = (String(row.tel || '').trim()) || (String(row.tel2 || '').trim()) || null;
      out.push({ codCliente: cod, nome, telefone: tel });
    }
    return out;
  }

  /**
   * Lista parcelas em aberto de UM codCliente específico (já resolvido pelo
   * autocomplete). Mais rápido que listOpenInstallmentsByCustomer porque
   * pula busca de cliente.
   */
  async listInstallmentsByCodCliente(input: {
    codCliente: string;
    storeCode?: string;
  }): Promise<OpenInstallment[]> {
    const cod = String(input.codCliente || '').trim();
    if (!cod) throw new BadRequestException('codCliente obrigatório');

    let map = await this.crediarios.detectColumns();
    if (!map.codCliente || !map.vencimento || !map.valorParcela) {
      map = await this.crediarios.detectColumns(true);
    }
    if (!map.codCliente) throw new BadRequestException('Coluna codCliente não detectada');

    const safeCod = cod.replace(/['"\\;]/g, '').slice(0, 50);
    const safeStore = input.storeCode
      ? String(input.storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
      : null;

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
    addCol('obs', 'obs');

    const where: string[] = [`\`${map.codCliente}\` = '${safeCod}'`];
    if (map.pago) {
      where.push(`(\`${map.pago}\` IS NULL OR \`${map.pago}\` = '' OR UPPER(\`${map.pago}\`) IN ('N','NAO','NÃO'))`);
    } else if (map.dataPagamento) {
      where.push(`(\`${map.dataPagamento}\` IS NULL OR \`${map.dataPagamento}\` = '0000-00-00')`);
    }
    if (safeStore && map.loja) {
      where.push(`\`${map.loja}\` = '${safeStore}'`);
    }

    const sql = `SELECT ${select.join(', ')} FROM \`movimento\` WHERE ${where.join(' AND ')} ORDER BY \`${map.vencimento}\` ASC LIMIT 500`;
    const result = await this.erp.runReadOnly(sql, { maxRows: 500, timeoutMs: 30000 });

    const phones = await this.crediarios.fetchPhonesByClienteIds([safeCod]);
    const phoneInfo = phones.get(safeCod) || null;

    const cfg = await this.getConfig();
    const out: OpenInstallment[] = [];
    for (const row of result.rows) {
      const valor = Number(row.valorParcela || 0);
      if (!row.vencimento || !valor) continue;
      const venc = new Date(row.vencimento);
      const { diasAtraso, juros } = this.calcJuros(venc, valor, cfg);
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
        codCliente: String(row.codCliente),
        nome: row.nome ? String(row.nome) : phoneInfo?.nome || null,
        telefone: phoneInfo?.telefone || null,
        obs: row.obs ? String(row.obs).trim() : null,
      });
    }
    return out;
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

    // Força refresh do cache pra garantir detecção atualizada
    let map = await this.crediarios.detectColumns();
    if (!map.codCliente || !map.vencimento || !map.valorParcela) {
      map = await this.crediarios.detectColumns(true);
    }
    if (!map.codCliente) {
      throw new BadRequestException(
        'Coluna codCliente não detectada no Giga. Detectadas: ' +
          Object.entries(map).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', '),
      );
    }
    if (!map.vencimento || !map.valorParcela) {
      const faltam = [!map.vencimento && 'vencimento', !map.valorParcela && 'valorParcela']
        .filter(Boolean).join(', ');
      throw new BadRequestException(
        `Colunas faltando: ${faltam}. Detectadas: ` +
          Object.entries(map).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', '),
      );
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
      // Busca por nome NA TABELA DE CLIENTES (nunca em movimento.NOME pra
      // evitar pegar registros onde o nome é o cliente real mas o CODCLIENTE
      // é cartão/avulso — ex: cliente "ELISA" pagou com VISA, fica como
      // CODCLIENTE=26 VISANET, NOME=ELISA. Não queremos VISANET aqui.)
      const cm = await this.crediarios.detectClientesTable();
      if (cm && cm.nome) {
        const sql = `SELECT \`${cm.codCliente}\` AS cod FROM \`${cm.table}\` WHERE \`${cm.nome}\` LIKE '%${safeBusca}%' LIMIT 50`;
        const r = await this.erp.runReadOnly(sql, { maxRows: 50, timeoutMs: 10000 });
        codClientes = r.rows.map((row) => String(row.cod));
      } else {
        throw new BadRequestException(
          'Tabela de clientes do Giga não detectada. Use código do cliente em vez de nome.',
        );
      }
    }

    // Filtra códigos "lixo" — duas camadas:
    //   1. Códigos 0-3: cartões clássicos (CREDICARD, REDESHOP, AMEX...).
    //   2. Nomes que parecem cartão (VISANET, MASTERCARD, ELO, HIPER...) — esses
    //      podem ter cód > 3 (ex: VISANET=26). Verifica na tabela clientes.
    codClientes = Array.from(new Set(
      codClientes.filter((c) => {
        if (!c) return false;
        const n = parseInt(String(c).replace(/\D/g, ''), 10);
        return !isNaN(n) && n > 3;
      }),
    ));

    // Filtra clientes-cartão pelo nome (VISANET, MASTERCARD, etc.)
    if (codClientes.length > 0) {
      const cm = await this.crediarios.detectClientesTable();
      if (cm && cm.nome) {
        const inList = codClientes.map((c) => `'${c}'`).join(',');
        const sql = `SELECT \`${cm.codCliente}\` AS cod, \`${cm.nome}\` AS nome FROM \`${cm.table}\` WHERE \`${cm.codCliente}\` IN (${inList}) LIMIT ${codClientes.length + 100}`;
        try {
          const r = await this.erp.runReadOnly(sql, { maxRows: codClientes.length + 100, timeoutMs: 10000 });
          const cardRegex = /^(VISANET|VISA|MASTER(CARD)?|AMEX|HIPER(CARD)?|REDESHOP|REDE\s|CREDICARD|CREDI[\s-]?CARD|ELO|DINERS|CABAL|TICKET|SODEXO|VR\s|BANRICOMPRAS|GETNET|CIELO|STONE|PAGSEGURO|MERCADO\s?PAGO|PIC\s?PAY|AVULSO|BALC[ÃA]O|CART[ÃA]O)$/i;
          const cardCodes = new Set(
            r.rows.filter((row: any) => cardRegex.test(String(row.nome || '').trim())).map((row: any) => String(row.cod)),
          );
          if (cardCodes.size > 0) {
            this.logger.log(`[crediario-baixa] excluindo ${cardCodes.size} clientes-cartão: ${Array.from(cardCodes).join(',')}`);
            codClientes = codClientes.filter((c) => !cardCodes.has(c));
          }
        } catch (e: any) {
          this.logger.warn(`Filtro cartões falhou: ${e?.message}`);
        }
      }
    }

    if (codClientes.length === 0) {
      throw new BadRequestException(
        'Nenhum cliente real encontrado pra essa busca. Códigos 0-3 e nomes de cartões (VISANET, MASTERCARD, etc.) são ignorados.',
      );
    }

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
    addCol('obs', 'obs');

    const inList = codClientes.map((c) => `'${c}'`).join(',');
    const where: string[] = [`\`${map.codCliente}\` IN (${inList})`];
    if (map.pago) {
      where.push(`(\`${map.pago}\` IS NULL OR \`${map.pago}\` = '' OR UPPER(\`${map.pago}\`) IN ('N','NAO','NÃO'))`);
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
        obs: row.obs ? String(row.obs).trim() : null,
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
      addCol('obs', 'obs');

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
        obs: row.obs ? String(row.obs).trim() : null,
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
    this.clearListCache();
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
    /** Validade do PIX em minutos. Default 15min (cliente presente).
     *  Pra link compartilhável usar 1440 (24h). */
    expiresInMinutes?: number;
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
      expiresInMinutes: input.expiresInMinutes || 15,
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
    this.clearListCache();
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
   *
   * IMPORTANTE: se a coluna PAGO não for detectada, força refresh do cache
   * antes de prosseguir. WinCred usa essa coluna pra filtrar relatório de
   * recebidos — se ficar nula, a baixa "não conta" mesmo com data preenchida.
   */
  private async executeGigaUpdates(baixaId: string): Promise<void> {
    const items = await (this.prisma as any).crediarioBaixaItem.findMany({
      where: { baixaId, gigaUpdateOk: false },
    });
    if (!items.length) return;

    let map = await this.crediarios.detectColumns();
    if (!map.pago) {
      // Não detectou PAGO no cache → força redetecção (talvez schema novo)
      this.logger.warn('[crediario-baixa] coluna PAGO não detectada no cache. Forçando refresh.');
      map = await this.crediarios.detectColumns(true);
    }
    if (!map.pago) {
      this.logger.error(
        '[crediario-baixa] coluna PAGO ainda não detectada após refresh. ' +
        'WinCred não vai exibir essa baixa como recebida! Verifique /crediarios/debug-columns.',
      );
    }
    const cols = {
      registro: map.registro,
      controle: map.controle,
      pago: map.pago,
      dataPagamento: map.dataPagamento,
      valorPago: map.valorPago,
      juros: map.juros,
      multa: map.multa,
    };

    // Multa fixa 2% sobre o valor (Lurd's padrão). Configurável via env var
    // ERP_MULTA_PERCENT se outra loja precisar de percentual diferente.
    const multaPct = Number(process.env.ERP_MULTA_PERCENT ?? '2.0') || 2.0;

    for (const it of items) {
      const multa = (Number(it.diasAtraso) > 0)
        ? Math.round(Number(it.valorParcela) * (multaPct / 100) * 100) / 100
        : 0;
      const result = await this.erp.markCrediarioParcelaPaid({
        registro: it.registro,
        controle: it.controle,
        valorPago: it.valorPago,
        dataPagamento: new Date(),
        juros: Number(it.jurosCalculado) || 0,
        multa: multa,
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
