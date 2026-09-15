import { refBaseOf } from './ref-base';

/**
 * PROMOÇÃO POR TERMO — a régua, num lugar só (dono, 15/09/2026).
 *
 * Substitui a promoção de 50% ("liquida antigos": cadastro até 31/12/2023,
 * REF -INV/-VER ou liberada na mão), que saiu do ar no mesmo dia. A pedida:
 * "30% em todos os itens de inverno, sem restrição de data — toda peça que
 * tiver CASACO, CALÇA MOLETOM, JAQUETA, INVERNO… (configurável) entra", e a
 * loja tem que conseguir DESMARCAR a peça que entrou por engano, na
 * retaguarda e no PDV.
 *
 * ── QUEM ENTRA ──
 *
 * A peça entra quando TODAS as palavras de pelo menos UM termo aparecem no
 * texto dela: descrição completa, descrição do PDV, grupo e a própria REF.
 * Sem acento, em qualquer ordem, em qualquer posição — "CALÇA MOLETOM" pega
 * "CALCA JOGGER EM MOLETOM". O plural não atrapalha ("CASACOS" = "CASACO",
 * "MOLETONS" = "MOLETOM"), e termo com `*` no fim pega começo de palavra
 * ("TRIC*" = TRICÔ e TRICOT).
 *
 * A decisão é por LINHA do catálogo (cada código), não pela família: o Giga
 * recicla REF, e a mesma numeração já foi bolero, calça e vestido ao mesmo
 * tempo (REF 9099, 07/08). Decidir pela família inteira daria 30% ao vestido
 * porque o bolero da mesma REF casou. A linha decide pelo texto DELA.
 *
 * ── A EXCEÇÃO NA MÃO É DA FAMÍLIA ──
 *
 * "Não é inverno" vale pra peça em TODAS as cores: a exceção é gravada na
 * REF-BASE (`refBaseOf`, a regra de família do sistema inteiro). Gravar na REF
 * exata faria a vendedora tirar a peça marinho e ver a preta, do mesmo modelo,
 * continuar com desconto no próximo bipe — e o site mostraria a mesma peça com
 * dois preços. A exceção vence o termo nos dois sentidos: `fora` tira quem
 * casou, `dentro` põe quem nenhum termo pegou.
 *
 * ── UM PREÇO SÓ NA REDE ──
 *
 * Vitrine, trava do carrinho, troca de peça e o caixa das lojas chamam ESTA
 * régua. Se a vitrine e a trava discordarem, o pedido é recusado no checkout;
 * se o site e o caixa discordarem, a cliente vê um preço na tela e paga outro
 * no balcão. Nada de cópia da decisão em outro arquivo.
 *
 * ── A ORDEM DE QUEM DECIDE (dono, 15/09/2026, 2ª rodada) ──
 *
 *   1. campanha desligada                → ninguém entra
 *   2. família TIRADA na mão (`fora`)    → fora, sempre (é a proteção)
 *   3. família INCLUÍDA na mão (`dentro`) → entra
 *   4. palavra que EXCLUI ("BERMUDA")    → fora — trava do termo largo:
 *      "MOLETOM" puxava ~250 peças de bermuda de moletom (medido em 15/09)
 *   5. termo OU grupo/subgrupo do ERP    → entra
 *   6. nada disso                        → fora
 *
 * O grupo/subgrupo entra por CÓDIGO (`EstruturaCampanha`, montada por quem
 * carrega a régua): todo chamador já manda o código, então nenhum SQL de
 * vitrine, carrinho ou caixa precisou saber que o critério existe — e não há
 * como um deles "esquecer" a coluna e cobrar outro preço. Só ~34% das peças
 * em estoque têm grupo no cadastro (quase tudo que nasceu de 2025 pra cá), por
 * isso o grupo SOMA com o termo e nunca o substitui.
 *
 * A linha da VENDA ainda tem a palavra final da vendedora (PDV, só naquela
 * linha): tirar vale sempre; pôr vale menos contra a família tirada na mão.
 */

