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

    const body: any = {
      customer: this.auth.customer || s.customer || undefined,
      cardpost: this.auth.cardpost || undefined,
      pricetable: this.auth.pricetable ? Number(this.auth.pricetable) : undefined,
      service: codigo,
      integratorId: 'flowops',
      sender: {
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
        delivery: 'normal', contact: d.nome, department: '', name: d.nome, branch: '',
        cep: onlyDigits(d.cep), address: d.endereco, number: String(d.numero || 'S/N'),
        neighborhood: d.bairro || '', city: d.cidade || '', state: d.uf || '', extent: d.complemento || '',
      },
      contact: {
        phone: onlyDigits(d.telefone), mail: d.email || '', federalid: onlyDigits(d.cpf),
        invoice: '', care: '', note: '', request: '', observation: '', save: false, whatsapp: false,
      },
      object: {
        object: 'Vestuário', package: '2', type: '1',
        weight: Math.max(1, Math.round(input.pesoGramas)), quantity: 1,
        ar: false, ardigital: false, ownhand: false, ap: false,
      },
      // Tipo do complemento = formato do volume (validação da API, 28/07):
      // 001 = Pacote/Caixa · 002 = Envelope · 003 = Rolo/Cilindro.
      // Roupa vai em pacote → 001. Ajustável via MAISENVIOS_COMPLEMENT_JSON.
      complement: (() => {
        try { return JSON.parse(process.env.MAISENVIOS_COMPLEMENT_JSON || '{"type":"001"}'); }
        catch { return { type: '001' }; }
      })(),
      nf: {
        nfeKey: String(input.nfe?.chave || '').replace(/\D/g, ''),
        nfeNumber: Number(input.nfe?.numero || 0),
        nfeSerie: Number(input.nfe?.serie || 0),
        nfeValue: String(input.valorDeclarado ?? input.nfe?.valor ?? 0),
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
    const d2: any = resp.data || {};
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

  /** Baixa a etiqueta (PDF) de uma pré-postagem pela tag. */
  async baixarEtiqueta(tag: string): Promise<any> {
    const t = String(tag || '').trim();
    if (!t) throw new BadRequestException('tag obrigatória');
    const headers = await this.auth.authHeader();
    const resp = await axios.post(`${this.auth.baseUrl}/prepost/print`, { tag: [t], options: {}, customer: this.auth.customer || undefined }, { headers, timeout: 30000, validateStatus: () => true });
    if (resp.status < 200 || resp.status >= 300) {
      return { ok: false, erro: resp.data?.message || `HTTP ${resp.status}`, raw: resp.data };
    }
    const pdf = resp.data?.pdf ?? resp.data?.dados ?? resp.data?.base64 ?? (typeof resp.data === 'string' ? resp.data : null);
    return pdf ? { ok: true, pdfBase64: String(pdf) } : { ok: false, erro: 'sem PDF na resposta', raw: resp.data };
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
