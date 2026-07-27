import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Autenticação na API do Mais Envios (portalmaisenvios.com.br).
 *
 * Login por usuário/senha → JWT (Bearer). Token cacheado em memória (renova
 * pelo `exp` do JWT, com folga de 5 min).
 *
 * Credenciais via env (Railway):
 *   MAISENVIOS_USER          usuário (e-mail de login do portal)
 *   MAISENVIOS_PASS          senha
 *   MAISENVIOS_CUSTOMER      id do cliente na conta (UUID) — usado na pré-postagem
 *   MAISENVIOS_CARDPOST      cartão de postagem
 *   MAISENVIOS_PRICETABLE    tabela de preço
 *   MAISENVIOS_CEP_ORIGEM    CEP de origem das postagens
 *   MAISENVIOS_SERVICO_PAC   default 03298 · MAISENVIOS_SERVICO_SEDEX default 03220
 */
@Injectable()
export class MaisEnviosAuthService {
  private readonly logger = new Logger(MaisEnviosAuthService.name);
  private cachedToken: { token: string; expiraEm: number } | null = null;

  get baseUrl(): string {
    return String(process.env.MAISENVIOS_BASE_URL || 'https://portalmaisenvios.com.br/api').replace(/\/+$/, '');
  }

  get configured(): boolean {
    return !!(process.env.MAISENVIOS_USER && process.env.MAISENVIOS_PASS);
  }

  get customer(): string { return String(process.env.MAISENVIOS_CUSTOMER || '').trim(); }
  get cardpost(): string { return String(process.env.MAISENVIOS_CARDPOST || '').trim(); }
  get pricetable(): string { return String(process.env.MAISENVIOS_PRICETABLE || '').trim(); }
  get cepOrigem(): string { return String(process.env.MAISENVIOS_CEP_ORIGEM || '').replace(/\D/g, ''); }

  /** Token válido (renova se faltar < 5 min pra expirar). */
  async getToken(): Promise<string> {
    if (!this.configured) {
      throw new BadRequestException('Mais Envios não configurado. Defina MAISENVIOS_USER e MAISENVIOS_PASS no Railway.');
    }
    const agora = Date.now();
    if (this.cachedToken && this.cachedToken.expiraEm - agora > 5 * 60 * 1000) {
      return this.cachedToken.token;
    }
    try {
      const resp = await axios.post(
        `${this.baseUrl}/auth/login`,
        { username: String(process.env.MAISENVIOS_USER).trim(), password: String(process.env.MAISENVIOS_PASS) },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20000, validateStatus: () => true },
      );
      const token = resp.data?.token ?? resp.data?.access_token ?? resp.data?.accessToken ?? resp.data?.jwt ?? null;
      if (resp.status < 200 || resp.status >= 300 || !token) {
        const msg = resp.data?.message || resp.data?.error || (typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {}).slice(0, 300)) || `HTTP ${resp.status}`;
        throw new BadRequestException(`Mais Envios recusou a autenticação (HTTP ${resp.status}): ${msg}`);
      }
      // Expiração pelo `exp` do JWT, se der pra decodificar; senão +11h.
      let expiraEm = agora + 11 * 60 * 60 * 1000;
      try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        if (payload?.exp) expiraEm = payload.exp * 1000;
      } catch { /* token não-JWT */ }
      this.cachedToken = { token: String(token), expiraEm };
      this.logger.log(`[maisenvios] token obtido, expira ${new Date(expiraEm).toISOString()}`);
      return this.cachedToken.token;
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`Falha ao autenticar no Mais Envios: ${e?.message || e}`);
    }
  }

  async authHeader(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }
}