export interface ConfigCampanha {
  /** Desligada = ninguém entra (nem incluída na mão). */
  ativa: boolean;
  /** Nome que a loja fala: "Inverno". Também é a chave das exceções. */
  nome: string;
  /** Desconto em % inteiro (30 = 30%). */
  pct: number;
  /** Termos como a matriz digitou ("CALÇA MOLETOM", "TRIC*"). */
  termos: string[];
  /** Palavras que TIRAM da regra automática o que um termo/grupo pôs ("BERMUDA"). */
  termosExclusao: string[];
  /** Grupos do ERP (`wincred_produtos.grupo`) cujas peças entram. */
  grupos: number[];
  /** Subgrupos do ERP (`wincred_produtos.subgrupo`) cujas peças entram. */
  subgrupos: number[];
}

export type DecisaoExcecao = 'fora' | 'dentro';

export interface ExcecaoCampanha {
  /** REF-BASE da família (sem espaço) — ou `#<codigo>` pra peça sem REF. */
  chave: string;
  decisao: DecisaoExcecao;
  motivo?: string | null;
  origem?: string | null;
  storeCode?: string | null;
  usuario?: string | null;
  refExemplo?: string | null;
  descricao?: string | null;
  em?: string | null;
}

/** O que a régua precisa saber de uma linha do catálogo. */
export interface LinhaCampanha {
  ref?: string | null;
  codigo?: string | null;
  descricao?: string | null;
  descricaoPdv?: string | null;
  grupo?: string | null;
}

/**
 * Quem decidiu, na ordem da régua. É o que a tela usa pra explicar a linha —
 * e o que os testes trancam: a precedência não pode mudar sem alguém ver.
 */
export type CriterioCampanha = 'desligada' | 'excecao' | 'exclusao' | 'termo' | 'estrutura' | 'nenhum';

export interface DecisaoCampanha {
  entra: boolean;
  /** Frase pronta pra tela ("casou com CASACO", "tirada na mão"). */
  motivo: string;
  criterio: CriterioCampanha;
  /** O termo que casou (como a matriz digitou), quando foi termo que decidiu. */
  termo: string | null;
  /** O grupo/subgrupo que pôs a peça ("subgrupo PLUSH"), quando foi ele. */
  estrutura: string | null;
  /** A palavra que excluiu ("BERMUDA"), quando foi ela. */
  exclusao: string | null;
  /** A exceção que decidiu, quando foi exceção. */
  excecao: ExcecaoCampanha | null;
  /** Chave da família — é nela que a exceção se grava. */
  chave: string;
}

/**
 * Códigos que entram por grupo/subgrupo do ERP, com o rótulo pra tela.
 * Quem monta é o serviço (consulta o espelho); a régua só consulta o mapa.
 */
export interface EstruturaCampanha {
  porCodigo: Map<string, string>;
}

export const CAMPANHA_PADRAO: ConfigCampanha = {
  ativa: true,
  nome: 'Inverno',
  pct: 30,
  // A lista do dono (15/09/2026). Plural não precisa: CASACOS = CASACO.
  termos: ['CASACO', 'JAQUETA', 'INVERNO', 'CALÇA DE MOLETOM', 'MOLETOM', 'PLUSH'],
  // Ordem do dono (15/09/2026): "tudo o que for BERMUDA tem que sair" e o
  // uniforme da Escola 22 de Abril sai mesmo sendo moletom. Medido no
  // catálogo: MOLETOM trazia 568 peças de bermuda e 130 do uniforme (blusão
  // de moletom, jaqueta tactel, calça). O DE é conectivo: pega "22 ABRIL" também.
  termosExclusao: ['BERMUDA', '22 DE ABRIL'],
  grupos: [],
  subgrupos: [],
};

export const PCT_MIN = 1;
export const PCT_MAX = 90;
export const TERMOS_MAX = 150;
/** Teto de grupos + subgrupos numa campanha — a tela escolhe da lista do ERP. */
export const ESTRUTURA_MAX = 300;

