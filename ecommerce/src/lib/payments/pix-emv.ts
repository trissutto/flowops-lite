/**
 * PIX COPIA-E-COLA — payload EMV/BR Code de verdade.
 *
 * O "copia e cola" do PIX é um payload EMVCo QRCPS-MPM: uma sequência de
 * campos TLV (Tag + Length + Value) fechada por um CRC16-CCITT. Qualquer app
 * de banco lê isto — desde que a CHAVE seja real. Em sandbox usamos uma chave
 * de mentira: o payload é estruturalmente válido (o banco abre a tela de
 * pagamento e mostra nome/valor), mas o pagamento não encontra destinatário.
 *
 * Campos que montamos (ids do padrão do Bacen):
 *   00  Payload Format Indicator ("01")
 *   26  Merchant Account Information — GUI "br.gov.bcb.pix" + a chave
 *   52  Merchant Category Code ("0000" = não informado)
 *   53  Moeda ("986" = BRL)
 *   54  Valor (com PONTO decimal, sempre 2 casas)
 *   58  País ("BR")
 *   59  Nome do recebedor (máx 25 chars, sem acento)
 *   60  Cidade (máx 15 chars, sem acento)
 *   62  Additional Data — subcampo 05 = txid (máx 25, alfanumérico)
 *   63  CRC16 ("6304" + 4 hex)
 *
 * Sem dependência externa de propósito: TLV e CRC são ~30 linhas e assim o
 * teste cobre o formato inteiro, byte a byte.
 */

export interface PixPayloadInput {
  /** Valor em REAIS (number) — como todo preço do projeto. */
  amount: number;
  /** Identificador da transação — vira o subcampo 62-05 (máx 25 alfanum). */
  txid: string;
  /** Chave PIX; sem ela usa a de sandbox (payload válido, não pagável). */
  key?: string;
  merchantName?: string;
  merchantCity?: string;
}

/* ─────────────────────────────────────────────────────────────── NORMALIZAÇÃO */

/** Remove acento e tudo que o padrão EMV não aceita nos campos de texto. */
function ascii(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // decompõe e descarta os acentos
    .replace(/[^A-Za-z0-9 @.\-]/g, '')
    .toUpperCase()
    .trim();
}

/** Txid: só alfanumérico, máx 25 (limite do subcampo 62-05). */
function normTxid(value: string): string {
  const limpo = value.replace(/[^A-Za-z0-9]/g, '').slice(0, 25);
  return limpo || '***'; // "***" = txid não informado, aceito pelo padrão
}

/* ────────────────────────────────────────────────────────────────────── TLV */

/**
 * Campo TLV: id (2 dígitos) + tamanho (2 dígitos, zero à esquerda) + valor.
 * Os campos normalizados são ASCII puro, então length em chars = length em
 * bytes — sem surpresa de multibyte.
 */
function tlv(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/* ─────────────────────────────────────────────────────────────────── CRC16 */

/**
 * CRC16-CCITT-FALSE — o do padrão EMV: polinômio 0x1021, valor inicial
 * 0xFFFF, sem reflexão, sem XOR final. Vetor de teste clássico:
 * "123456789" → 0x29B1.
 */
export function crc16ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/* ────────────────────────────────────────────────────────────────── PAYLOAD */

/**
 * Defaults de SANDBOX, declarados como tal: a chave não existe no DICT do
 * Bacen — nenhum app de banco completa esse pagamento. Em produção as três
 * envs são obrigatórias (a chave real é da conta PagBank da casa).
 */
const SANDBOX_KEY = 'sandbox@lurdsplussize.com.br';
const SANDBOX_NAME = 'LURDS PLUS SIZE';
const SANDBOX_CITY = 'ITANHAEM';

export function buildPixPayload(input: PixPayloadInput): string {
  const key = input.key ?? process.env.PIX_KEY ?? SANDBOX_KEY;
  // Limites do padrão: nome até 25, cidade até 15 — o app do banco trunca
  // feio se estourar, então truncamos nós, de forma previsível.
  const name = ascii(input.merchantName ?? process.env.PIX_MERCHANT_NAME ?? SANDBOX_NAME).slice(0, 25);
  const city = ascii(input.merchantCity ?? process.env.PIX_MERCHANT_CITY ?? SANDBOX_CITY).slice(0, 15);
  const amount = input.amount.toFixed(2); // PONTO decimal — vírgula invalida o QR

  const corpo = [
    tlv('00', '01'), // payload format indicator
    tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', key)), // conta PIX
    tlv('52', '0000'), // MCC não informado
    tlv('53', '986'), // BRL
    tlv('54', amount),
    tlv('58', 'BR'),
    tlv('59', name),
    tlv('60', city),
    tlv('62', tlv('05', normTxid(input.txid))),
  ].join('');

  // O CRC cobre TUDO, incluindo o "6304" que o anuncia.
  const semCrc = `${corpo}6304`;
  return `${semCrc}${crc16ccitt(semCrc)}`;
}
