/**
 * FRETE — a fonte agora é o BACKEND; o que sobrou aqui é paraquedas.
 *
 * Até 06/08/2026 esta tabela ERA o preço: faixa de CEP → PAC/SEDEX estimados,
 * e o cálculo real com contrato existia no FlowOps sem ninguém consumir. Duas
 * verdades, e a que a cliente via era a errada.
 *
 * Hoje `fetchQuotes()` pede as opções ao backend (`/api/loja/frete`), que
 * aplica a tabela promocional cadastrada — SP SEDEX R$ 9,99, RJ/MG/PR/SC/RS
 * PAC R$ 19,99, demais UFs pela cotação do contrato — soma os dias de
 * separação e devolve a régua do frete grátis vigente. Nada disso é decidido
 * aqui, e é de propósito: campanha de frete não pode esperar deploy.
 *
 * `quoteShipping()` continua existindo e continua SÍNCRONA porque é o
 * PARAQUEDAS (item 20): backend fora do ar, a cliente ainda vê um preço e
 * fecha o pedido. O backend reconfere na hora de cobrar, então o pior caso é
 * o valor mudar entre a tela e a cobrança — nunca cobrar errado. E desde
 * 17/08 "mudar" pra CIMA não passa calado: a tela manda o frete que mostrou
 * (`shippingPriceSeen`) e o `POST /api/checkout` recusa criar o pedido com
 * `shipping_changed` se o recotado subiu, devolvendo a cliente pra Entrega
 * com o valor novo. Quando a lista sai daqui, `fetchQuotes` marca
 * `origem: 'local'` e a etapa de entrega avisa + oferece "Recalcular".
 *
 * Retirada continua 100% local: depende de `data/stores.ts` e das faixas de
 * CEP das cidades atendidas, que o backend não tem.
 */

import { stores } from '@/data/stores';
import type { ShippingQuote } from '@/types/checkout';

/**
 * Régua do frete grátis usada SÓ no paraquedas e como valor inicial da barra
 * de progresso antes da primeira cotação. A régua que vale vem do backend
 * (`freteGratis.minimo`) — o dono mudou pra R$ 499,90 em 06/08 e daqui pra
 * frente muda na tela, sem deploy.
 */
export const FREE_SHIPPING_FROM = 499.9;

/** Faixas de CEP (2 primeiros dígitos) → grupo de preço/prazo. */
type Zone = 'sp-capital' | 'sp-interior' | 'sudeste' | 'sul' | 'centro-nordeste' | 'norte';

function zoneOf(cep: string): Zone {
  const d2 = Number(cep.slice(0, 2));
  if (Number.isNaN(d2)) return 'sudeste';
  if (d2 <= 9) return 'sp-capital'; // 01xxx–09xxx: capital e grande SP
  if (d2 <= 19) return 'sp-interior'; // 10–19: interior/litoral SP
  if (d2 <= 39) return 'sudeste'; // RJ/ES/MG
  if (d2 >= 80 && d2 <= 99) return 'sul';
  if (d2 >= 69 || (d2 >= 66 && d2 <= 68)) return 'norte';
  return 'centro-nordeste';
}

const TABELA: Record<Zone, { pac: { price: number; min: number; max: number }; sedex: { price: number; min: number; max: number } }> = {
  'sp-capital': { pac: { price: 14.9, min: 2, max: 4 }, sedex: { price: 24.9, min: 1, max: 2 } },
  'sp-interior': { pac: { price: 17.9, min: 3, max: 5 }, sedex: { price: 28.9, min: 1, max: 3 } },
  sudeste: { pac: { price: 21.9, min: 4, max: 7 }, sedex: { price: 34.9, min: 2, max: 4 } },
  sul: { pac: { price: 24.9, min: 5, max: 8 }, sedex: { price: 39.9, min: 2, max: 4 } },
  'centro-nordeste': { pac: { price: 27.9, min: 6, max: 10 }, sedex: { price: 46.9, min: 3, max: 5 } },
  norte: { pac: { price: 32.9, min: 8, max: 12 }, sedex: { price: 54.9, min: 4, max: 7 } },
};

