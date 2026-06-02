/**
 * CustomersGigaEtlService — sincroniza clientes do Giga (Wincred MySQL) pro
 * Postgres do FlowOps (modelo Customer).
 *
 * IMPORTANTE: Esta service é READ-ONLY no Giga. Nunca escreve lá. Só LÊ
 * via SELECT e POPULA o Postgres do FlowOps.
 *
 * Arquitetura:
 *
 *   Giga MySQL (tabela `clientes`) ─READ─┐
 *                                          │
 *   WooCommerce API (ETL próprio) ────────┼──→ Customer (Postgres FlowOps)
 *                                          │     fonte única consolidada
 *   Cadastro manual /clientes-crm ────────┘
 *
 * MERGE INTELIGENTE — quando o mesmo CPF aparece em 2+ canais:
 *
 * | Campo                    | Estratégia                                  |
 * |--------------------------|---------------------------------------------|
 * | CPF (chave)              | Nunca muda                                  |
 * | Nome                     | Só preenche se Customer.name for null/vazio |
 * | Telefone (whatsapp)      | Só preenche se null                         |
 * | Email                    | Só preenche se null                         |
 * | Endereço residencial     | Cria CustomerAddress(type=res) se não tiver |
 * | Aniversário (birthDate)  | Só preenche se null                         |
 * | registroGiga             | Sempre atualiza (rastreio)                  |
 * | tamanho preferido        | NUNCA toca (só vem do PDV/CRM)              |
 * | body type, estilo        | NUNCA toca                                  |
 * | cashback                 | NUNCA toca                                  |
 * | opt-in LGPD              | NUNCA toca                                  |
 * | tier VIP                 | Recalculado depois (LTV consolidado)        |
 *
 * Janela de histórico: TUDO (todas as vendas da tabela `caixa` no Giga).
 * Performance: batches de 500, pause 50ms entre batches pra não asfixiar
 * o Giga durante o expediente.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * Estado do sync Giga → Customer.
 * EXPORTADO porque o controller usa esse tipo no retorno público dos
 * endpoints — sem export o tsc lança TS4053 ("tipo não pode ser nomeado").
 */
export interface GigaSyncState {
  running: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  totalGiga: number;
  processados: number;
  criados: number;
  atualizados: number;
  pulados: number;
  erros: number;
  lastError: string | null;
  fase: 'idle' | 'clientes' | 'historico' | 'tier' | 'done';
  faseProgresso: { current: number; total: number };
}

@Injectable()
export class CustomersGigaEtlService {
  private readonly logger = new Logger(CustomersGigaEtlService.name);

  // State machine in-memory — só 1 sync por vez por instância.
  // Em produção (Railway), 1 instância = 1 lock. Suficiente.
  private state: GigaSyncState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    totalGiga: 0,
    processados: 0,
    criados: 0,
    atualizados: 0,
    pulados: 0,
    erros: 0,
    lastError: null,
    fase: 'idle',
    faseProgresso: { current: 0, total: 0 },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  getState(): GigaSyncState {
    return { ...this.state, faseProgresso: { ...this.state.faseProgresso } };
  }

