import { Injectable, Logger } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PrismaService } from '../prisma/prisma.service';
import { ehFichaNaoPessoa } from '../common/fichas-operadora';
import {
  CobrancaContext, ParcelaCobranca, renderCobranca, TEMPLATES,
  DEFAULT_TEMPLATE_STRINGS,
} from './cobranca-templates';

const TEMPLATES_KEY = 'cobranca_templates';
const LOJA_NOME_KEY = 'cobranca_loja_nome';
// Cache PERSISTENTE do mapa de colunas da tabela `movimento` do Giga.
// Ver detectColumns() — evita SHOW COLUMNS no MySQL frágil a cada chamada.
const COLUMN_MAP_KEY = 'crediario_movimento_column_map';

/**
 * CrediariosService — cobrança de parcelas vencidas direto da tabela
 * `movimento` do MySQL Gigasistemas.
 *
 * A tabela `movimento` no Giga (700k+ linhas) é o "razão" do crediário:
 * cada linha é UMA parcela de uma compra. Os nomes das colunas variam
 * entre instalações antigas do Gigasistemas (nem sempre tem padrão ANSI),
 * então o módulo usa AUTODETECÇÃO via SHOW COLUMNS + heurística por regex.
 *
 * Padrão típico (confirmado pelo print do Thiago):
 *   REGISTRO       PK
 *   CONTROLE       ID da parcela (sequencial)
 *   NUMEROCOMPRA   ID da compra (mesmo pra todas as parcelas dela)
 *   LOJA           '01'..'20'
 *   CODCLIENTE
 *   NOME           desnormalizado pra cobrança rápida
 *   DATACOMPRA
 *   VALORCOMPRA    (truncado VALORCON no print — checar)
 *   ...mais 16 colunas: PARCELA / VENCIMENTO / VALOR_PARCELA /
 *      DATA_PAGAMENTO / etc.
 *
 * Pra puxar TELEFONE do cliente também detectamos a tabela `clientes`
 * (ou `cadcli`) e cacheamos o mapping de colunas dela.
 */
@Injectable()
export class CrediariosService {
  private readonly logger = new Logger(CrediariosService.name);
  private columnMapCache: ColumnMap | null = null;
  private clientesMapCache: ClientesMap | null = null;

  constructor(
    private readonly erp: ErpService,
    private readonly wa: WhatsappService,
    private readonly prisma: PrismaService,
  ) {}

  // =========== TEMPLATES EDITÁVEIS ===========

  /**
   * Lê os 6 templates configuráveis. Se não tiver salvo, retorna os defaults.
   * Cache em memória 30s pra evitar SELECT em cada disparo.
   */
  private templatesCache: { value: string[]; lojaNome: string; expiresAt: number } | null = null;