/** Cidades atendidas → prefixos de CEP (faixa aproximada, mesma base do CRM). */
/**
 * ⚠️ REDE DE SEGURANÇA, NÃO A REGRA. Quem poda é o raio de 20 km
 * (`RAIO_RETIRADA_KM`); isto só vale quando não veio coordenada do CEP.
 *
 * ELA TEM QUE SER LARGA. Eu tinha estreitado `117` e `132` pra separar
 * Itanhaém de Praia Grande e Jundiaí de Vinhedo — e abri buracos: 1173,
 * 1177–1179 e 1322–1327 ficaram sem dono nenhum. Mongaguá (11730) perdeu a
 * retirada que tinha ontem, e ela está a 17,5 km de Itanhaém — DENTRO dos
 * 20 km que o dono pediu. Estreitar aqui não corrige nada que o raio já
 * não corrija, e cobra o preço nos CEPs esquecidos.
 *
 * Regra: aqui entra tudo que PODE ser perto. Longe demais o raio tira.
 */
const RETIRADA_POR_PREFIXO: Array<{ prefixos: string[]; slugs: string[] }> = [
  { prefixos: ['117'], slugs: ['itanhaem', 'praia-grande'] },
  { prefixos: ['110', '115'], slugs: ['santos'] },
  { prefixos: ['132'], slugs: ['jundiai', 'vinhedo'] },
  { prefixos: ['133'], slugs: ['indaiatuba'] },
  { prefixos: ['134'], slugs: ['piracicaba'] },
  { prefixos: ['180', '181'], slugs: ['sorocaba'] },
  { prefixos: ['130', '131'], slugs: ['campinas'] },
  { prefixos: ['122'], slugs: ['sao-jose-dos-campos'] },
  { prefixos: ['1348'], slugs: ['limeira'] },
  { prefixos: ['04', '05', '03', '01', '02', '08'], slugs: ['moema', 'analia-franco'] },
  { prefixos: ['086', '087'], slugs: ['suzano'] },
];

/** Raio em que buscar na loja faz sentido — decisão do dono (17/08). */
export const RAIO_RETIRADA_KM = 20;

interface Ponto { lat: number; lng: number }

/** Distância em linha reta, em km (Haversine). */
function distanciaEntre(a: Ponto, b: Ponto): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * A coordenada do CEP vem do BFF, em `dados.coord`.
 *
 * ELA SAIU DAQUI DE PROPÓSITO (17/08). Duas razões medidas: a fonte corta
 * em ~40 consultas por IP, e do navegador quem paga a cota é o IP da
 * cliente (CGNAT de 4G junta milhares de pessoas num IP só); e uma
 * requisição pendurada no navegador não rejeita — ela segurava a lista de
 * frete inteira, que é a armadilha do Giga descrita no CLAUDE.md.
 *
 * Ver `coordenadaDoCep` em app/api/loja/frete/route.ts, com cache e teto.
 */

/**
 * A ORDEM DA TELA, E ELA É FIXA (dono, 17/08):
 *
 *   1. FRETE PROMOCIONAL — a tabela da campanha (SP SEDEX R$ 9,99;
 *      RJ/MG/PR/SC/RS PAC R$ 19,99). É a oferta da casa e abre a lista.
 *   2. RETIRADA GRÁTIS EM LOJA — da mais perto pra mais longe.
 *   3. COTAÇÃO DOS CORREIOS — o preço cheio, por último.
 *
 * Fixa quer dizer fixa: não é "ordenar por preço e dar sorte". Se um dia a
 * cotação cheia sair mais barata que a promoção, a promoção continua em
 * cima — é ela que a campanha está anunciando.
 */