  /**
   * Atualiza SÓ originStoreId dos clientes que vieram do Giga (sem refazer
   * o sync inteiro). Útil quando os clientes já foram importados mas vieram
   * sem loja vinculada.
   *
   * Retorna { atualizados, semCompras } pro frontend mostrar feedback.
   */
  async atualizarLojaPrincipal(): Promise<{
    atualizados: number;
    semCompras: number;
    semStoreCorrespondente: number;
    duracaoMs: number;
  }> {
    const t0 = Date.now();
    const pool = (this.erp as any).pool;
    if (!pool) throw new Error('Pool Giga não inicializado');

    const stores = await (this.prisma as any).store.findMany({
      select: { id: true, code: true, name: true },
    });
    const storeByCode = new Map<string, string>();
    for (const s of stores as any[]) {
      storeByCode.set(String(s.code).trim().toUpperCase(), s.id);
      if (s.name) storeByCode.set(String(s.name).trim().toUpperCase(), s.id);
    }

    // Pega só os Giga clients SEM originStoreId — não toca quem já tem loja
    const customers = await (this.prisma as any).customer.findMany({
      where: { registroGiga: { not: null }, originStoreId: null },
      select: { id: true, registroGiga: true },
    });

    let atualizados = 0;
    let semCompras = 0;
    let semStoreCorrespondente = 0;

    for (const c of customers as any[]) {
      try {
        const [lojas]: any = await pool.query(
          `SELECT LOJA AS loja, COUNT(*) AS qtd
            FROM caixa
            WHERE CLIENTE = ?
              AND VALORTOTAL > 0
              AND UPPER(COALESCE(MARCADO, '')) != 'SIM'
              AND LOJA IS NOT NULL
            GROUP BY LOJA
            ORDER BY qtd DESC
            LIMIT 1`,
          [c.registroGiga],
        );
        const lojaCode = lojas?.[0]?.loja
          ? String(lojas[0].loja).trim().toUpperCase()
          : null;
        if (!lojaCode) { semCompras++; continue; }
        const storeId = storeByCode.get(lojaCode);
        if (!storeId) { semStoreCorrespondente++; continue; }

        await (this.prisma as any).customer.update({
          where: { id: c.id },
          data: { originStoreId: storeId },
        });
        atualizados++;
      } catch (e: any) {
        this.logger.warn(`[giga-etl] atualizar loja cliente ${c.id} falhou: ${e?.message}`);
      }
    }

    this.logger.log(
      `[giga-etl] atualizarLojaPrincipal: ${atualizados} atualizados, ` +
      `${semCompras} sem compras, ${semStoreCorrespondente} sem store match. ` +
      `${Date.now() - t0}ms`,
    );

    return {
      atualizados,
      semCompras,
      semStoreCorrespondente,
      duracaoMs: Date.now() - t0,
    };
  }

  /**
   * Diagnóstico — lista TODAS as colunas da tabela `clientes` do Giga
   * + 3 amostras de dados + sugestão de mapeamento pro modelo Customer.
   *
   * Usado pra você ver o que tem e me dizer quais campos novos importar.
   */
  async diagnosticarColunas(): Promise<{
    totalClientes: number;
    colunas: Array<{
      nome: string;
      tipo: string;
      nullable: boolean;
      mapeadoParaCustomer: string | null;
      amostra: Array<string | null>;
    }>;
  }> {
    const pool = (this.erp as any).pool;
    if (!pool) throw new Error('Pool Giga não inicializado');

    // 1. SHOW COLUMNS — pega TODAS as colunas com tipo e nullable
    const [colRows]: any = await pool.query(`SHOW COLUMNS FROM clientes`);

    // 2. Total clientes pra contexto
    const [[count]]: any = await pool.query(`SELECT COUNT(*) AS total FROM clientes`);

    // 3. Pega 3 amostras de cada coluna (limita 3 clientes aleatórios)
    const colNames = (colRows as any[]).map((r: any) => r.Field);
    const colsList = colNames.map((c) => `\`${c}\``).join(', ');
    const [amostras]: any = await pool.query(
      `SELECT ${colsList} FROM clientes ORDER BY CODIGO DESC LIMIT 3`,
    );

    // 4. Mapeamento conhecido — campos já importados pelo ETL atual
    const mapeamentoAtual: Record<string, string> = {
      CODIGO: 'registroGiga',
      NOME: 'name',
      CPF: 'cpf',
      FONECEL: 'whatsapp',
      CELULAR: 'whatsapp',
      WHATSAPP: 'whatsapp',
      FONE2: 'whatsapp',
      FONERES: 'phone',
      TELEFONE: 'phone',
      FONE: 'phone',
      FONE1: 'phone',
      EMAIL: 'email',
      E_MAIL: 'email',
      MAIL: 'email',
      NASCIMENTO: 'birthDate',
      DATA_NASCIMENTO: 'birthDate',
      DTNASC: 'birthDate',
      NASC: 'birthDate',
      ENDERECORES: 'address.street',
      ENDERECO: 'address.street',
      LOGRADOURO: 'address.street',
      RUA: 'address.street',
      NUMERORES: 'address.number',
      NUMERO: 'address.number',
      NUM: 'address.number',
      COMPRES: 'address.complement',
      COMPLEMENTO: 'address.complement',
      COMP: 'address.complement',
      BAIRRORES: 'address.district',
      BAIRRO: 'address.district',
      BAI: 'address.district',
      CIDADERES: 'address.city',
      CIDADE: 'address.city',
      MUNICIPIO: 'address.city',
      UFRES: 'address.state',
      UF: 'address.state',
      ESTADO: 'address.state',
      CEPRES: 'address.zipCode',
      CEP: 'address.zipCode',
    };

    const colunas = (colRows as any[]).map((r: any, idx: number) => {
      const nome = String(r.Field);
      const amostra = (amostras as any[]).map((row) => {
        const v = row[nome];
        if (v === null || v === undefined) return null;
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        const s = String(v).trim();
        return s.length > 60 ? s.slice(0, 60) + '...' : s;
      });
      return {
        nome,
        tipo: String(r.Type),
        nullable: String(r.Null).toUpperCase() === 'YES',
        mapeadoParaCustomer: mapeamentoAtual[nome.toUpperCase()] || null,
        amostra,
      };
    });

    return {
      totalClientes: Number(count?.total) || 0,
      colunas,
    };
  }

