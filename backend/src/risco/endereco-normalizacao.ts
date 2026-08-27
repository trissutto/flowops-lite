/**
 * NORMALIZAÇÃO DE ENDEREÇO — o que faz "Rua Professor Manuel Ferreira, 115" e
 * "R. Prof. Manuel Ferreira nº 115" serem o MESMO lugar.
 *
 * É a peça que decide se o cruzamento por endereço funciona ou não. Sem ela o
 * módulo inteiro só acha relação quando a cliente digita exatamente igual duas
 * vezes — e ninguém digita.
 *
 * DUAS CHAVES, de propósito:
 *
 *   cep_numero  → `11746692-115`. Barata e confiável: CEP é dado de máquina,
 *                 vem do ViaCEP e não tem grafia. É a chave que pega o caso
 *                 comum.
 *   endereco    → `rua professor manuel ferreira-115`. Existe porque o CEP
 *                 FALHA em dois casos reais desta operação: CEP genérico de
 *                 cidade pequena (um CEP pra bairro inteiro, que junta gente
 *                 sem relação nenhuma) e CEP digitado errado no pedido antigo
 *                 do site velho. Uma cobre o buraco da outra.
 *
 * ⚠️ NENHUMA das duas prova nada sozinha. Mãe e filha moram no mesmo endereço;
 * prédio tem 80 apartamentos e o complemento nem sempre é digitado. Endereço
 * igual é RELAÇÃO, não é fraude — quem decide é o score somado ao histórico, e
 * a decisão final é humana (item 24 do documento).
 */

/** Tira acento, caixa e espaço sobrando. */
export function semAcento(valor: string | null | undefined): string {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function digitos(valor: string | null | undefined): string {
  return String(valor || '').replace(/\D/g, '');
}

/**
 * ABREVIAÇÕES que a mesma pessoa escreve de jeito diferente em dois pedidos.
 *
 * A lista é CONSERVADORA de propósito: expandir demais junta endereço que não
 * é o mesmo. Ficaram de fora as ambíguas — "pe" (padre ou Pernambuco), "s"
 * (são ou sul), "b" (bairro ou bloco). Errar pra menos aqui custa um
 * cruzamento perdido; errar pra mais custa um alarme falso, que é pior.
 */
const ABREVIACOES: Record<string, string> = {
  // Tipo de logradouro
  r: 'rua',
  av: 'avenida',
  avn: 'avenida',
  avda: 'avenida',
  al: 'alameda',
  tv: 'travessa',
  trav: 'travessa',
  pc: 'praca',
  pca: 'praca',
  praca: 'praca',
  rod: 'rodovia',
  estr: 'estrada',
  est: 'estrada',
  lgo: 'largo',
  vd: 'viaduto',
  // Qualificadores de nome de rua
  prof: 'professor',
  profa: 'professora',
  dr: 'doutor',
  dra: 'doutora',
  sto: 'santo',
  sta: 'santa',
  eng: 'engenheiro',
  cel: 'coronel',
  gen: 'general',
  mal: 'marechal',
  pres: 'presidente',
  cap: 'capitao',
  min: 'ministro',
  des: 'desembargador',
  ver: 'vereador',
  cmte: 'comandante',
  vva: 'viuva',
  // Área
  jd: 'jardim',
  jrd: 'jardim',
  pq: 'parque',
  vl: 'vila',
  cj: 'conjunto',
  cjto: 'conjunto',
  res: 'residencial',
  cond: 'condominio',
};

/** Marcadores de "número" que não são o número: nº, n°, no, n., num. */
const MARCADOR_NUMERO = /^(n|no|num|nro|numero)$/;

/**
 * O logradouro reduzido à sua forma canônica: sem acento, sem pontuação, sem
 * abreviação, sem marcador de número, espaço único.
 *
 *   "R. Prof. Manuel Ferreira, nº 115"  →  "rua professor manuel ferreira 115"
 */
export function normalizarLogradouro(valor: string | null | undefined): string {
  const bruto = semAcento(valor)
    // Pontuação vira espaço (vírgula, ponto, hífen, barra, º, °, #).
    .replace(/[.,;:\-/\#º°ª'"()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!bruto) return '';

  const palavras = bruto
    .split(' ')
    .filter((p) => p && !MARCADOR_NUMERO.test(p))
    .map((p) => ABREVIACOES[p] || p);

  return palavras.join(' ').trim();
}

/**
 * O NÚMERO da casa, de onde ele estiver.
 *
 * Pedido do site novo já grava `number` em campo próprio (ver
 * `common/endereco-wc.ts`); pedido antigo tem "rua, número" grudado em
 * `address_1` e o número só sai por regex. As duas pontas passam por aqui.
 *
 * "s/n" e "sn" viram string vazia: sem número não existe chave de endereço —
 * uma rua inteira compartilhando "s/n" juntaria vizinhos sem relação.
 */
export function extrairNumero(
  numeroCampo: string | null | undefined,
  logradouroCru: string | null | undefined,
): string {
  const direto = semAcento(numeroCampo).replace(/[^0-9a-z]/g, '');
  if (direto && !/^(sn|s)$/.test(direto)) return direto;

  const texto = semAcento(logradouroCru);
  if (/\bs\s*\/?\s*n\b/.test(texto)) return '';

  // Último grupo numérico do texto — "Av. Brasil, 1500 A" → "1500a".
  const achados = texto.match(/\d+\s*[a-z]?/g);
  if (!achados || !achados.length) return '';
  return achados[achados.length - 1].replace(/\s+/g, '');
}

export interface EnderecoParaChave {
  /** `address_1` ou logradouro cru. */
  logradouro?: string | null;
  /** `number`, quando o pedido gravou em campo próprio. */
  numero?: string | null;
  cep?: string | null;
}

export interface ChavesEndereco {
  /** `<cep8>-<numero>` — a chave forte. Vazia sem CEP ou sem número. */
  cepNumero: string;
  /** `<logradouro normalizado>-<numero>` — a rede quando o CEP falha. */
  endereco: string;
}

/**
 * As duas chaves de um endereço. String vazia = "não dá pra cruzar por aqui",
 * e quem chama simplesmente não grava a chave — melhor nenhuma chave do que
 * uma chave que junta gente sem relação.
 */
export function chavesDeEndereco(end: EnderecoParaChave | null | undefined): ChavesEndereco {
  if (!end) return { cepNumero: '', endereco: '' };

  const numero = extrairNumero(end.numero, end.logradouro);
  const cep = digitos(end.cep);
  const logradouro = normalizarLogradouro(end.logradouro);

  // O número costuma vir grudado no fim do logradouro ("rua x 115"). Tira pra
  // a chave não depender de ele estar ou não no texto.
  const logradouroSemNumero = numero
    ? logradouro.replace(new RegExp(`\s*${numero}\s*$`), '').trim()
    : logradouro;

  return {
    cepNumero: cep.length === 8 && numero ? `${cep}-${numero}` : '',
    // Exige rua com ao menos duas palavras: "rua" sozinho juntaria a cidade
    // inteira.
    endereco:
      logradouroSemNumero.split(' ').filter(Boolean).length >= 2 && numero
        ? `${logradouroSemNumero}-${numero}`
        : '',
  };
}