export function ordenarOpcoes(quotes: ShippingQuote[]): ShippingQuote[] {
  const grupo = (q: ShippingQuote) => (q.promocional ? 0 : q.kind === 'retirada' ? 1 : 2);
  return [...quotes].sort((a, b) => {
    const g = grupo(a) - grupo(b);
    if (g !== 0) return g;
    // Dentro da retirada, a loja mais perto primeiro; no resto, o mais barato.
    if (grupo(a) === 1) return (a.distanciaKm ?? Infinity) - (b.distanciaKm ?? Infinity);
    return a.price - b.price;
  });
}

export function onlyDigits(v: string): string {
  return v.replace(/\D/g, '');
}

export function isValidCep(v: string): boolean {
  return onlyDigits(v).length === 8;
}

/**
 * Lojas com retirada disponível pro CEP.
 *
 * ⚠️ NÃO exige que a peça esteja NAQUELA loja (item 26, decisão do dono
 * 04/08): se a loja escolhida não tiver, vem de outra da rede. A retirada é
 * sobre ONDE a cliente quer buscar, não sobre onde a peça está hoje — quem
 * resolve a origem é o roteamento da matriz, exatamente como já faz com
 * qualquer pedido dividido entre lojas.
 *
 * COM `coord`: só as lojas a até 20 km, da mais perto pra mais longe.
 * SEM `coord`: a tabela de prefixos, que é aproximada.
 */
export function pickupStoresFor(cep: string, prazoHoras = 3, coord?: Ponto | null): ShippingQuote[] {
  const digits = onlyDigits(cep);
  if (digits.length < 3) return [];

  const monta = (s: (typeof stores)[number], km?: number): ShippingQuote => ({
    id: `retirada-${s.slug}`,
    kind: 'retirada' as const,
    label: `Retirar na loja ${s.unit}`,
    price: 0,
    readyInHours: prazoHoras,
    storeSlug: s.slug,
    storeLabel: `${s.unit} · ${s.city}/${s.uf}`,
    ...(km == null ? {} : { distanciaKm: Math.round(km * 10) / 10 }),
  });

  if (coord) {
    return stores
      .map((s) => ({ s, km: s.geo ? distanciaEntre(coord, s.geo) : Infinity }))
      .filter((x) => x.km <= RAIO_RETIRADA_KM)
      .sort((a, b) => a.km - b.km)
      .map((x) => monta(x.s, x.km));
  }

  const slugs = new Set<string>();
  for (const faixa of RETIRADA_POR_PREFIXO) {
    if (faixa.prefixos.some((p) => digits.startsWith(p))) faixa.slugs.forEach((s) => slugs.add(s));
  }
  return stores.filter((s) => slugs.has(s.slug)).map((s) => monta(s));
}

/**
 * Cotações pro CEP. Sempre devolve pelo menos PAC + SEDEX; retirada entra
 * quando há loja na área. Frete grátis: PAC zera acima do teto (o SEDEX
 * continua pago — grátis é o econômico, não o expresso).
 */
export function quoteShipping(cep: string, subtotal: number, coord?: Ponto | null): ShippingQuote[] {
  if (!isValidCep(cep)) return [];
  const digits = onlyDigits(cep);
  const zona = TABELA[zoneOf(digits)];
  const gratis = subtotal >= FREE_SHIPPING_FROM;

  // Sem promoção aqui: esta é a tabela de emergência, não a campanha. Sem
  // ninguém marcado `promocional`, a ordem vira retirada → Correios.
  return ordenarOpcoes([
    {
      id: 'correios-pac',
      kind: 'correios',
      label: 'Correios PAC',
      price: gratis ? 0 : zona.pac.price,
      etaDays: { min: zona.pac.min, max: zona.pac.max },
    },
    {
      id: 'correios-sedex',
      kind: 'expressa',
      label: 'SEDEX Expresso',
      price: zona.sedex.price,
      etaDays: { min: zona.sedex.min, max: zona.sedex.max },
    },
    ...pickupStoresFor(digits, 3, coord),
  ]);
}

