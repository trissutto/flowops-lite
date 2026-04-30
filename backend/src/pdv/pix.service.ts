import { Injectable, Logger } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PixService — gera BR Code (PIX EMVCo) com valor cravado e QR Code.
 *
 * Padrão: BR Code (Banco Central do Brasil) baseado em EMVCo MPM.
 * Estrutura TLV (Tag-Length-Value) com CRC16-CCITT-False no final.
 *
 * Aqui geramos PIX ESTÁTICO COM VALOR — funciona em qualquer app de banco,
 * sem precisar de API. O valor cai direto na conta da chave PIX cadastrada.
 *
 * Configuração padrão (pode ser sobrescrita por SystemSetting depois):
 *   - Chave: 5513996218277 (celular Lurd's)
 *   - Nome: LURDS PLUS SIZE
 *   - Cidade: ITANHAEM
 *
 * Limitação: NÃO há confirmação automática (precisaria de API do banco).
 * A vendedora confirma manualmente após ver o pagamento no app do banco.
 */
@Injectable()
export class PixService {
  private readonly logger = new Logger(PixService.name);

  // Defaults (sobrescritos por SystemSetting/env). CHAVE precisa estar
  // CADASTRADA no banco do recebedor — caso contrário o QR fica inválido.
  private readonly DEFAULT_CHAVE = process.env.PIX_DEFAULT_KEY || '+5513996218277';
  private readonly DEFAULT_NOME = process.env.PIX_DEFAULT_NAME || 'LURDS PLUS SIZE';
  private readonly DEFAULT_CIDADE = process.env.PIX_DEFAULT_CITY || 'ITANHAEM';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lê config PIX do SystemSetting (override via UI). Fallback: env/default.
   */
  async getConfig(): Promise<{ chave: string; nome: string; cidade: string; tipoChave: string }> {
    const get = async (key: string, def: string) => {
      try {
        const r = await (this.prisma as any).systemSetting.findUnique({ where: { key } });
        return r?.value || def;
      } catch { return def; }
    };
    return {
      chave: await get('pix_chave', this.DEFAULT_CHAVE),
      nome: await get('pix_nome', this.DEFAULT_NOME),
      cidade: await get('pix_cidade', this.DEFAULT_CIDADE),
      tipoChave: await get('pix_tipo_chave', 'telefone'), // cpf | cnpj | email | telefone | aleatoria
    };
  }

  async saveConfig(input: { chave?: string; nome?: string; cidade?: string; tipoChave?: string }): Promise<void> {
    const upsert = async (key: string, value: string) => {
      await (this.prisma as any).systemSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    };
    if (input.chave !== undefined)     await upsert('pix_chave', String(input.chave).trim());
    if (input.nome !== undefined)      await upsert('pix_nome', String(input.nome).trim());
    if (input.cidade !== undefined)    await upsert('pix_cidade', String(input.cidade).trim());
    if (input.tipoChave !== undefined) await upsert('pix_tipo_chave', String(input.tipoChave).trim());
  }

  /**
   * Monta o payload PIX (string BR Code) + gera QR Code em base64 (data URL).
   */
  async generatePixCharge(input: {
    valor: number;
    txid?: string;
    chave?: string;
    nome?: string;
    cidade?: string;
    descricao?: string;
  }): Promise<{
    txid: string;
    valor: number;
    chave: string;
    payload: string;
    qrCodeDataUrl: string;
  }> {
    const cfg = await this.getConfig();
    const chaveRaw = (input.chave || cfg.chave).trim();
    const chave = this.normalizeChave(chaveRaw, cfg.tipoChave);
    const nome = this.sanitizeAscii(input.nome || cfg.nome, 25);
    const cidade = this.sanitizeAscii(input.cidade || cfg.cidade, 15);
    const valor = Math.max(0, input.valor || 0);
    const txid = this.sanitizeTxid(input.txid || this.generateTxid());

    const payload = this.buildBrCode({
      chave,
      nome,
      cidade,
      valor,
      txid,
      descricao: input.descricao,
    });

    // Gera QR Code PNG em base64
    const qrCodeDataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 1,
      width: 400,
      color: { dark: '#000000', light: '#FFFFFF' },
    });

    this.logger.log(`[pix] Cobrança gerada: txid=${txid} valor=R$${valor.toFixed(2)}`);

    return { txid, valor, chave, payload, qrCodeDataUrl };
  }

  /**
   * Monta o payload BR Code (EMVCo) seguindo a especificação do BCB.
   */
  private buildBrCode(input: {
    chave: string;
    nome: string;
    cidade: string;
    valor: number;
    txid: string;
    descricao?: string;
  }): string {
    // Merchant Account Information (tag 26) — sub-campos de PIX
    const subPix: string[] = [
      this.tlv('00', 'BR.GOV.BCB.PIX'), // GUI fixo
      this.tlv('01', input.chave),       // Chave PIX
    ];
    if (input.descricao) {
      subPix.push(this.tlv('02', input.descricao.slice(0, 25)));
    }
    const merchantAccountInfo = this.tlv('26', subPix.join(''));

    // Additional Data Field Template (tag 62) — TXID
    const additionalData = this.tlv('62', this.tlv('05', input.txid));

    // Monta payload em ordem
    const parts: string[] = [
      this.tlv('00', '01'),               // Payload Format Indicator
      this.tlv('01', '12'),               // Point of Initiation = 12 (estático com valor — pode reutilizar)
      merchantAccountInfo,
      this.tlv('52', '0000'),             // Merchant Category Code
      this.tlv('53', '986'),              // Currency = BRL
      this.tlv('54', input.valor.toFixed(2)), // Transaction Amount
      this.tlv('58', 'BR'),               // Country
      this.tlv('59', input.nome),         // Merchant Name
      this.tlv('60', input.cidade),       // Merchant City
      additionalData,
    ];
    const payloadSemCrc = parts.join('') + '6304';
    const crc = this.crc16(payloadSemCrc);
    return payloadSemCrc + crc;
  }

  /**
   * Helper TLV: monta "TT LL VVVV..."
   * tag = 2 chars, length = 2 chars (decimal padded), value = string
   */
  private tlv(tag: string, value: string): string {
    const len = value.length.toString().padStart(2, '0');
    return `${tag}${len}${value}`;
  }

  /**
   * CRC16-CCITT-False (polinômio 0x1021, init 0xFFFF).
   * Padrão EMVCo / BR Code.
   */
  private crc16(payload: string): string {
    let crc = 0xffff;
    for (let i = 0; i < payload.length; i++) {
      crc ^= payload.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
        else crc <<= 1;
        crc &= 0xffff;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  /**
   * Remove acentos e caracteres não-ASCII pra evitar problemas de encoding
   * em alguns leitores de QR. Limita ao tamanho máximo.
   */
  private sanitizeAscii(s: string, maxLen: number): string {
    // Range ̀-ͯ = combining diacritical marks (acentos da NFD)
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .toUpperCase()
      .slice(0, maxLen)
      .trim();
  }

  /**
   * TXID curto, alfanumérico, único por venda.
   */
  private generateTxid(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `LURDS${ts}${rnd}`.slice(0, 25);
  }

  /**
   * BR Code aceita txid 1-25 chars [A-Z0-9]. Remove qualquer caractere fora
   * do alfabeto seguro pra evitar QR rejeitado por banco.
   */
  private sanitizeTxid(raw: string): string {
    const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (clean || 'LURDS').slice(0, 25);
  }

  /**
   * Normaliza a chave PIX conforme o tipo:
   *   - cpf       → só dígitos (11)
   *   - cnpj      → só dígitos (14)
   *   - telefone  → +55 + DDD + número (formato E.164)
   *   - email     → minúsculo, trim
   *   - aleatoria → UUID v4 (mantém como veio)
   *
   * Esse passo é CRÍTICO: chave mal formatada faz o QR ficar inválido no
   * app do recebedor. Padrão BCB EMVCo (anexo II do MPM-PIX).
   */
  private normalizeChave(raw: string, tipo: string): string {
    const v = String(raw || '').trim();
    const t = String(tipo || '').toLowerCase();
    if (t === 'cpf' || t === 'cnpj') return v.replace(/\D/g, '');
    if (t === 'telefone') {
      let n = v.replace(/\D/g, '');
      if (n.startsWith('0')) n = n.slice(1);
      if (n.length === 8 || n.length === 9) n = '13' + n; // adiciona DDD 13 se faltar
      if (n.length === 10 || n.length === 11) n = '55' + n;
      return '+' + n;
    }
    if (t === 'email') return v.toLowerCase();
    // aleatoria (UUID): mantém como veio (já normalizada pelo banco)
    return v;
  }
}
