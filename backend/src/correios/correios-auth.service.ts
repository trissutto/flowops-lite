import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Autenticação na API dos Correios (CWS — "Meu Correios"), que SUBSTITUI o
 * SIGEP Web legado (SOAP, descontinuado).
 *
 * Fluxo OAuth (token válido ~24h, cacheado em memória):
 *   POST {base}/token/v1/autentica/cartaopostagem
 *   Header: Authorization: Basic base64(usuario:codigoAcessoAPI)
 *   Body:   { "numero": "<numero do cartão de postagem>" }
 *   → { token, expiraEm, ... }
 *
 * Credenciais via env (Railway):
 *   CORREIOS_API_USER          usuário do Meu Correios
 *   CORREIOS_API_TOKEN         código de acesso à API (gerado no portal)
 *   CORREIOS_CARTAO_POSTAGEM   número do cartão de postagem
 *   CORREIOS_CONTRATO          número do contrato
 *   CORREIOS_AMBIENTE          'prod' (default) | 'hom'
 *   CORREIOS_CEP_ORIGEM        CEP de origem das postagens (8 dígitos)
 */
@Injectable()
export class CorreiosAuthService {
  private readonly logger = new Logger(CorreiosAuthService.name);
  private cachedToken: { token: string; expiraEm: number } | null = null;

  get baseUrl(): string {
    const amb = String(process.env.CORREIOS_AMBIENTE ?? 'prod').trim();
    return amb === 'hom' ? 'https://apihom.correios.com.br' : 'https://api.correios.com.br';
  }

  get configured(): boolean {
    return !!(
      process.env.CORREIOS_API_USER &&
      process.env.CORREIOS_API_TOKEN &&
      process.env.CORREIOS_CARTAO_POSTAGEM
    );
  }

  get cartaoPostagem(): string {
    return String(process.env.CORREIOS_CARTAO_POSTAGEM || '').trim();
  }
  get contrato(): string {
    return String(process.env.CORREIOS_CONTRATO || '').trim();
  }
  get cepOrigem(): string {
    return String(process.env.CORREIOS_CEP_ORIGEM || '').replace(/\D/g, '');
  }

  /** Token válido (renova se faltar < 5 min pra expirar). */
  async getToken(): Promise<string> {
    if (!this.configured) {
      throw new BadRequestException(
        'Correios não configurado. Defina CORREIOS_API_USER, CORREIOS_API_TOKEN e CORREIOS_CARTAO_POSTAGEM no Railway.',
      );
    }
    const agora = Date.now();
    if (this.cachedToken && this.cachedToken.expiraEm - agora > 5 * 60 * 1000) {
      return this.cachedToken.token;
    }
    const user = String(process.env.CORREIOS_API_USER || '').trim();
    const pass = String(process.env.CORREIOS_API_TOKEN || '').trim();
    const basic = Buffer.from(`${user}:${pass}`).toString('base64');
    try {
      const resp = await axios.post(
        `${this.baseUrl}/token/v1/autentica/cartaopostagem`,
        { numero: this.cartaoPostagem },
        {
          headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
          timeout: 20000,
          validateStatus: () => true,
        },
      );
      if (resp.status < 200 || resp.status >= 300 || !resp.data?.token) {
        const msg = resp.data?.mensagens?.join('; ') || resp.data?.message || `HTTP ${resp.status}`;
        throw new BadRequestException(`Correios recusou a autenticação: ${msg}`);
      }
      // expiraEm vem em ISO ("2026-07-25T18:00:00") — cai pra +23h se ausente.
      const expIso = resp.data?.expiraEm;
      const expiraEm = expIso ? new Date(expIso).getTime() : agora + 23 * 60 * 60 * 1000;
      this.cachedToken = { token: resp.data.token, expiraEm };
      this.logger.log(`[correios] token obtido, expira ${new Date(expiraEm).toISOString()}`);
      return this.cachedToken.token;
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`Falha ao autenticar nos Correios: ${e?.message || e}`);
    }
  }

  /** Header pronto (Bearer) pras chamadas de serviço. */
  async authHeader(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }
}
