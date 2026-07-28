import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { MaisEnviosAuthService } from './mais-envios-auth.service';

/**
 * Serviços do Mais Envios (portalmaisenvios.com.br) — cotação de frete,
 * descoberta de conta (services/senders), pré-postagem, etiqueta e rastreio.
 *
 * Códigos de serviço (mesmos dos Correios COM contrato, por padrão):
 *   PAC = 03298 · SEDEX = 03220 — override por env MAISENVIOS_SERVICO_*.
 */
@Injectable()
export class MaisEnviosService {
  private readonly logger = new Logger(MaisEnviosService.name);
  constructor(private readonly auth: MaisEnviosAuthService) {}

  private get servicos(): Array<{ nome: 'PAC' | 'SEDEX'; codigo: string }> {
    return [
      { nome: 'PAC', codigo: String(process.env.MAISENVIOS_SERVICO_PAC || '03298').trim() },
      { nome: 'SEDEX', codigo: String(process.env.MAISENVIOS_SERVICO_SEDEX || '03220').trim() },
    ];
  }

  status() {
    return {
      configurado: this.auth.configured,
      base: this.auth.baseUrl,
      usuario: process.env.MAISENVIOS_USER ? String(process.env.MAISENVIOS_USER).trim() : null,
      customer: this.auth.customer || null,
      cardpost: this.auth.cardpost ? '••••' + this.auth.cardpost.slice(-4) : null,
      pricetable: this.auth.pricetable || null,
      cepOrigem: this.auth.cepOrigem || null,
      servicos: this.servicos,
    };
  }

