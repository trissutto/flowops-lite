/**
 * DADOS OBRIGATÓRIOS DA CLIENTE NA VENDA ONLINE (dono 18/08/2026).
 *
 * Espelho da régua do servidor (`backend/src/common/dados-cliente-online.ts`):
 * a mesma validação roda na tela (pra vendedora ver o que falta ANTES de
 * mandar o PIX/link) e no backend (que recusa o pagamento). Mexeu num lado,
 * mexe no outro — régua diferente entre quem mostra e quem cobra é como nasce
 * o "preenchi tudo e não deixa fechar".
 *
 * Por que é obrigatório: venda online não é balcão. A peça VIAJA e a venda
 * vira pedido no trilho do site — sem nome de verdade a etiqueta sai
 * "Cliente", sem CPF os Correios não postam nem sai NF-e, sem CEP o pedido
 * nem vira Order (cai no fluxo legado, sem card e sem etiqueta) e sem
 * telefone/e-mail ninguém avisa a cliente.
 */

export type DadosClienteOnline = {
  cpf?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  cep?: string | null;
  endereco?: string | null;
  numero?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
};

/** CPF com dígitos verificadores — mesmo algoritmo do checkout e da live. */
export function cpfValido(raw?: string | null): boolean {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(d[i]) * (10 - i);
  let dv1 = (s * 10) % 11;
  if (dv1 === 10) dv1 = 0;
  if (dv1 !== Number(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += Number(d[i]) * (11 - i);
  let dv2 = (s * 10) % 11;
  if (dv2 === 10) dv2 = 0;
  return dv2 === Number(d[10]);
}

const UFS = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB',
  'PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
];

/** Nome DE VERDADE: "Cliente", "sem nome" e primeiro nome solto não valem. */
export function nomeCompletoOk(raw?: string | null): boolean {
  const nome = String(raw || '').trim().replace(/\s+/g, ' ');
  if (nome.length < 5) return false;
  const generico = /^(cliente|consumidor|consumidor final|sem nome|nao identificado|não identificado|teste|xxx+)$/i;
  if (generico.test(nome)) return false;
  const partes = nome.split(' ').filter((p) => /[a-zà-ÿ]{2,}/i.test(p));
  return partes.length >= 2;
}

export function emailOk(raw?: string | null): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(raw || '').trim());
}

/** Fixo (10) ou celular (11) com DDD. */
export function telefoneOk(raw?: string | null): boolean {
  return [10, 11].includes(String(raw || '').replace(/\D/g, '').length);
}

/** Campo a campo — o modal pinta de vermelho o que ainda não está de pé. */
export function checarDadosClienteOnline(c: DadosClienteOnline) {
  return {
    name: nomeCompletoOk(c.name),
    cpf: cpfValido(c.cpf),
    phone: telefoneOk(c.phone),
    email: emailOk(c.email),
    cep: String(c.cep || '').replace(/\D/g, '').length === 8,
    endereco: String(c.endereco || '').trim().length >= 3,
    numero: !!String(c.numero || '').trim(),
    bairro: String(c.bairro || '').trim().length >= 2,
    cidade: String(c.cidade || '').trim().length >= 2,
    uf: UFS.includes(String(c.uf || '').trim().toUpperCase()),
  };
}

/** Rótulos na ordem em que os campos aparecem no modal. */
const ROTULOS: Array<[keyof ReturnType<typeof checarDadosClienteOnline>, string]> = [
  ['name', 'nome completo (nome e sobrenome)'],
  ['cpf', 'CPF válido'],
  ['phone', 'WhatsApp com DDD'],
  ['email', 'e-mail'],
  ['cep', 'CEP'],
  ['endereco', 'rua'],
  ['numero', 'número'],
  ['bairro', 'bairro'],
  ['cidade', 'cidade'],
  ['uf', 'UF'],
];

/**
 * O que ainda falta. Lista vazia = pode mandar cobrança e fechar a venda.
 * `complemento` fica de fora de propósito: a maioria dos endereços não tem.
 */
export function faltandoDadosClienteOnline(c: DadosClienteOnline): string[] {
  const ok = checarDadosClienteOnline(c);
  return ROTULOS.filter(([k]) => !ok[k]).map(([, rotulo]) => rotulo);
}

/** Adapta a venda do PDV (campos `customer*`) pro shape da régua. */
export function dadosClienteDaVenda(sale: {
  customerCpf?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerCep?: string | null;
  customerEndereco?: string | null;
  customerNumero?: string | null;
  customerBairro?: string | null;
  customerCidade?: string | null;
  customerUf?: string | null;
} | null | undefined): DadosClienteOnline {
  return {
    cpf: sale?.customerCpf ?? '',
    name: sale?.customerName ?? '',
    email: sale?.customerEmail ?? '',
    phone: sale?.customerPhone ?? '',
    cep: sale?.customerCep ?? '',
    endereco: sale?.customerEndereco ?? '',
    numero: sale?.customerNumero ?? '',
    bairro: sale?.customerBairro ?? '',
    cidade: sale?.customerCidade ?? '',
    uf: sale?.customerUf ?? '',
  };
}
