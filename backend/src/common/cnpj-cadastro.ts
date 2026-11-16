/**
 * CADASTRO DO CNPJ DO DESTINATÁRIO — o que a nota precisa saber de uma empresa.
 *
 * Por que existe (16/11/2026 — NFC-e 425 de Santos, R$ 219,80, pro CONDOMÍNIO
 * EDIFÍCIO EXCELSIOR): a nota voltou com **181 "CNPJ do destinatário não
 * cadastrado na Receita Federal"** — e o CNPJ existe, está ATIVO, fica a
 * poucas quadras da loja. A regra é nova: NT 2026.007 (regras 12E02-10/20,
 * modelos 55 e 65), em produção desde 16/11/2026. A SEFAZ passou a conferir
 * o CNPJ do destinatário na LCC-RFB (a base nacional de CNPJ da Receita), e a
 * CHAVE da consulta é **UF do destinatário + CNPJ**.
 *
 * O cupom do Flow saía com `<dest><CNPJ>…</CNPJ><xNome>CONSUMIDOR</xNome>` —
 * sem `enderDest`, ou seja, **sem UF**. Sem a metade da chave a consulta não
 * acha ninguém e a empresa mais regular do mundo vira "não cadastrada".
 *
 * A cura é a nota levar o que a Receita tem: razão social e endereço (com UF e
 * código IBGE do município). Ninguém no balcão sabe o código IBGE de cabeça,
 * então o dado vem da consulta pública do CNPJ — é o cartão CNPJ, informação
 * pública por lei. Só o NÚMERO do CNPJ sai do sistema.
 *
 * Este arquivo é a parte PURA: confere o dígito, lê a resposta de cada fonte
 * pública pro mesmo formato e monta o endereço do jeito que o schema da NF-e
 * aceita. Quem fala com a rede é `cnpj/cnpj-consulta.service.ts`.
 */

export type FonteCnpj = 'brasilapi' | 'cnpjws' | 'cnpja';

export interface CadastroCnpj {
  /** 14 dígitos. */
  cnpj: string;
  razaoSocial: string;
  fantasia: string | null;
  /** Situação cadastral como a Receita escreve, em maiúsculas: ATIVA, BAIXADA, INAPTA, SUSPENSA, NULA. */
  situacao: string;
  /** Só ATIVA passa na regra 12E02-20 (rejeição 182). */
  ativa: boolean;
  /** Já com o tipo: "AVENIDA BARTOLOMEU DE GUSMAO". */
  logradouro: string;
  numero: string;
  complemento: string | null;
  bairro: string;
  municipio: string;
  /** Código IBGE do município, 7 dígitos — '' quando a fonte não trouxe. */
  codMunicipio: string;
  uf: string;
  /** 8 dígitos — '' quando a fonte não trouxe. */
  cep: string;
  fonte: FonteCnpj;
}

/**
 * Resultado da consulta. `inexistente` e `indisponivel` NÃO são a mesma coisa
 * (regra de ouro do CLAUDE.md): "a Receita não tem esse CNPJ" é resposta;
 * "não consegui perguntar" é falta de resposta, e nunca pode virar a primeira.
 */
export type ConsultaCnpj =
  | { status: 'encontrado'; cadastro: CadastroCnpj }
  | { status: 'inexistente' }
  | { status: 'invalido' }
  | { status: 'indisponivel'; erro: string };

/** Endereço no formato do grupo `enderDest` da NF-e/NFC-e (TEndereco). */
export interface EnderecoDestinatario {
  xLgr: string;
  nro: string;
  xBairro: string;
  cMun: string;
  xMun: string;
  UF: string;
  /** null = não informar a tag (o schema recusa CEP que não tenha 8 dígitos). */
  CEP: string | null;
}

/** Código IBGE de cada UF — os 2 primeiros dígitos do código do município. */
const CUF: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
  MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35',
  PR: '41', SC: '42', RS: '43',
  MS: '50', MT: '51', GO: '52', DF: '53',
};

const soDigitos = (v: unknown): string => String(v ?? '').replace(/\D/g, '');
const txt = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