  /** Cota preço + prazo (PAC/SEDEX). Peso em GRAMAS. `cepOrigem` vem por loja
   *  (na Parte 2) ou digitado na tela de diagnóstico; cai pra env se não vier. */
  async calcularFrete(input: { cepDestino: string; cepOrigem?: string; pesoGramas?: number; comprimento?: number; largura?: number; altura?: number }) {
    const destiny = String(input.cepDestino || '').replace(/\D/g, '');
    const source = (String(input.cepOrigem || '').replace(/\D/g, '')) || this.auth.cepOrigem;
    if (destiny.length !== 8) throw new BadRequestException('CEP destino inválido (8 dígitos).');
    if (source.length !== 8) throw new BadRequestException('Informe o CEP de origem (cada loja tem o seu).');

    const peso = Math.max(300, Number(input.pesoGramas) || 500);
    const length = Number(input.comprimento) || 30;
    const width = Number(input.largura) || 20;
    const height = Number(input.altura) || 10;

    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;
    const opcoes: Array<{ servico: string; codigo: string; precoReais: number | null; prazoDias: number | null; erro?: string; raw?: any }> = [];

    for (const s of this.servicos) {
      let precoReais: number | null = null;
      let prazoDias: number | null = null;
      let erro: string | undefined;
      let raw: any = null;
      try {
        const body: any = {
          service: s.codigo,
          source,
          destiny,
          weigth: peso, weidth: peso, // a doc tem os dois (typo) — mando ambos = peso
          length, width, height, diameter: 0,
          ownhand: false, warning: false, ap: false, digital: false,
          format: '001', valuedeclared: 0, volumes: [],
          ...(this.auth.customer ? { customer: this.auth.customer } : {}),
        };
        const resp = await axios.post(`${base}/price.deadline/deadlinePrice`, body, { headers, timeout: 20000, validateStatus: () => true });
        raw = resp.data;
        if (resp.status >= 200 && resp.status < 300) {
          const d = Array.isArray(resp.data) ? resp.data[0] : resp.data;
          const parseBRL = (v: any) => {
            if (v == null) return null;
            const t = String(v).trim();
            return t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t);
          };
          // Resposta do Mais Envios: preço em `pricetable`, prazo em `deadlineDays`.
          precoReais = parseBRL(d?.pricetable ?? d?.price ?? d?.value ?? d?.valor ?? d?.total);
          const pz = d?.deadlineDays ?? d?.deadline ?? d?.prazo;
          prazoDias = pz != null ? Number(pz) : null;
        } else {
          erro = resp.data?.message || resp.data?.error || `HTTP ${resp.status}`;
        }
      } catch (e: any) {
        erro = e?.message || 'falha';
      }
      opcoes.push({ servico: s.nome, codigo: s.codigo, precoReais, prazoDias, erro, raw });
    }
    return { source, destiny, pesoGramas: peso, opcoes };
  }

  /** Detalhe completo de um remetente (número/bairro/cidade/UF que a lista não traz). */
  private async senderDetalhe(senderId: number | string): Promise<any> {
    const headers = await this.auth.authHeader();
    const r = await axios.get(`${this.auth.baseUrl}/senders/${senderId}`, { headers, timeout: 20000, validateStatus: () => true });
    return (r.status >= 200 && r.status < 300) ? r.data : null;
  }

  /**
   * Cria a PRÉ-POSTAGEM no Mais Envios (POST /prepost) a partir do pedido.
   * ESQUELETO — o corpo segue a doc CWS do Mais Envios; devolve a resposta CRUA
   * pra ajustar campos (customer/cardpost/pricetable e sub-objetos) no 1º teste,
   * igual foi no Correios.
   */
  async criarPrepost(input: {
    senderId: number | string;
    servico: 'PAC' | 'SEDEX';
    destinatario: { nome: string; cpf?: string; cep: string; endereco: string; numero: string; complemento?: string; bairro: string; cidade: string; uf: string; telefone?: string; email?: string };
    pesoGramas: number;
    valorDeclarado?: number;
    /** Referência ÚNICA do envio (nº do pedido/pick) — vai no contact.invoice/
     *  request. Vazio repetido é suspeito de colidir ("Etiqueta já cadastrada"). */
    referencia?: string;
    /** Nome da loja do envio — vira o "Departamento" na lista do portal. */
    departamento?: string;
    /** NF-e do envio (emitida antes da etiqueta). Sem ela o nf.nfeKey vai vazio
     *  e o Mais Envios COLIDE ("Etiqueta já cadastrada" — visto 28/07: a chave
     *  vazia é única no sistema deles). */
    nfe?: { chave: string; numero?: number; serie?: string | number; valor?: number };
    itens: Array<{ conteudo: string; quantidade?: number }>;
  }): Promise<any> {
    const codigo = this.servicos.find((s) => s.nome === input.servico)?.codigo;
    if (!codigo) throw new BadRequestException(`Serviço inválido: ${input.servico}`);
    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;
    const s = (await this.senderDetalhe(input.senderId)) || {};
    const d = input.destinatario;
    const onlyDigits = (v: any) => String(v || '').replace(/\D/g, '');

    // ═══ MOLDE DO PORTAL (payload REAL capturado no DevTools, 28/07) ═══
    // customer/cardpost = UUIDs da conta (envs); package = UUID de embalagem;
    // complement carrega DIMENSÕES + tipo + typeContent + nfeKey; pricetable é
    // o PREÇO cotado; delivery.delivery vazio (destinatário inline). O formato
    // aninhado antigo (da doc) meio-validava e morria com "Etiqueta já
    // cadastrada" — este é o formato que o portal usa com sucesso diário.
    const customer = this.auth.customer;
    const cardpost = this.auth.cardpost;
    if (!customer || !cardpost) {
      throw new BadRequestException('Mais Envios: defina MAISENVIOS_CUSTOMER e MAISENVIOS_CARDPOST (UUIDs da conta) no Railway.');
    }
    const pacote = {
      id: process.env.MAISENVIOS_PACKAGE_ID || 'c631a267-2cf5-4b93-a653-8ebc71830a64', // "Caixa 1" (M08 24×17×10)
      height: Number(process.env.MAISENVIOS_PKG_ALTURA || 10),
      length: Number(process.env.MAISENVIOS_PKG_COMPRIMENTO || 24),
      width: Number(process.env.MAISENVIOS_PKG_LARGURA || 17),
    };
    // O portal manda o PREÇO do serviço escolhido no pricetable → cota antes
    let pricetable = 0;
    try {
      const cot = await this.calcularFrete({
        cepDestino: d.cep, cepOrigem: s.zipcode || s.cep, pesoGramas: input.pesoGramas,
        comprimento: pacote.length, largura: pacote.width, altura: pacote.height,
      });
      const op = (cot.opcoes || []).find((o: any) => o.codigo === codigo);
      if (op?.precoReais) pricetable = op.precoReais;
    } catch { /* sem cotação → 0; a API acusa se exigir */ }

    const chave = String(input.nfe?.chave || '').replace(/\D/g, '');
    const cepDash = (v: any) => { const dd = onlyDigits(v); return dd.length === 8 ? `${dd.slice(0, 5)}-${dd.slice(5)}` : dd; };
    const referencia = String(input.referencia || '').slice(0, 40);

    const body: any = {
      customer,
      cardpost,
      service: codigo,
      pricetable,
      primary: '',
      sender: {
        sender: '',
        contact: s.name || s.contact || 'LURDS',
        federalId: onlyDigits(s.federalid || s.federalId),
        cep: onlyDigits(s.zipcode || s.cep),
        address: s.address || '',
        number: String(s.number || 'S/N'),
        neighborhood: s.neighborhood || '',
        city: s.city || '',
        state: s.state || '',
        extent: s.complement || s.extent || '',
      },
      delivery: {
        delivery: '',
        department: String(input.departamento || '').toUpperCase().slice(0, 30),
        contact: d.nome,
        name: d.nome,
        cep: cepDash(d.cep),
        address: d.endereco,
        number: String(d.numero || 'S/N'),
        neighborhood: d.bairro || '',
        city: d.cidade || '',
        state: d.uf || '',
        extent: d.complemento || '',
      },
      contact: {
        save: false,
        invoice: referencia,
        request: referencia,
        care: '',
        mail: d.email || '',
        phone: onlyDigits(d.telefone),
        federalid: onlyDigits(d.cpf),
        observation: '',
        note: '',
        whatsapp: false,
      },
      object: {
        ownhand: false,
        ar: false,
        ardigital: false,
        ap: false,
        weight: String(Math.max(1, Math.round(input.pesoGramas))),
        quantity: 1,
        package: pacote.id,
      },
      complement: {
        value: Number(input.valorDeclarado ?? input.nfe?.valor ?? 0),
        height: pacote.height,
        length: pacote.length,
        width: pacote.width,
        diameter: 1,
        type: '001',
        // typeContent (radio do portal): 1 = Com nota fiscal · 4 = Enviar NF-e depois
        typeContent: chave ? '1' : '4',
        nfeKey: chave,
      },
      nf: {
        nfeKey: chave,
        nfeNumber: input.nfe?.numero ? String(input.nfe.numero) : '',
        nfeSerie: input.nfe?.serie ? String(input.nfe.serie) : '',
      },
      dc: (input.itens || []).map((it) => ({ conteudo: String(it.conteudo || 'Vestuário').slice(0, 60), quantidade: String(it.quantidade ?? 1) })),
    };

    // DEBUG da homologação (28/07): payload e resposta CRUS nos logs do Railway
    // pra enxergar a causa do "Etiqueta já cadastrada" (buscar "maisenvios").
    console.log(`[maisenvios] prepost PAYLOAD: ${JSON.stringify(body).slice(0, 1500)}`);
    const resp = await axios.post(`${base}/prepost`, body, { headers, timeout: 30000, validateStatus: () => true });
    console.log(`[maisenvios] prepost RESPOSTA HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 1500)}`);
    if (resp.status < 200 || resp.status >= 300) {
      return { ok: false, erro: resp.data?.message || resp.data?.error || (Array.isArray(resp.data?.msgs) ? resp.data.msgs.join('; ') : `HTTP ${resp.status}`), raw: resp.data };
    }
    // A pré-postagem CRIA com sucesso (2xx) — validado 28/07 — mas o nome do
    // campo da tag no retorno ainda não é conhecido: prova o máximo de nomes
    // e, se nada bater, devolve o CORPO CRU no erro pra tela mostrar o formato.
    // A resposta vem como ARRAY [{ id, tag, status, ... }] (visto 28/07 no 1º
    // sucesso real: tag AD731902123BR) — desembrulha antes de procurar a tag.
    const dResp: any = resp.data || {};
    const d2: any = Array.isArray(dResp) ? (dResp[0] || {}) : dResp;
    const tag = d2.tag ?? d2.codigo ?? d2.objeto ?? d2.tracking ?? d2.etiqueta ?? d2.code ??
      d2.prepost?.tag ?? d2.data?.tag ?? d2.data?.tracking ?? d2.data?.codigo ?? null;
    if (!tag) {
      return { ok: false, erro: `pré-postagem criada mas sem tag no retorno — corpo: ${JSON.stringify(d2).slice(0, 250)}`, raw: d2 };
    }
    return {
      ok: true,
      tag: String(tag),
      idPrepostagem: d2.id ?? d2.data?.id ?? null,
      raw: d2,
    };
  }

  /** DIAG: GET cru autenticado em qualquer path da API (ex.: /prepost) —
   *  pra enxergar as etiquetas criadas que não aparecem no painel. */
  async diagGet(path: string): Promise<any> {
    const p = String(path || '').trim();
    if (!p.startsWith('/')) throw new BadRequestException('path deve começar com /');
    const headers = await this.auth.authHeader();
    const resp = await axios.get(`${this.auth.baseUrl}${p}`, { headers, timeout: 20000, validateStatus: () => true });
    return { status: resp.status, data: resp.data };
  }

  /** Baixa a etiqueta (PDF) de uma pré-postagem pela tag. Logo após a criação
   *  a API pode ainda estar processando — repesca até 3× com 2s de espera. */
  async baixarEtiqueta(tag: string): Promise<any> {
    let ultimo: any = null;
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2000));
      ultimo = await this.baixarEtiquetaOnce(tag);
      if (ultimo?.ok && ultimo.pdfBase64) return ultimo;
    }
    return ultimo;
  }

  private async baixarEtiquetaOnce(tag: string): Promise<any> {
    const t = String(tag || '').trim();
    if (!t) throw new BadRequestException('tag obrigatória');
    const headers = await this.auth.authHeader();
    // MOLDE DO PORTAL (capturado 28/07): o options PRECISA vir preenchido —
    // vazio, a API responde 201 com corpo null. Com ele, a resposta é o
    // PRÓPRIO PDF binário (%PDF...), então baixamos como arraybuffer.
    const printBody = { tag: [t], options: { declared: true, warning: true, model: '1', type: '1' } };
    const resp = await axios.post(`${this.auth.baseUrl}/prepost/print`, printBody, {
      headers, timeout: 30000, validateStatus: () => true, responseType: 'arraybuffer',
    });
    const buf = Buffer.from(resp.data || []);
    console.log(`[maisenvios] print ${t}: HTTP ${resp.status}, ${buf.length} bytes, head="${buf.slice(0, 8).toString('utf8').replace(/[^\x20-\x7E]/g, '.')}"`);
    if (resp.status < 200 || resp.status >= 300) {
      let msg = `HTTP ${resp.status}`;
      try { msg = JSON.parse(buf.toString('utf8'))?.message || msg; } catch { /* binário */ }
      return { ok: false, erro: msg };
    }
    if (buf.slice(0, 5).toString('utf8').startsWith('%PDF')) {
      return { ok: true, pdfBase64: buf.toString('base64') };
    }
    // Não veio PDF: tenta interpretar como JSON (base64/url em algum campo)
    try {
      const dRaw: any = JSON.parse(buf.toString('utf8'));
      const d: any = Array.isArray(dRaw) ? (dRaw[0] || {}) : dRaw;
      let pdf = d?.pdf ?? d?.dados ?? d?.base64 ?? d?.file ?? d?.etiqueta ?? null;
      const url = d?.url ?? d?.link ?? null;
      if (!pdf && url) {
        const bin = await axios.get(String(url), { responseType: 'arraybuffer', timeout: 30000 });
        pdf = Buffer.from(bin.data).toString('base64');
      }
      if (pdf) return { ok: true, pdfBase64: String(pdf) };
      return { ok: false, erro: 'sem PDF na resposta', raw: dRaw };
    } catch {
      return { ok: false, erro: `resposta inesperada (${buf.length} bytes)` };
    }
  }

  /** DESCOBERTA: lista os serviços disponíveis na conta. */
  async listarServices() {
    const headers = await this.auth.authHeader();
    const r = await axios.get(`${this.auth.baseUrl}/services`, { headers, timeout: 20000, validateStatus: () => true });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data };
  }

  /** DESCOBERTA: lista os remetentes/senders cadastrados na conta. */
  async listarSenders() {
    const headers = await this.auth.authHeader();
    const r = await axios.get(`${this.auth.baseUrl}/senders`, { headers, timeout: 20000, validateStatus: () => true });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data };
  }

  /** DESCOBERTA: dados da conta (customer) + tabelas de preço — pra achar o
   *  `customer` que faz a cotação usar a tabela NEGOCIADA (não a cheia). */
  async descobrirConta() {
    const headers = await this.auth.authHeader();
    const base = this.auth.baseUrl;
    const get = async (path: string) => {
      try {
        const r = await axios.get(`${base}${path}`, { headers, timeout: 20000, validateStatus: () => true });
        return { status: r.status, data: r.data };
      } catch (e: any) { return { erro: e?.message || 'falha' }; }
    };
    return {
      me: await get('/customers/data/me'),
      pricetables: await get('/pricetable'),
    };
  }

  /** Rastreia um objeto pela tag/código. */
  async rastrear(tag: string) {
    const t = String(tag || '').trim();
    if (!t) throw new BadRequestException('Código/tag obrigatório.');
    const headers = await this.auth.authHeader();
    const r = await axios.get(`${this.auth.baseUrl}/tracking/tag/${encodeURIComponent(t)}`, { headers, timeout: 20000, validateStatus: () => true });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data };
  }
}
