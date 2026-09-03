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
import { CrediarioMirrorService } from './crediario-mirror.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { PagbankService } from '../pagbank/pagbank.service';
import { sqlParcelaAberta } from '../common/crediario-pago';

export interface JurosConfig {
  diasCarencia: number;
  taxaMensalPercent: number;
  enabled: boolean;
  // Multa fixa (%) aplicada uma vez ao entrar em atraso. 0 = sem multa.
  multaPercent: number;
  // Teto de juros como % da parcela (0 = sem teto).
  jurosMaxPercentParcela: number;
  // Política de limite de crédito (default off).
  limiteEnabled: boolean;
  limiteMaxParcelasVencidas: number;
  limiteMaxValorEmAberto: number;
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

/**
 * Nomes de "cliente" que na verdade são cartões/adquirentes/avulso lançados no
 * Giga (não são pessoas com crediário). Filtrados das listagens de parcelas.
 * FONTE ÚNICA (antes estava duplicado em 4 pontos). Ancorado em ^...$ — só casa
 * o nome EXATO, então um cliente real "VISA STORE" NÃO é excluído.
 * Extensível via env CREDIARIO_EXTRA_CARD_NAMES (lista separada por vírgula).
 */
/**
 * Códigos 1–3 eram tratados como RESERVADOS (cartões clássicos/consumidor do
 * Giga) e descartados pelo NÚMERO — até a OZELINA, cliente REAL com código 2,
 * sumir da tela de recebimentos (05/08). Cadastro antigo tem código baixo.
 *
 * Agora código baixo só é descartado quando o NOME é genérico (cartão,
 * consumidor, avulso). Nome de pessoa passa, qualquer que seja o código.
 */
const GENERIC_LOW_CODE_REGEX = /CONSUMIDOR|CLIENTE\s*(PADRAO|PADRÃO|FINAL)|DIVERSOS|VENDA\s*AVULSA/i;
function isPseudoClienteCodigoBaixo(codNum: number, nome: string): boolean {
  if (isNaN(codNum) || codNum > 3) return false;
  return !nome || CARD_NAME_REGEX.test(nome) || GENERIC_LOW_CODE_REGEX.test(nome);
}

const CARD_NAME_REGEX: RegExp = (() => {
  const base = 'VISANET|VISA|MASTER(CARD)?|AMEX|HIPER(CARD)?|REDESHOP|REDE\\s|CREDICARD|CREDI[\\s-]?CARD|ELO|DINERS|CABAL|TICKET|SODEXO|VR\\s|BANRICOMPRAS|GETNET|CIELO|STONE|PAGSEGURO|MERCADO\\s?PAGO|PIC\\s?PAY|AVULSO|BALC[ÃA]O|CART[ÃA]O';
  const extra = String(process.env.CREDIARIO_EXTRA_CARD_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); // escapa regex
  const all = extra.length ? `${base}|${extra.join('|')}` : base;
  return new RegExp(`^(${all})$`, 'i');
})();

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
    private readonly crediarioMirror: CrediarioMirrorService,
    private readonly pagarme: PagarmeService,
    private readonly pagbank: PagbankService,
  ) {}

  /**
   * Gera PIX pra crediario com estrategia 2-providers (PagBank preferido).
   * Retorna sempre o mesmo formato pra nao quebrar o resto do codigo
   * (campos chamam pagarmeOrderId/qrCodeImageUrl por motivos historicos,
   * mas armazenam o ID/dado do gateway que efetivamente gerou).
   *
   * Fluxo:
   *  1. Tenta PagBank usando config da loja (cada loja com seu CNPJ/conta)
   *  2. Se falhar, cai pra Pagar.me como fallback
   *  3. Resposta unificada — campo `provider` marca quem gerou pra rastreio
   */
  private async createPixForCrediario(input: {
    saleId: string;
    valor: number;
    storeCode: string;
    customerName?: string;
    customerCpf?: string;
    customerPhone?: string;
    customerEmail?: string;
    expiresInMinutes?: number;
  }): Promise<{
    provider: 'pagbank' | 'pagarme';
    orderId: string;
    qrCodeText: string;
    qrCodeImageUrl: string;
  }> {
    // Provedor escolhido pela loja (campo Store.pixProvider):
    //   'auto'    = PagBank primeiro, Pagar.me como fallback (padrao)
    //   'pagbank' = so PagBank (sem fallback cross-provider)
    //   'pagarme' = so Pagar.me (sem fallback cross-provider)
    // Se PagBank/Pagar.me falhar num modo forcado, o erro propaga e o caller
    // cai pro PIX local — sem misturar conta de outro provedor.
    let pref: 'auto' | 'pagbank' | 'pagarme' = 'auto';
    try {
      const st = await (this.prisma as any).store.findUnique({
        where: { code: input.storeCode },
        select: { pixProvider: true },
      });
      if (st?.pixProvider === 'pagbank' || st?.pixProvider === 'pagarme') {
        pref = st.pixProvider;
      }
    } catch { /* mantem auto */ }

    const tryPagbank = pref === 'auto' || pref === 'pagbank';
    const tryPagarme = pref === 'auto' || pref === 'pagarme';

    // 1) PagBank (se permitido pela loja)
    if (tryPagbank) {
      try {
        const pb = await this.pagbank.createPixCharge({
          saleId: input.saleId,
          valor: input.valor,
          storeCode: input.storeCode,
          customerName: input.customerName,
          customerCpf: input.customerCpf,
          customerEmail: input.customerEmail,
          expiresInMinutes: input.expiresInMinutes || 15,
        });
        this.logger.log(
          `[crediario-pix] PagBank OK — saleId=${input.saleId} order=${pb.pagbankOrderId} loja=${input.storeCode} (pref=${pref})`,
        );
        return {
          provider: 'pagbank',
          orderId: pb.pagbankOrderId,
          qrCodeText: pb.qrCodeText,
          // PagBank entrega base64; converte pra data URL pro frontend renderizar igual.
          qrCodeImageUrl: pb.qrCodeImageB64
            ? `data:image/png;base64,${pb.qrCodeImageB64}`
            : '',
        };
      } catch (e: any) {
        if (!tryPagarme) throw e; // loja forcou PagBank: sem fallback cross-provider
        this.logger.warn(
          `[crediario-pix] PagBank falhou (${e?.message?.slice(0, 80)}), tentando Pagar.me...`,
        );
      }
    }
    // 2) Pagar.me (fallback do auto, ou provedor forcado da loja)
    const pm = await this.pagarme.createPixCharge({
      saleId: input.saleId,
      valor: input.valor,
      storeCode: input.storeCode,
      customerName: input.customerName,
      customerCpf: input.customerCpf,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      expiresInMinutes: input.expiresInMinutes || 15,
    });
    this.logger.log(
      `[crediario-pix] Pagar.me OK — saleId=${input.saleId} order=${pm.pagarmeOrderId} loja=${input.storeCode} (pref=${pref})`,
    );
    return {
      provider: 'pagarme',
      orderId: pm.pagarmeOrderId,
      qrCodeText: pm.qrCodeText,
      qrCodeImageUrl: pm.qrCodeImageUrl || '',
    };
  }

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
      multaPercent: cfg.multaPercent ?? 0,
      jurosMaxPercentParcela: cfg.jurosMaxPercentParcela ?? 0,
      limiteEnabled: cfg.limiteEnabled ?? false,
      limiteMaxParcelasVencidas: cfg.limiteMaxParcelasVencidas ?? 0,
      limiteMaxValorEmAberto: cfg.limiteMaxValorEmAberto ?? 0,
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
    if (input.multaPercent != null) {
      data.multaPercent = Math.max(0, Math.min(100, Number(input.multaPercent)));
    }
    if (input.jurosMaxPercentParcela != null) {
      data.jurosMaxPercentParcela = Math.max(0, Math.min(1000, Number(input.jurosMaxPercentParcela)));
    }
    if (input.limiteEnabled != null) data.limiteEnabled = !!input.limiteEnabled;
    if (input.limiteMaxParcelasVencidas != null) {
      data.limiteMaxParcelasVencidas = Math.max(0, Math.min(999, Math.floor(Number(input.limiteMaxParcelasVencidas))));
    }
    if (input.limiteMaxValorEmAberto != null) {
      data.limiteMaxValorEmAberto = Math.max(0, Number(input.limiteMaxValorEmAberto));
    }
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

    // FUSO (01/08/2026): usa o dia de BRASÍLIA, não o do servidor.
    //
    // Era `new Date(today.getFullYear(), today.getMonth(), today.getDate())`
    // com `today = new Date()`. O Railway roda em UTC: das 21h à meia-noite,
    // getDate() já devolve o DIA SEGUINTE. Toda parcela ganhava um dia a mais
    // de atraso nessa janela — a cliente pagava juros indevidos, e quem estava
    // no último dia de carência começava a ser cobrada antes da hora.
    //
    // Os dois lados leem com getUTC*: `vencimento` vem de coluna DATE (chega
    // como meia-noite UTC) e `hoje` é deslocado pra Brasília antes. Ler um em
    // fuso local e outro em UTC daria diferença de um dia sozinho.
    const diaDe = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const hojeBrasilia = new Date(today.getTime() - 3 * 60 * 60 * 1000);

    const venc = diaDe(vencimento);
    const t = diaDe(hojeBrasilia);
    const diasAtraso = Math.max(0, Math.floor((t - venc) / oneDay));

    if (!cfg.enabled) return { diasAtraso, juros: 0 };
    if (diasAtraso <= cfg.diasCarencia) return { diasAtraso, juros: 0 };

    const diasComJuros = diasAtraso - cfg.diasCarencia;
    const jurosDia = (cfg.taxaMensalPercent / 30) / 100;
    let juros = valorParcela * jurosDia * diasComJuros;

    // Multa fixa (única) ao entrar em atraso — padrão BR é 2%. 0 = sem multa.
    const multaPct = cfg.multaPercent ?? 0;
    if (multaPct > 0) juros += valorParcela * (multaPct / 100);

    // Teto: juros (incl. multa) não pode passar de X% da parcela. 0 = sem teto.
    const tetoPct = cfg.jurosMaxPercentParcela ?? 0;
    if (tetoPct > 0) {
      const teto = valorParcela * (tetoPct / 100);
      if (juros > teto) juros = teto;
    }

    juros = Math.round(juros * 100) / 100;
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
    // ── ESPELHO PRIMEIRO (02/07) — wincred_movimento_aberto + wincred_clientes.
    // A varredura da tabela movimento no Giga (5.000 linhas / teto 30s) era a
    // query mais pesada do sistema. Se o espelho tem dados, a lista sai do
    // Postgres em ms — e a cobrança funciona com o Giga fora do ar.
    // Fallback: espelho vazio (1ª carga ainda não rodou) ou erro → Giga.
    if (String(process.env.PDV_MIRROR_READS ?? '').trim() !== '0') {
      try {
        const espelho = await this.listAbertasDoEspelho(input.storeCode);
        if (espelho) {
          this.logger.log(
            `[crediario-baixa] listAllOpen via ESPELHO (${espelho.parcelas.length} parcelas)`,
          );
          this.listCache.set(cacheKey, {
            data: espelho,
            expiresAt: Date.now() + this.LIST_CACHE_TTL_MS,
          });
          return espelho;
        }
        this.logger.log('[crediario-baixa] espelho de movimento vazio → Giga ao vivo');
      } catch (e: any) {
        this.logger.warn(`[crediario-baixa] espelho falhou (${e?.message || e}) → Giga ao vivo`);
      }
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
    // Em aberto: regra unica em common/crediario-pago.ts (vale R$ 2,9 mi).
    where.push(sqlParcelaAberta(map.pago, map.dataPagamento));
    // Filtro por loja (opcional)
    if (safeStore && map.loja) {
      where.push(`\`${map.loja}\` = '${safeStore}'`);
    }
    // Exclui null/vazio (cód 0-3 são filtrados depois no JS pra evitar
    // CAST UNSIGNED que pode falhar dependendo do tipo da coluna)
    where.push(`\`${map.codCliente}\` IS NOT NULL`);
    where.push(`\`${map.codCliente}\` <> ''`);
    where.push(`\`${map.codCliente}\` <> '0'`);

    // LEITURA PAGINADA (31/07). Era `LIMIT 5000` com o comentário "5000 cobre
    // uns 800-1500 clientes — suficiente pra Lurd's". Não cobria: a rede tem
    // 72.831 parcelas em aberto, então a tela mostrava as 5.000 mais antigas e
    // escondia o resto sem avisar. Páginas de 10k, ordenadas por REGISTRO
    // (único) — vencimento repete e OFFSET pularia linha.
    const baseSql = `SELECT ${select.join(', ')} FROM \`movimento\` WHERE ${where.join(' AND ')}`;
    this.logger.log(`[crediario-baixa] listAllOpen SQL: ${baseSql.slice(0, 500)}`);
    const t0 = Date.now();
    const leitura = await this.erp.readAllPages(baseSql, {
      orderBy: `\`${map.registro}\``,
      batch: 10_000,
      timeoutMs: 60_000,
    });
    const result = { rows: leitura.rows, truncated: leitura.truncado };
    if (leitura.truncado) {
      this.logger.error(`[crediario-baixa] listAllOpen TRUNCADO no teto — a lista está incompleta`);
    }
    this.logger.log(
      `[crediario-baixa] listAllOpen retornou ${result.rows.length} linhas (${leitura.paginas} página(s)) em ${Date.now() - t0}ms`,
    );

    // Código baixo (0–3) NÃO cai mais pelo número (caso OZELINA cod 2, 05/08):
    // segue no fluxo e é descartado adiante SÓ se o nome na tabela clientes
    // for de cartão/genérico (cardCodes).
    const filteredRows = result.rows.filter((r: any) => {
      const cod = String(r.codCliente || '').replace(/\D/g, '');
      const n = parseInt(cod, 10);
      return !isNaN(n);
    });

    // Enriquece com telefone + filtra clientes-cartão
    const codClientes = Array.from(new Set(filteredRows.map((r: any) => String(r.codCliente))));
    const phones = await this.crediarios.fetchPhonesByClienteIds(codClientes, safeStore || undefined);

    // Filtra cartões pelo nome (escopado por loja quando há filtro)
    const cardRegex = CARD_NAME_REGEX;
    const cardCodes = new Set<string>();
    const cm = await this.crediarios.detectClientesTable();
    if (cm && cm.nome && codClientes.length > 0) {
      const inList = codClientes.map((c) => `'${c.replace(/'/g, '')}'`).join(',');
      const lojaAnd = safeStore && cm.loja ? ` AND \`${cm.loja}\` = '${safeStore}'` : '';
      const sqlCli = `SELECT \`${cm.codCliente}\` AS cod, \`${cm.nome}\` AS nome FROM \`${cm.table}\` WHERE \`${cm.codCliente}\` IN (${inList})${lojaAnd} LIMIT ${codClientes.length + 100}`;
      try {
        const r = await this.erp.runReadOnly(sqlCli, {
          maxRows: codClientes.length + 100,
          timeoutMs: 30000,
        });
        for (const row of r.rows as any[]) {
          const nomeCli = String(row.nome || '').trim();
          const nCli = parseInt(String(row.cod || '').replace(/\D/g, ''), 10);
          if (cardRegex.test(nomeCli) || isPseudoClienteCodigoBaixo(nCli, nomeCli)) {
            cardCodes.add(String(row.cod));
          }
        }
      } catch (e: any) {
        this.logger.warn(`Filtro cartões: ${e?.message}`);
      }
    }

    const response = await this.montarRespostaAbertas(filteredRows, phones, cardCodes);

    // Cacheia 5 min — evita matar o pool com requests repetidas
    this.listCache.set(cacheKey, {
      data: response,
      expiresAt: Date.now() + this.LIST_CACHE_TTL_MS,
    });

    return response;
  }

  /**
   * Cauda COMPARTILHADA entre o caminho Giga e o caminho espelho:
   * calcula juros/multa por parcela e agrupa o resumo por cliente.
   */
  private async montarRespostaAbertas(
    filteredRows: any[],
    phones: Map<string, { nome?: string | null; telefone?: string | null }>,
    cardCodes: Set<string>,
  ): Promise<{ parcelas: OpenInstallment[]; clientes: Array<{ codCliente: string; nome: string; telefone: string | null; qtdParcelas: number; total: number }> }> {
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

    return {
      parcelas: out,
      clientes: Array.from(byCliente.values())
        .sort((a, b) => a.nome.localeCompare(b.nome)),
    };
  }

  /**
   * Lista de parcelas abertas 100% do ESPELHO (Postgres). Retorna null quando
   * o espelho ainda não tem dados (1ª carga pendente) — caller cai pro Giga.
   * Filtros idênticos ao caminho Giga: codCliente > 3 (cartões clássicos) e
   * clientes-cartão pelo nome (CARD_NAME_REGEX, via wincred_clientes).
   */
  private async listAbertasDoEspelho(storeCode?: string): Promise<{
    parcelas: OpenInstallment[];
    clientes: Array<{ codCliente: string; nome: string; telefone: string | null; qtdParcelas: number; total: number }>;
  } | null> {
    const safeStore = storeCode
      ? String(storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
      : null;

    // SEM TETO DE 5.000 (31/07). A ordem é por vencimento CRESCENTE, então o
    // que passava do teto eram as parcelas de vencimento mais DISTANTE — ou
    // seja, as vendas mais RECENTES sumiam da cobrança, caladas.
    //
    // Não era hipótese: 8 lojas passavam de 5.000 (loja 06 com 8.143), somando
    // R$ 826.180,86 invisíveis por loja, e R$ 6,58 milhões na visão da rede.
    // Medido em `scripts/giga-etl/diag-teto-recebimentos.js`.
    //
    // É a mesma família do teto de 50.000 que o espelho carregava e que foi
    // removido hoje — lá o dado não ENTRAVA, aqui ele não SAÍA. O teto que fica
    // é só uma barreira de sanidade, e se for atingido o log grita: truncar em
    // silêncio numa tela de cobrança é pior que demorar.
    const TETO_SANIDADE = 200_000;
    const abertas: any[] = await (this.prisma as any).wincredMovimentoAberto.findMany({
      where: safeStore ? { loja: safeStore } : undefined,
      orderBy: { vencimento: 'asc' },
      take: TETO_SANIDADE,
    });
    if (abertas.length >= TETO_SANIDADE) {
      this.logger.error(
        `[crediario-baixa] lista de abertas bateu o teto de sanidade (${TETO_SANIDADE}) ` +
        `na loja ${safeStore || 'TODAS'} — há dívida FORA da tela. Paginar esta leitura.`,
      );
    }
    // ── UNIÃO ADITIVA (31/07) ──────────────────────────────────────────────
    // Parcela criada no Flow (CrediarioCriacaoService) NÃO é escrita neste
    // espelho de propósito: ele é apagado inteiro a cada 10 minutos e, com a
    // ordenação por vencimento, a parcela nova — de vencimento mais distante —
    // seria a primeira a sumir. Some aqui, na leitura, pra dívida aparecer na
    // cobrança no mesmo instante da venda, sem esperar réplica nem sync.
    //
    // Dedup por `registro`: quando a réplica chegar no Giga e o espelho
    // recarregar, a mesma parcela existe dos dois lados. O Flow ganha, porque é
    // a fonte.
    let nativasAbertas: any[] = [];
    try {
      nativasAbertas = await (this.prisma as any).crediarioParcela.findMany({
        where: {
          flowIsSource: true,
          pago: false,
          cancelado: false,
          ...(safeStore ? { loja: safeStore } : {}),
        },
        orderBy: { vencimento: 'asc' },
      });
    } catch (e: any) {
      // Falhar aqui esconderia dívida recém-criada; o log é o que denuncia.
      this.logger.error(`[crediario-baixa] união com parcelas nativas falhou: ${e?.message}`);
    }

    if (nativasAbertas.length) {
      const jaTem = new Set(abertas.map((r: any) => String(r.registro)));
      for (const p of nativasAbertas) {
        if (jaTem.has(String(p.registro))) continue;
        abertas.push({
          registro: String(p.registro),
          controle: String(p.controle ?? ''),
          numeroCompra: p.numeroCompra ?? null,
          parcela: p.parcela,
          totalParcelas: p.totalParcelas,
          vencimento: p.vencimento,
          valorParcela: p.valorParcela,
          codCliente: p.codCliente,
          nome: p.nomeCliente,
          loja: p.loja,
          obs: p.obs ?? null,
        });
      }
      abertas.sort((a: any, b: any) => {
        const va = a.vencimento ? new Date(a.vencimento).getTime() : 0;
        const vb = b.vencimento ? new Date(b.vencimento).getTime() : 0;
        return va - vb;
      });
    }

    // A checagem de vazio vem DEPOIS da união de propósito: se o espelho ainda
    // não carregou mas já existe parcela criada no Flow, ela tem que aparecer.
    // Antes esta guarda ficava logo após a leitura do espelho e devolvia null
    // (recuo pro Giga) mesmo havendo dívida nativa pra mostrar.
    if (!abertas.length) {
      // Espelho vazio pode ser 1ª carga pendente OU realmente não haver
      // parcelas. Distingue: se a tabela inteira está vazia → null (fallback).
      const totalEspelho = await (this.prisma as any).wincredMovimentoAberto.count();
      if (totalEspelho === 0) return null;
      return { parcelas: [], clientes: [] };
    }

    // Código baixo (0–3) só cai quando o NOME é genérico — cliente real com
    // cadastro antigo tem código baixo e as PARCELAS dela sumiam daqui
    // (caso OZELINA cod 2, 05/08).
    const filteredRows = abertas
      .filter((r) => {
        const cod = String(r.codCliente || '').replace(/\D/g, '');
        const n = parseInt(cod, 10);
        if (isNaN(n)) return false;
        return !isPseudoClienteCodigoBaixo(n, String(r.nome || '').trim());
      })
      .map((r) => ({
        registro: r.registro,
        controle: r.controle,
        numeroCompra: r.numeroCompra,
        parcela: r.parcela,
        totalParcelas: r.totalParcelas,
        vencimento: r.vencimento,
        valorParcela: r.valorParcela != null ? Number(r.valorParcela) : 0,
        codCliente: r.codCliente,
        nome: r.nome,
        obs: r.obs ? String(r.obs).trim() : null,
      }));

    // Nome + telefone + filtro de clientes-cartão via espelho de clientes.
    // Filtra por LOJA quando há escopo — o mesmo cod em outra loja é OUTRA
    // pessoa (nome/telefone errados sem o filtro).
    const codClientes = Array.from(new Set(filteredRows.map((r) => String(r.codCliente))));
    const clientesEspelho: any[] = codClientes.length
      ? await (this.prisma as any).wincredCliente.findMany({
          where: {
            codCliente: { in: codClientes },
            ...(safeStore ? { loja: safeStore } : {}),
          },
        })
      : [];
    const phones = new Map<string, { nome?: string | null; telefone?: string | null }>();
    const cardCodes = new Set<string>();
    for (const c of clientesEspelho) {
      const cod = String(c.codCliente);
      phones.set(cod, { nome: c.nome || null, telefone: c.telefone || c.telefone2 || null });
      if (CARD_NAME_REGEX.test(String(c.nome || '').trim())) cardCodes.add(cod);
    }

    // Cliente NOVO de crediário (ficha criada no Flow depois que o espelho
    // de clientes congelou junto com o Giga, 27/08): completa nome/telefone
    // pela ficha nativa. Sem isto ele entra na cobrança sem telefone.
    const semTelefone = codClientes.filter((cod) => !phones.get(cod)?.telefone);
    if (semTelefone.length) {
      const fichas: any[] = await (this.prisma as any).gigaCliente
        .findMany({
          where: { codigo: { in: semTelefone }, ...(safeStore ? { loja: safeStore } : {}) },
        })
        .catch(() => []);
      for (const f of fichas) {
        const cod = String(f.codigo);
        const atual: any = phones.get(cod) || {};
        phones.set(cod, {
          nome: atual.nome || f.nome || null,
          telefone: atual.telefone || f.foneCel || f.foneRes || f.foneRec || null,
        });
        if (CARD_NAME_REGEX.test(String(f.nome || '').trim())) cardCodes.add(cod);
      }
    }

    return this.montarRespostaAbertas(filteredRows, phones, cardCodes);
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

  // Cache POR LOJA ('all' = sem filtro): cada loja tem sua base de clientes
  // e seu crediário — a lista da loja 05 não pode servir a loja 01.
  private clientesCache = new Map<string, { data: any[]; expiresAt: number }>();
  private readonly CLIENTES_CACHE_TTL_MS = 30 * 60 * 1000;

  // Lock anti-stampede POR LOJA: se múltiplas vendedoras abrem RECEBIMENTOS ao
  // mesmo tempo (cache vazio), só 1 query roda — as demais aguardam o resultado.
  private clientesPromise = new Map<string, Promise<Array<{ codCliente: string; nome: string; telefone: string | null; loja: string | null }>>>();

  // Circuit breaker: se Giga falhar 3x seguidas, bloqueia por 5min
  // (evita rebloquear o IP por excesso de erros).
  private breakerFailCount = 0;
  private breakerOpenUntil = 0;

  async listAllClientesGiga(storeCode?: string): Promise<Array<{
    codCliente: string;
    nome: string;
    telefone: string | null;
    loja: string | null;
  }>> {
    const safeStore = storeCode
      ? String(storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
      : null;
    const cacheKey = safeStore || 'all';

    const cached = this.clientesCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    // ── ESPELHO PRIMEIRO (02/07) — wincred_clientes. Mesmos filtros do
    // caminho Giga (cod > 3, sem clientes-cartão, dedup loja+cod+nome).
    // Espelho vazio (1ª carga pendente) OU só linhas legadas sem loja
    // (pré-migração da chave composta) → segue pro Giga normalmente.
    if (String(process.env.PDV_MIRROR_READS ?? '').trim() !== '0') {
      try {
        // Linhas legadas (loja='00') não servem pra filtro por loja — se o
        // espelho ainda não foi re-carregado com loja, cai pro Giga ao vivo.
        const espelhoMigrado = safeStore
          ? (await (this.prisma as any).wincredCliente.count({ where: { loja: { not: '00' } }, take: 1 }).catch(() => 0)) > 0
          : true;
        const doEspelho: any[] = espelhoMigrado
          ? await (this.prisma as any).wincredCliente.findMany({
              where: { nome: { not: null }, ...(safeStore ? { loja: safeStore } : {}) },
              orderBy: { nome: 'asc' },
            })
          : [];
        if (doEspelho.length > 0) {
          const seen = new Set<string>();
          const out: Array<{ codCliente: string; nome: string; telefone: string | null; loja: string | null }> = [];
          for (const c of doEspelho) {
            const cod = String(c.codCliente || '').trim();
            const codNum = parseInt(cod.replace(/\D/g, ''), 10);
            if (!cod || isNaN(codNum)) continue;
            const nome = String(c.nome || '').trim();
            if (!nome || CARD_NAME_REGEX.test(nome)) continue;
            // Código baixo só cai se o nome for genérico (caso OZELINA cod 2)
            if (isPseudoClienteCodigoBaixo(codNum, nome)) continue;
            const lojaCli = String(c.loja || '').trim() || null;
            const dedupKey = `${lojaCli || ''}|${cod}|${nome.toUpperCase()}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            out.push({
              codCliente: cod,
              nome,
              telefone: (String(c.telefone || '').trim()) || (String(c.telefone2 || '').trim()) || null,
              loja: lojaCli === '00' ? null : lojaCli,
            });
          }
          // Fichas criadas NO FLOW depois do congelamento do espelho (27/08):
          // sem isto o cliente novo nem aparece na lista de cobrança.
          const novas: any[] = await (this.prisma as any).gigaCliente
            .findMany({ where: { flowIsSource: true, nome: { not: null } } })
            .catch(() => []);
          for (const f of novas) {
            const cod = String(f.codigo || '').trim();
            const nome = String(f.nome || '').trim();
            if (!cod || !nome || CARD_NAME_REGEX.test(nome)) continue;
            const lojaCli = String(f.loja || '').trim() || null;
            const dedupKey = `${lojaCli || ''}|${cod}|${nome.toUpperCase()}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            out.push({
              codCliente: cod,
              nome,
              telefone: f.foneCel || f.foneRes || f.foneRec || null,
              loja: lojaCli === '00' ? null : lojaCli,
            });
          }
          this.logger.log(`[crediario-baixa] listAllClientes via ESPELHO (${out.length} clientes, loja=${cacheKey})`);
          this.clientesCache.set(cacheKey, { data: out, expiresAt: Date.now() + this.CLIENTES_CACHE_TTL_MS });
          return out;
        }
      } catch (e: any) {
        this.logger.warn(`[crediario-baixa] espelho de clientes falhou (${e?.message || e}) → Giga`);
      }
    }

    // Circuit breaker aberto?
    if (Date.now() < this.breakerOpenUntil) {
      throw new BadRequestException(
        `Giga temporariamente indisponível. Tente em ${Math.ceil((this.breakerOpenUntil - Date.now()) / 1000)}s.`,
      );
    }

    // Já tem outra request rodando pra essa loja? Espera ela.
    const inflight = this.clientesPromise.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    // Encadeia: cria a promise UNA por loja, chamadas concorrentes pegam a mesma
    const p = this._doListAllClientesGiga(safeStore)
      .then((data) => {
        this.breakerFailCount = 0;
        this.clientesPromise.delete(cacheKey);
        return data;
      })
      .catch((err) => {
        this.breakerFailCount++;
        this.clientesPromise.delete(cacheKey);
        if (this.breakerFailCount >= 3) {
          this.breakerOpenUntil = Date.now() + 5 * 60 * 1000;
          this.logger.error(`[crediario-baixa] CIRCUIT BREAKER aberto por 5min — ${this.breakerFailCount} falhas seguidas`);
        }
        throw err;
      });
    this.clientesPromise.set(cacheKey, p);

    return p;
  }

  private async _doListAllClientesGiga(safeStore: string | null): Promise<Array<{ codCliente: string; nome: string; telefone: string | null; loja: string | null }>> {

    const cm = await this.crediarios.detectClientesTable();
    if (!cm || !cm.nome) {
      throw new BadRequestException(
        'Tabela de clientes do Giga não detectada',
      );
    }

    const cols: string[] = [`\`${cm.codCliente}\` AS cod`, `\`${cm.nome}\` AS nome`];
    if (cm.telefone) cols.push(`\`${cm.telefone}\` AS tel`);
    if (cm.telefone2) cols.push(`\`${cm.telefone2}\` AS tel2`);
    if (cm.loja) cols.push(`\`${cm.loja}\` AS loja`);

    // Filtro por LOJA — cada loja tem sua base de clientes e seu crediário.
    const whereLoja = safeStore && cm.loja ? ` AND \`${cm.loja}\` = '${safeStore}'` : '';

    // Paginado (31/07). Era `LIMIT 15000` — hoje são 7.701 clientes, então
    // ainda não cortava; mas era o mesmo teto silencioso que comeu 22 mil
    // parcelas do crediário. Cliente que some é venda que não acontece.
    const baseSql = `SELECT ${cols.join(', ')} FROM \`${cm.table}\` WHERE \`${cm.nome}\` IS NOT NULL AND \`${cm.nome}\` <> ''${whereLoja}`;
    this.logger.log(`[crediario-baixa] listAllClientes SQL: ${baseSql.slice(0, 300)}`);
    const t0 = Date.now();
    const leituraCli = await this.erp.readAllPages(baseSql, {
      orderBy: `\`${cm.codCliente}\``,
      batch: 10_000,
      timeoutMs: 30_000,
    });
    const result = { rows: leituraCli.rows };
    if (leituraCli.truncado) this.logger.error('[crediario-baixa] listAllClientes TRUNCADO no teto');
    this.logger.log(`[crediario-baixa] listAllClientes retornou ${result.rows.length} em ${Date.now() - t0}ms`);

    const cardRegex = CARD_NAME_REGEX;

    // DEDUP por LOJA+COD+NOME — o mesmo COD em lojas diferentes é OUTRA pessoa;
    // e múltiplos registros com mesmo cod na MESMA loja (legado, troca de nome)
    // são preservados pelo nome.
    const seen = new Set<string>();
    const out: Array<{ codCliente: string; nome: string; telefone: string | null; loja: string | null }> = [];
    let descartadosCod = 0, descartadosCodInvalido = 0, descartadosNome = 0, descartadosCartao = 0, descartadosDup = 0;
    for (const row of result.rows as any[]) {
      const cod = String(row.cod || '').trim();
      if (!cod) { descartadosCod++; continue; }
      const codNum = parseInt(cod.replace(/\D/g, ''), 10);
      if (isNaN(codNum)) { descartadosCodInvalido++; continue; }
      const nome = String(row.nome || '').trim();
      if (!nome) { descartadosNome++; continue; }
      if (cardRegex.test(nome)) { descartadosCartao++; continue; }
      // Código baixo só cai se o nome for genérico (caso OZELINA cod 2)
      if (isPseudoClienteCodigoBaixo(codNum, nome)) { descartadosCodInvalido++; continue; }
      const lojaCli = row.loja != null ? String(row.loja).trim() : null;
      const dedupKey = `${lojaCli || ''}|${cod}|${nome.toUpperCase()}`;
      if (seen.has(dedupKey)) { descartadosDup++; continue; }
      const tel = (String(row.tel || '').trim()) || (String(row.tel2 || '').trim()) || null;
      seen.add(dedupKey);
      out.push({ codCliente: cod, nome, telefone: tel, loja: lojaCli });
    }
    this.logger.log(`[crediario-baixa] após filtros: ${out.length} clientes únicos (de ${result.rows.length} linhas, loja=${safeStore || 'todas'}) | descartados: cod=${descartadosCod} codInvalido=${descartadosCodInvalido} nome=${descartadosNome} cartao=${descartadosCartao} dup=${descartadosDup}`);

    this.clientesCache.set(safeStore || 'all', {
      data: out,
      expiresAt: Date.now() + this.CLIENTES_CACHE_TTL_MS,
    });
    return out;
  }

  /** Limpa cache (chamado após cada baixa) */
  clearClientesCache() {
    this.clientesCache.clear();
  }

  // ── Autocomplete: busca rápida de clientes ────────────────────────

  /**
   * Busca rápida na tabela `clientes` do Giga — só nomes/códigos.
   * Usado pelo autocomplete do frontend. Não retorna parcelas.
   *
   * Filtra clientes-cartão (VISANET, MASTERCARD, etc) e cód <= 3.
   */
  async searchClientes(input: { q: string; storeCode?: string }): Promise<Array<{
    codCliente: string;
    nome: string;
    telefone: string | null;
  }>> {
    const q = String(input.q || '').trim();
    if (q.length < 2) return [];

    // ── ESPELHO PRIMEIRO (wincred_clientes). Só quando populado. ──
    if (this.nativeReads && (await (this.prisma as any).wincredCliente.count()) > 0) {
      const safeQ = q.replace(/['"\\;]/g, '').slice(0, 100);
      const onlyDigits = /^\d+$/.test(safeQ);
      const safeStoreS = input.storeCode
        ? String(input.storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
        : null;
      const rows: any[] = await (this.prisma as any).wincredCliente.findMany({
        where: {
          ...(onlyDigits ? { codCliente: { in: this.codVariants(safeQ) } } : { nome: { contains: safeQ, mode: 'insensitive' } }),
          ...(safeStoreS ? { loja: safeStoreS } : {}),
        },
        orderBy: { nome: 'asc' },
        take: 60,
      });
      const outS: Array<{ codCliente: string; nome: string; telefone: string | null }> = [];
      for (const c of rows) {
        const cod = String(c.codCliente || '');
        const n = parseInt(cod.replace(/\D/g, ''), 10);
        if (isNaN(n)) continue;
        const nome = String(c.nome || '').trim();
        if (CARD_NAME_REGEX.test(nome)) continue;
        // Código baixo só cai se o nome for genérico (caso OZELINA cod 2)
        if (isPseudoClienteCodigoBaixo(n, nome)) continue;
        const tel = String(c.telefone || '').trim() || String(c.telefone2 || '').trim() || null;
        outS.push({ codCliente: cod, nome, telefone: tel });
        if (outS.length >= 30) break;
      }
      // REDE DE SEGURANÇA: nada no espelho → cai pro Giga (não retorna vazio à toa).
      if (outS.length > 0) return outS;
    }

    const cm = await this.crediarios.detectClientesTable();
    if (!cm || !cm.nome) {
      throw new BadRequestException(
        'Tabela de clientes do Giga não detectada — não dá pra buscar por nome.',
      );
    }

    const safe = q.replace(/['"\\;]/g, '').slice(0, 100);
    const onlyDigits = /^\d+$/.test(safe);
    const safeStore = input.storeCode
      ? String(input.storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
      : null;

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
    // Escopo por loja — cada loja tem sua base (mesmo cod = outra pessoa)
    if (safeStore && cm.loja) {
      where += ` AND \`${cm.loja}\` = '${safeStore}'`;
    }

    const sql = `SELECT ${cols.join(', ')} FROM \`${cm.table}\` WHERE ${where} ORDER BY \`${cm.nome}\` ASC LIMIT 30`;
    const r = await this.erp.runReadOnly(sql, { maxRows: 30, timeoutMs: 8000 });

    // Regex pra excluir clientes-cartão
    const cardRegex = CARD_NAME_REGEX;

    const out: Array<{ codCliente: string; nome: string; telefone: string | null }> = [];
    for (const row of r.rows as any[]) {
      const cod = String(row.cod || '');
      const n = parseInt(cod.replace(/\D/g, ''), 10);
      if (isNaN(n)) continue;
      const nome = String(row.nome || '').trim();
      if (cardRegex.test(nome)) continue;
      // Código baixo só cai se o nome for genérico (caso OZELINA cod 2)
      if (isPseudoClienteCodigoBaixo(n, nome)) continue;
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

    const safeStoreN = input.storeCode
      ? String(input.storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
      : null;

    // ── SÓ ESPELHO (03/09 — Giga morto). `wincred_movimento_aberto` é cópia
    // da tabela nativa (ciclo de 10min + write-through da baixa): presente =
    // em aberto AGORA. Miss = cliente sem parcela aberta ([]). O antigo
    // "cai pro Giga por segurança" caía num pool morto e travava a tela.
    const rows: any[] = await (this.prisma as any).wincredMovimentoAberto.findMany({
      where: { codCliente: { in: this.codVariants(cod) }, ...(safeStoreN ? { loja: safeStoreN } : {}) },
      orderBy: { vencimento: 'asc' },
      take: 500,
    });

    // União aditiva (mesma régua do listAbertasDoEspelho): parcela criada NO
    // FLOW há menos de 10min ainda não caiu no espelho — soma aqui, dedup por
    // registro, pra dívida recém-vendida aparecer na hora.
    const nativas: any[] = await (this.prisma as any).crediarioParcela.findMany({
      where: {
        flowIsSource: true,
        pago: false,
        cancelado: false,
        codCliente: { in: this.codVariants(cod) },
        ...(safeStoreN ? { loja: safeStoreN } : {}),
      },
      orderBy: { vencimento: 'asc' },
    });
    if (nativas.length) {
      const jaTem = new Set(rows.map((r: any) => String(r.registro)));
      for (const p of nativas) {
        if (jaTem.has(String(p.registro))) continue;
        rows.push({
          registro: String(p.registro),
          controle: String(p.controle ?? ''),
          numeroCompra: p.numeroCompra ?? null,
          parcela: p.parcela,
          totalParcelas: p.totalParcelas,
          vencimento: p.vencimento,
          valorParcela: p.valorParcela,
          codCliente: p.codCliente,
          nome: p.nomeCliente,
          obs: p.obs ?? null,
        });
      }
      rows.sort((a: any, b: any) => {
        const va = a.vencimento ? new Date(a.vencimento).getTime() : 0;
        const vb = b.vencimento ? new Date(b.vencimento).getTime() : 0;
        return va - vb;
      });
    }
    if (!rows.length) return [];

    const phonesN = await this.crediarios.fetchPhonesByClienteIds([cod], safeStoreN || undefined);
    const phoneInfoN = phonesN.get(cod) || null;
    const cfgN = await this.getConfig();
    const outN: OpenInstallment[] = [];
    for (const row of rows) {
      const valor = Number(row.valorParcela || 0);
      if (!row.vencimento || !valor) continue;
      const venc = new Date(row.vencimento);
      const { diasAtraso, juros } = this.calcJuros(venc, valor, cfgN);
      outN.push({
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
        nome: row.nome ? String(row.nome) : phoneInfoN?.nome || null,
        telefone: phoneInfoN?.telefone || null,
        obs: row.obs ? String(row.obs).trim() : null,
      });
    }
    return outN;
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

    // ── SÓ ESPELHO (03/09 — o Giga morreu; o caminho ao vivo foi deletado) ──
    // Resolve o cliente no espelho de fichas (`giga_clientes`) e filtra a
    // MESMA lista de abertas do espelho que a tela Recebimentos usa
    // (`listAbertasDoEspelho` = wincred_movimento_aberto + parcelas nativas do
    // Flow, com todas as réguas de pseudo-cliente/cartão). Cliente sem ficha
    // ou espelho sem parcela = lista vazia; erro de banco SOBE — nada de catch
    // calado mostrando "sem dívida" pra quem deve.
    const onlyDigitsM = /^\d+$/.test(busca);
    const safeBuscaM = busca.replace(/['"\\]/g, '').slice(0, 100);
    const safeStoreM = input.storeCode
      ? String(input.storeCode).replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2)
      : null;
    const strip = (s: any) => String(s ?? '').trim().replace(/^0+/, '') || String(s ?? '').trim();

    const cods = new Set<string>();
    if (onlyDigitsM) {
      cods.add(strip(safeBuscaM));
      const cpfDigits = safeBuscaM.replace(/\D/g, '');
      const cpfFmt = cpfDigits.length === 11
        ? `${cpfDigits.slice(0, 3)}.${cpfDigits.slice(3, 6)}.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9)}`
        : null;
      const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
        where: {
          ...(safeStoreM ? { loja: safeStoreM } : {}),
          OR: [
            { codigo: safeBuscaM },
            { codigo: strip(safeBuscaM) },
            ...(cpfFmt ? [{ cpf: { in: [cpfDigits, cpfFmt] } }] : []),
          ],
        },
        select: { codigo: true },
        take: 50,
      });
      for (const f of fichas) cods.add(strip(f.codigo));
    } else {
      const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
        where: {
          ...(safeStoreM ? { loja: safeStoreM } : {}),
          nome: { contains: safeBuscaM, mode: 'insensitive' },
        },
        select: { codigo: true },
        take: 50,
      });
      for (const f of fichas) cods.add(strip(f.codigo));
    }

    // Sem ficha que case a busca = dado ausente legítimo, lista vazia.
    if (!cods.size) return [];
    const lista = await this.listAbertasDoEspelho(input.storeCode);
    // Espelho vazio (1ª carga pendente) — sem parcela aberta pra mostrar.
    if (!lista) return [];
    return lista.parcelas.filter((p: any) => cods.has(strip(p.codCliente)));
  }
  // ── Preview ────────────────────────────────────────────────────────

  /** Leituras do crediário pelo Postgres (nativo/espelho) em vez do Giga ao vivo.
   *  DEFAULT LIGADO desde 03/09/2026. Era off desde o incidente de 25/07
   *  ("crediários sumiram do PDV") — fazia sentido enquanto existia um Giga
   *  pra onde voltar. Ele morreu em 27/08: com a env ausente o código caía no
   *  ramo legado e a parcela paga continuava aberta SEM ERRO, que é o mesmo
   *  sumiço de 25/07 pela porta oposta. Produção roda =1; o default agora
   *  concorda com ela. `CREDIARIO_NATIVE_READS=0` ainda força o ramo antigo. */
  private get nativeReads(): boolean {
    return String(process.env.CREDIARIO_NATIVE_READS ?? '1') === '1';
  }

  /** Variantes do codCliente pra casar o espelho (padding de zeros varia entre
   *  as tabelas do Giga — clientes vs movimento). */
  private codVariants(cod: string): string[] {
    const c = String(cod || '').trim();
    const set = new Set<string>();
    if (c) set.add(c);
    const noZeros = c.replace(/^0+/, '');
    if (noZeros) set.add(noZeros);
    if (/^\d+$/.test(c)) set.add(String(Number(c)));
    return Array.from(set);
  }

  /** Escrita da baixa/estorno no Giga via erp_outbox (assíncrona) em vez de
   *  inline. DEFAULT LIGADO desde 03/09/2026: o recibo (crediarioBaixa) é a
   *  fonte e o espelho de abertas tem write-through, então o outbox só teria
   *  a réplica pro Giga — que hoje o cron descarta com motivo. Com a env
   *  ausente o caminho voltava a ser INLINE no MySQL morto, ou seja, a
   *  vendedora esperando um servidor que não responde pra dar baixa que já
   *  estava gravada. `CREDIARIO_ERP_OUTBOX=0` ainda força o inline. */
  private get crediarioOutboxEnabled(): boolean {
    return String(process.env.CREDIARIO_ERP_OUTBOX ?? '1') === '1';
  }

  /** Lê 1 parcela ABERTA do espelho (wincred_movimento_aberto) por REGISTRO+
   *  CONTROLE. Esse espelho tem write-through na baixa (marcarPagasNoEspelho):
   *  parcela paga SOME dele na hora — logo "presente = em aberto AGORA", sem
   *  risco de baixa dupla. Ausente (paga ou não-sincronizada) → undefined, e o
   *  caller confere no Giga (autoridade sobre PAGO). */
  private async previewParcelaEspelho(
    registro: string,
    controle: string,
    cfg: JurosConfig,
  ): Promise<OpenInstallment | undefined> {
    const row: any = await (this.prisma as any).wincredMovimentoAberto.findFirst({
      where: { registro: String(registro), controle: String(controle) },
    });
    if (!row) return undefined;
    const valor = Number(row.valorParcela || 0);
    const venc = new Date(row.vencimento);
    const { diasAtraso, juros } = this.calcJuros(venc, valor, cfg);
    return {
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
    };
  }

  async previewBaixa(input: {
    parcelas: Array<{ registro: string; controle: string }>;
    storeCode?: string;
  }): Promise<{
    parcelas: OpenInstallment[];
    totalPrincipal: number;
    totalJuros: number;
    totalPago: number;
  }> {
    if (!input.parcelas?.length) throw new BadRequestException('Selecione pelo menos 1 parcela');

    const cfg = await this.getConfig();

    // ── SÓ ESPELHO (03/09 — Giga morto). Presente em wincred_movimento_aberto
    // = em aberto AGORA (o write-through da baixa remove na hora — sem risco de
    // baixa dupla). Fora do espelho, confere a tabela nativa (parcela criada no
    // Flow há <10min ainda não caiu no ciclo) e só então nega, com erro honesto
    // — a conferência no Giga foi deletada junto com o pool.
    const result: OpenInstallment[] = [];
    for (const p of input.parcelas) {
      const nat = await this.previewParcelaEspelho(p.registro, p.controle, cfg);
      if (nat) { result.push(nat); continue; }
      const nativa: any = await (this.prisma as any).crediarioParcela.findFirst({
        where: {
          registro: String(p.registro),
          controle: String(p.controle),
          pago: false,
          cancelado: false,
        },
      });
      if (!nativa) {
        throw new BadRequestException(
          'Parcela não encontrada — já foi paga ou não existe. Atualize a lista.',
        );
      }
      const valor = Number(nativa.valorParcela || 0);
      const venc = new Date(nativa.vencimento);
      const { diasAtraso, juros } = this.calcJuros(venc, valor, cfg);
      result.push({
        registro: String(nativa.registro),
        controle: String(nativa.controle ?? ''),
        numeroCompra: nativa.numeroCompra ? String(nativa.numeroCompra) : null,
        parcela: nativa.parcela != null ? Number(nativa.parcela) : null,
        totalParcelas: nativa.totalParcelas != null ? Number(nativa.totalParcelas) : null,
        vencimento: venc.toISOString().slice(0, 10),
        valorParcela: valor,
        diasAtraso,
        jurosCalculado: juros,
        valorComJuros: Math.round((valor + juros) * 100) / 100,
        codCliente: String(nativa.codCliente ?? ''),
        nome: nativa.nomeCliente ? String(nativa.nomeCliente) : null,
        telefone: null,
        obs: nativa.obs ? String(nativa.obs).trim() : null,
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
    /** Origem do PIX — 'presencial' (QR loja) ou 'link' (WhatsApp remoto).
     *  Define se mostra alerta global na tela quando pago. */
    origem?: 'presencial' | 'link';
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
      origem: input.origem || 'presencial',
    });

    // Gera PIX (PagBank preferido, Pagar.me fallback) — saleId=baixaId
    const pix = await this.createPixForCrediario({
      saleId: baixaId,
      valor: preview.totalPago,
      storeCode: input.lojaCode,
      customerName: input.customerName || preview.parcelas[0]?.nome || 'Consumidor Final',
      customerCpf: input.customerCpf,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      expiresInMinutes: input.expiresInMinutes || 15,
    });

    // Vincula o orderId (PagBank ou Pagar.me) ao header da baixa.
    // Campo se chama pagarmeOrderId por motivos historicos — agora pode
    // armazenar ID do PagBank tambem (provider marcado em log).
    await (this.prisma as any).crediarioBaixa.update({
      where: { id: baixaId },
      data: { pagarmeOrderId: pix.orderId },
    });

    return {
      baixaId,
      pagarmeOrderId: pix.orderId,
      qrCodeText: pix.qrCodeText,
      qrCodeImageUrl: pix.qrCodeImageUrl,
      valor: preview.totalPago,
    };
  }

  // ── Aplicar baixa SPLIT (parte dinheiro + parte PIX) ─────────────────
  // Cliente paga UMA parte na hora em dinheiro e o resto via QR PIX.
  // Fluxo:
  //   1. Recebe valorDinheiro + valorPix (soma === totalPago)
  //   2. Cria baixa com formaPagamento='misto' status='pending'
  //      (parcelas ainda em aberto no Wincred ate o PIX confirmar)
  //   3. Gera QR Pagar.me APENAS pelo valorPix
  //   4. Cliente paga → polling/webhook confirma → marca parcelas pagas
  //
  // Se o PIX nao for pago dentro da validade (15min), a baixa fica
  // pending/expired. Vendedora pode estornar e cobrar so o dinheiro
  // como pagamento parcial avulso.
  async createPendingBaixaSplit(input: {
    parcelas: Array<{ registro: string; controle: string }>;
    valorDinheiro: number;
    valorPix: number;
    lojaCode: string;
    lojaName?: string;
    userId?: string;
    userName?: string;
    customerName?: string;
    customerCpf?: string;
    customerPhone?: string;
    customerEmail?: string;
    expiresInMinutes?: number;
  }): Promise<{
    baixaId: string;
    pagarmeOrderId: string;
    qrCodeText: string;
    qrCodeImageUrl: string;
    valor: number;
    valorDinheiro: number;
    valorPix: number;
  }> {
    const preview = await this.previewBaixa({ parcelas: input.parcelas });
    const valorDinheiro = Math.round((Number(input.valorDinheiro) || 0) * 100) / 100;
    const valorPix = Math.round((Number(input.valorPix) || 0) * 100) / 100;
    if (valorDinheiro <= 0 || valorPix <= 0) {
      throw new BadRequestException(
        'Split exige valores > 0 em dinheiro E em PIX. Pra forma unica use /dinheiro ou /pix.',
      );
    }
    const soma = Math.round((valorDinheiro + valorPix) * 100) / 100;
    if (Math.abs(soma - preview.totalPago) > 0.02) {
      throw new BadRequestException(
        `Soma dinheiro+PIX (${soma}) nao bate com total das parcelas (${preview.totalPago}).`,
      );
    }

    const baixaId = await this.persistBaixa({
      preview,
      formaPagamento: 'misto',
      status: 'pending',
      paidAt: null,
      lojaCode: input.lojaCode,
      lojaName: input.lojaName,
      userId: input.userId,
      userName: input.userName,
      customerName: input.customerName,
      customerCpf: input.customerCpf,
      customerPhone: input.customerPhone,
      valorDinheiro,
      valorPix,
    });

    const pix = await this.createPixForCrediario({
      saleId: baixaId,
      valor: valorPix,
      storeCode: input.lojaCode,
      customerName: input.customerName || preview.parcelas[0]?.nome || 'Consumidor Final',
      customerCpf: input.customerCpf,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      expiresInMinutes: input.expiresInMinutes || 15,
    });

    await (this.prisma as any).crediarioBaixa.update({
      where: { id: baixaId },
      data: { pagarmeOrderId: pix.orderId },
    });

    return {
      baixaId,
      pagarmeOrderId: pix.orderId,
      qrCodeText: pix.qrCodeText,
      qrCodeImageUrl: pix.qrCodeImageUrl,
      valor: valorPix,
      valorDinheiro,
      valorPix,
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
    if (!baixa) throw new NotFoundException('Baixa nao encontrada');
    if (baixa.status === 'paid') return { confirmed: false };

    // FIX CRITICO (jun/2026): suporta PagBank E Pagar.me.
    // Antes so funcionava com Pagar.me — se baixa veio do PagBank,
    // dava exception e baixa ficava em pending eternamente.
    let isPaid = false;
    try {
      const pb = await (this.prisma as any).pagbankPayment.findFirst({
        where: { saleId: baixaId },
        orderBy: { createdAt: 'desc' },
      });
      if (pb) {
        if (pb.status === 'paid') {
          isPaid = true;
        } else if (pb.pagbankOrderId) {
          const live = await (this.pagbank as any).checkOrderStatus?.(pb.pagbankOrderId);
          if (live?.isPaid || live?.status === 'paid') {
            isPaid = true;
            try {
              await (this.prisma as any).pagbankPayment.update({
                where: { id: pb.id },
                data: { status: 'paid', paidAt: new Date() },
              });
            } catch {/* nao bloqueia */}
          }
        }
      }
    } catch (e: any) {
      this.logger.warn('[confirmBaixaPix] PagBank check falhou: ' + e?.message);
    }
    if (!isPaid && baixa.pagarmeOrderId) {
      try {
        const live = await this.pagarme.checkOrderStatus(baixa.pagarmeOrderId);
        if (live.isPaid) isPaid = true;
      } catch (e: any) {
        this.logger.warn('[confirmBaixaPix] Pagar.me check falhou: ' + e?.message);
      }
    }
    if (!isPaid) {
      return { confirmed: false };
    }

    await (this.prisma as any).crediarioBaixa.update({
      where: { id: baixaId },
      data: { status: 'paid', paidAt: new Date() },
    });

    await this.executeGigaUpdates(baixaId);
    this.clearListCache();
    this.logger.log('[confirmBaixaPix] baixa ' + baixaId + ' confirmada + Giga atualizado');
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
    // Se PIX pendente (formaPagamento='pix' OU 'misto' com parte PIX),
    // consulta provider ao vivo + auto-confirma.
    if (
      status === 'pending'
      && (baixa.formaPagamento === 'pix' || baixa.formaPagamento === 'misto')
    ) {
      // FIX jun/2026: PagBank tambem precisa ser consultado pro polling pegar.
      // Sem isso, se o webhook PagBank falhar, parcela ficava em pending eterno.
      // Estrategia: tenta achar PagbankPayment por saleId=baixaId (= como salvamos),
      // consulta PagBank ao vivo se ainda pending. Senao, tenta Pagar.me como antes.
      try {
        const pb = await (this.prisma as any).pagbankPayment.findFirst({
          where: { saleId: baixaId, status: 'pending' },
          orderBy: { createdAt: 'desc' },
        });
        if (pb?.pagbankOrderId) {
          const live = await (this.pagbank as any).checkOrderStatus?.(pb.pagbankOrderId);
          if (live?.isPaid || live?.status === 'paid') {
            // Confirma pelo wrapper (atualiza PagbankPayment + dispara executeGigaUpdates)
            await this.confirmBaixaPixIfExists(baixaId);
            status = 'paid';
            this.logger.log(`[getBaixaStatus] PagBank auto-confirmou ${baixaId}`);
          }
        }
      } catch (e: any) {
        this.logger.warn(`[getBaixaStatus] PagBank check falhou: ${e?.message}`);
      }
      // Fallback Pagar.me (legado)
      if (status === 'pending' && baixa.pagarmeOrderId) {
        try {
          const live = await this.pagarme.checkOrderStatus(baixa.pagarmeOrderId);
          if (live.isPaid) {
            await this.confirmBaixaPix(baixaId);
            status = 'paid';
          }
        } catch {/* mantém pending */}
      }
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
    valorDinheiro?: number;
    valorPix?: number;
    origem?: string;
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
        valorDinheiro: input.valorDinheiro ?? null,
        valorPix: input.valorPix ?? null,
        origem: input.origem ?? null,
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

    // ── OUTBOX (default OFF): finaliza no Postgres + write-through no espelho e
    // enfileira a réplica pro Giga. O worker faz o markCrediarioParcelaPaid. ──
    if (this.crediarioOutboxEnabled) {
      const jobItems = items.map((it: any) => ({
        baixaItemId: it.id,
        registro: it.registro,
        controle: it.controle,
        valorPago: it.valorPago,
        juros: Number(it.jurosCalculado) || 0,
        multa: (Number(it.diasAtraso) > 0)
          ? Math.round(Number(it.valorParcela) * (multaPct / 100) * 100) / 100
          : 0,
        dataPagamento: new Date().toISOString(),
      }));
      // Write-through imediato: parcela paga sai do espelho de abertas já.
      void this.crediarioMirror
        .marcarPagasNoEspelho(items.map((it: any) => it.registro))
        .catch(() => { /* cron corrige */ });
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'crediario_baixa',
          saleId: `credbaixa-${baixaId}`,
          payload: { items: jobItems, columns: cols },
          status: 'pending',
        },
      });
      this.logger.log(`[crediario-baixa] baixa ${baixaId}: ${items.length} parcela(s) enfileirada(s) pro Giga (outbox)`);
      return;
    }

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
      } else {
        // WRITE-THROUGH: parcela paga sai do espelho na hora (não espera o
        // cron horário) — a tela de cobrança reflete imediatamente.
        void this.crediarioMirror
          .marcarPagasNoEspelho([it.registro])
          .catch(() => { /* cron corrige */ });
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

  /**
   * WRAPPER pra ser chamado pelo webhook do Pagar.me. Faz lookup pela id
   * (ou orderId) e dispara confirmBaixaPix se for uma baixa ainda pending.
   * Retorna silenciosamente se a baixa não existe (saleId era venda PDV).
   *
   * Chamado pelo PagarmeController após o webhook marcar PagarmePayment=paid.
   * Sem isso, baixas via PIX-LINK ficavam pending eternamente — Wincred
   * nunca era atualizado.
   */
  async confirmBaixaPixIfExists(baixaIdOrOrderId: string): Promise<{ confirmed: boolean; reason?: string }> {
    try {
      // 1) Busca por id direto (saleId no payment eh a baixaId quando crediario)
      let baixa = await (this.prisma as any).crediarioBaixa.findUnique({
        where: { id: baixaIdOrOrderId },
      });
      // 2) Fallback Pagar.me orderId
      if (!baixa) {
        baixa = await (this.prisma as any).crediarioBaixa.findUnique({
          where: { pagarmeOrderId: baixaIdOrOrderId },
        });
      }
      // 3) FALLBACK CRITICO (jun/2026): PagBank webhook pode mandar o pagbankOrderId
      // em vez de saleId. Busca PagbankPayment por pagbankOrderId, pega saleId (=baixaId)
      if (!baixa) {
        try {
          const pb = await (this.prisma as any).pagbankPayment.findUnique({
            where: { pagbankOrderId: baixaIdOrOrderId },
          });
          if (pb?.saleId) {
            baixa = await (this.prisma as any).crediarioBaixa.findUnique({
              where: { id: pb.saleId },
            });
            if (baixa) {
              this.logger.log('[confirmBaixaPixIfExists] achou via PagBank orderId ' + baixaIdOrOrderId + ' -> baixaId ' + pb.saleId);
            }
          }
        } catch { /* segue */ }
      }
      // 4) FALLBACK extra: PagbankPayment pode ter saleId armazenado direto
      if (!baixa) {
        try {
          const pb = await (this.prisma as any).pagbankPayment.findFirst({
            where: { saleId: baixaIdOrOrderId },
            orderBy: { createdAt: 'desc' },
          });
          if (pb?.saleId) {
            baixa = await (this.prisma as any).crediarioBaixa.findUnique({
              where: { id: pb.saleId },
            });
          }
        } catch { /* segue */ }
      }
      if (!baixa) {
        this.logger.warn('[confirmBaixaPixIfExists] baixa NAO ENCONTRADA — id=' + baixaIdOrOrderId);
        return { confirmed: false, reason: 'baixa_nao_encontrada' };
      }
      if (baixa.status === 'paid') {
        return { confirmed: false, reason: 'ja_paga' };
      }
      if (baixa.status === 'canceled') {
        return { confirmed: false, reason: 'baixa_cancelada' };
      }
      // Confirma a baixa (vai disparar executeGigaUpdates internamente)
      await this.confirmBaixaPix(baixa.id);
      this.logger.log(`[crediario-baixa] webhook auto-confirmou baixa ${baixa.id}`);
      return { confirmed: true };
    } catch (e: any) {
      this.logger.error(`[crediario-baixa] confirmBaixaPixIfExists falhou: ${e?.message || e}`);
      return { confirmed: false, reason: e?.message || 'erro' };
    }
  }

  /**
   * Baixas confirmadas RECENTEMENTE — usado pela tela de Recebimentos pra
   * detectar pagamentos via webhook (PIX-link) e disparar alerta + impressão
   * automática quando cliente pagou em casa.
   *
   * Filtra por:
   *  - status='paid'
   *  - paidAt > since (timestamp ISO da última verificação)
   *  - lojaCode opcional
   */
  async listRecentlyPaid(input: {
    sinceIso?: string;
    lojaCode?: string;
  }): Promise<Array<any>> {
    const since = input.sinceIso
      ? new Date(input.sinceIso)
      : new Date(Date.now() - 10 * 60 * 1000); // default últimos 10 min
    // FILTRO: alerta global so pra PIX-LINK remoto (mandado por WhatsApp).
    // PIX presencial QR a vendedora ja ve o cliente pagar — alerta seria ruido.
    const where: any = {
      status: 'paid',
      paidAt: { gt: since },
      origem: 'link',
    };
    if (input.lojaCode) where.lojaCode = input.lojaCode;
    const baixas = await (this.prisma as any).crediarioBaixa.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      take: 50,
      include: {
        items: { orderBy: { vencimento: 'asc' } },
      },
    });
    return baixas;
  }

  // ── Histórico de baixas ──────────────────────────────────────────────
  // Lista as baixas feitas (paid + canceled) com filtros por loja e período.
  // Usado pela tela /minha-loja/pdv/recebimentos/historico pra ver e estornar.

  async listHistorico(input: {
    lojaCode?: string;
    dias?: number; // últimos N dias (default 30)
    status?: 'paid' | 'canceled' | 'all';
  }): Promise<Array<any>> {
    const dias = Math.max(1, Math.min(365, Number(input.dias) || 30));
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);

    const where: any = { createdAt: { gte: desde } };
    if (input.lojaCode) where.lojaCode = input.lojaCode;
    if (input.status && input.status !== 'all') {
      where.status = input.status;
    }

    const baixas = await (this.prisma as any).crediarioBaixa.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        items: { orderBy: { vencimento: 'asc' } },
      },
    });
    return baixas;
  }

  // ── Estorno ──────────────────────────────────────────────────────────
  // Reverte uma baixa: marca CrediarioBaixa.status='canceled' + UPDATE no Wincred
  // pra cada parcela voltando PAGO='N', DATA_PAGAMENTO=NULL, VALOR_PAGO=0.

  async estornarBaixa(input: {
    baixaId: string;
    userId?: string;
    userName?: string;
    reason?: string;
  }): Promise<{ ok: boolean; revertidos: number; falhas: number; details: any[] }> {
    const baixa = await (this.prisma as any).crediarioBaixa.findUnique({
      where: { id: input.baixaId },
      include: { items: true },
    });
    if (!baixa) throw new NotFoundException('Baixa não encontrada');
    if (baixa.status === 'canceled') {
      throw new BadRequestException('Baixa já está estornada');
    }
    if (baixa.status !== 'paid') {
      throw new BadRequestException(`Baixa em status "${baixa.status}" — só estorna baixas pagas`);
    }

    // Reverte cada parcela no Wincred
    const map = await this.crediarios.detectColumns();
    const cols = {
      registro: map.registro,
      controle: map.controle,
      pago: map.pago,
      dataPagamento: map.dataPagamento,
      valorPago: map.valorPago,
      juros: map.juros,
      multa: map.multa,
    };

    // OUTBOX (default OFF): enfileira a reversão no Giga; o UPDATE PAGO='N' roda
    // no worker com retry. O estorno "vale" no Flow na hora (write-through abaixo).
    const useOutbox = this.crediarioOutboxEnabled;
    if (useOutbox) {
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'crediario_estorno',
          saleId: `credestorno-${input.baixaId}`,
          payload: {
            items: (baixa.items as any[]).map((it) => ({ registro: it.registro, controle: it.controle })),
            columns: cols,
          },
          status: 'pending',
        },
      });
    }

    const details: any[] = [];
    let revertidos = 0, falhas = 0;
    for (const it of baixa.items as any[]) {
      // Inline: reverte no Giga na hora. Outbox: otimista (worker replica).
      const r = useOutbox
        ? { success: true, error: undefined as string | undefined }
        : await this.erp.markCrediarioParcelaUnpaid({
            registro: it.registro,
            controle: it.controle,
            columns: cols,
          });
      details.push({
        registro: it.registro,
        controle: it.controle,
        success: r.success,
        error: r.error,
      });
      if (r.success) revertidos++; else falhas++;
      // Marca o item como gigaUpdateOk=false (estornado)
      await (this.prisma as any).crediarioBaixaItem.update({
        where: { id: it.id },
        data: {
          gigaUpdateOk: false,
          gigaError: r.success ? (useOutbox ? 'ESTORNADA (outbox)' : 'ESTORNADA') : `ESTORNO FALHOU: ${r.error || 'erro'}`,
        },
      });
    }

    // WRITE-THROUGH do estorno: re-sincroniza as abertas do espelho em
    // background pra parcela estornada voltar à lista sem esperar o cron.
    // Os registros vão junto pra desfazer também em `crediario_parcelas` — a
    // ficha da cliente lê de lá e ficaria mostrando "pago" numa parcela que
    // acabou de ser estornada.
    if (revertidos > 0) {
      const estornados = (details || []).filter((d: any) => d.success).map((d: any) => d.registro);
      void this.crediarioMirror.reinserirAposEstorno(estornados).catch(() => { /* cron corrige */ });
    }

    // Marca a baixa como cancelada
    await (this.prisma as any).crediarioBaixa.update({
      where: { id: input.baixaId },
      data: {
        status: 'canceled',
        canceledAt: new Date(),
        canceledByUserId: input.userId ?? null,
        canceledByUserName: input.userName ?? null,
        canceledReason: input.reason ?? null,
      },
    });

    // Limpa cache de clientes pra refletir mudanças
    this.clearClientesCache();

    this.logger.log(
      `[crediario-baixa] estorno baixa=${input.baixaId} cliente=${baixa.codCliente} revertidos=${revertidos}/${baixa.items.length} falhas=${falhas}`,
    );

    return { ok: falhas === 0, revertidos, falhas, details };
  }
}