/** CNPJ numérico de 14 dígitos com os dois dígitos verificadores certos. */
export function cnpjValido(v: unknown): boolean {
  const d = soDigitos(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (base: string): number => {
    let peso = base.length - 7; // 12 dígitos → começa em 5; 13 → em 6
    let soma = 0;
    for (const ch of base) {
      soma += Number(ch) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(d.slice(0, 12)) === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13]);
}

/** 66503871000136 → 66.503.871/0001-36 (devolve o original se não tiver 14 dígitos). */
export function formatarCnpj(v: unknown): string {
  const d = soDigitos(v);
  if (d.length !== 14) return String(v ?? '');
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

const SITUACAO_POR_CODIGO: Record<string, string> = {
  '1': 'NULA', '2': 'ATIVA', '3': 'SUSPENSA', '4': 'INAPTA', '8': 'BAIXADA',
};

function situacaoDe(texto: unknown, codigo?: unknown): string {
  const t = txt(texto).toUpperCase();
  if (t) return t;
  return SITUACAO_POR_CODIGO[String(Number(codigo))] || '';
}

/** "AVENIDA" + "BARTOLOMEU DE GUSMAO" — sem repetir o tipo quando a rua já vem com ele. */
function comTipo(tipo: unknown, logradouro: unknown): string {
  const t = txt(tipo);
  const l = txt(logradouro);
  if (!t || !l) return l || t;
  return l.toUpperCase().startsWith(t.toUpperCase() + ' ') ? l : `${t} ${l}`;
}

function montar(
  fonte: FonteCnpj,
  c: {
    cnpj: unknown; razaoSocial: unknown; fantasia: unknown; situacao: string;
    logradouro: string; numero: unknown; complemento: unknown; bairro: unknown;
    municipio: unknown; codMunicipio: unknown; uf: unknown; cep: unknown;
  },
): CadastroCnpj | null {
  const cnpj = soDigitos(c.cnpj);
  const razaoSocial = txt(c.razaoSocial);
  // Sem CNPJ ou sem razão social a resposta não é um cadastro — é lixo.
  if (cnpj.length !== 14 || !razaoSocial) return null;
  const cod = soDigitos(c.codMunicipio);
  const cep = soDigitos(c.cep);
  return {
    cnpj,
    razaoSocial,
    fantasia: txt(c.fantasia) || null,
    situacao: c.situacao,
    ativa: c.situacao === 'ATIVA',
    logradouro: c.logradouro,
    numero: txt(c.numero),
    complemento: txt(c.complemento) || null,
    bairro: txt(c.bairro),
    municipio: txt(c.municipio),
    codMunicipio: cod.length === 7 ? cod : '',
    uf: txt(c.uf).toUpperCase().slice(0, 2),
    cep: cep.length === 8 ? cep : '',
    fonte,
  };
}

/** https://brasilapi.com.br/api/cnpj/v1/{cnpj} */
export function lerBrasilApi(j: any): CadastroCnpj | null {
  if (!j || typeof j !== 'object') return null;
  return montar('brasilapi', {
    cnpj: j.cnpj,
    razaoSocial: j.razao_social,
    fantasia: j.nome_fantasia,
    situacao: situacaoDe(j.descricao_situacao_cadastral, j.situacao_cadastral),
    logradouro: comTipo(j.descricao_tipo_de_logradouro, j.logradouro),
    numero: j.numero,
    complemento: j.complemento,
    bairro: j.bairro,
    municipio: j.municipio,
    codMunicipio: j.codigo_municipio_ibge,
    uf: j.uf,
    cep: j.cep,
  });
}

/** https://publica.cnpj.ws/cnpj/{cnpj} */
export function lerCnpjWs(j: any): CadastroCnpj | null {
  const e = j?.estabelecimento;
  if (!e || typeof e !== 'object') return null;
  return montar('cnpjws', {
    cnpj: e.cnpj,
    razaoSocial: j.razao_social,
    fantasia: e.nome_fantasia,
    situacao: situacaoDe(e.situacao_cadastral),
    logradouro: comTipo(e.tipo_logradouro, e.logradouro),
    numero: e.numero,
    complemento: e.complemento,
    bairro: e.bairro,
    municipio: e.cidade?.nome,
    codMunicipio: e.cidade?.ibge_id,
    uf: e.estado?.sigla,
    cep: e.cep,
  });
}

/** https://open.cnpja.com/office/{cnpj} */
export function lerCnpja(j: any): CadastroCnpj | null {
  const a = j?.address;
  if (!j || typeof j !== 'object' || !a) return null;
  return montar('cnpja', {
    cnpj: j.taxId,
    razaoSocial: j.company?.name,
    fantasia: j.alias,
    situacao: situacaoDe(j.status?.text, j.status?.id),
    logradouro: txt(a.street), // já vem com o tipo ("Avenida Bartolomeu de Gusmao")
    numero: a.number,
    complemento: a.details,
    bairro: a.district,
    municipio: a.city,
    codMunicipio: a.municipality,
    uf: a.state,
    cep: a.zip,
  });
}

/**
 * Endereço do destinatário pronto pro `enderDest` — ou `null` quando o
 * cadastro não fecha o que o schema e as regras da SEFAZ exigem:
 *
 *  - UF de verdade e código IBGE de 7 dígitos **da mesma UF** (município de
 *    outra UF é rejeição própria; e sem UF o grupo não serve pra nada);
 *  - logradouro e município com pelo menos 2 letras (minLength do schema).
 *
 * `null` quer dizer "não dá pra montar o grupo", e quem chama emite SEM ele —
 * endereço pela metade derruba a nota com 225 (falha de schema), que é pior
 * do que a rejeição que ele tentava evitar.
 */
export function enderecoDoDestinatario(c: CadastroCnpj | null | undefined): EnderecoDestinatario | null {
  if (!c) return null;
  const uf = String(c.uf || '').toUpperCase();
  const cuf = CUF[uf];
  const cMun = soDigitos(c.codMunicipio);
  const xLgr = txt(c.logradouro);
  const xMun = txt(c.municipio);
  if (!cuf || cMun.length !== 7 || !cMun.startsWith(cuf)) return null;
  if (xLgr.length < 2 || xMun.length < 2) return null;
  const nro = txt(c.numero);
  const bairro = txt(c.bairro);
  const cep = soDigitos(c.cep);
  return {
    xLgr,
    nro: nro || 'S/N',
    xBairro: bairro.length >= 2 ? bairro : 'NAO INFORMADO',
    cMun,
    xMun,
    UF: uf,
    CEP: cep.length === 8 ? cep : null,
  };
}