/** Maiúscula, sem acento, só letra e número separados por espaço. */
export function textoNormalizado(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export function palavrasDe(v: unknown): string[] {
  const t = textoNormalizado(v);
  return t ? t.split(' ') : [];
}

/**
 * O "singular" de uma palavra — só pra COMPARAR, nunca pra mostrar.
 *
 * Os dois lados (termo e texto) passam por aqui, então o que importa é que o
 * plural e o singular caiam no mesmo lugar, não que a raiz seja bonita.
 * `M`/`N` finais viram um só (MOLETOM/MOLETON, CARDIGAN/CARDIGANS): palavra
 * portuguesa terminada em N quase não existe em descrição de roupa, e a
 * grafia do moletom varia de cadastro pra cadastro.
 */
export function formaDeComparacao(palavra: string): string {
  let w = palavra;
  if (w.length >= 5 && /(OES|AES)$/.test(w)) w = `${w.slice(0, -3)}AO`;
  else if (w.length >= 4 && w.endsWith('NS')) w = `${w.slice(0, -2)}M`;
  else if (w.length >= 5 && /[RZ]ES$/.test(w)) w = w.slice(0, -2);
  else if (w.length >= 4 && w.endsWith('S')) w = w.slice(0, -1);
  if (w.length >= 3 && w.endsWith('N')) w = `${w.slice(0, -1)}M`;
  return w;
}

interface PalavraDoTermo {
  /** Forma de comparação — ou o começo, quando `prefixo`. */
  raiz: string;
  prefixo: boolean;
}

export interface TermoCompilado {
  /** Como a matriz digitou (é o que a tela mostra). */
  original: string;
  palavras: PalavraDoTermo[];
}

/** Mínimo de letras antes do `*` — "C*" pegaria meio catálogo. */
const PREFIXO_MIN = 3;

/**
 * Conectivos que a matriz escreve e o cadastro pula: "CALÇA DE MOLETOM" tem
 * que pegar "CALCA MOLETOM FEMININA". Sem isto o DE virava palavra obrigatória
 * — medido em 15/09: 10 códigos com o DE contra 438 sem ele. Letra solta (P,
 * M, G) NÃO entra aqui: é tamanho, e sumir com ela alargaria o termo.
 */
const CONECTIVOS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'NA', 'NO', 'NAS', 'NOS', 'COM', 'PARA']);

/** null = termo que não pega nada (vazio, só símbolo ou conectivo, `*` curto demais). */
export function compilarTermo(termo: unknown): TermoCompilado | null {
  const original = String(termo ?? '').trim().replace(/\s+/g, ' ');
  if (!original) return null;
  // Mesmo corte do texto (hífen e barra separam palavra: "CORTA-VENTO" são
  // duas), só que guardando o `*` que marca começo de palavra.
  const marcado = original
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9*]+/g, ' ')
    .trim();
  const palavras: PalavraDoTermo[] = [];
  for (const bruta of marcado.split(' ')) {
    const prefixo = bruta.endsWith('*');
    const limpa = bruta.replace(/\*/g, '');
    if (!limpa) continue;
    if (!prefixo && CONECTIVOS.has(limpa)) continue;
    if (prefixo) {
      if (limpa.length < PREFIXO_MIN) return null;
      palavras.push({ raiz: limpa, prefixo: true });
    } else {
      palavras.push({ raiz: formaDeComparacao(limpa), prefixo: false });
    }
  }
  return palavras.length ? { original, palavras } : null;
}

/** Palavras do texto já prontas pra comparar (as duas formas: crua e singular). */
export interface TextoIndexado {
  cruas: string[];
  formas: Set<string>;
}

export function indexarTexto(...partes: unknown[]): TextoIndexado {
  const cruas = partes.flatMap((p) => palavrasDe(p));
  return { cruas, formas: new Set(cruas.map(formaDeComparacao)) };
}

/** O texto de uma linha do catálogo que a campanha lê — sempre estes 4 campos. */
export function textoDaLinha(linha: LinhaCampanha | null | undefined): TextoIndexado {
  return indexarTexto(linha?.descricao, linha?.descricaoPdv, linha?.grupo, linha?.ref);
}