  async getEditableTemplates(force = false): Promise<{ templates: string[]; lojaNome: string; isDefault: boolean }> {
    if (!force && this.templatesCache && Date.now() < this.templatesCache.expiresAt) {
      return {
        templates: this.templatesCache.value,
        lojaNome: this.templatesCache.lojaNome,
        isDefault: false,
      };
    }
    let templates = [...DEFAULT_TEMPLATE_STRINGS];
    let lojaNome = `Lurd's Plus Size`;
    let isDefault = true;
    try {
      const rec = await (this.prisma as any).systemSetting.findUnique({ where: { key: TEMPLATES_KEY } });
      if (rec?.value) {
        const parsed = JSON.parse(rec.value);
        if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
          templates = parsed.filter((s: string) => s && s.trim().length > 0);
          isDefault = false;
        }
      }
      const recLoja = await (this.prisma as any).systemSetting.findUnique({ where: { key: LOJA_NOME_KEY } });
      if (recLoja?.value && typeof recLoja.value === 'string') {
        lojaNome = recLoja.value;
      }
    } catch (e: any) {
      this.logger.warn(`getEditableTemplates: usando defaults (${e?.message})`);
    }
    if (!templates.length) templates = [...DEFAULT_TEMPLATE_STRINGS];
    this.templatesCache = { value: templates, lojaNome, expiresAt: Date.now() + 30_000 };
    return { templates, lojaNome, isDefault };
  }

  async setEditableTemplates(templates: string[], lojaNome?: string): Promise<{ ok: boolean }> {
    const clean = (templates || [])
      .map((s) => String(s ?? '').trim())
      .filter((s) => s.length > 0);
    if (clean.length < 1) {
      throw new Error('Pelo menos 1 template precisa ter conteúdo');
    }
    if (clean.length > 12) {
      throw new Error('Máximo 12 templates');
    }
    await (this.prisma as any).systemSetting.upsert({
      where: { key: TEMPLATES_KEY },
      update: { value: JSON.stringify(clean) },
      create: { key: TEMPLATES_KEY, value: JSON.stringify(clean) },
    });
    if (typeof lojaNome === 'string' && lojaNome.trim().length > 0) {
      await (this.prisma as any).systemSetting.upsert({
        where: { key: LOJA_NOME_KEY },
        update: { value: lojaNome.trim() },
        create: { key: LOJA_NOME_KEY, value: lojaNome.trim() },
      });
    }
    this.templatesCache = null;
    return { ok: true };
  }

  async resetEditableTemplates(): Promise<{ ok: boolean }> {
    await (this.prisma as any).systemSetting.delete({ where: { key: TEMPLATES_KEY } }).catch(() => null);
    this.templatesCache = null;
    return { ok: true };
  }

  /**
   * Lê SHOW COLUMNS FROM movimento e tenta mapear nomes da instalação local
   * pros nossos nomes lógicos (parcela, vencimento, valorParcela, etc).
   *
   * CACHE EM 2 NÍVEIS — memória do processo → SystemSetting no Postgres:
   *   1. `columnMapCache`: zero I/O, morre no restart.
   *   2. `system_settings[crediario_movimento_column_map]`: sobrevive a deploy
   *      (o backend reinicia a cada deploy, então o nível 1 sozinho zerava).
   *
   * Por que: cada detecção custa 3 queries no Giga (`getTableSchema` faz
   * SHOW COLUMNS + SELECT * LIMIT 1 + COUNT(*) — e `movimento` tem 700k+
   * linhas), e detectColumns é chamado em 5 caminhos quentes, vários com
   * force=true. Nome de coluna do Gigasistemas praticamente nunca muda, então
   * não vale pagar essa viagem toda hora num MySQL que PENDURA quando o
   * firewall por IP da KingHost derruba o IP do Railway.
   *
   * `force = true` mantém o contrato antigo: vai no Giga e REESCREVE os dois
   * níveis de cache. Também exposto por `GET /crediarios/schema` (admin).
   *
   * Degradação com o Giga fora:
   *   - sem nenhum cache  → EMPTY_MAP + log de erro, IGUAL a hoje.
   *   - com cache gravado → devolve o último mapa bom (melhor, nunca pior).
   *
   * Só mapa íntegro entra no cache (ver isUsableColumnMap): EMPTY_MAP ou
   * detecção pela metade NUNCA é persistida — era justamente o medo do
   * comentário de force=true em crediario-baixa.service.ts.
   */
  async detectColumns(force = false): Promise<ColumnMap> {
    if (this.columnMapCache && !force) return this.columnMapCache;

    // Nível 2: mapa de uma detecção anterior, sem tocar no Giga.
    if (!force) {
      const stored = await this.readStoredColumnMap();
      if (stored) {
        this.columnMapCache = stored;
        return stored;
      }
    }

    const schema = await this.erp.getTableSchema('movimento', 1);
    if (!schema) {
      // Giga fora/pendurado. Se já detectamos alguma vez, é melhor usar o
      // último mapa bom do que derrubar o crediário inteiro com EMPTY_MAP.
      const fallback = this.columnMapCache ?? (await this.readStoredColumnMap());
      if (fallback) {
        this.logger.warn(
          'detectColumns: Giga não respondeu — seguindo com o mapa de colunas em cache',
        );
        this.columnMapCache = fallback;
        return fallback;
      }
      this.logger.error('detectColumns: tabela movimento não encontrada');
      return EMPTY_MAP;
    }
    const cols = schema.columns.map((c) => c.field);
    const map: ColumnMap = {
      registro:       pickColumn(cols, /^registro$/i, /^id$/i),
      controle:       pickColumn(cols, /^controle$/i),
      numeroCompra:   pickColumn(cols, /^numero?_?compra$/i, /^num_?venda$/i),
      loja:           pickColumn(cols, /^loja$/i, /^codloja$/i, /^cod_?loja$/i),
      codCliente:     pickColumn(cols, /^cod_?cliente$/i, /^codcli$/i, /^idcliente$/i),
      nome:           pickColumn(cols, /^nome$/i, /^nome_?cliente$/i, /^cliente$/i),
      dataCompra:     pickColumn(cols, /^data_?compra$/i, /^dt_?compra$/i, /^data$/i),
      valorCompra:    pickColumn(cols, /^valor_?compra$/i, /^valorcon$/i, /^valor_?con$/i, /^total_?compra$/i, /^vlr_?compra$/i),
      parcela:        pickColumn(cols, /^parcela$/i, /^num_?parcela$/i, /^numparcela$/i, /^parc(?:ela)?$/i),
      totalParcelas:  pickColumn(cols, /^qtd_?parcelas?$/i, /^total_?parcelas?$/i, /^numparcelas$/i, /^np$/i),
      vencimento:     pickColumn(cols, /^vencimento$/i, /^data_?vencimento$/i, /^dt_?venc$/i, /^vencto$/i, /^venc$/i),
      valorParcela:   pickColumn(cols, /^valor_?parcela$/i, /^valor_?parc$/i, /^vlrparc$/i, /^valor$/i),
      // Lurd's usa simplesmente "PAGAMENTO" (sem prefixo data_). MUITO CRÍTICO:
      // colocar /^pagamento$/i ANTES de /^pago$/i conflict — não, são regex
      // diferentes em campos diferentes (pago vs dataPagamento), sem conflito.
      dataPagamento:  pickColumn(cols, /^pagamento$/i, /^data_?pagamento$/i, /^dt_?pagto$/i, /^data_?pagto$/i, /^datapagto$/i, /^data_?baixa$/i, /^datapag$/i),
      valorPago:      pickColumn(cols, /^valor_?pago$/i, /^valorpago$/i, /^vlrpago$/i),
      pago:           pickColumn(cols,
        /^pago$/i, /^pg$/i, /^pago_?sn$/i, /^st_?pago$/i, /^stat_?pago$/i, /^status_?pago$/i,
        /^flag_?pago$/i, /^baixado$/i, /^baixa$/i, /^bx$/i, /^quitado$/i, /^liquidado$/i,
        /^pgto$/i, /^pgo$/i, /^paga$/i, /^pagto$/i, /^foi_?pago$/i, /^pago_?nao$/i,
        /^pg_?sn$/i, /^bxd$/i, /^marc(?:ado)?_?pago$/i,
      ),
      status:         pickColumn(cols, /^status$/i, /^situacao$/i),
      tipo:           pickColumn(cols, /^tipo$/i, /^tipo_?pagamento$/i, /^forma_?pagamento$/i),
      telefone:       pickColumn(cols, /^telefone$/i, /^fone$/i, /^celular$/i),
      juros:          pickColumn(cols, /^juros$/i, /^vlr_?juros$/i, /^valor_?juros$/i),
      multa:          pickColumn(cols, /^multa$/i, /^vlr_?multa$/i, /^valor_?multa$/i),
      // OBS — coluna de observação livre da promissória (recibo, lembrete, etc)
      obs:            pickColumn(cols,
        /^obs$/i, /^obs_?promiss?oria$/i, /^observacao$/i, /^observacoes$/i,
        /^observa(?:[çc][ãa]o)?$/i, /^historico$/i, /^memo$/i, /^nota$/i, /^notas$/i,
        /^complemento$/i, /^obs_?fin$/i, /^obs_?cred$/i, /^descricao$/i,
      ),
    };
    this.columnMapCache = map;
    await this.writeStoredColumnMap(map);
    this.logger.log(`detectColumns mapeamento: ${JSON.stringify(map)}`);
    return map;
  }

  /**
   * Lê o mapa de colunas persistido no Postgres. Devolve null (= "vai no
   * Giga") se não existir, estiver ilegível ou vier incompleto — nunca deixa
   * um cache podre substituir a detecção ao vivo.
   */
  private async readStoredColumnMap(): Promise<ColumnMap | null> {
    try {
      const rec = await (this.prisma as any).systemSetting.findUnique({
        where: { key: COLUMN_MAP_KEY },
      });
      if (!rec?.value) return null;
      const parsed = JSON.parse(rec.value);
      if (!parsed || typeof parsed !== 'object') return null;

      // Normaliza contra a forma canônica: campo novo que ainda não existia
      // quando o cache foi gravado vira null, campo estranho é descartado.
      const map: ColumnMap = { ...EMPTY_MAP };
      for (const k of Object.keys(EMPTY_MAP) as Array<keyof ColumnMap>) {
        const v = (parsed as any)[k];
        map[k] = typeof v === 'string' && v.length > 0 ? v : null;
      }
      return isUsableColumnMap(map) ? map : null;
    } catch (e: any) {
      this.logger.warn(
        `detectColumns: cache de colunas ilegível (${e?.message}) — vai no Giga`,
      );
      return null;
    }
  }

  /**
   * Persiste o mapa detectado. Detecção incompleta não é gravada (senão o
   * cache congelaria justamente o estado ruim). Falha ao gravar não quebra
   * nada: o caminho segue funcionando, só sem cache.
   */
  private async writeStoredColumnMap(map: ColumnMap): Promise<void> {
    if (!isUsableColumnMap(map)) {
      this.logger.warn(
        'detectColumns: mapa incompleto — NÃO persistido (segue detectando ao vivo)',
      );
      return;
    }
    try {
      const value = JSON.stringify(map);
      await (this.prisma as any).systemSetting.upsert({
        where: { key: COLUMN_MAP_KEY },
        update: { value },
        create: { key: COLUMN_MAP_KEY, value },
      });
    } catch (e: any) {
      this.logger.warn(
        `detectColumns: não consegui salvar o cache de colunas (${e?.message}) — segue sem`,
      );
    }
  }

  /**
   * Tenta detectar a tabela de clientes do Giga (`clientes` ou `cadcli`)
   * e mapear códigos+nome+telefone. Cache em memória.
   *
   * Retorna null se não conseguir detectar — nesse caso `enrichWithPhone`
   * vira no-op.
   */
  async detectClientesTable(force = false): Promise<ClientesMap | null> {
    if (this.clientesMapCache && !force) return this.clientesMapCache;

    const candidates = ['clientes', 'cliente', 'cadcli', 'cadcliente', 'cadclientes'];
    let connectionError: any = null;
    for (const tbl of candidates) {
      try {
        const schema = await this.erp.getTableSchema(tbl, 1);
        if (!schema) continue;
        const cols = schema.columns.map((c) => c.field);
        const codCliente = pickColumn(cols, /^cod_?cliente$/i, /^codcli$/i, /^codigo$/i, /^id_?cliente$/i, /^id$/i);
        const nome = pickColumn(cols, /^nome$/i, /^nome_?cliente$/i, /^cliente$/i, /^razao_?social$/i);
        // PRINCIPAL → CELULAR. Lurd's usa FONECEL no Gigasistemas.
        const telefone = pickColumn(cols,
          /^fonecel$/i, /^fone_?cel$/i,             // ← Lurd's / Giga (PRIORIDADE)
          /^celular$/i, /^cel$/i, /^whatsapp$/i, /^wpp$/i,
          /^telefone$/i, /^tel$/i, /^fone$/i,
          /^telefone1$/i, /^tel1$/i, /^fone1$/i,
        );
        // FALLBACK → RESIDENCIAL. Lurd's usa FONERES.
        const telefone2 = pickColumn(cols,
          /^foneres$/i, /^fone_?res$/i,             // ← Lurd's / Giga (PRIORIDADE)
          /^telefone2$/i, /^tel2$/i, /^fone2$/i, /^celular2$/i, /^contato$/i,
        );
        // CPF — coluna pode variar muito no Giga.
        // Lurd's costuma usar CPF puro, mas alguns clones usam CPFCGC, CGCCPF, CPF_CNPJ.
        const cpf = pickColumn(cols,
          /^cpf$/i, /^cpf_?cnpj$/i, /^cnpj_?cpf$/i, /^cpfcgc$/i, /^cgccpf$/i,
          /^doc(?:umento)?$/i, /^num_?doc$/i,
        );
        const cidade = pickColumn(cols, /^cidade$/i, /^municipio$/i, /^localidade$/i);
        const endereco = pickColumn(cols, /^endereco$/i, /^logradouro$/i, /^rua$/i, /^endereço$/i);
        const bairro = pickColumn(cols, /^bairro$/i, /^distrito$/i);
        const cep = pickColumn(cols, /^cep$/i, /^codigo_?postal$/i);
        // LOJA — char(2) com zero à esquerda. CRÍTICO: o CODIGO de cliente se
        // REPETE entre lojas (cada loja tem sua numeração) — toda busca de
        // cliente pra crediário PRECISA filtrar por loja junto.
        const loja = pickColumn(cols, /^loja$/i, /^cod_?loja$/i, /^filial$/i);
        if (!codCliente) continue;
        const result: ClientesMap = {
          table: tbl, codCliente, nome, telefone, telefone2,
          cpf, cidade, endereco, bairro, cep, loja,
        };
        this.clientesMapCache = result;
        this.logger.log(`detectClientesTable: ${JSON.stringify(result)}`);
        return result;
      } catch (e: any) {
        // Captura erro de CONEXAO (não de tabela inexistente). Códigos típicos
        // de problema de rede: EHOSTUNREACH, ETIMEDOUT, ECONNREFUSED, PROTOCOL_*.
        // Esses não significam que a tabela não existe — o MySQL tá fora do ar.
        const code = e?.code || e?.errno;
        const msg = String(e?.message || '');
        if (
          code === 'EHOSTUNREACH' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' ||
          code === 'ECONNRESET' || code === 'ENOTFOUND' ||
          msg.includes('Connection lost') || msg.includes('connect ETIMEDOUT')
        ) {
          connectionError = e;
          break; // não adianta tentar outras tabelas — é problema de rede
        }
        // tabela não existe — segue tentando próxima
      }
    }
    // Se foi erro de CONEXAO e já temos cache válido, usa o cache pra não quebrar UX.
    if (connectionError && this.clientesMapCache) {
      this.logger.warn(
        `detectClientesTable: Wincred indisponível (${connectionError.code || connectionError.message}) — usando cache em fallback`,
      );
      return this.clientesMapCache;
    }
    if (connectionError) {
      this.logger.error(
        `detectClientesTable: erro de conexão Wincred (${connectionError.code || connectionError.message}) e SEM cache — vai retornar null`,
      );
    } else {
      this.logger.warn('detectClientesTable: nenhuma tabela de clientes encontrada');
    }
    return null;
  }

  /**
   * Diagnóstico do universo de clientes do Giga: totais + cobertura de telefone.
   * Útil pra responder "286 sem telefone do total de quantos?".
   */
  async diagnoseClientesPhones(): Promise<{
    table: string | null;
    columnMap: any;
    total: number;
    comTelefonePrincipal: number;
    comTelefoneFallback: number;
    semNenhum: number;
    sample: any[];
  }> {
    const cm = await this.detectClientesTable(true);
    if (!cm) {
      return {
        table: null, columnMap: null, total: 0,
        comTelefonePrincipal: 0, comTelefoneFallback: 0, semNenhum: 0,
        sample: [],
      };
    }

    const tel1 = cm.telefone ? `\`${cm.telefone}\`` : null;
    const tel2 = cm.telefone2 ? `\`${cm.telefone2}\`` : null;

    // Conta total + cobertura
    const cond1 = tel1 ? `${tel1} IS NOT NULL AND TRIM(${tel1}) <> ''` : 'FALSE';
    const cond2 = tel2 ? `${tel2} IS NOT NULL AND TRIM(${tel2}) <> ''` : 'FALSE';
    const sql = `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ${cond1} THEN 1 ELSE 0 END) AS comTel1,
        SUM(CASE WHEN ${cond2} THEN 1 ELSE 0 END) AS comTel2,
        SUM(CASE WHEN NOT (${cond1}) AND NOT (${cond2}) THEN 1 ELSE 0 END) AS semNenhum
      FROM \`${cm.table}\`
    `;

    let total = 0, comTel1 = 0, comTel2 = 0, semNenhum = 0;
    try {
      const r = await this.erp.runReadOnly(sql, { maxRows: 1, timeoutMs: 30000 });
      const row = r.rows[0] || {};
      total = Number(row.total ?? 0);
      comTel1 = Number(row.comTel1 ?? 0);
      comTel2 = Number(row.comTel2 ?? 0);
      semNenhum = Number(row.semNenhum ?? 0);
    } catch (e: any) {
      this.logger.warn(`diagnoseClientesPhones: count falhou: ${e?.message}`);
    }

    // Amostra de 5 clientes pra ver os dados (NOMES MASCARADOS, telefones FULL pra debug)
    const sampleCols: string[] = [];
    if (cm.codCliente) sampleCols.push(`\`${cm.codCliente}\` AS codCliente`);
    if (cm.nome) sampleCols.push(`\`${cm.nome}\` AS nome`);
    if (cm.telefone) sampleCols.push(`\`${cm.telefone}\` AS telefonePrincipal`);
    if (cm.telefone2) sampleCols.push(`\`${cm.telefone2}\` AS telefoneFallback`);
    let sample: any[] = [];
    try {
      const r = await this.erp.runReadOnly(
        `SELECT ${sampleCols.join(', ')} FROM \`${cm.table}\` LIMIT 5`,
        { maxRows: 5, timeoutMs: 10000 },
      );
      sample = r.rows;
    } catch (e: any) {
      this.logger.warn(`diagnoseClientesPhones: sample falhou: ${e?.message}`);
    }

    return {
      table: cm.table,
      columnMap: { codCliente: cm.codCliente, nome: cm.nome, telefonePrincipal: cm.telefone, telefoneFallback: cm.telefone2 },
      total,
      comTelefonePrincipal: comTel1,
      comTelefoneFallback: comTel2,
      semNenhum,
      sample,
    };
  }

  /**
   * Pra cada codCliente recebido, busca telefone no ESPELHO Postgres
   * (`wincred_clientes`) com complemento da ficha nativa (`giga_clientes` —
   * cliente criado/atualizado NO FLOW depois que o espelho congelou, 27/08).
   * O Giga morreu (03/09): telefone que não está em nenhuma das duas tabelas
   * é dado ausente legítimo — o campo volta vazio, sem erro calado e sem
   * tocar no pool morto.
   * Retorna Map<codCliente, { telefone, nome }>.
   */
  async fetchPhonesByClienteIds(
    codClientes: string[],
    storeCode?: string,
  ): Promise<Map<string, { telefone: string | null; nome: string | null }>> {
    const out = new Map<string, { telefone: string | null; nome: string | null }>();
    if (codClientes.length === 0) return out;

    // Sanitiza ids + variantes de padding (zeros à esquerda variam entre as
    // tabelas do Giga — movimento vs clientes — e o espelho herdou isso).
    const ids = Array.from(new Set(codClientes.map((c) => String(c).trim()).filter(Boolean)));
    if (ids.length === 0) return out;
    const variantes = (cod: string): string[] => {
      const set = new Set<string>([cod]);
      const semZeros = cod.replace(/^0+/, '');
      if (semZeros) set.add(semZeros);
      return Array.from(set);
    };
    const todasVariantes = Array.from(new Set(ids.flatMap(variantes)));

    // Escopo por loja (opcional) — o mesmo cod em outra loja é OUTRA pessoa;
    // sem o filtro, nome/telefone podem vir do cadastro errado.
    const safeStore = storeCode
      ? String(storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
      : null;

    const { normalizeBrPhone } = await import('../lib/phone-br');
    // Registra o cliente sob TODAS as variantes do código — quem consulta o
    // Map pode chegar com ou sem zeros à esquerda.
    const registrar = (cod: string, info: { telefone: string | null; nome: string | null }) => {
      for (const k of variantes(cod)) {
        const atual = out.get(k);
        out.set(k, {
          telefone: atual?.telefone || info.telefone,
          nome: atual?.nome || info.nome,
        });
      }
    };

    // 1) Espelho slim de clientes (wincred_clientes) — o mesmo que a tela de
    // Recebimentos usa. Prefere telefone1 (FONECEL); se vazio, telefone2
    // (FONERES). Normaliza pra formato BR — DDD 13 (Lurd's default) se faltar.
    const doEspelho: any[] = await (this.prisma as any).wincredCliente.findMany({
      where: {
        codCliente: { in: todasVariantes },
        ...(safeStore ? { loja: safeStore } : {}),
      },
    });
    for (const c of doEspelho) {
      const norm1 = normalizeBrPhone(String(c.telefone || '').trim());
      const norm2 = normalizeBrPhone(String(c.telefone2 || '').trim());
      registrar(String(c.codCliente), {
        telefone: norm1 || norm2 || null,
        nome: c.nome ? String(c.nome) : null,
      });
    }

    // 2) Complemento pela ficha nativa (giga_clientes) — cobre cliente novo
    // do Flow e telefone atualizado depois do congelamento do espelho.
    const faltando = ids.filter((id) => !out.get(id)?.telefone);
    if (faltando.length) {
      const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
        where: {
          codigo: { in: Array.from(new Set(faltando.flatMap(variantes))) },
          ...(safeStore ? { loja: safeStore } : {}),
        },
      });
      for (const f of fichas) {
        const tel =
          normalizeBrPhone(String(f.foneCel || '').trim()) ||
          normalizeBrPhone(String(f.foneRes || '').trim()) ||
          normalizeBrPhone(String(f.foneRec || '').trim()) ||
          null;
        registrar(String(f.codigo), { telefone: tel, nome: f.nome ? String(f.nome) : null });
      }
    }
    return out;
  }

  /**
   * Lista parcelas VENCIDAS e NÃO PAGAS de uma loja, ordenadas por
   * VENCIMENTO ASC (mais antigo primeiro — fila de cobrança real).
   *
   * FONTE (03/09 — Giga morto): `crediario_parcelas`, o ledger NATIVO do
   * crediário — a MESMA tabela de onde o espelho de abertas
   * (`wincred_movimento_aberto`) é copiado a cada 10min e que recebe baixa e
   * estorno por write-through na hora. Vencida: vencimento < hoje (Brasília).
   * Não paga: pago=false e cancelado=false. Miss = lista vazia; ledger
   * inteiro vazio = erro honesto que SOBE (importação pendente).
   *
   * Filtros opcionais:
   *   - daysBack:    janela máxima no passado (default 365)
   *   - dataInicio:  filtro >= (formato YYYY-MM-DD)
   *   - dataFim:     filtro <= (formato YYYY-MM-DD)
   *   - limit:       teto de linhas (default 5000)
   */
  async listOverdue(opts: {
    storeCode: string;
    daysBack?: number;
    dataInicio?: string;
    dataFim?: string;
    limit?: number;
    orderBy?: 'vencimento' | 'cliente';
  }): Promise<{
    columnMap: ColumnMap;
    rows: any[];
    summary: { totalParcelas: number; totalDevido: number; clientes: number };
    rawSql: string;
  }> {
    const daysBack = Math.max(1, Math.min(3650, opts.daysBack ?? 365));
    const limit = Math.max(1, Math.min(50000, opts.limit ?? 5000));
    const safeStore = String(opts.storeCode || '').replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2);
    const safeDate = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
    const dataInicio = safeDate(opts.dataInicio);
    const dataFim = safeDate(opts.dataFim);

    // "Hoje" no dia de BRASÍLIA (mesma convenção do calcJuros da baixa) — o
    // Railway roda em UTC e o CURDATE() antigo era do MySQL. `vencimento` é
    // coluna DATE (meia-noite UTC), então a comparação fica dia contra dia.
    const agoraBrasilia = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const hoje = new Date(Date.UTC(
      agoraBrasilia.getUTCFullYear(), agoraBrasilia.getUTCMonth(), agoraBrasilia.getUTCDate(),
    ));

    const vencimento: any = { lt: hoje };
    // Janela máxima (daysBack) — só aplica se NÃO tiver dataInicio explícito
    if (dataInicio) vencimento.gte = new Date(`${dataInicio}T00:00:00Z`);
    else vencimento.gte = new Date(hoje.getTime() - daysBack * 86400000);
    if (dataFim) vencimento.lte = new Date(`${dataFim}T00:00:00Z`);

    const where = {
      pago: false,
      cancelado: false,
      loja: safeStore,
      vencimento,
      // Excluir cliente 0 (cartão / avulso / VISANET / CREDICARD / REDESHOP)
      codCliente: { notIn: ['', '0', '00'] },
    };
    const abertas: any[] = await (this.prisma as any).crediarioParcela.findMany({
      where,
      orderBy: opts.orderBy === 'cliente'
        ? [{ codCliente: 'asc' }, { vencimento: 'asc' }]
        : [{ vencimento: 'asc' }, { codCliente: 'asc' }],
      take: limit,
    });

    // REGRA DE OURO: vazio POR FILTRO é legítimo; ledger inteiro vazio é a
    // 1ª carga que nunca rodou — erro honesto em vez de "ninguém deve".
    if (!abertas.length) {
      const totalAbertas = await (this.prisma as any).crediarioParcela.count({
        where: { pago: false, cancelado: false },
      });
      if (totalAbertas === 0) {
        throw new Error(
          'Ledger nativo do crediário vazio (crediario_parcelas sem nenhuma parcela aberta) — importação/1ª carga pendente.',
        );
      }
    }

    // Mesmos aliases da resposta antiga (a tela de Cobrança e o cron leem por
    // esses nomes). Datas viram 'YYYY-MM-DD' (ordenável e comparável como
    // string) e Decimal vira Number.
    const dataIso = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const rawSql =
      `-- espelho nativo: crediario_parcelas (pago=false, cancelado=false, loja='${safeStore}', ` +
      `vencimento < '${dataIso(hoje)}'${dataInicio ? `, >= '${dataInicio}'` : ` , janela ${daysBack}d`}` +
      `${dataFim ? `, <= '${dataFim}'` : ''}) LIMIT ${limit}`;

    // Enriquecimento de telefone via espelho de clientes
    let rows: any[] = abertas.map((r) => ({
      registro: String(r.registro),
      controle: r.controle != null ? String(r.controle) : null,
      numeroCompra: r.numeroCompra != null ? String(r.numeroCompra) : null,
      codCliente: r.codCliente != null ? String(r.codCliente) : null,
      nome: r.nomeCliente != null ? String(r.nomeCliente) : null,
      telefone: null, // preenchido abaixo pelo cadastro
      dataCompra: dataIso(r.dataCompra),
      valorCompra: r.valorCompra != null ? Number(r.valorCompra) : null,
      parcela: r.parcela != null ? Number(r.parcela) : null,
      totalParcelas: r.totalParcelas != null ? Number(r.totalParcelas) : null,
      vencimento: dataIso(r.vencimento),
      valorParcela: r.valorParcela != null ? Number(r.valorParcela) : 0,
      dataPagamento: null,
      valorPago: r.valorPago != null ? Number(r.valorPago) : null,
      pago: 'N',
      status: null,
    }));
    try {
      const ids = Array.from(new Set(rows.map((r) => String(r.codCliente)).filter(Boolean)));
      if (ids.length > 0) {
        const phones = await this.fetchPhonesByClienteIds(ids);
        rows = rows.map((r) => {
          const cli = phones.get(String(r.codCliente));
          if (!cli) return r;
          return {
            ...r,
            // Prioridade: telefone do cadastro > o que veio da movimento
            telefone: cli.telefone ?? r.telefone ?? null,
            nome: r.nome || cli.nome || '',
          };
        });
      }
    } catch (e: any) {
      this.logger.warn(`Enrichment de telefone falhou: ${e?.message}`);
    }

    // ── FORA DA COBRANÇA: ficha que não é pessoa ──
    // A VISANET aparecia aqui com 37 parcelas vencidas e um botão de WhatsApp
    // do lado. Cartão, CONSUMIDOR e VENDA ONLINE são repasse, não dívida de
    // alguém — e cobrar repasse é mandar mensagem pra ninguém.
    //
    // Filtra pelo NOME já enriquecido. Se o enriquecimento falhou, `nome` vem
    // vazio e a linha PASSA: esconder cliente de verdade por falha de leitura
    // é pior do que deixar uma operadora aparecer.
    const antesDoFiltro = rows.length;
    rows = rows.filter((r: any) => !r.nome || !ehFichaNaoPessoa(r.nome));
    const ocultadas = antesDoFiltro - rows.length;
    if (ocultadas > 0) {
      this.logger.log(`[cobranca] ${ocultadas} parcela(s) de ficha não-pessoa fora da lista`);
    }

    // Sumário
    const totalDevido = rows.reduce((sum: number, r: any) => {
      const v = Number(r.valorParcela ?? 0);
      const pago = Number(r.valorPago ?? 0);
      return sum + Math.max(0, v - pago);
    }, 0);
    const clientes = new Set(rows.map((r: any) => String(r.codCliente))).size;

    // columnMap é informativo (debug da tela). Sem tocar no Giga: usa o último
    // mapa detectado (memória → SystemSetting); sem nenhum, devolve vazio.
    const columnMap = this.columnMapCache ?? (await this.readStoredColumnMap()) ?? EMPTY_MAP;

    return {
      columnMap,
      rows,
      summary: {
        totalParcelas: rows.length,
        totalDevido,
        clientes,
      },
      rawSql,
    };
  }

  /**
   * Agrupa por cliente — pra tela inicial de cobrança ("quem deve quanto").
   * Reusa listOverdue e agrupa em memória (mais simples que GROUP BY no SQL).
   */
  async listOverdueByCustomer(opts: {
    storeCode: string;
    daysBack?: number;
    dataInicio?: string;
    dataFim?: string;
  }): Promise<{
    customers: Array<{
      codCliente: string;
      nome: string;
      telefone: string | null;
      parcelasVencidas: number;
      totalDevido: number;
      vencimentoMaisAntigo: string | null;
      vencimentoMaisRecente: string | null;
      diasAtraso: number;
      parcelas: any[];
    }>;
    summary: { totalClientes: number; totalParcelas: number; totalDevido: number };
    columnMap: ColumnMap;
    rawSql: string;
  }> {
    const overdue = await this.listOverdue({ ...opts, limit: 50000 });
    const grouped = new Map<string, any>();

    for (const r of overdue.rows) {
      const key = String(r.codCliente ?? 'sem-codigo');
      if (!grouped.has(key)) {
        grouped.set(key, {
          codCliente: key,
          nome: String(r.nome ?? ''),
          telefone: r.telefone ?? null,
          parcelasVencidas: 0,
          totalDevido: 0,
          vencimentoMaisAntigo: null as string | null,
          vencimentoMaisRecente: null as string | null,
          parcelas: [] as any[],
        });
      }
      const g = grouped.get(key);
      g.parcelasVencidas += 1;
      g.totalDevido += Math.max(0, Number(r.valorParcela ?? 0) - Number(r.valorPago ?? 0));
      const venc = r.vencimento ? String(r.vencimento) : null;
      if (venc) {
        if (!g.vencimentoMaisAntigo || venc < g.vencimentoMaisAntigo) g.vencimentoMaisAntigo = venc;
        if (!g.vencimentoMaisRecente || venc > g.vencimentoMaisRecente) g.vencimentoMaisRecente = venc;
      }
      // Telefone: pega o primeiro não-nulo (movimento já enriqueceu via clientes)
      if (!g.telefone && r.telefone) g.telefone = r.telefone;
      g.parcelas.push(r);
    }

    const today = new Date();
    const customers = Array.from(grouped.values()).map((c) => {
      const oldest = c.vencimentoMaisAntigo ? new Date(c.vencimentoMaisAntigo) : null;
      const dias = oldest ? Math.floor((today.getTime() - oldest.getTime()) / 86400000) : 0;
      return { ...c, diasAtraso: dias };
    });
    customers.sort((a, b) => b.totalDevido - a.totalDevido);

    return {
      customers,
      summary: {
        totalClientes: customers.length,
        totalParcelas: overdue.summary.totalParcelas,
        totalDevido: overdue.summary.totalDevido,
      },
      columnMap: overdue.columnMap,
      rawSql: overdue.rawSql,
    };
  }

  // =========== CAMPANHA WHATSAPP ===========

  /**
   * Monta a fila de mensagens de cobrança a partir das parcelas vencidas.
   * NÃO envia — só prepara. O frontend usa pra preview.
   *
   * Regras:
   *   - Pula clientes sem telefone (não dá pra mandar)
   *   - Pula parcelas com menos de minDiasAtraso (default 3)
   *   - Agrupa todas parcelas do mesmo cliente em UMA mensagem (lista empilhada)
   *   - Rotaciona templates por seq do cliente (anti-ban)
   *   - Aplica testPhone do env COBRANCA_TEST_PHONE — sobrescreve número real
   */
  async buildCampanhaQueue(opts: {
    storeCode: string;
    dataInicio?: string;
    dataFim?: string;
    daysBack?: number;
    minDiasAtraso?: number;
    dayOffset?: number;
  }): Promise<{
    queue: Array<{
      codCliente: string;
      nome: string;
      telefoneOriginal: string | null;
      telefone: string;       // o que vai realmente ser usado (testPhone se ativo)
      diasAtraso: number;
      parcelasVencidas: number;
      totalDevido: number;
      mensagem: string;
      templateIndex: number;
    }>;
    skipped: Array<{ codCliente: string; nome: string; motivo: string }>;
    testMode: boolean;
    testPhone: string | null;
    summary: { totalClientes: number; totalMensagens: number; totalDevido: number };
  }> {
    const minDiasAtraso = Math.max(0, Math.min(365, opts.minDiasAtraso ?? 3));
    const dayOffset = Math.max(0, Math.min(30, opts.dayOffset ?? 0));
    const data = await this.listOverdueByCustomer(opts);
    const cfg = await this.getEditableTemplates();

    const testPhone = (process.env.COBRANCA_TEST_PHONE || '').replace(/\D/g, '') || null;
    const testMode = !!testPhone;

    const queue: Array<any> = [];
    const skipped: Array<{ codCliente: string; nome: string; motivo: string }> = [];

    let seq = 0;
    for (const c of data.customers) {
      // Filtra: só parcelas com diasAtraso >= minDiasAtraso
      // (diasAtraso é do cliente — se a parcela MAIS ANTIGA dele tem >= 3 dias, manda)
      if (c.diasAtraso < minDiasAtraso) {
        skipped.push({ codCliente: c.codCliente, nome: c.nome, motivo: `Atraso < ${minDiasAtraso} dias (${c.diasAtraso}d)` });
        continue;
      }

      const tel = c.telefone ? String(c.telefone).replace(/\D/g, '') : '';
      if (!tel && !testMode) {
        skipped.push({ codCliente: c.codCliente, nome: c.nome, motivo: 'Sem telefone cadastrado' });
        continue;
      }

      // Renderiza mensagem
      const parcelas: ParcelaCobranca[] = c.parcelas.map((p: any) => ({
        vencimento: String(p.vencimento || '').slice(0, 10),
        valor: Math.max(0, Number(p.valorParcela ?? 0) - Number(p.valorPago ?? 0)),
        parcela: p.parcela ? Number(p.parcela) : undefined,
        totalParcelas: p.totalParcelas ? Number(p.totalParcelas) : undefined,
      }));

      const ctx: CobrancaContext = {
        nome: c.nome,
        parcelas,
        lojaNome: cfg.lojaNome,
      };
      const { text, templateIndex } = renderCobranca(ctx, seq, dayOffset, cfg.templates);

      queue.push({
        codCliente: c.codCliente,
        nome: c.nome,
        telefoneOriginal: c.telefone,
        telefone: testMode ? testPhone! : tel,
        diasAtraso: c.diasAtraso,
        parcelasVencidas: c.parcelasVencidas,
        totalDevido: c.totalDevido,
        mensagem: text,
        templateIndex,
      });
      seq++;
    }

    return {
      queue,
      skipped,
      testMode,
      testPhone,
      summary: {
        totalClientes: queue.length,
        totalMensagens: queue.length, // 1 por cliente (parcelas empilhadas)
        totalDevido: queue.reduce((s, q) => s + q.totalDevido, 0),
      },
    };
  }

  /**
   * Dispara a campanha em sequência via WhatsappService.
   * Delay padrão 120000ms (2 min) entre mensagens — anti-ban.
   *
   * Roda SÍNCRONO (await) — o frontend deve mostrar progresso ou usar pollingstatus.
   * Pra campanhas grandes (>50 clientes), roda em background e o frontend
   * faz polling em /crediarios/cobranca/status (não implementado nesta fase).
   */
  async dispararCampanha(opts: {
    storeCode: string;
    dataInicio?: string;
    dataFim?: string;
    daysBack?: number;
    minDiasAtraso?: number;
    dayOffset?: number;
    delayMs?: number;
    dryRun?: boolean; // se true, não envia (só monta queue)
  }): Promise<{
    total: number;
    sent: number;
    failed: Array<{ codCliente: string; nome: string; telefone: string; error: string }>;
    testMode: boolean;
    durationMs: number;
  }> {
    const t0 = Date.now();
    const delayMs = Math.max(60_000, Math.min(600_000, opts.delayMs ?? 120_000));
    const built = await this.buildCampanhaQueue(opts);

    if (opts.dryRun) {
      this.logger.log(`[DRY-RUN] Campanha ${built.queue.length} mensagens (test=${built.testMode})`);
      return { total: built.queue.length, sent: 0, failed: [], testMode: built.testMode, durationMs: Date.now() - t0 };
    }

    // Verifica WhatsApp conectado
    const status = this.wa.getStatus();
    if (!status.connected) {
      throw new Error('WhatsApp desconectado. Conecte primeiro em /retaguarda/whatsapp.');
    }

    const items = built.queue.map((q) => ({
      number: q.telefone,
      text: q.mensagem,
      tag: q.codCliente,
    }));

    this.logger.log(
      `Disparando campanha de cobrança: ${items.length} clientes, delay ${delayMs}ms (test=${built.testMode}, phone=${built.testPhone || 'real'})`,
    );

    const result = await this.wa.sendBulk(items, { delayMs });

    const failed = result.failed.map((f) => {
      const original = built.queue.find((q) => q.codCliente === f.tag);
      return {
        codCliente: f.tag || '',
        nome: original?.nome || '',
        telefone: f.number,
        error: f.error,
      };
    });

    return {
      total: result.total,
      sent: result.sent,
      failed,
      testMode: built.testMode,
      durationMs: Date.now() - t0,
    };
  }

  /**
   * Envia 1 mensagem direto via Baileys (já conectado).
   * Usado pelos botões individuais "WA" da tela — em vez de abrir aba do
   * web.whatsapp.com (que exige login toda vez), reusa a sessão do backend.
   *
   * Aplica o testPhone se a env COBRANCA_TEST_PHONE estiver setada.
   */
  async sendOne(opts: {
    rawNumber: string;
    text: string;
  }): Promise<{ ok: boolean; testMode: boolean; usedNumber: string; error?: string }> {
    const status = this.wa.getStatus();
    if (!status.connected) {
      return { ok: false, testMode: false, usedNumber: '', error: 'WhatsApp desconectado. Conecte primeiro em /retaguarda/whatsapp.' };
    }
    const testPhone = (process.env.COBRANCA_TEST_PHONE || '').replace(/\D/g, '') || null;
    const usedNumber = testPhone || String(opts.rawNumber || '').replace(/\D/g, '');
    if (!usedNumber) {
      return { ok: false, testMode: !!testPhone, usedNumber: '', error: 'Número inválido' };
    }
    const r = await this.wa.sendText(usedNumber, opts.text);
    return { ok: r.ok, testMode: !!testPhone, usedNumber, error: r.error };
  }

  /**
   * Valida em lote se os números têm WhatsApp ativo. Retorna objeto serializável.
   */
  async validateNumbers(rawNumbers: string[]): Promise<{
    results: Record<string, { exists: boolean | null; jid?: string }>;
    summary: { total: number; ativos: number; inativos: number; erros: number };
    connected: boolean;
  }> {
    const status = this.wa.getStatus();
    const map = await this.wa.validateNumbers(rawNumbers || []);
    const results: Record<string, { exists: boolean | null; jid?: string }> = {};
    let ativos = 0, inativos = 0, erros = 0;
    for (const [k, v] of map.entries()) {
      results[k] = v;
      if (v.exists === true) ativos++;
      else if (v.exists === false) inativos++;
      else erros++;
    }
    return {
      results,
      summary: { total: map.size, ativos, inativos, erros },
      connected: status.connected,
    };
  }

  /** Lista os templates renderizados com dados-exemplo — pra preview no admin. */
  async previewTemplates(): Promise<Array<{ index: number; preview: string }>> {
    const cfg = await this.getEditableTemplates();
    const ctx: CobrancaContext = {
      nome: 'Maria Silva',
      lojaNome: cfg.lojaNome,
      parcelas: [
        { vencimento: '2026-04-10', valor: 89.90, parcela: 2, totalParcelas: 4 },
        { vencimento: '2026-04-25', valor: 89.90, parcela: 3, totalParcelas: 4 },
      ],
    };
    return cfg.templates.map((_, i) => {
      const { text } = renderCobranca(ctx, i, 0, cfg.templates);
      return { index: i, preview: text };
    });
  }
}

