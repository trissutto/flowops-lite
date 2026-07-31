import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CorreiosService } from '../correios/correios.service';
import { MaisEnviosService } from '../mais-envios/mais-envios.service';
import { NfeTransferService } from '../nfe/nfe-transfer.service';
import { DanfePdfService } from '../nfe/danfe-pdf.service';

// Lojas que despacham pelo Mais Envios (mesma regra dos pedidos): mapa fixo da
// rede + extensão por env MAISENVIOS_STORES_JSON (franquias etc.).
const ME_STORES: Record<string, number> = { '05': 3605, '06': 209, '11': 213, '15': 22908 };
function maisEnviosStores(): Record<string, number> {
  const base: Record<string, number> = { ...ME_STORES };
  try {
    const j = JSON.parse(process.env.MAISENVIOS_STORES_JSON || '{}');
    for (const k of Object.keys(j)) { const v = Number(j[k]); if (v > 0) base[String(k)] = v; }
  } catch { /* só o mapa fixo */ }
  return base;
}

/**
 * ENVIO FÍSICO da remessa entre lojas (regra do dono 28/07):
 *   - SEMPRE SEDEX; provedor pela regra da loja ORIGEM (Mais Envios ou Correios)
 *   - a NF-e de transferência (5152, emitente pela raiz do destino) é emitida
 *     ANTES (auto-emite se ainda não existir) e a CHAVE vai na pré-postagem
 *   - destinatário = a LOJA DESTINO (endereço da config fiscal dela)
 *   - impressão: PDF ÚNICO etiqueta + DANFE (mesmo padrão dos pedidos)
 */
@Injectable()
export class RemessaEnvioService {
  private readonly logger = new Logger(RemessaEnvioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly correios: CorreiosService,
    private readonly maisEnvios: MaisEnviosService,
    private readonly nfe: NfeTransferService,
    private readonly danfePdf: DanfePdfService,
  ) {}

  /** Endereço/identidade de uma loja pela config fiscal (NfceConfig). */
  private async dadosLoja(storeCode: string) {
    const cfg: any = await this.prisma.nfceConfig.findUnique({ where: { storeCode } });
    if (!cfg?.endereco) throw new BadRequestException(`Loja ${storeCode} sem endereço na config fiscal (NfceConfig) — necessário pro envio da remessa.`);
    let e: any = {};
    try { e = JSON.parse(String(cfg.endereco)); } catch { /* valida abaixo */ }
    const cep = String(e?.cep || '').replace(/\D/g, '');
    if (!e?.logradouro || cep.length !== 8) throw new BadRequestException(`Loja ${storeCode} com endereço fiscal incompleto (logradouro/CEP).`);
    return {
      nome: String(cfg.fantasia || cfg.razaoSocial || `LOJA ${storeCode}`).slice(0, 50),
      cnpj: String(cfg.cnpj || '').replace(/\D/g, ''),
      endereco: String(e.logradouro),
      numero: String(e.numero || 'S/N'),
      bairro: String(e.bairro || ''),
      cidade: String(e.municipio || e.cidade || ''),
      uf: String(e.uf || 'SP'),
      cep,
    };
  }

  /** Botão "Imprimir Nota Fiscal" do Ponto a Ponto (dono 29/07): emite a
   *  NF-e de transferência (idempotente — reusa a autorizada) e devolve a
   *  DANFE em base64 pra loja imprimir na hora. */
  async emitirNota(shipmentId: string, storeId: string, userId?: string | null) {
    const shipment: any = await this.prisma.realignmentShipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    await this.validarLojaOrigem(shipment, storeId);
    if (shipment.status === 'open') {
      throw new BadRequestException('Processe e envie a remessa primeiro — a nota sai na sequência.');
    }
    let doc: any = await this.prisma.nfeDoc.findFirst({ where: { shipmentId, status: 'authorized' } });
    if (!doc) {
      const r: any = await this.nfe.emitForShipment(shipmentId, { userId: userId ?? null });
      if (!r?.ok) {
        throw new BadRequestException(`NF-e não autorizada (${r?.cStat ?? ''}): ${r?.xMotivo ?? r?.erro ?? 'erro'}`);
      }
      doc = await this.prisma.nfeDoc.findFirst({ where: { shipmentId, status: 'authorized' } });
    }
    if (!doc) throw new BadRequestException('NF-e não encontrada após a emissão — tente de novo.');
    const { buffer } = await this.danfePdf.generateForDoc(doc.id);
    return { ok: true, numero: doc.numero, serie: doc.serie, chave: doc.chave, danfeB64: buffer.toString('base64') };
  }

