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

  /** Cota preço + prazo (PAC/SEDEX) por CEP destino. Peso em GRAMAS. */
  async calcularFrete(input: { cepDestino: string; pesoGramas?: number; comprimento?: number; largura?: number; altura?: number }) {
    const destiny = String(input.cepDestino || '').replace(/\D/g, '');
    const source = this.auth.cepOrigem;
    if (destiny.length !== 8) throw new BadRequestException('CEP destino inválido (8 dígitos).');
    if (source.length !== 8) throw new BadRequestException('CEP de origem não configurado (MAISENVIOS_CEP_ORIGEM).');

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
          precoReais = parseBRL(d?.price ?? d?.value ?? d?.pcFinal ?? d?.valor ?? d?.total);
          prazoDias = d?.deadline != null ? Number(d.deadline) : (d?.prazo != null ? Number(d.prazo) : null);
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

  /** Rastreia um objeto pela tag/código. */
  async rastrear(tag: string) {
    const t = String(tag || '').trim();
    if (!t) throw new BadRequestException('Código/tag obrigatório.');
    const headers = await this.auth.authHeader();
    const r = await axios.get(`${this.auth.baseUrl}/tracking/tag/${encodeURIComponent(t)}`, { headers, timeout: 20000, validateStatus: () => true });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data };
  }
}
