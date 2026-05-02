import { forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from '../crediarios/crediarios.service';
import * as path from 'path';
import * as fs from 'fs';
// pdfkit é CommonJS — usa require() pra evitar problema de interop runtime
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

/**
 * Conversão milímetros → points pdfkit. 1pt = 1/72 polegada, 1in = 25.4mm.
 * Logo: 1mm = 72/25.4 ≈ 2.83465pt. Usado em TODA leitura do JSON de coords.
 */
const MM_TO_PT = 72 / 25.4;
const mm = (v: number) => v * MM_TO_PT;

/**
 * Resolve path de um asset dentro de backend/assets/. Procura em vários
 * locais pra funcionar tanto em dev (ts-node) quanto em prod (dist/).
 */
function resolveAssetPath(...parts: string[]): string | null {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', ...parts),
    path.join(__dirname, '..', '..', '..', 'assets', ...parts),
    path.join(process.cwd(), 'assets', ...parts),
    path.join(process.cwd(), 'backend', 'assets', ...parts),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

function resolveVerdanaPath(): string | null {
  return resolveAssetPath('fonts', 'verdana.ttf');
}

/**
 * Carrega o JSON de coordenadas em mm e converte pra pt. Cada campo do JSON
 * (`fields_mm`) substitui o default hardcoded; campos faltantes ficam no default.
 * Retorna `null` se o arquivo não existir / for inválido — caller usa hardcoded.
 */
function loadCoordsConfig(logger: Logger): {
  blocoY?: number[];
  blocoH?: number;
  fields?: Record<string, { x: number; dy: number; w?: number }>;
} | null {
  const cfgPath = resolveAssetPath('config', 'promissoria-coords.json');
  if (!cfgPath) {
    logger.warn('[crediario-print] JSON de coords NÃO encontrado em assets/config/. Usando defaults.');
    return null;
  }
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const json = JSON.parse(raw);
    const out: any = {};

    // Converte blocos de mm pra pt
    if (Array.isArray(json.blocosY_mm)) {
      out.blocoY = json.blocosY_mm.map((v: number) => mm(Number(v)));
      // blocoH = distância média entre topos
      if (out.blocoY.length >= 2) {
        out.blocoH = out.blocoY[1] - out.blocoY[0];
      }
    }

    // Converte fields de mm pra pt (x → x, y → dy, w → w)
    if (json.fields_mm && typeof json.fields_mm === 'object') {
      out.fields = {};
      for (const [name, f] of Object.entries<any>(json.fields_mm)) {
        out.fields[name] = {
          x: mm(Number(f.x) || 0),
          dy: mm(Number(f.y) || 0),
          ...(f.w !== undefined ? { w: mm(Number(f.w)) } : {}),
        };
      }
    }

    logger.log(`[crediario-print] coords carregadas de ${cfgPath} (${Object.keys(out.fields || {}).length} campos)`);
    return out;
  } catch (e: any) {
    logger.warn(`[crediario-print] falha ler JSON de coords (${cfgPath}): ${e?.message}. Usando defaults.`);
    return null;
  }
}

/**
 * CrediarioPrintService — gera PDF preenchendo as FOLHAS PRÉ-IMPRESSAS
 * da Lurd's (promissória 3/folha A4, carnê 2/folha A4 azul).
 *
 * O PDF tem APENAS o texto nas posições corretas — sem layout, sem caixas,
 * sem títulos. A folha pré-impressa cuida do visual; a impressora roda o
 * PDF "por cima" e os dados caem nos campos em branco.
 *
 * Coordenadas: pdfkit usa POINTS (1pt = 1/72 polegada = 0.353mm).
 * A4 = 595×842pt.
 *
 * CALIBRAÇÃO: as coordenadas iniciais são chutes educados baseados nas
 * fotos das folhas pré-impressas. Provavelmente vai precisar ajustar
 * 2-5mm em alguns campos. Bloco CONFIG no topo agrupa os offsets pra
 * facilitar ajustes sem sair caçando no código.
 */
@Injectable()
export class CrediarioPrintService {
  private readonly logger = new Logger(CrediarioPrintService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    @Inject(forwardRef(() => CrediariosService))
    private readonly crediarios: CrediariosService,
  ) {
    // Carrega coords do JSON e mescla com defaults. Feito no constructor pra
    // garantir ordem de inicialização correta.
    const cfg = loadCoordsConfig(this.logger);
    this.PROM = {
      blocoY: cfg?.blocoY?.length === 3 ? cfg.blocoY : this.PROM_DEFAULT.blocoY,
      blocoH: cfg?.blocoH ?? this.PROM_DEFAULT.blocoH,
      fields: { ...this.PROM_DEFAULT.fields, ...(cfg?.fields ?? {}) },
    };
  }

  // Razão social do beneficiário (vai no campo "A ___ pagar" da promissória).
  // Empresa juridicamente responsável pela cobrança.
  private readonly RAZAO_SOCIAL = 'T.O. RISSUTTO EIRELI';
  // CNPJ da empresa beneficiária (vai no campo "C.P.F. C.N.P.J." ao lado da
  // razão social — esse campo identifica a EMPRESA que recebe, NÃO o cliente).
  private readonly CNPJ_BENEFICIARIO = '20.104.813/0001-39';

  // ═══════════════════════════════════════════════════════════════════════
  // CALIBRAÇÃO — ajuste essas constantes pra alinhar nas folhas Lurd's
  // ═══════════════════════════════════════════════════════════════════════

  // PROMISSÓRIA — 3 por folha A4.
  //
  // FONTE DE VERDADE: backend/assets/config/promissoria-coords.json (em mm).
  // O usuário edita o JSON, restart do backend, sem recompile. Os defaults
  // abaixo são FALLBACK — usados se o JSON faltar ou tiver campo ausente.
  //
  // Por que dois lugares: pra que mesmo sem o JSON o sistema gere PDF.
  // Em produção o JSON manda; aqui é só rede de segurança.
  private readonly PROM_DEFAULT = {
    blocoY: [22, 280, 540],
    blocoH: 258,
    fields: {
      numero:           { x: 167, dy: 29 },
      parcela:          { x: 222, dy: 29 },
      valor:            { x: 480, dy: 29 },
      vencDia:          { x: 345, dy: 60 },
      vencMes:          { x: 400, dy: 60 },
      vencAno:          { x: 525, dy: 60 },
      vencExtenso:      { x: 215, dy: 80, w: 320 },
      beneficiarioA:    { x: 144, dy: 106 },
      cpfDevedor:       { x: 489, dy: 100 },
      quantiaExtenso:   { x: 325, dy: 129, w: 240 },
      pagavelEm:        { x: 275, dy: 170 },
      emissaoDia:       { x: 349, dy: 170 },
      emissaoMes:       { x: 419, dy: 170 },
      emissaoAno:       { x: 489, dy: 170 },
      emitente:         { x: 55,  dy: 200 },
      cpfEmitente:      { x: 245, dy: 220 },
      endereco:         { x: 215, dy: 240, w: 280 },
      cep:              { x: 215, dy: 250 },
    } as Record<string, { x: number; dy: number; w?: number }>,
  };

  /**
   * Coordenadas EFETIVAS — mescla do JSON com os defaults. Atribuído no constructor.
   * Tipo idêntico ao PROM_DEFAULT pra preservar shape.
   */
  private readonly PROM: {
    blocoY: number[];
    blocoH: number;
    fields: Record<string, { x: number; dy: number; w?: number }>;
  };

  // CARNÊ — 2 por folha A4 (azul). Cada bloco ocupa ~410pt.
  private readonly CARNE = {
    blocoY: [25, 435],
    blocoH: 410,
    fields: {
      numero:        { x: 250, dy: 30 },
      data:          { x: 480, dy: 30 },
      cliente:       { x: 230, dy: 65 },           // nome cliente
      ultimaCompra:  { x: 280, dy: 100 },          // data última compra
      limite:        { x: 480, dy: 100 },          // limite crédito
      pontos:        { x: 480, dy: 130 },          // pontos
      total:         { x: 250, dy: 175 },          // TOTAL R$
      entrada:       { x: 250, dy: 215 },          // ENT R$
      // Parcelas: 5 esquerda (1-5) + 5 direita (6-10)
      parcelaEsq: { xValor: 280, xData: 415, dy0: 175, dyStep: 28 },
      parcelaDir: { xValor: 565, xData: 705, dy0: 175, dyStep: 28 },
      // Total a vencer (3 colunas × 12 linhas) — começa após o "TOTAL DE PARCELAS A VENCER"
      totalAVencer: {
        col1: { x: 60,  yStart: 1080, dyStep: 32 },
        col2: { x: 280, yStart: 1080, dyStep: 32 },
        col3: { x: 500, yStart: 1080, dyStep: 32 },
      },
    },
  };

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  private fmtBRL(v: number): string {
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  private fmtDate(d: Date): string {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  private mesPorExtenso(d: Date): string {
    const meses = [
      'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
    ];
    return meses[d.getMonth()];
  }

  /**
   * Mês por extenso com a primeira letra MAIÚSCULA — formato usado pelo Giga
   * nos campos isolados (Maio, Junho, Julho).
   */
  private mesPorExtensoCap(d: Date): string {
    const m = this.mesPorExtenso(d);
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  /**
   * Vencimento por extenso no formato Giga: "os dez dias do mes de Maio de 2026".
   * Usa o dia escrito por extenso (dois, dez, vinte, etc) e mês capitalizado.
   */
  private vencimentoExtenso(d: Date): string {
    const dia = d.getDate();
    const diaTxt = this.numPorExtenso(dia);
    const mes = this.mesPorExtensoCap(d);
    const ano = d.getFullYear();
    const sufixo = dia === 1 ? 'dia' : 'dias';
    return `os ${diaTxt} ${sufixo} do mes de ${mes} de ${ano}`;
  }

  /**
   * Registra a fonte Verdana no doc pdfkit (com fallback Helvetica).
   * Centralizado pra os 3 generators usarem o mesmo nome 'Verdana' sempre —
   * se a TTF não estiver disponível em prod, faz alias 'Verdana' → Helvetica
   * e nada quebra.
   */
  private registerFonts(doc: any) {
    const verdanaPath = resolveVerdanaPath();
    if (verdanaPath) {
      try {
        doc.registerFont('Verdana', verdanaPath);
        return;
      } catch (e: any) {
        this.logger.warn(`[crediario-print] falha registrar Verdana (${verdanaPath}): ${e?.message}`);
      }
    } else {
      this.logger.warn(`[crediario-print] verdana.ttf NÃO encontrada em assets/fonts/. Caindo pra Helvetica.`);
    }
    // Fallback: registra 'Verdana' apontando pra Helvetica built-in.
    // Assim os generators podem chamar doc.font('Verdana') sem branch.
    doc.registerFont('Verdana', 'Helvetica');
  }

  /**
   * Converte número em valor monetário por extenso pra promissória.
   * Cobre 0 a 999.999,99 (suficiente pra varejo). Ex: 153.10 → "Cento e cinquenta e três reais e dez centavos".
   */
  private valorPorExtenso(valor: number): string {
    const reais = Math.floor(valor);
    const centavos = Math.round((valor - reais) * 100);
    let s = '';
    if (reais === 0 && centavos === 0) return 'Zero reais';
    if (reais > 0) {
      s += this.numPorExtenso(reais);
      s += reais === 1 ? ' real' : ' reais';
    }
    if (centavos > 0) {
      if (s) s += ' e ';
      s += this.numPorExtenso(centavos);
      s += centavos === 1 ? ' centavo' : ' centavos';
    }
    // Capitaliza primeira letra
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private numPorExtenso(n: number): string {
    if (n === 0) return 'zero';
    if (n === 100) return 'cem';
    const unidades = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
    const dez_a_dezenove = ['dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
    const dezenas = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
    const centenas = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

    const partes: string[] = [];
    if (n >= 1000) {
      const milhares = Math.floor(n / 1000);
      partes.push(milhares === 1 ? 'mil' : `${this.numPorExtenso(milhares)} mil`);
      n = n % 1000;
      if (n === 0) return partes.join(' ');
      if (n < 100) partes.push('e');
    }
    if (n >= 100) {
      const c = Math.floor(n / 100);
      partes.push(centenas[c]);
      n = n % 100;
      if (n > 0) partes.push('e');
    }
    if (n >= 20) {
      const d = Math.floor(n / 10);
      partes.push(dezenas[d]);
      n = n % 10;
      if (n > 0) {
        partes.push('e');
        partes.push(unidades[n]);
      }
    } else if (n >= 10) {
      partes.push(dez_a_dezenove[n - 10]);
    } else if (n > 0) {
      partes.push(unidades[n]);
    }
    return partes.filter(Boolean).join(' ').trim();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GERAÇÃO DOS PDFs
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * DIAGNÓSTICO — retorna as coordenadas ATIVAS (em pt e mm), o path do JSON
   * que foi lido (ou null se caiu no default), e os blocos. Pra o usuário
   * confirmar se a edição do JSON está sendo carregada.
   *
   * Endpoint: GET /pdv/diag-coords
   */
  diagCoords(): any {
    const PT_TO_MM = 25.4 / 72;
    const cfgPath = resolveAssetPath('config', 'promissoria-coords.json');
    const verdanaPath = resolveVerdanaPath();
    const fields_pt: any = {};
    const fields_mm: any = {};
    for (const [name, f] of Object.entries(this.PROM.fields)) {
      fields_pt[name] = { x: Math.round(f.x * 10) / 10, dy: Math.round(f.dy * 10) / 10, ...(f.w !== undefined ? { w: Math.round(f.w * 10) / 10 } : {}) };
      fields_mm[name] = {
        x: Math.round(f.x * PT_TO_MM * 100) / 100,
        y: Math.round(f.dy * PT_TO_MM * 100) / 100,
        ...(f.w !== undefined ? { w: Math.round(f.w * PT_TO_MM * 100) / 100 } : {}),
      };
    }
    return {
      json_path_lido: cfgPath,
      json_existe: !!cfgPath,
      verdana_path_lido: verdanaPath,
      verdana_existe: !!verdanaPath,
      blocoY_pt: this.PROM.blocoY,
      blocoY_mm: this.PROM.blocoY.map((y) => Math.round(y * PT_TO_MM * 100) / 100),
      blocoH_pt: this.PROM.blocoH,
      campos_ativos_pt: fields_pt,
      campos_ativos_mm: fields_mm,
      _help: 'Se json_existe=false, o sistema está usando defaults hardcoded. Editar o JSON NÃO terá efeito até o arquivo ser deployado e o backend reiniciado.',
    };
  }

  /**
   * DIAGNÓSTICO — busca um cliente no Giga pelo CPF e retorna a linha CRUA
   * (todas as colunas que existem na tabela). Usado pra entender por que
   * endereço/CEP não estão sendo lidos: vê os nomes EXATOS das colunas e
   * ajusta o `pick(...)` no loadSaleForPrint se necessário.
   *
   * Endpoint: GET /pdv/diag-cliente?cpf=XXXXXXXXXXX
   */
  async diagCliente(cpf: string): Promise<any> {
    const cmTable = await this.crediarios.detectClientesTable();
    if (!cmTable) {
      return { error: 'Tabela de clientes não detectada no Giga', cpf };
    }
    const safeCpf = String(cpf || '').replace(/\D/g, '').slice(0, 14);
    if (!safeCpf) return { error: 'CPF inválido', cpf };
    const formattedCpf = safeCpf.length === 11
      ? `${safeCpf.slice(0,3)}.${safeCpf.slice(3,6)}.${safeCpf.slice(6,9)}-${safeCpf.slice(9)}`
      : safeCpf;

    const tries = [
      { label: 'CPF dígitos', sql: `SELECT * FROM \`${cmTable.table}\` WHERE \`CPF\` = '${safeCpf}' LIMIT 1` },
      { label: 'CPF formatado', sql: `SELECT * FROM \`${cmTable.table}\` WHERE \`CPF\` = '${formattedCpf}' LIMIT 1` },
      { label: 'CPF REPLACE', sql: `SELECT * FROM \`${cmTable.table}\` WHERE REPLACE(REPLACE(REPLACE(\`CPF\`,'.',''),'-',''),'/','') = '${safeCpf}' LIMIT 1` },
    ];

    const log: any[] = [];
    let row: any = null;
    for (const t of tries) {
      try {
        const r = await this.erp.runReadOnly(t.sql, { maxRows: 1, timeoutMs: 10000 });
        log.push({ tentativa: t.label, encontrou: !!r.rows[0] });
        if (r.rows[0]) { row = r.rows[0]; break; }
      } catch (e: any) {
        log.push({ tentativa: t.label, erro: e?.message });
      }
    }

    return {
      tabela: cmTable.table,
      cpf_buscado: safeCpf,
      tentativas: log,
      colunas: row ? Object.keys(row) : [],
      cliente: row,
    };
  }

  /**
   * Carrega dados básicos da venda + parcelas geradas (a partir do payment crediario)
   * pra usar nas impressões.
   */
  private async loadSaleForPrint(saleId: string) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      include: { items: true, payments: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');

    // Encontra o payment crediário pra extrair parcelas/vencimentos.
    // Pode estar em sale.paymentMethod direto (modo legado) OU em payments[]
    // (modo split). details JSON tem: parcelas, valorIguais, valorUltima,
    // primeiroVencimento, entrada, observacao.
    const credPayment = (sale.payments || []).find((p: any) => p.method === 'crediario');
    const credDetailsSrc = credPayment?.details ?? null;
    const totalSale = Number(sale.total) || 0;

    let parcelas = 1;
    let valorIguais = totalSale;
    let valorUltima = totalSale;
    let primeiroVencimento: Date | null = null;
    let entradaSalva = 0;
    if (credDetailsSrc) {
      try {
        const d = typeof credDetailsSrc === 'string' ? JSON.parse(credDetailsSrc) : credDetailsSrc;
        parcelas = Number(d.parcelas) || 1;
        valorIguais = Number(d.valorIguais) || (totalSale / parcelas);
        valorUltima = Number(d.valorUltima) || valorIguais;
        if (d.primeiroVencimento) primeiroVencimento = new Date(d.primeiroVencimento);
        entradaSalva = Number(d.entrada) || 0;
      } catch {/* fallback */}
    }

    // BUG FIX: quando parcelas=1, valorUltima sempre é 0 (não há split de centavos).
    // O cálculo antigo `i === parcelas-1 ? valorUltima : valorIguais` retornava 0.
    // Solução: só usar valorUltima quando parcelas > 1.
    // Também: se valorIguais ainda for 0, calcula a partir do total da venda.
    if (parcelas === 1) {
      valorIguais = totalSale - entradaSalva;
      valorUltima = valorIguais; // mesma coisa, evita zero
    }
    if (!valorIguais || valorIguais <= 0) {
      // Fallback robusto: divide o financiado igualmente
      const financiado = Math.max(0, totalSale - entradaSalva);
      valorIguais = Math.round((financiado / parcelas) * 100) / 100;
      valorUltima = parcelas > 1
        ? Math.round((financiado - valorIguais * (parcelas - 1)) * 100) / 100
        : valorIguais;
    }

    // Gera array de parcelas com valores e vencimentos
    const parcelasArr: Array<{ num: number; valor: number; vencimento: Date }> = [];
    const dataBase = primeiroVencimento || (() => {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      return d;
    })();
    for (let i = 0; i < parcelas; i++) {
      const venc = new Date(dataBase);
      venc.setMonth(venc.getMonth() + i);
      const isUltima = parcelas > 1 && i === parcelas - 1;
      parcelasArr.push({
        num: i + 1,
        valor: isUltima ? valorUltima : valorIguais,
        vencimento: venc,
      });
    }

    // Busca dados completos do cliente no Giga via CrediariosService
    // (que tem o detectClientesTable correto). Pega: codCliente, NOME, ENDERECO,
    // BAIRRO, CIDADE, CEP, CPF, etc.
    //
    // Robustez de busca:
    //  1) Tenta CPF só com dígitos
    //  2) Se não achar, tenta CPF formatado (123.456.789-00) — algumas
    //     instalações Giga gravam o campo CPF formatado.
    //  3) Se ainda não achar, tenta REPLACE no MySQL (remove pontuação no DB).
    let clienteFull: any = null;
    let cmTable: any = null;
    if (sale.customerCpf) {
      try {
        cmTable = await this.crediarios.detectClientesTable();
        if (cmTable) {
          const safeCpf = String(sale.customerCpf).replace(/\D/g, '').slice(0, 14);
          const formattedCpf = safeCpf.length === 11
            ? `${safeCpf.slice(0,3)}.${safeCpf.slice(3,6)}.${safeCpf.slice(6,9)}-${safeCpf.slice(9)}`
            : safeCpf;

          // Tentativa 1: CPF só dígitos
          let r = await this.erp.runReadOnly(
            `SELECT * FROM \`${cmTable.table}\` WHERE \`CPF\` = '${safeCpf}' LIMIT 1`,
            { maxRows: 1, timeoutMs: 10000 },
          );
          clienteFull = r.rows[0] || null;

          // Tentativa 2: CPF formatado
          if (!clienteFull && formattedCpf !== safeCpf) {
            r = await this.erp.runReadOnly(
              `SELECT * FROM \`${cmTable.table}\` WHERE \`CPF\` = '${formattedCpf}' LIMIT 1`,
              { maxRows: 1, timeoutMs: 10000 },
            );
            clienteFull = r.rows[0] || null;
          }

          // Tentativa 3: REPLACE no DB (remove pontuação na coluna)
          if (!clienteFull) {
            r = await this.erp.runReadOnly(
              `SELECT * FROM \`${cmTable.table}\` WHERE REPLACE(REPLACE(REPLACE(\`CPF\`,'.',''),'-',''),'/','') = '${safeCpf}' LIMIT 1`,
              { maxRows: 1, timeoutMs: 10000 },
            );
            clienteFull = r.rows[0] || null;
          }

          this.logger.log(
            `[crediario-print] cliente Giga: cpf=${safeCpf} found=${!!clienteFull}` +
            (clienteFull ? ` cols=[${Object.keys(clienteFull).join(',')}]` : ''),
          );
        }
      } catch (e: any) {
        this.logger.warn(`[crediario-print] falha buscar cliente Giga: ${e?.message}`);
      }
    }

    // codCliente: prioriza a coluna detectada dinamicamente (cm.codCliente).
    // Senão tenta CODCLIENTE/CODIGO/cod_cliente como fallback.
    const codCliente = clienteFull && cmTable?.codCliente
      ? String(clienteFull[cmTable.codCliente] ?? '').trim()
      : String(
          clienteFull?.CODCLIENTE ?? clienteFull?.CODIGO ?? clienteFull?.cod_cliente ?? '',
        ).trim();

    // Loja pra "Pagável em" (cidade)
    const store = await this.prisma.store.findFirst({
      where: { code: sale.storeCode },
      select: { city: true, name: true } as any,
    });

    // Helper: busca primeiro valor não-vazio entre N variantes de coluna
    // (Giga muda nome em diferentes instalações: ENDERECO/LOGRADOURO/RUA/END...)
    const pick = (row: any, ...keys: string[]): string => {
      if (!row) return '';
      for (const k of keys) {
        const v = row[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      // Última cartada: case-insensitive — pra colunas com casing inesperado
      const lowered: Record<string, string> = {};
      for (const k of Object.keys(row)) lowered[k.toLowerCase()] = k;
      for (const k of keys) {
        const real = lowered[k.toLowerCase()];
        if (real && row[real] !== undefined && row[real] !== null && String(row[real]).trim() !== '') {
          return String(row[real]).trim();
        }
      }
      return '';
    };

    return {
      sale,
      credPayment,
      parcelas,
      parcelasArr,
      entrada: entradaSalva,
      cliente: {
        codCliente,
        nome: sale.customerName || pick(clienteFull, 'NOME', 'nome', 'CLIENTE', 'cliente', 'RAZAO_SOCIAL') || '',
        cpf: sale.customerCpf || '',
        endereco: pick(clienteFull, 'ENDERECO', 'ENDERE', 'END', 'LOGRADOURO', 'RUA', 'endereco'),
        numero:   pick(clienteFull, 'NUMERO', 'NUM', 'numero'),
        bairro:   pick(clienteFull, 'BAIRRO', 'BAI', 'bairro'),
        cidade:   pick(clienteFull, 'CIDADE', 'MUNICIPIO', 'cidade'),
        cep:      pick(clienteFull, 'CEP', 'cep'),
      },
      cidadeLoja: (store as any)?.city || sale.storeName || 'Itanhaém',
    };
  }

  /**
   * Gera PDF de PROMISSÓRIAS — N folhas A4, 3 promissórias por folha.
   * Cada promissória corresponde a UMA parcela. Ordem: 1ª, 2ª, 3ª, ...
   */
  async generatePromissorias(saleId: string): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.loadSaleForPrint(saleId);
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 0 });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this.registerFonts(doc);
        const fontSize = 10;
        doc.font('Verdana').fontSize(fontSize);

        // Cada parcela = 1 promissória. 3 promissórias por página.
        for (let i = 0; i < data.parcelas; i++) {
          const slotNaPagina = i % 3;
          if (slotNaPagina === 0 && i > 0) doc.addPage();

          const parc = data.parcelasArr[i];
          const blocoTopY = this.PROM.blocoY[slotNaPagina];
          this.drawPromissoriaBloco(doc, blocoTopY, data, parc);
        }

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
    return { buffer, filename: `promissorias-${saleId.slice(-6)}.pdf` };
  }

  /**
   * Desenha um bloco de promissória (1 parcela) na coordenada blocoTopY.
   * Centralizado pra reutilizar entre generatePromissorias e generateImpressaoCompleta.
   */
  private drawPromissoriaBloco(
    doc: any,
    blocoTopY: number,
    data: any,
    parc: { num: number; valor: number; vencimento: Date },
  ) {
    const f = this.PROM.fields;
    const codCli = data.cliente.codCliente || data.sale.customerCpf || '';

    // ── linha Y+40 ── número, parcela, valor
    this.drawAt(doc, f.numero, blocoTopY, String(codCli));
    this.drawAt(doc, f.parcela, blocoTopY, `${parc.num} / ${data.parcelas}`);
    this.drawAt(doc, f.valor, blocoTopY, this.fmtBRL(parc.valor));

    // ── linha Y+60 ── data vencimento
    this.drawAt(doc, f.vencDia, blocoTopY, String(parc.vencimento.getDate()).padStart(2, '0'));
    this.drawAt(doc, f.vencMes, blocoTopY, this.mesPorExtensoCap(parc.vencimento));
    this.drawAt(doc, f.vencAno, blocoTopY, String(parc.vencimento.getFullYear()));

    // ── linha Y+80 ── vencimento por extenso (Giga: "os dez dias do mes de Maio de 2026")
    doc.text(
      this.vencimentoExtenso(parc.vencimento),
      f.vencExtenso.x,
      blocoTopY + f.vencExtenso.dy,
      { width: (f.vencExtenso as any).w ?? 320, lineBreak: false },
    );

    // ── linha Y+100 ── beneficiário (T.O. RISSUTTO) + CNPJ
    this.drawAt(doc, f.beneficiarioA, blocoTopY, this.RAZAO_SOCIAL);
    this.drawAt(doc, f.cpfDevedor, blocoTopY, this.CNPJ_BENEFICIARIO);

    // ── linha Y+140 ── quantia por extenso (pode quebrar)
    doc.text(
      this.valorPorExtenso(parc.valor),
      f.quantiaExtenso.x,
      blocoTopY + f.quantiaExtenso.dy,
      { width: f.quantiaExtenso.w, lineBreak: true },
    );

    // ── linha Y+170 ── pagável em + emissão
    this.drawAt(doc, f.pagavelEm, blocoTopY, data.cidadeLoja);
    const hoje = new Date();
    this.drawAt(doc, f.emissaoDia, blocoTopY, String(hoje.getDate()).padStart(2, '0'));
    this.drawAt(doc, f.emissaoMes, blocoTopY, this.mesPorExtensoCap(hoje));
    this.drawAt(doc, f.emissaoAno, blocoTopY, String(hoje.getFullYear()));

    // ── dados do emitente (cliente) ──
    this.drawAt(doc, f.emitente, blocoTopY, data.cliente.nome);
    this.drawAt(doc, f.cpfEmitente, blocoTopY, this.fmtCpfCnpj(data.cliente.cpf));
    // Monta endereço completo: "RUA X, 291, BAIRRO"
    const partes = [data.cliente.endereco, data.cliente.numero, data.cliente.bairro]
      .map((p: any) => String(p || '').trim()).filter(Boolean);
    const endFull = partes.join(', ');
    if (endFull && f.endereco) {
      doc.text(
        endFull,
        f.endereco.x,
        blocoTopY + f.endereco.dy,
        { width: (f.endereco as any).w ?? 280, lineBreak: false },
      );
    }
    // CEP — só desenha se tiver dado e config tiver o campo
    if (data.cliente.cep && f.cep) {
      this.drawAt(doc, f.cep, blocoTopY, this.fmtCep(data.cliente.cep));
    }
  }

  /** Formata CPF (11 dígitos) ou CNPJ (14 dígitos). Devolve raw se não for nenhum. */
  private fmtCpfCnpj(raw: string): string {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11) {
      return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
    }
    if (d.length === 14) {
      return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
    }
    return d || String(raw || '');
  }

  /** Formata CEP (8 dígitos) como XXXXX-XXX. */
  private fmtCep(raw: string): string {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length === 8) return `${d.slice(0,5)}-${d.slice(5)}`;
    return d || String(raw || '');
  }

  /**
   * Gera PDF do CARNÊ — 1 folha A4 azul (2 carnês iguais por folha).
   * Imprime o MESMO carnê 2× pro cliente recortar uma cópia.
   */
  async generateCarne(saleId: string): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.loadSaleForPrint(saleId);
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 0 });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this.registerFonts(doc);
        doc.font('Verdana').fontSize(10);

        // Imprime os 2 blocos do carnê (idênticos)
        for (let bloco = 0; bloco < 2; bloco++) {
          const blocoY = this.CARNE.blocoY[bloco];
          const f = this.CARNE.fields;

          // Cabeçalho
          this.drawAt(doc, f.numero, blocoY, String(data.cliente.codCliente || data.sale.id.slice(-6).toUpperCase()));
          this.drawAt(doc, f.data, blocoY, this.fmtDate(new Date()));
          this.drawAt(doc, f.cliente, blocoY, data.cliente.nome);
          // ÚLTIMA COMPRA / LIMITE / PONTOS — deixados em branco até confirmar com user
          // (se quiser preencher, adicionar aqui)

          // Total e entrada
          this.drawAt(doc, f.total, blocoY, this.fmtBRL(data.sale.total));
          // Entrada vem do payment dinheiro com flag isEntradaCrediario
          // Entrada: do details do payment crediário OU dos payments dinheiro com flag.
          let entrada = data.entrada || 0;
          if (entrada === 0) {
            for (const p of data.sale.payments || []) {
              try {
                const d = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
                if (p.method === 'dinheiro' && d?.isEntradaCrediario) entrada += p.valor;
              } catch {/* ignora */}
            }
          }
          this.drawAt(doc, f.entrada, blocoY, entrada > 0 ? this.fmtBRL(entrada) : '0,00');

          // Parcelas — 5 na coluna esquerda (1-5), 5 na direita (6-10)
          for (let i = 0; i < Math.min(data.parcelas, 10); i++) {
            const parc = data.parcelasArr[i];
            const isEsq = i < 5;
            const config = isEsq ? f.parcelaEsq : f.parcelaDir;
            const idxNaCol = isEsq ? i : i - 5;
            const yPos = blocoY + config.dy0 + idxNaCol * config.dyStep;
            doc.text(this.fmtBRL(parc.valor), config.xValor, yPos, { lineBreak: false });
            doc.text(this.fmtDate(parc.vencimento), config.xData, yPos, { lineBreak: false });
          }
        }

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
    return { buffer, filename: `carne-${saleId.slice(-6)}.pdf` };
  }

  /**
   * Gera PDF combinado — promissórias + carnê na ordem que a vendedora
   * carrega na impressora (2 folhas brancas + 1 azul).
   */
  async generateImpressaoCompleta(saleId: string): Promise<{ buffer: Buffer; filename: string }> {
    // pdfkit não tem merge nativo; geramos um único Document concatenando páginas
    const data = await this.loadSaleForPrint(saleId);
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 0 });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this.registerFonts(doc);
        doc.font('Verdana').fontSize(10);

        // === PROMISSÓRIAS ===
        for (let i = 0; i < data.parcelas; i++) {
          const slotNaPagina = i % 3;
          if (i > 0 && slotNaPagina === 0) doc.addPage();
          const parc = data.parcelasArr[i];
          const blocoTopY = this.PROM.blocoY[slotNaPagina];
          this.drawPromissoriaBloco(doc, blocoTopY, data, parc);
        }

        // === CARNÊ === (sempre uma página nova)
        doc.addPage();
        for (let bloco = 0; bloco < 2; bloco++) {
          const blocoY = this.CARNE.blocoY[bloco];
          const f = this.CARNE.fields;
          this.drawAt(doc, f.numero, blocoY, String(data.cliente.codCliente || data.sale.id.slice(-6).toUpperCase()));
          this.drawAt(doc, f.data, blocoY, this.fmtDate(new Date()));
          this.drawAt(doc, f.cliente, blocoY, data.cliente.nome);
          this.drawAt(doc, f.total, blocoY, this.fmtBRL(data.sale.total));
          // Entrada: do details do payment crediário OU dos payments dinheiro com flag.
          let entrada = data.entrada || 0;
          if (entrada === 0) {
            for (const p of data.sale.payments || []) {
              try {
                const d = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
                if (p.method === 'dinheiro' && d?.isEntradaCrediario) entrada += p.valor;
              } catch {/* ignora */}
            }
          }
          this.drawAt(doc, f.entrada, blocoY, entrada > 0 ? this.fmtBRL(entrada) : '0,00');
          for (let i = 0; i < Math.min(data.parcelas, 10); i++) {
            const parc = data.parcelasArr[i];
            const isEsq = i < 5;
            const config = isEsq ? f.parcelaEsq : f.parcelaDir;
            const idxNaCol = isEsq ? i : i - 5;
            const yPos = blocoY + config.dy0 + idxNaCol * config.dyStep;
            doc.text(this.fmtBRL(parc.valor), config.xValor, yPos, { lineBreak: false });
            doc.text(this.fmtDate(parc.vencimento), config.xData, yPos, { lineBreak: false });
          }
        }

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
    return { buffer, filename: `credprint-${saleId.slice(-6)}.pdf` };
  }

  /**
   * RÉGUA DE CALIBRAÇÃO — gera A4 com linhas horizontais a cada 10pt e
   * linhas verticais a cada 50pt. O usuário imprime numa folha branca,
   * sobrepõe na promissória pré-impressa contra a janela e me diz em
   * que Y caem os labels do form. Aí ajustamos as constantes com precisão.
   */
  async generateRegua(): Promise<{ buffer: Buffer; filename: string }> {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 0 });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Linhas horizontais a cada 10pt + label do Y
        doc.fontSize(7).font('Helvetica');
        for (let y = 0; y <= 842; y += 10) {
          const isMajor = y % 50 === 0;
          doc.lineWidth(isMajor ? 0.5 : 0.2)
            .strokeColor(isMajor ? '#FF0000' : '#999999')
            .moveTo(0, y).lineTo(595, y).stroke();
          if (isMajor) {
            doc.fillColor('#FF0000').text(`Y=${y}`, 4, y + 1, { lineBreak: false });
            doc.fillColor('#FF0000').text(`Y=${y}`, 560, y + 1, { lineBreak: false });
          }
        }
        // Linhas verticais a cada 50pt
        for (let x = 0; x <= 595; x += 50) {
          doc.lineWidth(0.3).strokeColor('#0000FF')
            .moveTo(x, 0).lineTo(x, 842).stroke();
          doc.fillColor('#0000FF').text(`X=${x}`, x + 1, 4, { lineBreak: false });
        }
        // Marcadores dos blocoY atuais
        for (let i = 0; i < this.PROM.blocoY.length; i++) {
          const y = this.PROM.blocoY[i];
          doc.lineWidth(1.5).strokeColor('#00AA00')
            .moveTo(0, y).lineTo(595, y).stroke();
          doc.fillColor('#00AA00').fontSize(10)
            .text(`BLOCO ${i + 1} - Y=${y}`, 220, y - 12, { lineBreak: false });
        }

        doc.end();
      } catch (e) { reject(e); }
    });
    return { buffer, filename: 'regua-calibracao.pdf' };
  }

  /**
   * PROMISSÓRIA DE TESTE COM RÉGUA DE FUNDO — modo DEBUG.
   * Imprime numa folha A4 SÓ: a régua + a promissória de teste por cima.
   * O usuário sobrepõe na pré-impressa do Giga e consegue dizer com
   * precisão "campo X cai no Y=180 mas devia estar no Y=200" — daí
   * eu ajusto numericamente sem chute.
   *
   * Use: GET /pdv/promissorias-teste-debug-pdf
   */
  async generatePromissoriasTesteDebug(): Promise<{ buffer: Buffer; filename: string }> {
    const dataMock = {
      sale: { customerCpf: '28665529896' },
      cliente: {
        codCliente: '2315',
        nome: 'THIAGO DE OLIVEIRA RISSUTTO',
        cpf: '28665529896',
        endereco: 'RUA NICOLA MANCUSO FILHO',
        numero: '291',
        bairro: 'CH TAMARAS',
        cidade: 'ITANHAEM',
        cep: '11740000',
      },
      cidadeLoja: 'ITANHAEM',
      parcelas: 4,
    };
    const parcelasMock = [
      { num: 1, valor: 8.90, vencimento: new Date(2026, 4, 10) },
      { num: 2, valor: 5.00, vencimento: new Date(2026, 5, 10) },
      { num: 3, valor: 5.00, vencimento: new Date(2026, 6, 10) },
    ];

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 0 });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // ===== RÉGUA DE FUNDO (cinza claro pra não atrapalhar leitura) =====
        doc.fontSize(6).font('Helvetica').fillColor('#CCCCCC');
        for (let y = 0; y <= 842; y += 10) {
          const isMajor = y % 50 === 0;
          doc.lineWidth(isMajor ? 0.4 : 0.15)
            .strokeColor(isMajor ? '#FF6666' : '#DDDDDD')
            .moveTo(0, y).lineTo(595, y).stroke();
          if (isMajor) {
            doc.fillColor('#FF6666').text(`Y=${y}`, 4, y + 1, { lineBreak: false });
            doc.fillColor('#FF6666').text(`Y=${y}`, 560, y + 1, { lineBreak: false });
          }
        }
        for (let x = 0; x <= 595; x += 50) {
          doc.lineWidth(0.2).strokeColor('#AACCFF')
            .moveTo(x, 0).lineTo(x, 842).stroke();
          doc.fillColor('#6699FF').text(`X=${x}`, x + 1, 4, { lineBreak: false });
        }
        // Linha verde marcando topo de cada bloco
        for (let i = 0; i < this.PROM.blocoY.length; i++) {
          const y = this.PROM.blocoY[i];
          doc.lineWidth(1).strokeColor('#00AA00')
            .moveTo(0, y).lineTo(595, y).stroke();
          doc.fillColor('#00AA00').fontSize(8)
            .text(`BLOCO ${i + 1} TOPO Y=${y}`, 200, y - 9, { lineBreak: false });
        }

        // ===== PROMISSÓRIAS POR CIMA (preto, fonte de verdade) =====
        this.registerFonts(doc);
        doc.font('Verdana').fontSize(10).fillColor('#000000');
        for (let i = 0; i < parcelasMock.length; i++) {
          const blocoTopY = this.PROM.blocoY[i];
          this.drawPromissoriaBloco(doc, blocoTopY, dataMock, parcelasMock[i]);
        }

        doc.end();
      } catch (e) { reject(e); }
    });
    return { buffer, filename: 'promissorias-TESTE-DEBUG.pdf' };
  }

  /**
   * PROMISSÓRIA DE TESTE — gera 3 promissórias com os MESMOS dados do print
   * de referência do WinCred (Thiago de Oliveira Rissutto, código 2315,
   * 4 parcelas de R$ 8,90/5,00/5,00/5,00). NÃO depende do banco — pra
   * calibrar coordenadas sobre a folha pré-impressa sem precisar criar venda.
   *
   * Use: GET /pdv/promissorias-teste-pdf
   * Imprime, sobrepõe na pré-impressa do WinCred, confere se cada campo cai
   * EXATAMENTE em cima do impresso original.
   */
  async generatePromissoriasTeste(): Promise<{ buffer: Buffer; filename: string }> {
    // Mock data idêntico ao print de calibração que o usuário enviou.
    const dataMock = {
      sale: { customerCpf: '28665529896' },
      cliente: {
        codCliente: '2315',
        nome: 'THIAGO DE OLIVEIRA RISSUTTO',
        cpf: '28665529896',
        endereco: 'RUA NICOLA MANCUSO FILHO',
        numero: '291',
        bairro: 'CH TAMARAS',
        cidade: 'ITANHAEM',
        cep: '11740000',
      },
      cidadeLoja: 'ITANHAEM',
      parcelas: 4,
    };
    const parcelasMock = [
      { num: 1, valor: 8.90, vencimento: new Date(2026, 4, 10) },  // Maio
      { num: 2, valor: 5.00, vencimento: new Date(2026, 5, 10) },  // Junho
      { num: 3, valor: 5.00, vencimento: new Date(2026, 6, 10) },  // Julho
    ];

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 0 });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        this.registerFonts(doc);
        doc.font('Verdana').fontSize(10);

        // 3 parcelas em 1 folha (3 blocos)
        for (let i = 0; i < parcelasMock.length; i++) {
          const blocoTopY = this.PROM.blocoY[i];
          this.drawPromissoriaBloco(doc, blocoTopY, dataMock, parcelasMock[i]);
        }

        doc.end();
      } catch (e) { reject(e); }
    });
    return { buffer, filename: 'promissorias-TESTE.pdf' };
  }

  /** Helper pra desenhar texto em coordenada absoluta (x, y_relativo + bloco_top) */
  private drawAt(
    doc: any,
    field: { x: number; dy: number },
    blocoTopY: number,
    text: string,
  ) {
    if (!text) return;
    doc.text(String(text), field.x, blocoTopY + field.dy, { lineBreak: false });
  }
}
