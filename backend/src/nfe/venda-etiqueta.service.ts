import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CorreiosService } from '../correios/correios.service';
import { MaisEnviosService } from '../mais-envios/mais-envios.service';

// Mesma regra de provedor dos pedidos/remessas: essas lojas despacham pelo
// Mais Envios; o resto vai direto nos Correios (CWS).
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
 * ETIQUETA DOS CORREIOS DA VENDA ONLINE (31/07).
 *
 * A VENDA_ONLINE feita no PDV (cliente de fora, com linha de frete) não tinha
 * caminho nenhum pra postar: "Gerar envio" só existe pra pedido do site
 * (pick-order) e pra remessa entre lojas. A vendedora emitia a NF-e da venda
 * e... escrevia a etiqueta NA MÃO.
 *
 * O pulo do gato: o ENDEREÇO da cliente já está dentro da NF-e autorizada
 * (grupo <dest>) — foi digitado no modal da nota grande. Então a etiqueta sai
 * daqui sem pedir nada de novo: lê o destinatário do próprio XML autorizado,
 * usa a CHAVE da nota na pré-postagem (obrigação de quem posta com NF) e o
 * remetente é a identidade fiscal da loja (mesma regra da NF-e — se o CNPJ da
 * NF-e é outro, endereço vai junto; bug Itanhaém/Sorocaba, 31/07).
 *
 * Por isso a exigência: SEM NF-e autorizada da venda, não há etiqueta.
 */
@Injectable()
export class VendaEtiquetaService {
  private readonly logger = new Logger(VendaEtiquetaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly correios: CorreiosService,
    private readonly maisEnvios: MaisEnviosService,
  ) {}

  /** Primeiro valor da tag dentro do trecho — o XML é nosso (gerado aqui). */
  private tag(xml: string, nome: string): string {
    const m = xml.match(new RegExp(`<${nome}>([^<]*)</${nome}>`));
    return m ? m[1].trim() : '';
  }

