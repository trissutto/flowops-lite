/**
 * FICHAS QUE NÃO SÃO PESSOA.
 *
 * No Giga, venda no cartão vira parcela de crediário de uma ficha-operadora
 * (VISANET, CIELO, CREDICARD...). Elas ficam misturadas com as clientes de
 * verdade em toda tela que lê a `movimento`.
 *
 * Foi assim que a tela de cobrança passou a mostrar a VISANET com 37 parcelas
 * vencidas e um botão de WhatsApp do lado — bastava alguém clicar pra mandar
 * cobrança de dívida pra uma adquirente.
 *
 * ── CASAR POR NOME EXATO, NUNCA POR LIKE ──
 *
 * Em 01/08 eu escrevi um filtro com `LIKE '%ELO%'`. Ele casou com MARCELO,
 * MELO, ANGELO, BARCELOS, VELOSO, RABELO, VASCONCELOS, SAMELO, HELOISA,
 * ELOISE — mais de 100 pessoas reais tratadas como operadora. Num script de
 * baixa isso teria perdoado dívida de cliente.
 *
 * ── E NUNCA POR CÓDIGO ──
 *
 * O código se repete entre lojas: cada loja numera o seu cadastro. O 26 que é
 * VISANET numa loja é uma pessoa na vizinha.
 */

/** Adquirentes e financeiras. Ficha de repasse, não de cliente. */
export const NOMES_OPERADORA = [
  'CREDICARD', 'VISANET', 'VISA ELECTRON', 'VISAELECTRON',
  'REDESHOP', 'REDE SHOP', 'CIELO', 'CIELODEB',
  'ELO', 'ELO (ANTIGO)', 'AMEX', 'HIPERCARD',
  'SOROCRED', 'CREDSYSTEM', 'SISPUMI', 'SISPUMI - BANCRED CARD',
  'MASTERCARD', 'MAESTRO', 'BANRICOMPRAS', 'GETNET', 'STONE',
];

/**
 * Outras fichas que não são uma pessoa física cobrável.
 *
 * CONSUMIDOR é a venda à vista sem identificação; VENDA ONLINE é o repasse do
 * site. Cobrar qualquer uma delas é cobrar ninguém.
 *
 * GREMIO fica de FORA desta lista de propósito: convênio de funcionário é
 * dívida real de gente real, só que descontada em folha. Não é cliente de
 * balcão, mas também não é repasse — quem decide o que fazer com ele é o dono.
 */
export const NOMES_NAO_PESSOA = [
  'CONSUMIDOR', 'CONSUMIDOR 1', 'CONSUMIDOR 2',
  'VENDA ONLINE', 'VENDAS ONLINE', 'RESERVA',
];

const norm = (s: unknown) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

const SET_OPERADORA = new Set(NOMES_OPERADORA.map(norm));
const SET_NAO_PESSOA = new Set([...NOMES_OPERADORA, ...NOMES_NAO_PESSOA].map(norm));

/** É ficha de adquirente/financeira? */
export function ehOperadora(nome: unknown): boolean {
  return SET_OPERADORA.has(norm(nome));
}

/** É qualquer ficha que não represente uma pessoa cobrável? */
export function ehFichaNaoPessoa(nome: unknown): boolean {
  return SET_NAO_PESSOA.has(norm(nome));
}

/** Lista SQL pronta pra um IN (...). Escapa aspas simples. */
export function sqlListaNaoPessoa(): string {
  return [...SET_NAO_PESSOA].map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
}