  /** 'correios' | 'proprio' — escolhido na tela, senão regra automática
   *  (até 10 peças → Correios; acima → próprio). Dono 29/07. */
  async transporteEfetivo(shipment: any): Promise<'correios' | 'proprio'> {
    const m = String(shipment?.transportMode || '');
    if (m === 'correios' || m === 'proprio') return m as any;
    const rows: any[] = await this.prisma.transferOrder.findMany({
      where: { shipmentId: shipment.id, realignmentStatus: { not: 'cancelled' } } as any,
      select: { qtyOrigem: true } as any,
    });
    const pecas = rows.reduce((a, r) => a + (Number(r.qtyOrigem) || 1), 0);
    return pecas <= 10 ? 'correios' : 'proprio';
  }

  /** `storeId` nulo = retaguarda (admin), que enxerga todas as remessas. */
  private async validarLojaOrigem(shipment: any, storeId: string | null) {
    if (!storeId) return null;
    const store: any = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store || store.code !== shipment.fromStoreCode) {
      throw new ForbiddenException('Só a loja ORIGEM gera o envio da remessa.');
    }
    return store;
  }

  /**
   * Gera NF-e (se faltar) + pré-postagem SEDEX com a chave. Idempotente.
   *
   * `storeId` nulo → chamada da retaguarda. `forcar` → emite a etiqueta mesmo
   * quando o transporte estava como PRÓPRIO (pedido do dono 31/07: poder
   * postar qualquer remessa quando ele quiser, sem depender da regra das 10
   * peças). Nesse caso o transporte da remessa VIRA 'correios' — senão a tela
   * ficaria mostrando 🚚 PRÓPRIO numa remessa que tem código de rastreio.
   */
  async gerarEnvio(
    shipmentId: string,
    storeId: string | null,
    userId?: string | null,
    opts?: { forcar?: boolean },
  ) {
    const shipment: any = await this.prisma.realignmentShipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    await this.validarLojaOrigem(shipment, storeId);
    if (shipment.status !== 'in_transit') {
      throw new BadRequestException('Feche e envie a remessa primeiro (o envio físico é gerado com a remessa em trânsito).');
    }
    if (shipment.trackingCode) {
      return { ok: true, jaGerado: true, codigoRastreio: shipment.trackingCode, carrier: shipment.carrier };
    }

    // Regra do transporte (dono 29/07): até 10 peças → CORREIOS; acima →
    // PRÓPRIO. Override manual: transportMode (botão na tela de remessas).
    const modoTransporte = await this.transporteEfetivo(shipment);
    if (modoTransporte !== 'correios' && !opts?.forcar) {
      throw new BadRequestException('Remessa marcada como transporte PRÓPRIO — não gera etiqueta. Se for postar, troque o transporte pra CORREIOS na remessa.');
    }
    if (modoTransporte !== 'correios') {
      await this.prisma.realignmentShipment.update({
        where: { id: shipmentId },
        data: { transportMode: 'correios' },
      });
      this.logger.warn(`[remessa-envio] ${shipment.code}: transporte forçado PRÓPRIO → CORREIOS pela retaguarda`);
    }

    // 1) NF-e de transferência (5152) — auto-emite se ainda não existir
    let doc: any = await this.prisma.nfeDoc.findFirst({ where: { shipmentId, status: 'authorized' } });
    if (!doc) {
      const r: any = await this.nfe.emitForShipment(shipmentId, { userId: userId ?? null });
      if (!r?.ok) {
        throw new BadRequestException(`NF-e da remessa não autorizada (${r?.cStat ?? ''}): ${r?.xMotivo ?? 'erro'} — o envio precisa da chave.`);
      }
      doc = await this.prisma.nfeDoc.findFirst({ where: { shipmentId, status: 'authorized' } });
    }
    const chave = String(doc?.chave || '').replace(/\D/g, '');
    if (chave.length !== 44) throw new BadRequestException('NF-e da remessa sem chave — não dá pra gerar o envio.');

    // 2) Dados físicos
    const itens: any[] = await (this.prisma as any).transferOrder.findMany({ where: { shipmentId } });
    const totalPecas = itens.reduce((s, it) => s + (Number(it.qtyOrigem) || 1), 0) || 1;
    const pesoGramas = Math.max(300, totalPecas * 200);
    const valor = (Number(doc?.valorTotalCents) || 0) / 100;
    const origem = await this.dadosLoja(shipment.fromStoreCode);
    const destino = await this.dadosLoja(shipment.toStoreCode);
    const itensDeclaracao = itens.slice(0, 50).map((it) => ({
      conteudo: [it.refCode, it.cor, it.tamanho].filter(Boolean).join(' ').slice(0, 60) || 'Vestuário',
      quantidade: String(it.qtyOrigem || 1),
    }));

    // 3) Provedor pela regra da loja ORIGEM (mesma dos pedidos) — sempre SEDEX
    const senderId = maisEnviosStores()[String(shipment.fromStoreCode)];
    const routingOn = String(process.env.MAISENVIOS_ROUTING || '').trim() === '1';
    let r: any;
    if (routingOn && senderId) {
      const resp: any = await this.maisEnvios.criarPrepost({
        senderId,
        servico: 'SEDEX',
        destinatario: {
          nome: destino.nome,
          cpf: destino.cnpj,
          cep: destino.cep,
          endereco: destino.endereco,
          numero: destino.numero,
          complemento: '',
          bairro: destino.bairro,
          cidade: destino.cidade,
          uf: destino.uf,
          telefone: '',
          email: '',
        },
        pesoGramas,
        valorDeclarado: valor || undefined,
        nfe: { chave, numero: doc.numero, serie: doc.serie, valor },
        referencia: String(shipment.code || shipmentId).slice(0, 40),
        departamento: shipment.fromStoreName,
        itens: itensDeclaracao.map((i) => ({ conteudo: i.conteudo, quantidade: Number(i.quantidade) || 1 })),
      });
      if (!resp?.ok || !resp.tag) throw new BadRequestException(`Mais Envios recusou a remessa: ${resp?.erro || 'sem tag'}`);
      r = { codigoRastreio: resp.tag, idPrepostagem: resp.idPrepostagem ?? null, carrier: 'Mais Envios SEDEX', etiquetaPdf: null };
      try { const et = await this.maisEnvios.baixarEtiqueta(resp.tag); if (et?.ok && et.pdfBase64) r.etiquetaPdf = et.pdfBase64; } catch { /* opcional */ }
    } else {
      const resp: any = await this.correios.criarPrepostagem({
        servico: 'SEDEX',
        remetente: {
          nome: origem.nome, cnpjCpf: origem.cnpj, endereco: origem.endereco, numero: origem.numero,
          bairro: origem.bairro, cidade: origem.cidade, uf: origem.uf, cep: origem.cep,
        },
        destinatario: {
          nome: destino.nome, cpfCnpj: destino.cnpj, endereco: destino.endereco, numero: destino.numero,
          complemento: '', bairro: destino.bairro, cidade: destino.cidade, uf: destino.uf, cep: destino.cep,
        },
        pesoGramas,
        valorDeclarado: valor || undefined,
        nfeChave: chave,
        itensDeclaracao,
      });
      if (!resp?.ok) throw new BadRequestException(`Correios recusou a remessa: ${resp?.erro || 'erro'}`);
      r = { codigoRastreio: resp.codigoRastreio, idPrepostagem: resp.idPrepostagem ?? null, carrier: 'Correios SEDEX', etiquetaPdf: null };
    }

    await this.prisma.realignmentShipment.update({
      where: { id: shipmentId },
      data: {
        trackingCode: r.codigoRastreio,
        carrier: r.carrier,
        correiosPrepostagemId: r.idPrepostagem ? String(r.idPrepostagem) : null,
        envioGeneratedAt: new Date(),
      },
    });
    this.logger.log(`[remessa-envio] ${shipment.code}: ${r.carrier} ${r.codigoRastreio} (NF-e ${doc.numero}, chave ...${chave.slice(-8)})`);
    return { ok: true, codigoRastreio: r.codigoRastreio, carrier: r.carrier, idPrepostagem: r.idPrepostagem, etiquetaPdf: r.etiquetaPdf, nfeNumero: doc.numero };
  }

  /**
   * PDF ÚNICO: etiqueta + DANFE da transferência (pra imprimir de uma vez).
   * `storeId` nulo = retaguarda. `somenteEtiqueta` = só a etiqueta dos
   * Correios/Mais Envios, sem a DANFE junto (o dono às vezes só quer colar a
   * etiqueta numa caixa cuja nota já foi impressa).
   */
  async docsEnvio(shipmentId: string, storeId: string | null, opts?: { somenteEtiqueta?: boolean }) {
    const shipment: any = await this.prisma.realignmentShipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException('Remessa não encontrada');
    if (storeId) {
      const store: any = await this.prisma.store.findUnique({ where: { id: storeId } });
      if (!store || (store.code !== shipment.fromStoreCode && store.code !== shipment.toStoreCode)) {
        throw new ForbiddenException('Remessa de outra loja.');
      }
    }
    if (!shipment.trackingCode) throw new BadRequestException('Envio ainda não gerado.');

    const pdfs: Buffer[] = [];
    const ehME = String(shipment.carrier || '').includes('Mais Envios');
    try {
      if (ehME) {
        const et: any = await this.maisEnvios.baixarEtiqueta(shipment.trackingCode);
        if (et?.ok && et.pdfBase64) pdfs.push(Buffer.from(String(et.pdfBase64), 'base64'));
      } else if (shipment.correiosPrepostagemId) {
        const et: any = await this.correios.baixarEtiqueta(String(shipment.correiosPrepostagemId));
        if (et?.ok && et.pdfBase64) pdfs.push(Buffer.from(String(et.pdfBase64), 'base64'));
      }
    } catch (e: any) {
      this.logger.warn(`[remessa-envio] etiqueta indisponível (${shipment.code}): ${e?.message || e}`);
    }
    const temEtiqueta = pdfs.length > 0;
    let temNota = false;
    if (!opts?.somenteEtiqueta) {
      try {
        const doc: any = await this.prisma.nfeDoc.findFirst({ where: { shipmentId, status: 'authorized' } });
        if (doc?.id) {
          const { buffer } = await this.danfePdf.generateForDoc(doc.id);
          pdfs.push(buffer);
          temNota = true;
        }
      } catch (e: any) {
        this.logger.warn(`[remessa-envio] DANFE indisponível (${shipment.code}): ${e?.message || e}`);
      }
    }
    if (!pdfs.length) {
      throw new BadRequestException(
        opts?.somenteEtiqueta
          ? 'A transportadora ainda não devolveu o PDF da etiqueta — tente de novo em alguns segundos.'
          : 'Nem etiqueta nem DANFE disponíveis ainda — tente de novo em alguns segundos.',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.create();
    for (const b of pdfs) {
      const src = await PDFDocument.load(b, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    }
    const bytes = await out.save();
    return {
      ok: true,
      pdfBase64: Buffer.from(bytes).toString('base64'),
      temEtiqueta,
      temNota,
      trackingCode: shipment.trackingCode,
      carrier: shipment.carrier,
    };
  }
}
