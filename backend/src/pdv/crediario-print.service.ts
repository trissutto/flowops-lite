import { forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from '../crediarios/crediarios.service';
// pdfkit é CommonJS — usa require() pra evitar problema de interop runtime
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

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
  ) {}

  // Razão social do beneficiário (vai no campo "A ___ pagar" da promissória).
  // Empresa juridicamente responsável pela cobrança.
  private readonly RAZAO_SOCIAL = 'T.O. RISSUTTO';

  // ═══════════════════════════════════════════════════════════════════════
  // CALIBRAÇÃO — ajuste essas constantes pra alinhar nas folhas Lurd's
  // ═══════════════════════════════════════════════════════════════════════

  // PROMISSÓRIA — 3 por folha A4. Cada bloco ocupa ~280pt.
  private readonly PROM = {
    // Y do TOPO de cada um dos 3 blocos
    blocoY: [25, 305, 585],
    blocoH: 280,
    // Offset dos campos DENTRO de cada bloco (relativo ao topo do bloco)
    fields: {
      numero:           { x: 245, dy: 30 },        // Nº (sequencial)
      valor:            { x: 480, dy: 30 },        // R$ XX,XX
      vencDia:          { x: 365, dy: 65 },        // dia do vencimento
      vencMes:          { x: 410, dy: 65 },        // mês por extenso
      vencAno:          { x: 510, dy: 65 },        // ano
      beneficiarioA:    { x: 215, dy: 100 },       // "A ___" — quem recebe (Lurd's)
      devedorAa:        { x: 165, dy: 130 },       // "a ___" — devedor (cliente)
      cpfDevedor:       { x: 480, dy: 130 },       // CPF/CNPJ no canto direito
      quantiaExtenso:   { x: 320, dy: 165, w: 220 }, // "QUANTIA DE ___"
      pagavelEm:        { x: 290, dy: 220 },       // cidade
      emissaoDia:       { x: 410, dy: 220 },
      emissaoMes:       { x: 460, dy: 220 },
      emissaoAno:       { x: 520, dy: 220 },
      emitente:         { x: 215, dy: 250 },       // = nome do cliente
      cpfEmitente:      { x: 175, dy: 280 },       // CPF na linha de baixo
      endereco:         { x: 200, dy: 305 },       // Endereço
      cep:              { x: 145, dy: 325 },       // CEP
    },
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
    let clienteFull: any = null;
    let cmTable: any = null;
    if (sale.customerCpf) {
      try {
        cmTable = await this.crediarios.detectClientesTable();
        if (cmTable) {
          const safeCpf = String(sale.customerCpf).replace(/\D/g, '').slice(0, 14);
          // Tenta CPF primeiro, depois codCliente
          const sql = `SELECT * FROM \`${cmTable.table}\` WHERE \`CPF\` = '${safeCpf}' LIMIT 1`;
          const r = await this.erp.runReadOnly(sql, { maxRows: 1, timeoutMs: 10000 });
          clienteFull = r.rows[0] || null;
          this.logger.log(`[crediario-print] cliente Giga: cpf=${safeCpf} found=${!!clienteFull}`);
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

    return {
      sale,
      credPayment,
      parcelas,
      parcelasArr,
      entrada: entradaSalva,
      cliente: {
        codCliente,
        nome: sale.customerName || (clienteFull?.NOME ?? clienteFull?.nome ?? '') || '',
        cpf: sale.customerCpf || '',
        endereco: clienteFull?.ENDERECO || clienteFull?.endereco || '',
        bairro: clienteFull?.BAIRRO || clienteFull?.bairro || '',
        cidade: clienteFull?.CIDADE || clienteFull?.cidade || '',
        cep: clienteFull?.CEP || clienteFull?.cep || '',
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

        const fontSize = 10;
        doc.font('Helvetica').fontSize(fontSize);

        // Cada parcela = 1 promissória. 3 promissórias por página.
        for (let i = 0; i < data.parcelas; i++) {
          const slotNaPagina = i % 3;
          if (slotNaPagina === 0 && i > 0) doc.addPage();

          const parc = data.parcelasArr[i];
          const blocoTopY = this.PROM.blocoY[slotNaPagina];

          // Numeração: codCliente + " " + parcela + "/" + totalParcelas
          // Ex: "2315 1/3"
          const numeroPromiss = `${data.cliente.codCliente || data.sale.customerCpf} ${parc.num}/${data.parcelas}`;

          this.drawAt(doc, this.PROM.fields.numero, blocoTopY, numeroPromiss);
          this.drawAt(doc, this.PROM.fields.valor, blocoTopY, this.fmtBRL(parc.valor));
          this.drawAt(doc, this.PROM.fields.vencDia, blocoTopY, String(parc.vencimento.getDate()).padStart(2, '0'));
          this.drawAt(doc, this.PROM.fields.vencMes, blocoTopY, this.mesPorExtenso(parc.vencimento));
          this.drawAt(doc, this.PROM.fields.vencAno, blocoTopY, String(parc.vencimento.getFullYear()));
          this.drawAt(doc, this.PROM.fields.beneficiarioA, blocoTopY, this.RAZAO_SOCIAL);
          this.drawAt(doc, this.PROM.fields.devedorAa, blocoTopY, data.cliente.nome);
          this.drawAt(doc, this.PROM.fields.cpfDevedor, blocoTopY, data.cliente.cpf);
          // Quantia por extenso pode quebrar 2 linhas — usa width
          doc.text(
            this.valorPorExtenso(parc.valor),
            this.PROM.fields.quantiaExtenso.x,
            blocoTopY + this.PROM.fields.quantiaExtenso.dy,
            { width: this.PROM.fields.quantiaExtenso.w, lineBreak: true },
          );
          this.drawAt(doc, this.PROM.fields.pagavelEm, blocoTopY, data.cidadeLoja);
          const hoje = new Date();
          this.drawAt(doc, this.PROM.fields.emissaoDia, blocoTopY, String(hoje.getDate()).padStart(2, '0'));
          this.drawAt(doc, this.PROM.fields.emissaoMes, blocoTopY, this.mesPorExtenso(hoje));
          this.drawAt(doc, this.PROM.fields.emissaoAno, blocoTopY, String(hoje.getFullYear()));
          this.drawAt(doc, this.PROM.fields.emitente, blocoTopY, data.cliente.nome);
          this.drawAt(doc, this.PROM.fields.cpfEmitente, blocoTopY, data.cliente.cpf);
          this.drawAt(doc, this.PROM.fields.endereco, blocoTopY, `${data.cliente.endereco} ${data.cliente.bairro}`.trim());
          this.drawAt(doc, this.PROM.fields.cep, blocoTopY, data.cliente.cep);
        }

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
    return { buffer, filename: `promissorias-${saleId.slice(-6)}.pdf` };
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

        doc.font('Helvetica').fontSize(10);

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

        doc.font('Helvetica').fontSize(10);

        // === PROMISSÓRIAS ===
        for (let i = 0; i < data.parcelas; i++) {
          const slotNaPagina = i % 3;
          if (i > 0 && slotNaPagina === 0) doc.addPage();
          const parc = data.parcelasArr[i];
          const blocoTopY = this.PROM.blocoY[slotNaPagina];
          const numeroPromiss = `${data.cliente.codCliente || data.sale.customerCpf} ${parc.num}/${data.parcelas}`;
          this.drawAt(doc, this.PROM.fields.numero, blocoTopY, numeroPromiss);
          this.drawAt(doc, this.PROM.fields.valor, blocoTopY, this.fmtBRL(parc.valor));
          this.drawAt(doc, this.PROM.fields.vencDia, blocoTopY, String(parc.vencimento.getDate()).padStart(2, '0'));
          this.drawAt(doc, this.PROM.fields.vencMes, blocoTopY, this.mesPorExtenso(parc.vencimento));
          this.drawAt(doc, this.PROM.fields.vencAno, blocoTopY, String(parc.vencimento.getFullYear()));
          this.drawAt(doc, this.PROM.fields.beneficiarioA, blocoTopY, this.RAZAO_SOCIAL);
          this.drawAt(doc, this.PROM.fields.devedorAa, blocoTopY, data.cliente.nome);
          this.drawAt(doc, this.PROM.fields.cpfDevedor, blocoTopY, data.cliente.cpf);
          doc.text(
            this.valorPorExtenso(parc.valor),
            this.PROM.fields.quantiaExtenso.x,
            blocoTopY + this.PROM.fields.quantiaExtenso.dy,
            { width: this.PROM.fields.quantiaExtenso.w, lineBreak: true },
          );
          this.drawAt(doc, this.PROM.fields.pagavelEm, blocoTopY, data.cidadeLoja);
          const hoje = new Date();
          this.drawAt(doc, this.PROM.fields.emissaoDia, blocoTopY, String(hoje.getDate()).padStart(2, '0'));
          this.drawAt(doc, this.PROM.fields.emissaoMes, blocoTopY, this.mesPorExtenso(hoje));
          this.drawAt(doc, this.PROM.fields.emissaoAno, blocoTopY, String(hoje.getFullYear()));
          this.drawAt(doc, this.PROM.fields.emitente, blocoTopY, data.cliente.nome);
          this.drawAt(doc, this.PROM.fields.cpfEmitente, blocoTopY, data.cliente.cpf);
          this.drawAt(doc, this.PROM.fields.endereco, blocoTopY, `${data.cliente.endereco} ${data.cliente.bairro}`.trim());
          this.drawAt(doc, this.PROM.fields.cep, blocoTopY, data.cliente.cep);
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