  /**
   * Inicia sync FULL Giga→Customer em background.
   * Retorna imediatamente — o sync pode demorar minutos/horas pra 10k+ clientes.
   *
   * Frontend faz polling em GET /customers-crm/etl/giga/status pra acompanhar.
   */
  startFullSync(): boolean {
    if (this.state.running) {
      this.logger.warn('[giga-etl] sync já em andamento — ignorando novo start');
      return false;
    }
    this.state = {
      running: true,
      startedAt: new Date(),
      finishedAt: null,
      totalGiga: 0,
      processados: 0,
      criados: 0,
      atualizados: 0,
      pulados: 0,
      erros: 0,
      lastError: null,
      fase: 'clientes',
      faseProgresso: { current: 0, total: 0 },
    };
    // Fire-and-forget — roda em background
    this._runSync().catch((e) => {
      this.logger.error(`[giga-etl] sync falhou: ${e?.message}`);
      this.state.lastError = e?.message || String(e);
      this.state.running = false;
      this.state.fase = 'idle';
      this.state.finishedAt = new Date();
    });
    return true;
  }

  /**
   * Executa as 3 fases:
   *  1. clientes — sync cadastro básico (NOME, CPF, telefones, endereço)
   *  2. historico — pra cada Customer, calcula LTV/orderCount/lastOrderAt
   *     somando compras da tabela caixa do Giga (sem dupla contagem com PDV)
   *  3. tier — recalcula vipTier baseado no LTV final consolidado
   */
  private async _runSync(): Promise<void> {
    this.logger.log('[giga-etl] === SYNC FULL iniciado ===');

    // ─── FASE 1: CLIENTES ────────────────────────────────────────────────
    this.state.fase = 'clientes';
    await this._syncClientes();

    // ─── FASE 2: HISTÓRICO (LTV / orderCount / lastOrderAt) ──────────────
    this.state.fase = 'historico';
    await this._syncHistorico();

    // ─── FASE 3: TIER (recalcula vipTier) ────────────────────────────────
    this.state.fase = 'tier';
    await this._recalcularTiers();

    this.state.fase = 'done';
    this.state.running = false;
    this.state.finishedAt = new Date();
    this.logger.log(
      `[giga-etl] === SYNC concluído === ` +
      `criados=${this.state.criados} atualizados=${this.state.atualizados} ` +
      `pulados=${this.state.pulados} erros=${this.state.erros}`,
    );
  }

