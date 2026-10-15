/**
 * CÓDIGO DE BARRAS DO FORNECEDOR — a régua da conferência (15/10/2026).
 *
 * Pedido do dono: "alguns produtos a gente utiliza o próprio código de barras
 * dele. Preciso, na tela de pedidos, quando formos aceitar e dar entrada, uma
 * flag para, ao marcá-la, o sistema pedir o código de barras daquele item
 * através do leitor."
 *
 * O que muda — e o que NÃO muda — no cadastro:
 *
 * - A peça continua nascendo com o CÓDIGO do Flow (EAN-13 de prefixo 8, da
 *   `EanSequence`). O código é a chave de ~30 tabelas e não muda por causa da
 *   etiqueta do fornecedor.
 * - O código de barras lido vai na coluna `ean` de `product` e de
 *   `wincred_produtos`. É por ela que o bipe do PDV (`getPdvProductInfo`), a
 *   reposição (`reposicaoBipe`) e as etiquetas avulsas já resolvem EAN de
 *   fornecedor — o mesmo destino que o `trocarCodigo` dá a um código antigo
 *   com cara de código de barras.
 *
 * Esta régua é PURA e roda ANTES de qualquer escrita: item marcado com algum
 * tamanho (com peça) sem código é recusa do recebimento inteiro, com a lista
 * do que falta. Nunca "recebe o que deu" e deixa um tamanho sem EAN calado —
 * a peça bipada no caixa viraria "não existe", a família de erro que a regra
 * de ouro proíbe.
 */

/** Teto da coluna `ean` nas duas tabelas (VarChar(20)). */
export const CODIGO_BARRAS_MAX = 20;
/**
 * Piso: o bipe do PDV só procura na coluna `ean` termos com 8+ caracteres
 * (`wincred-catalog.service.ts`). Código menor que isso seria gravado e
 * nunca encontrado — por isso é recusado na entrada.
 */
export const CODIGO_BARRAS_MIN = 8;

/**
 * Normaliza o que o leitor mandou: tira espaços (inclusive no meio — leitor
 * configurado com separador manda "7891 234") e põe em maiúsculas. Dígito
 * fica como veio, COM zero à esquerda: o bipe procura pelo texto cru e pelos
 * dígitos, então "0123456789012" precisa ser gravado igual ao que a etiqueta
 * imprime.
 */
export function normalizarCodigoBarras(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, '').trim().toUpperCase();
}

/** Motivo da recusa de UM código, ou null quando ele serve. */
export function motivoCodigoBarrasInvalido(codigo: string): string | null {
  const c = normalizarCodigoBarras(codigo);
  if (!c) return 'vazio';
  if (c.length < CODIGO_BARRAS_MIN) return `curto demais (mínimo ${CODIGO_BARRAS_MIN} caracteres)`;
  if (c.length > CODIGO_BARRAS_MAX) return `longo demais (máximo ${CODIGO_BARRAS_MAX} caracteres)`;
  if (!/^[A-Z0-9-]+$/.test(c)) return 'só letras, números e hífen';
  return null;
}

export interface ConferenciaCodigosDeBarras {
  ok: boolean;
  /** tamanho → código normalizado, SÓ dos tamanhos com peça. */
  porTamanho: Record<string, string>;
  /** Tamanhos com peça que ficaram sem código. */
  faltando: string[];
  invalidos: Array<{ tamanho: string; valor: string; motivo: string }>;
  /** O mesmo código em dois tamanhos do mesmo item — o bipe não saberia qual é. */
  repetidos: Array<{ codigo: string; tamanhos: string[] }>;
}

/**
 * Confere o que o leitor mandou contra os tamanhos que TÊM peça neste
 * recebimento. Tamanho sem peça (qty 0) não pede código e, se vier, é
 * ignorado — ele não vai ser cadastrado.
 */
export function conferirCodigosDeBarras(
  tamanhosComPeca: string[],
  lidos: Record<string, unknown> | null | undefined,
): ConferenciaCodigosDeBarras {
  const porTamanho: Record<string, string> = {};
  const faltando: string[] = [];
  const invalidos: ConferenciaCodigosDeBarras['invalidos'] = [];
  const porCodigo = new Map<string, string[]>();

  for (const tamanho of tamanhosComPeca) {
    const bruto = lidos?.[tamanho];
    const codigo = normalizarCodigoBarras(bruto);
    if (!codigo) {
      faltando.push(tamanho);
      continue;
    }
    const motivo = motivoCodigoBarrasInvalido(codigo);
    if (motivo) {
      invalidos.push({ tamanho, valor: codigo, motivo });
      continue;
    }
    porTamanho[tamanho] = codigo;
    porCodigo.set(codigo, [...(porCodigo.get(codigo) || []), tamanho]);
  }

  const repetidos = Array.from(porCodigo.entries())
    .filter(([, tams]) => tams.length > 1)
    .map(([codigo, tamanhos]) => ({ codigo, tamanhos }));

  return {
    ok: faltando.length === 0 && invalidos.length === 0 && repetidos.length === 0,
    porTamanho,
    faltando,
    invalidos,
    repetidos,
  };
}

/** Frase única pro erro 400 — a tela mostra e a pessoa sabe o que bipar. */
export function descreverProblemasDosCodigos(c: ConferenciaCodigosDeBarras): string {
  const partes: string[] = [];
  if (c.faltando.length) partes.push(`sem código de barras no tamanho ${c.faltando.join(', ')}`);
  for (const i of c.invalidos) partes.push(`tamanho ${i.tamanho}: código "${i.valor}" ${i.motivo}`);
  for (const r of c.repetidos) {
    partes.push(`código ${r.codigo} lido em mais de um tamanho (${r.tamanhos.join(', ')})`);
  }
  return partes.join(' · ') || 'códigos de barras conferidos';
}

/**
 * A peça achada no catálogo pelo código de barras é ESTA (REF + COR + TAMANHO
 * do item do pedido)? Se for, a entrada reaproveita o código que já existe
 * (segunda compra da mesma peça) em vez de cadastrar outro — dois cadastros
 * com o mesmo EAN deixariam o bipe no escuro. Se NÃO for, o código de barras
 * é de outra peça e a entrada é recusada.
 *
 * As colunas do cadastro são cortadas (`ref` 10, `cor` 15, `tamanho` 20 —
 * `gravarNoFlow`), então a comparação corta igual.
 */
export function mesmaPeca(
  achada: { ref?: string | null; cor?: string | null; tamanho?: string | null },
  item: { ref: string; cor: string; tamanho: string },
): boolean {
  const n = (v: unknown, max: number) => String(v ?? '').trim().toUpperCase().slice(0, max);
  return (
    !!n(achada.ref, 10) &&
    n(achada.ref, 10) === n(item.ref, 10) &&
    n(achada.cor, 15) === n(item.cor, 15) &&
    n(achada.tamanho, 20) === n(item.tamanho, 20)
  );
}