  private desescapa(s: string): string {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  /** Identidade/endereço do remetente — MESMA regra do loadStoreFiscal:
   *  CNPJ da NF-e diferente → identidade inteira da NF-e. */
  private async remetente(storeCode: string) {
    const cfg: any = await this.prisma.nfceConfig.findUnique({ where: { storeCode } });
    if (!cfg) throw new BadRequestException(`Loja ${storeCode} sem config fiscal (NfceConfig).`);
    const digits = (v: any) => String(v ?? '').replace(/\D/g, '');
    const nfeCnpj = digits(cfg.nfeCnpj);
    const identidadePropria = nfeCnpj.length === 14 && nfeCnpj !== digits(cfg.cnpj);
    const parse = (raw: any) => {
      if (!raw) return null;
      let e: any = null;
      try { e = JSON.parse(String(raw)); } catch { return null; }
      const cep = digits(e?.cep);
      if (!e?.logradouro || cep.length !== 8) return null;
      return { ...e, cep };
    };
    const e = (identidadePropria ? parse(cfg.nfeEndereco) : null) ?? parse(cfg.endereco);
    if (!e) throw new BadRequestException(`Loja ${storeCode} com endereço fiscal incompleto.`);
    const nome = identidadePropria
      ? String(cfg.nfeFantasia || cfg.nfeRazaoSocial || cfg.fantasia || cfg.razaoSocial || `LOJA ${storeCode}`)
      : String(cfg.fantasia || cfg.razaoSocial || `LOJA ${storeCode}`);
    return {
      nome: nome.slice(0, 50),
      cnpjCpf: identidadePropria ? nfeCnpj : digits(cfg.cnpj),
      endereco: String(e.logradouro),
      numero: String(e.numero || 'S/N'),
      bairro: String(e.bairro || ''),
      cidade: String(e.municipio || e.cidade || ''),
      uf: String(e.uf || 'SP'),
      cep: e.cep,
    };
  }

  /**
   * Gera (idempotente) a pré-postagem da venda e devolve a etiqueta.
   * `lojaPermitida` ≠ null → sessão de loja: só posta venda DELA.
   */
  async gerar(saleId: string, opts: { servico?: 'PAC' | 'SEDEX'; lojaPermitida?: string | null; userName?: string | null }) {
    const sale: any = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (opts.lojaPermitida && String(opts.lojaPermitida) !== String(sale.storeCode)) {
      throw new ForbiddenException('Venda de outra loja');
    }

    const doc: any = await this.prisma.nfeDoc.findFirst({
      where: { shipmentId: `venda:${saleId}`, status: 'authorized' },
      orderBy: { createdAt: 'desc' } as any,
    });
    if (!doc) {
      throw new BadRequestException(
        'Emita a NF-e da venda primeiro (botão NF-e) — a etiqueta usa a chave e o endereço que estão na nota.',
      );
    }

    // Já gerada → só baixa a etiqueta de novo (reimpressão).
    if (doc.trackingCode) {
      const pdf = await this.baixarPdf(doc);
      return { ok: true, jaGerado: true, codigoRastreio: doc.trackingCode, carrier: doc.carrier, etiquetaPdf: pdf };
    }

    // Destinatário direto do XML autorizado da nota.
    const xml = String(doc.xmlAutorizado || doc.xmlEnviado || '');
    const trecho = xml.slice(xml.indexOf('<dest>'), xml.indexOf('</dest>') + 7);
    if (!trecho.includes('<enderDest>')) {
      throw new BadRequestException('A NF-e da venda não tem endereço do destinatário — emita a nota com o endereço completo.');
    }
    const destinatario = {
      nome: this.desescapa(this.tag(trecho, 'xNome')).slice(0, 50) || 'CLIENTE',
      cpfCnpj: this.tag(trecho, 'CPF') || this.tag(trecho, 'CNPJ') || undefined,
      endereco: this.desescapa(this.tag(trecho, 'xLgr')),
      numero: this.tag(trecho, 'nro') || 'S/N',
      complemento: this.desescapa(this.tag(trecho, 'xCpl')),
      bairro: this.desescapa(this.tag(trecho, 'xBairro')),
      cidade: this.desescapa(this.tag(trecho, 'xMun')),
      uf: this.tag(trecho, 'UF'),
      cep: this.tag(trecho, 'CEP').replace(/\D/g, ''),
    };
    if (!destinatario.endereco || destinatario.cep.length !== 8) {
      throw new BadRequestException('Endereço do destinatário incompleto na NF-e (logradouro/CEP).');
    }

    const chave = String(doc.chave || '').replace(/\D/g, '');
    const servico: 'PAC' | 'SEDEX' = opts.servico === 'SEDEX' ? 'SEDEX' : 'PAC';
    const pecas = (sale.items || [])
      .filter((it: any) => String(it.ref || it.sku || '').trim().toUpperCase() !== 'FRETE')
      .reduce((s: number, it: any) => s + Math.max(1, Number(it.qty) || 1), 0) || 1;
    const pesoGramas = Math.max(300, pecas * 200);
    const valor = (Number(doc.valorTotalCents) || 0) / 100;
    const itensDeclaracao = (sale.items || [])
      .filter((it: any) => String(it.ref || it.sku || '').trim().toUpperCase() !== 'FRETE')
      .slice(0, 50)
      .map((it: any) => ({ conteudo: String(it.descricao || it.sku || 'Vestuário').slice(0, 60), quantidade: String(it.qty || 1) }));

    const origem = await this.remetente(String(sale.storeCode));

    const senderId = maisEnviosStores()[String(sale.storeCode)];
    const routingOn = String(process.env.MAISENVIOS_ROUTING || '').trim() === '1';
    let r: { codigoRastreio: string; idPrepostagem: string | null; carrier: string; etiquetaPdf: string | null };
    if (routingOn && senderId) {
      const resp: any = await this.maisEnvios.criarPrepost({
        senderId,
        servico,
        destinatario: {
          nome: destinatario.nome,
          cpf: destinatario.cpfCnpj || '',
          cep: destinatario.cep,
          endereco: destinatario.endereco,
          numero: destinatario.numero,
          complemento: destinatario.complemento || '',
          bairro: destinatario.bairro,
          cidade: destinatario.cidade,
          uf: destinatario.uf,
          telefone: '',
          email: '',
        },
        pesoGramas,
        valorDeclarado: valor || undefined,
        nfe: { chave, numero: doc.numero, serie: doc.serie, valor },
        referencia: `venda ${String(saleId).slice(0, 8)}`,
        departamento: `LOJA ${sale.storeCode}`,
        itens: itensDeclaracao.map((i: any) => ({ conteudo: i.conteudo, quantidade: Number(i.quantidade) || 1 })),
      });
      if (!resp?.ok || !resp.tag) throw new BadRequestException(`Mais Envios recusou: ${resp?.erro || 'sem tag'}`);
      r = { codigoRastreio: resp.tag, idPrepostagem: resp.idPrepostagem ? String(resp.idPrepostagem) : null, carrier: `Mais Envios ${servico}`, etiquetaPdf: null };
      try { const et = await this.maisEnvios.baixarEtiqueta(resp.tag); if (et?.ok && et.pdfBase64) r.etiquetaPdf = et.pdfBase64; } catch { /* opcional */ }
    } else {
      const resp: any = await this.correios.criarPrepostagem({
        servico,
        remetente: origem,
        destinatario,
        pesoGramas,
        valorDeclarado: valor || undefined,
        nfeChave: chave.length === 44 ? chave : undefined,
        itensDeclaracao,
      });
      if (!resp?.ok) throw new BadRequestException(`Correios recusaram: ${resp?.erro || 'erro'}`);
      r = { codigoRastreio: resp.codigoRastreio, idPrepostagem: resp.idPrepostagem ? String(resp.idPrepostagem) : null, carrier: `Correios ${servico}`, etiquetaPdf: null };
      if (r.idPrepostagem) {
        try { const et = await this.correios.baixarEtiqueta(r.idPrepostagem); if (et?.ok && et.pdfBase64) r.etiquetaPdf = et.pdfBase64; } catch { /* baixa depois */ }
      }
    }

    await this.prisma.nfeDoc.update({
      where: { id: doc.id },
      data: {
        trackingCode: r.codigoRastreio,
        correiosPrepostagemId: r.idPrepostagem,
        carrier: r.carrier,
        envioGeneratedAt: new Date(),
      } as any,
    });
    this.logger.log(
      `[venda-etiqueta] venda ${saleId} loja ${sale.storeCode}: ${r.carrier} ${r.codigoRastreio} (NF-e ${doc.numero}, ${pecas} peça(s), ${pesoGramas}g) — ${opts.userName || '?'}`,
    );
    return { ok: true, jaGerado: false, codigoRastreio: r.codigoRastreio, carrier: r.carrier, etiquetaPdf: r.etiquetaPdf };
  }

  private async baixarPdf(doc: any): Promise<string | null> {
    try {
      if (String(doc.carrier || '').includes('Mais Envios')) {
        const et: any = await this.maisEnvios.baixarEtiqueta(doc.trackingCode);
        return et?.ok && et.pdfBase64 ? et.pdfBase64 : null;
      }
      if (doc.correiosPrepostagemId) {
        const et: any = await this.correios.baixarEtiqueta(String(doc.correiosPrepostagemId));
        return et?.ok && et.pdfBase64 ? et.pdfBase64 : null;
      }
    } catch (e) {
      this.logger.warn(`[venda-etiqueta] etiqueta indisponível (${doc.trackingCode}): ${(e as Error).message}`);
    }
    return null;
  }
}