export function findQuote(cep: string, subtotal: number, quoteId: string): ShippingQuote | undefined {
  return quoteShipping(cep, subtotal).find((q) => q.id === quoteId);
}

/* ───────────────────────── cotação de verdade ──────────────────────────── */

/**
 * Por que a cotação do backend não veio (o BFF `/api/loja/frete` carimba):
 * `rate_limit` = 429 do backend · `timeout` = 9s estourados · `backend` =
 * respondeu sem cotação · `rede` = fetch falhou · `config` = env ausente.
 */
export type MotivoFalhaCotacao = 'rate_limit' | 'timeout' | 'backend' | 'rede' | 'config';

export interface CotacaoDoSite {
  quotes: ShippingQuote[];
  /** Régua vigente — a barra de progresso da sacola lê daqui. */
  freteGratis: { ativo: boolean; minimo: number; alcancado: boolean; falta: number };
  /** true = veio da tabela local (backend fora) ou da estimativa do backend. */
  estimado: boolean;
  /**
   * DE ONDE saíram os números. `backend` é a cotação de verdade (mesmo que
   * marcada `estimado`, porque os Correios não responderam — a promoção e a
   * régua do frete grátis ainda são as cadastradas). `local` é o paraquedas:
   * tabela deste arquivo, SEM promoção, e o valor pode mudar na hora de pagar.
   * A tela precisa distinguir pra avisar — até 17/08 os dois casos eram o
   * mesmo " · frete estimado" e a cliente de SP via SEDEX R$ 24,90 no lugar
   * do R$ 9,99 anunciado sem nenhum aviso nem botão pra tentar de novo.
   */
  origem: 'backend' | 'local';
  /** Só quando `origem === 'local'`: o motivo que o BFF viu (telemetria + retry). */
  motivo?: MotivoFalhaCotacao;
  /** Texto da retirada em loja, cadastrado na retaguarda. */
  retirada?: { prazoHoras: number; instrucoes: string | null };
}

/**
 * As opções de entrega REAIS. Roda no navegador (a rota /api carrega o token).
 *
 * Sempre devolve algo: backend fora → tabela local marcada `estimado` e
 * `origem:'local'`. A retirada é adicionada aqui nos dois casos, porque quem
 * sabe quais lojas atendem aquele CEP é o site.
 *
 * UMA retentativa quando o BFF falhou por timeout/rede/backend — e NENHUMA
 * no 429. Motivo: o abort de 9s do BFF não cancela o handler do Nest, que
 * termina de falar com os Correios e grava o cache de 20 min; a segunda
 * chamada volta em menos de 1s com a tabela promocional. Já o rate-limit é
 * janela deslizante de 60s: retentar dentro do mesmo minuto só gasta o balde
 * e atrasa a tela. `config` também não retenta (env não muda entre duas
 * chamadas).
 */