export function termoCasa(termo: TermoCompilado, texto: TextoIndexado): boolean {
  return termo.palavras.every((p) =>
    p.prefixo ? texto.cruas.some((w) => w.startsWith(p.raiz)) : texto.formas.has(p.raiz),
  );
}

/**
 * Chave da família: REF-BASE sem espaço ("VMS-223 MA" → "VMS-223").
 * Peça sem REF (meia, acessório) é classificada pelo código, igual à tela de
 * Classificação: `#<codigo>`.
 */
export function chaveDaFamilia(ref: unknown, codigo?: unknown): string {
  const r = String(ref ?? '').trim().toUpperCase();
  if (r && r !== 'MARCADO') return refBaseOf(r).replace(/\s+/g, '');
  const c = String(codigo ?? '').trim().toUpperCase();
  return c ? `#${c}` : '';
}

/** Chave das exceções de uma campanha: o nome, sem acento e sem espaço. */
export function chaveDaCampanha(nome: unknown): string {
  return textoNormalizado(nome).replace(/\s+/g, '-').toLowerCase() || 'campanha';
}

/**
 * O preço com o desconto — em CENTAVOS inteiros, pra site e caixa baterem.
 *
 * Com float, R$ 99,95 × 0,70 dava R$ 69,97 no site e o caixa, que desconta
 * 30% e subtrai, cobrava R$ 69,96. Quem calcula o item no PDV parte DESTE
 * preço (ver `totalDoItemComDesconto`), nunca do desconto.
 */
export function precoComDesconto(preco: number, pct: number): number {
  const centavos = Math.round(Number(preco || 0) * 100);
  return Math.round((centavos * (100 - pct)) / 100) / 100;
}

/** Linha do PDV: total = preço unitário com desconto × quantidade. */
export function totalDoItemComDesconto(precoUnit: number, qty: number, pct: number) {
  const bruto = Math.round(Number(precoUnit || 0) * Math.max(1, qty) * 100) / 100;
  const total = Math.round(precoComDesconto(precoUnit, pct) * Math.max(1, qty) * 100) / 100;
  return { bruto, total, desconto: Math.round((bruto - total) * 100) / 100 };
}

/** A forma que decide se dois termos são o mesmo ("CASACOS" = "casaco"). */
export function formaDoTermo(termo: unknown): string {
  return compilarTermo(termo)?.palavras.map((p) => `${p.raiz}${p.prefixo ? '*' : ''}`).join(' ') ?? '';
}

function listaDeTermos(lista: unknown): string[] {
  const vistos = new Set<string>();
  const termos: string[] = [];
  for (const t of Array.isArray(lista) ? lista : []) {
    const comp = compilarTermo(t);
    if (!comp) continue;
    const k = formaDoTermo(t);
    if (vistos.has(k)) continue;
    vistos.add(k);
    termos.push(comp.original.toUpperCase());
  }
  return termos.slice(0, TERMOS_MAX);
}

/**
 * Código de grupo/subgrupo que veio de verdade. `Number(null)` e `Number('')`
 * valem ZERO — e o subgrupo 0 EXISTE no ERP (4.726 peças de blusa em 15/09):
 * um nulo escorregando da tela poria a rede inteira de blusas na campanha.
 */