  /**
   * FASE 1 — Lê tabela clientes do Giga em batches, faz upsert no Customer.
   * Colunas conhecidas (Lurd's Wincred): CODIGO, NOME, CPF, FONECEL, FONERES,
   * EMAIL, NASCIMENTO, ENDERECORES, NUMERORES, COMPRES, BAIRRORES, CIDADERES,
   * UFRES, CEPRES.
   */
  private async _syncClientes(): Promise<void> {
    const pool = (this.erp as any).pool;
    if (!pool) throw new Error('Pool Giga não inicializado');

    // 1. Conta total pra mostrar progresso
    const [[count]]: any = await pool.query(`SELECT COUNT(*) AS total FROM clientes`);
    this.state.totalGiga = Number(count?.total) || 0;
    this.state.faseProgresso = { current: 0, total: this.state.totalGiga };
    this.logger.log(`[giga-etl] FASE 1: ${this.state.totalGiga} clientes no Giga`);

    // 2. Detecta colunas reais (Giga muda nome entre instalações)
    const cols = await this._detectarColunasClientes();

    // 3. Lê em batches de 500
    const BATCH = 500;
    let offset = 0;
    while (offset < this.state.totalGiga) {
      try {
        const selectFields = [
          `${cols.codigo} AS codCliente`,
          `${cols.nome} AS nome`,
          `${cols.cpf} AS cpf`,
          cols.foneCel ? `${cols.foneCel} AS foneCel` : `NULL AS foneCel`,
          cols.foneRes ? `${cols.foneRes} AS foneRes` : `NULL AS foneRes`,
          cols.email ? `${cols.email} AS email` : `NULL AS email`,
          cols.nascimento ? `${cols.nascimento} AS nascimento` : `NULL AS nascimento`,
          cols.endereco ? `${cols.endereco} AS endereco` : `NULL AS endereco`,
          cols.numero ? `${cols.numero} AS numero` : `NULL AS numero`,
          cols.complemento ? `${cols.complemento} AS complemento` : `NULL AS complemento`,
          cols.bairro ? `${cols.bairro} AS bairro` : `NULL AS bairro`,
          cols.cidade ? `${cols.cidade} AS cidade` : `NULL AS cidade`,
          cols.uf ? `${cols.uf} AS uf` : `NULL AS uf`,
          cols.cep ? `${cols.cep} AS cep` : `NULL AS cep`,
        ].join(', ');

        const [rows]: any = await pool.query(
          `SELECT ${selectFields} FROM clientes ORDER BY ${cols.codigo} LIMIT ? OFFSET ?`,
          [BATCH, offset],
        );

        for (const r of rows) {
          try {
            await this._upsertCustomerFromGiga(r);
            this.state.processados++;
          } catch (e: any) {
            this.state.erros++;
            this.state.lastError = `${r.cpf || r.nome}: ${e?.message}`;
            this.logger.warn(`[giga-etl] erro upsert: ${this.state.lastError}`);
          }
        }
        offset += BATCH;
        this.state.faseProgresso.current = offset;
        // pause 50ms entre batches pra não asfixiar Giga
        await new Promise((res) => setTimeout(res, 50));
      } catch (e: any) {
        this.state.erros++;
        this.state.lastError = `Batch offset=${offset}: ${e?.message}`;
        this.logger.error(`[giga-etl] FASE 1 batch falhou: ${this.state.lastError}`);
        offset += BATCH; // pula esse batch
      }
    }
  }

  /**
   * Detecta nomes reais das colunas na tabela `clientes` do Giga.
   * Lurd's usa o padrão com sufixo RES (residencial).
   */
  private async _detectarColunasClientes(): Promise<{
    codigo: string; nome: string; cpf: string;
    foneCel: string | null; foneRes: string | null;
    email: string | null; nascimento: string | null;
    endereco: string | null; numero: string | null; complemento: string | null;
    bairro: string | null; cidade: string | null; uf: string | null; cep: string | null;
  }> {
    const pool = (this.erp as any).pool;
    const [rows]: any = await pool.query(`SHOW COLUMNS FROM clientes`);
    const available = new Set((rows as any[]).map((r: any) => String(r.Field).toUpperCase()));

    const pick = (...candidates: string[]): string | null => {
      for (const c of candidates) {
        if (available.has(c.toUpperCase())) return c;
      }
      return null;
    };

    return {
      codigo: pick('CODIGO') || 'CODIGO',
      nome: pick('NOME', 'CLIENTE', 'RAZAO_SOCIAL') || 'NOME',
      cpf: pick('CPF', 'CPF_CNPJ', 'DOCUMENTO') || 'CPF',
      foneCel: pick('FONECEL', 'CELULAR', 'WHATSAPP', 'FONE2'),
      foneRes: pick('FONERES', 'TELEFONE', 'FONE', 'FONE1'),
      email: pick('EMAIL', 'E_MAIL', 'MAIL'),
      nascimento: pick('NASCIMENTO', 'DATA_NASCIMENTO', 'DTNASC', 'NASC'),
      endereco: pick('ENDERECORES', 'ENDERECO', 'LOGRADOURO', 'RUA', 'END'),
      numero: pick('NUMERORES', 'NUMERO', 'NUM'),
      complemento: pick('COMPRES', 'COMPLEMENTO', 'COMP'),
      bairro: pick('BAIRRORES', 'BAIRRO', 'BAI'),
      cidade: pick('CIDADERES', 'CIDADE', 'MUNICIPIO'),
      uf: pick('UFRES', 'UF', 'ESTADO'),
      cep: pick('CEPRES', 'CEP'),
    };
  }