export async function fetchQuotes(
  cep: string,
  subtotal: number,
  pecas = 1,
  signal?: AbortSignal,
): Promise<CotacaoDoSite> {
  const digits = onlyDigits(cep);

  const local = (motivo?: MotivoFalhaCotacao): CotacaoDoSite => ({
    // Sem coordenada aqui de propósito: este é o caminho de EMERGÊNCIA
    // (backend fora), e ele não pode depender de mais nenhuma rede.
    quotes: quoteShipping(digits, subtotal),
    freteGratis: {
      ativo: true,
      minimo: FREE_SHIPPING_FROM,
      alcancado: subtotal >= FREE_SHIPPING_FROM,
      falta: Math.max(0, Math.round((FREE_SHIPPING_FROM - subtotal) * 100) / 100),
    },
    estimado: true,
    origem: 'local',
    ...(motivo ? { motivo } : {}),
  });

  if (!isValidCep(digits)) {
    return {
      quotes: [],
      freteGratis: { ativo: false, minimo: 0, alcancado: false, falta: 0 },
      estimado: false,
      origem: 'local',
    };
  }

  const motivoDe = (dados: unknown): MotivoFalhaCotacao => {
    const m = (dados as { motivo?: unknown } | null)?.motivo;
    return m === 'rate_limit' || m === 'timeout' || m === 'backend' || m === 'rede' || m === 'config' ? m : 'backend';
  };

  type OpcaoBff = {
    id?: string | number; kind?: string; label?: string;
    price?: number | string; etaDays?: { min: number; max: number };
    promocional?: boolean;
  };
  type RespostaBff = {
    ok?: boolean;
    opcoes?: OpcaoBff[];
    motivo?: unknown;
    freteGratis?: CotacaoDoSite['freteGratis'];
    estimado?: boolean;
    retirada?: CotacaoDoSite['retirada'];
    coord?: Ponto | null;
  } | null;

  const chamar = async (): Promise<RespostaBff> => {
    try {
      const res = await fetch('/api/loja/frete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cep: digits, subtotal, pecas }),
        signal,
      });
      return (await res.json().catch(() => null)) as RespostaBff;
    } catch (err) {
      // Cancelamento sobe (o `catch` de fora devolve a tabela local, que a
      // tela descarta); falha de rede do celular vira `rede` e ganha a mesma
      // retentativa única de qualquer outra falha.
      if (signal?.aborted) throw err;
      return { ok: false, motivo: 'rede' };
    }
  };

  const semCotacao = (d: RespostaBff) => !d?.ok || !Array.isArray(d.opcoes) || !d.opcoes.length;

  try {
    let dados = await chamar();
    if (semCotacao(dados)) {
      const motivo = motivoDe(dados);
      // Quem cancelou não quer resultado; 429 e env ausente não melhoram
      // numa segunda chamada.
      if (signal?.aborted || motivo === 'rate_limit' || motivo === 'config') return local(motivo);
      dados = await chamar();
      if (semCotacao(dados)) return local(motivoDe(dados));
    }
    if (!dados || !Array.isArray(dados.opcoes)) return local('backend');

    return {
      quotes: ordenarOpcoes([
        ...dados.opcoes.map(
          (o: OpcaoBff): ShippingQuote => ({
            id: String(o.id),
            kind: o.kind === 'expressa' ? 'expressa' : 'correios',
            label: String(o.label),
            price: Number(o.price) || 0,
            etaDays: o.etaDays,
            // Quem carimba é o backend: ele conhece a campanha e a janela
            // de datas. Adivinhar aqui por faixa de preço quebraria calado
            // no dia em que a campanha mudasse.
            promocional: o.promocional === true,
          }),
        ),
        ...pickupStoresFor(digits, dados.retirada?.prazoHoras, dados.coord),
      ]),
      freteGratis: dados.freteGratis ?? {
        ativo: true,
        minimo: FREE_SHIPPING_FROM,
        alcancado: subtotal >= FREE_SHIPPING_FROM,
        falta: Math.max(0, Math.round((FREE_SHIPPING_FROM - subtotal) * 100) / 100),
      },
      estimado: !!dados.estimado,
      origem: 'backend',
      retirada: dados.retirada,
    };
  } catch {
    // AbortError incluído: quem cancelou não quer resultado, e devolver a
    // tabela local é inofensivo (a tela descarta).
    return local('rede');
  }
}

/** Quanto falta pro frete grátis — alimenta a barra de progresso da sacola. */
export function freeShippingGap(
  subtotal: number,
  minimo = FREE_SHIPPING_FROM,
): { reached: boolean; missing: number; progress: number } {
  if (!(minimo > 0)) return { reached: true, missing: 0, progress: 1 };
  const missing = Math.max(0, minimo - subtotal);
  return {
    reached: missing === 0,
    missing: Math.round(missing * 100) / 100,
    progress: Math.min(1, subtotal / minimo),
  };
}