// ----------- types & helpers -----------

export interface ColumnMap {
  registro: string | null;
  controle: string | null;
  numeroCompra: string | null;
  loja: string | null;
  codCliente: string | null;
  nome: string | null;
  dataCompra: string | null;
  valorCompra: string | null;
  parcela: string | null;
  totalParcelas: string | null;
  vencimento: string | null;
  valorParcela: string | null;
  dataPagamento: string | null;
  valorPago: string | null;
  pago: string | null;
  status: string | null;
  tipo: string | null;
  telefone: string | null;
  obs: string | null;
  juros: string | null;
  multa: string | null;
}

export interface ClientesMap {
  table: string;
  codCliente: string;
  nome: string | null;
  telefone: string | null;
  telefone2: string | null;
  cpf: string | null;       // ← coluna do CPF (varia: CPF, cpf, CPFCGC, CPF_CNPJ…)
  cidade: string | null;    // ← coluna da cidade (CIDADE, cidade, MUNICIPIO…)
  endereco: string | null;
  bairro: string | null;
  cep: string | null;
  // Coluna LOJA (char(2)). O CODIGO de cliente se repete entre lojas —
  // buscas pra crediário DEVEM filtrar (LOJA, CODIGO) juntos.
  loja: string | null;
}

const EMPTY_MAP: ColumnMap = {
  registro: null, controle: null, numeroCompra: null, loja: null,
  codCliente: null, nome: null, dataCompra: null, valorCompra: null,
  parcela: null, totalParcelas: null, vencimento: null, valorParcela: null,
  dataPagamento: null, valorPago: null, pago: null, status: null, tipo: null, telefone: null,
  obs: null, juros: null, multa: null,
};

/**
 * Detecção "saudável" o bastante pra virar cache: as 4 colunas que TODO
 * caminho do crediário exige (crediario-baixa.service e crediario-mirror
 * abortam sem elas). Gate só do cache — o valor RETORNADO por detectColumns
 * continua sendo exatamente o que a detecção produziu, passando ou não aqui.
 */
function isUsableColumnMap(map: ColumnMap | null): map is ColumnMap {
  return !!map && !!map.registro && !!map.codCliente && !!map.vencimento && !!map.valorParcela;
}

function pickColumn(cols: string[], ...patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const found = cols.find((c) => re.test(c));
    if (found) return found;
  }
  return null;
}