  /**
   * UPSERT de 1 cliente Giga no Customer FlowOps.
   * MERGE: nunca sobrescreve dados marketing. Só preenche o que está null.
   */
  private async _upsertCustomerFromGiga(row: any): Promise<void> {
    const cpfDigits = String(row.cpf || '').replace(/\D/g, '');
    const codCliente = Number(row.codCliente) || null;

    // Sem CPF, tenta linkar por registroGiga (codCliente) se já existe
    // Senão pula — não tem como deduplicar de forma confiável
    if (!cpfDigits || cpfDigits.length !== 11) {
      if (!codCliente) {
        this.state.pulados++;
        return;
      }
      // Pode ter cliente sem CPF mas com codCliente — atualiza só se já existe
      const existing = await (this.prisma as any).customer.findFirst({
        where: { registroGiga: codCliente },
      });
      if (!existing) {
        this.state.pulados++;
        return;
      }
      // Atualiza nome/telefone se nulos no Customer
      await this._aplicarMerge(existing, row);
      this.state.atualizados++;
      return;
    }

    // CPF formatado pro padrão FlowOps: 12345678901 → 123.456.789-01
    const cpfFormatted = this._formatCpf(cpfDigits);
    const existing = await (this.prisma as any).customer.findFirst({
      where: { OR: [{ cpf: cpfDigits }, { cpf: cpfFormatted }] },
    });

    if (existing) {
      await this._aplicarMerge(existing, row);
      this.state.atualizados++;
    } else {
      await this._criarNovo(row, cpfDigits, codCliente);
      this.state.criados++;
    }
  }

  /**
   * MERGE NÃO-DESTRUTIVO: só preenche campos null/vazios.
   * Marketing/cashback/opt-in nunca são tocados.
   */
  private async _aplicarMerge(existing: any, row: any): Promise<void> {
    const updates: any = {};

    // registroGiga sempre atualiza (rastreio)
    const codCliente = Number(row.codCliente) || null;
    if (codCliente && existing.registroGiga !== codCliente) {
      updates.registroGiga = codCliente;
    }

    // Nome: só preenche se Customer.name é null/vazio
    if (!existing.name && row.nome) {
      updates.name = String(row.nome).trim().toUpperCase();
    }

    // WhatsApp: prefere FONECEL, fallback FONERES. Só preenche se null.
    if (!existing.whatsapp) {
      const tel = String(row.foneCel || row.foneRes || '').replace(/\D/g, '');
      if (tel && tel.length >= 10) updates.whatsapp = tel;
    }

    // Telefone fixo separado se foneRes existe E é diferente do whatsapp
    if (!existing.phone && row.foneRes) {
      const tel = String(row.foneRes).replace(/\D/g, '');
      if (tel && tel.length >= 10) updates.phone = tel;
    }

    // Email
    if (!existing.email && row.email) {
      const email = String(row.email).trim().toLowerCase();
      if (email.includes('@')) updates.email = email;
    }

    // Aniversário: tenta parse de várias formatações
    if (!existing.birthDate && row.nascimento) {
      const dt = this._parseDate(row.nascimento);
      if (dt) updates.birthDate = dt;
    }

    if (Object.keys(updates).length > 0) {
      await (this.prisma as any).customer.update({
        where: { id: existing.id },
        data: updates,
      });
    }

    // Endereço: cria CustomerAddress(type=residencial) se ainda não tiver
    await this._criarEnderecoSeFaltar(existing.id, row);
  }