export function idDeEstrutura(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function listaDeIds(lista: unknown): number[] {
  const ids = (Array.isArray(lista) ? lista : [])
    .map(idDeEstrutura)
    .filter((n): n is number => n != null);
  return Array.from(new Set(ids)).sort((a, b) => a - b).slice(0, ESTRUTURA_MAX);
}

/** Normaliza o que chega da tela/banco. Nunca lança — valida quem grava. */
export function normalizarConfig(c: Partial<ConfigCampanha> | null | undefined): ConfigCampanha {
  const base = { ...CAMPANHA_PADRAO, ...(c || {}) };
  const pct = Math.round(Number(base.pct));
  return {
    ativa: base.ativa !== false,
    nome: String(base.nome || '').trim().slice(0, 30) || CAMPANHA_PADRAO.nome,
    pct: Number.isFinite(pct) ? Math.min(PCT_MAX, Math.max(PCT_MIN, pct)) : CAMPANHA_PADRAO.pct,
    termos: listaDeTermos(base.termos),
    termosExclusao: listaDeTermos(base.termosExclusao),
    grupos: listaDeIds(base.grupos),
    subgrupos: listaDeIds(base.subgrupos),
  };
}

/** Impressão curta de um conjunto de códigos — muda quando entra ou sai um. */
function digestoDe(codigos: Iterable<string>): string {
  const ordenados = Array.from(codigos).sort();
  let h = 0x811c9dc5;
  for (const c of ordenados) {
    for (let i = 0; i < c.length; i++) {
      h ^= c.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c; // separador: "12"+"3" ≠ "1"+"23"
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${ordenados.length}:${h.toString(16)}`;
}

export interface RegraCampanha {
  config: ConfigCampanha;
  /** Chave das exceções desta campanha (`chaveDaCampanha(nome)`). */
  campanha: string;
  /** Etiqueta do item no PDV: "PROMO 30% · inverno" (o PDV reconhece o prefixo PROMO). */
  rotulo: string;
  /**
   * Muda quando config, exceções ou os códigos do grupo/subgrupo mudam — a
   * vitrine remonta por ela (peça nova cadastrada no subgrupo escolhido tem que
   * aparecer com desconto antes do teto de 10 min, senão a trava do carrinho
   * cobra um preço e a página mostra outro).
   */
  assinatura: string;
  /**
   * `texto` pronto é só atalho de desempenho (a tela da retaguarda indexa o
   * catálogo inteiro uma vez) — a resposta é a mesma de indexar aqui.
   */
  decidir(linha: LinhaCampanha, texto?: TextoIndexado): DecisaoCampanha;
  /** A exceção da família, se houver (a tela mostra quem tirou e por quê). */
  excecaoDe(ref: unknown, codigo?: unknown): ExcecaoCampanha | null;
  precoComDesconto(preco: number): number;
}

export function criarRegra(
  configEntrada: Partial<ConfigCampanha> | null | undefined,
  excecoes: ExcecaoCampanha[] = [],
  estrutura: EstruturaCampanha | null = null,
): RegraCampanha {
  const config = normalizarConfig(configEntrada);
  const compilar = (lista: string[]) =>
    lista.map((t) => compilarTermo(t)).filter((t): t is TermoCompilado => !!t);
  const termos = compilar(config.termos);
  const exclusoes = compilar(config.termosExclusao);
  const porChave = new Map<string, ExcecaoCampanha>();
  for (const e of excecoes) {
    const chave = String(e?.chave || '').trim().toUpperCase();
    if (chave && (e.decisao === 'fora' || e.decisao === 'dentro')) porChave.set(chave, { ...e, chave });
  }
  // Sem grupo/subgrupo escolhido não há o que consultar — mesmo que alguém
  // passe um mapa velho, ele não dá desconto a ninguém.
  const temEstrutura = config.grupos.length > 0 || config.subgrupos.length > 0;
  const porCodigo = temEstrutura ? estrutura?.porCodigo ?? new Map<string, string>() : new Map<string, string>();

  const excecaoDe = (ref: unknown, codigo?: unknown) =>
    porChave.get(chaveDaFamilia(ref, codigo)) ?? null;

  const decisao = (
    chave: string,
    entra: boolean,
    criterio: CriterioCampanha,
    motivo: string,
    extra: Partial<Pick<DecisaoCampanha, 'termo' | 'estrutura' | 'exclusao' | 'excecao'>> = {},
  ): DecisaoCampanha => ({
    entra, motivo, criterio, termo: null, estrutura: null, exclusao: null, excecao: null, chave, ...extra,
  });

  const decidir = (linha: LinhaCampanha, textoPronto?: TextoIndexado): DecisaoCampanha => {
    const chave = chaveDaFamilia(linha?.ref, linha?.codigo);
    if (!config.ativa) return decisao(chave, false, 'desligada', 'campanha desligada');

    const excecao = chave ? porChave.get(chave) ?? null : null;
    if (excecao?.decisao === 'fora') {
      return decisao(chave, false, 'excecao', 'tirada da campanha na mão', { excecao });
    }
    if (excecao?.decisao === 'dentro') {
      return decisao(chave, true, 'excecao', 'incluída na campanha na mão', { excecao });
    }

    const texto = textoPronto ?? textoDaLinha(linha);
    const exclui = exclusoes.find((t) => termoCasa(t, texto));
    if (exclui) {
      return decisao(chave, false, 'exclusao', `tem "${exclui.original}" (palavra que exclui)`, {
        exclusao: exclui.original,
      });
    }
    const casou = termos.find((t) => termoCasa(t, texto));
    if (casou) {
      return decisao(chave, true, 'termo', `casou com "${casou.original}"`, { termo: casou.original });
    }
    const daEstrutura = porCodigo.size ? porCodigo.get(String(linha?.codigo ?? '').trim()) : undefined;
    if (daEstrutura) {
      return decisao(chave, true, 'estrutura', `está no ${daEstrutura}`, { estrutura: daEstrutura });
    }
    return decisao(chave, false, 'nenhum', 'nenhum termo nem grupo da campanha');
  };

  const assinatura = JSON.stringify([
    config,
    [...porChave.values()].map((e) => `${e.chave}:${e.decisao}`).sort(),
    temEstrutura ? digestoDe(porCodigo.keys()) : '',
  ]);

  return {
    config,
    campanha: chaveDaCampanha(config.nome),
    rotulo: `PROMO ${config.pct}% · ${config.nome.toLowerCase()}`,
    assinatura,
    decidir,
    excecaoDe,
    precoComDesconto: (preco: number) => precoComDesconto(preco, config.pct),
  };
}

/**
 * SUGESTÕES de termo pra tela da retaguarda — só aparecem as que existem no
 * catálogo e que nenhum termo atual já cobre. Não entram sozinhas: termo é
 * dinheiro, quem decide é a matriz.
 */
export const SUGESTOES_INVERNO = [
  'MOLETOM', 'TRICO', 'TRICOT', 'CARDIGAN', 'SUETER', 'BLUSAO', 'CASACO', 'JAQUETA',
  'SOBRETUDO', 'PARKA', 'PUFFER', 'CORTA VENTO', 'FLEECE', 'PELUCIA', 'PELUCIADO',
  'PELUCIADA', 'SEGUNDA PELE', 'TERMICA', 'TERMICO', 'CACHECOL', 'GORRO', 'LUVA',
  'POLAINA', 'PONCHO', 'LA', 'VELUDO', 'CAMURCA', 'GOLA ALTA', 'CACHAREL',
  'MEIA CALCA', 'JOGGER', 'INVERNO', 'INV', 'TEDDY', 'SHERPA', 'MATELASSE',
  'ACOLCHOADO', 'ACOLCHOADA', 'FORRADO', 'FORRADA', 'FLANELA', 'MANGA LONGA',
  'CANELADO', 'CAPA', 'COLETE', 'BOTA',
];

export const SUGESTOES_VERAO = [
  'REGATA', 'SHORT', 'BERMUDA', 'BIQUINI', 'MAIO', 'SAIDA DE PRAIA', 'ALCINHA',
  'LINHO', 'CROPPED', 'VERAO', 'VER', 'MANGA CURTA', 'CIGANINHA', 'TOMARA QUE CAIA',
  'KIMONO', 'MACAQUINHO', 'SANDALIA', 'VISCOLINHO',
];

export function sugestoesPara(nome: unknown): string[] {
  const n = textoNormalizado(nome);
  return /VERAO|PRAIA/.test(n) ? SUGESTOES_VERAO : SUGESTOES_INVERNO;
}