  /**
   * Cria Customer novo a partir de linha do Giga.
   * vipTier inicial = 'bronze' (recalculado na fase 3 com base no LTV).
   */
  private async _criarNovo(row: any, cpfDigits: string, codCliente: number | null): Promise<void> {
    const tel = String(row.foneCel || row.foneRes || '').replace(/\D/g, '');
    const telRes = String(row.foneRes || '').replace(/\D/g, '');
    const email = String(row.email || '').trim().toLowerCase();
    const birthDate = this._parseDate(row.nascimento);

    const customer = await (this.prisma as any).customer.create({
      data: {
        cpf: this._formatCpf(cpfDigits),
        name: String(row.nome || '').trim().toUpperCase() || null,
        whatsapp: tel.length >= 10 ? tel : null,
        phone: telRes.length >= 10 && telRes !== tel ? telRes : null,
        email: email.includes('@') ? email : null,
        birthDate,
        registroGiga: codCliente,
        originSource: 'giga',
        vipTier: 'bronze',
        active: true,
      },
    });

    await this._criarEnderecoSeFaltar(customer.id, row);
  }

  /**
   * Cria CustomerAddress(type='residencial', isPrimary=true) se ainda não houver
   * endereço residencial pra esse cliente.
   */
  private async _criarEnderecoSeFaltar(customerId: string, row: any): Promise<void> {
    if (!row.endereco && !row.cep) return; // sem endereço minimamente preenchido, pula

    const existing = await (this.prisma as any).customerAddress.findFirst({
      where: { customerId, type: 'residencial' },
    });
    if (existing) return;

    const cep = String(row.cep || '').replace(/\D/g, '');
    await (this.prisma as any).customerAddress.create({
      data: {
        customerId,
        type: 'residencial',
        isPrimary: true,
        active: true,
        street: String(row.endereco || '').trim() || null,
        number: String(row.numero || '').trim() || null,
        complement: String(row.complemento || '').trim() || null,
        district: String(row.bairro || '').trim() || null,
        city: String(row.cidade || '').trim() || null,
        state: String(row.uf || '').trim().toUpperCase().slice(0, 2) || null,
        zipCode: cep.length === 8 ? cep : null,
      },
    }).catch((e: any) => {
      this.logger.warn(`[giga-etl] criar endereço falhou customer=${customerId}: ${e?.message}`);
    });
  }

  /**
   * FASE 2 — Recalcula LTV/orderCount/lastOrderAt somando histórico do Giga
   * (tabela caixa). Importante: PULA registros que vieram do PDV FlowOps
   * pra não dupla-contar (PDV já gravou no Customer via finalize).
   *
   * Como identificar PDV no Giga? Vou usar OBSERVACAO ou OPERACAO que contenha
   * marcador. Em última instância, posso filtrar por janela de data (vendas
   * antes da data de início do FlowOps).
   *
   * Por ora: simples — soma TUDO. Em produção real, podemos refinar depois.
   */
  private async _syncHistorico(): Promise<void> {
    const pool = (this.erp as any).pool;

    // Carrega TODAS as Stores do FlowOps pra mapear code → id (originStoreId)
    // O Giga usa LOJA como texto ('01', 'ITANHAEM', etc.). Mapeio pelo store.code.
    const stores = await (this.prisma as any).store.findMany({
      select: { id: true, code: true, name: true },
    });
    const storeByCode = new Map<string, string>();
    for (const s of stores as any[]) {
      // Indexa por code exato + nome normalizado (alguns Gigas guardam o nome)
      storeByCode.set(String(s.code).trim().toUpperCase(), s.id);
      if (s.name) storeByCode.set(String(s.name).trim().toUpperCase(), s.id);
    }

    const customers = await (this.prisma as any).customer.findMany({
      where: { registroGiga: { not: null } },
      select: { id: true, registroGiga: true, cpf: true, originStoreId: true },
    });

    this.state.faseProgresso = { current: 0, total: customers.length };
    this.logger.log(
      `[giga-etl] FASE 2: histórico + originStoreId de ${customers.length} clientes ` +
      `(${stores.length} lojas mapeadas)`,
    );

    for (const c of customers as any[]) {
      try {
        // 1) Soma compras (LTV/orderCount/lastOrderAt)
        const [rows]: any = await pool.query(
          `SELECT
              COUNT(DISTINCT NUMERO) AS totalCompras,
              SUM(VALORTOTAL) AS valorTotal,
              MAX(DATA) AS ultimaCompra
            FROM caixa
            WHERE CLIENTE = ?
              AND VALORTOTAL > 0
              AND UPPER(COALESCE(MARCADO, '')) != 'SIM'`,
          [c.registroGiga],
        );
        const r = rows[0] || {};
        const ltvCents = Math.round((Number(r.valorTotal) || 0) * 100);
        const orderCount = Number(r.totalCompras) || 0;
        const lastOrderAt = r.ultimaCompra ? new Date(r.ultimaCompra) : null;

        // 2) Loja PRINCIPAL — onde o cliente mais comprou (top 1 por COUNT)
        // Group by LOJA + ORDER BY DESC + LIMIT 1
        let lojaPrincipal: string | null = null;
        if (orderCount > 0) {
          const [lojas]: any = await pool.query(
            `SELECT LOJA AS loja, COUNT(*) AS qtd
              FROM caixa
              WHERE CLIENTE = ?
                AND VALORTOTAL > 0
                AND UPPER(COALESCE(MARCADO, '')) != 'SIM'
                AND LOJA IS NOT NULL
              GROUP BY LOJA
              ORDER BY qtd DESC
              LIMIT 1`,
            [c.registroGiga],
          );
          if (lojas?.[0]?.loja) {
            lojaPrincipal = String(lojas[0].loja).trim().toUpperCase();
          }
        }

        const novoStoreId = lojaPrincipal ? storeByCode.get(lojaPrincipal) : undefined;

        if (orderCount > 0 || novoStoreId) {
          const updates: any = {};
          if (orderCount > 0) {
            updates.ltvCents = BigInt(ltvCents);
            updates.orderCount = orderCount;
            updates.lastOrderAt = lastOrderAt;
            updates.ticketMedioCents = orderCount > 0 ? Math.round(ltvCents / orderCount) : 0;
          }
          // Só seta originStoreId se ainda não tiver (não sobrescreve cadastro manual)
          if (novoStoreId && !c.originStoreId) {
            updates.originStoreId = novoStoreId;
          }
          await (this.prisma as any).customer.update({
            where: { id: c.id },
            data: updates,
          });
        }
      } catch (e: any) {
        this.logger.warn(`[giga-etl] histórico cliente ${c.id} falhou: ${e?.message}`);
      }
      this.state.faseProgresso.current++;
    }
  }

  /**
   * FASE 3 — Recalcula vipTier conforme régua oficial:
   *   bronze:   LTV < R$ 500
   *   prata:    R$ 500-1500
   *   ouro:     R$ 1500-5000
   *   diamante: R$ 5000+
   * tierEnteredAt = data em que entrou no tier atual (now() se mudou).
   */
  private async _recalcularTiers(): Promise<void> {
    const customers = await (this.prisma as any).customer.findMany({
      select: { id: true, vipTier: true, ltvCents: true, tierEnteredAt: true },
    });
    this.state.faseProgresso = { current: 0, total: customers.length };
    this.logger.log(`[giga-etl] FASE 3: recalculando tier de ${customers.length} clientes`);

    for (const c of customers as any[]) {
      try {
        const ltvBRL = Number(c.ltvCents || 0) / 100;
        let novoTier: string;
        if (ltvBRL < 500) novoTier = 'bronze';
        else if (ltvBRL < 1500) novoTier = 'prata';
        else if (ltvBRL < 5000) novoTier = 'ouro';
        else novoTier = 'diamante';

        if (novoTier !== c.vipTier) {
          await (this.prisma as any).customer.update({
            where: { id: c.id },
            data: {
              vipTier: novoTier,
              tierEnteredAt: new Date(),
            },
          });
        }
      } catch (e: any) {
        this.logger.warn(`[giga-etl] tier cliente ${c.id} falhou: ${e?.message}`);
      }
      this.state.faseProgresso.current++;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private _formatCpf(digits: string): string {
    if (digits.length !== 11) return digits;
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }

  private _parseDate(input: any): Date | null {
    if (!input) return null;
    if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
    const s = String(input).trim();
    if (!s) return null;
    // Formato YYYY-MM-DD ou ISO
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const dt = new Date(s);
      return isNaN(dt.getTime()) ? null : dt;
    }
    // DD/MM/YYYY
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) {
      const dt = new Date(`${m[3]}-${m[2]}-${m[1]}`);
      return isNaN(dt.getTime()) ? null : dt;
    }
    return null;
  }
}
