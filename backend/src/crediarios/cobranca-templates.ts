/**
 * Templates de cobrança WhatsApp — 6 variações pra rotacionar e evitar
 * detecção de spam pelo WhatsApp.
 *
 * Cada template recebe:
 *   - nome:        primeiro nome do cliente (em PascalCase)
 *   - parcelas:    array com { vencimento, valor, parcela, totalParcelas }
 *   - lojaNome:    nome amigável da loja (default "Lurd's Plus Size")
 *
 * Regra de rotação: usa `seq % templates.length` — então clientes diferentes
 * pegam mensagens diferentes, e o MESMO cliente em dias diferentes também
 * pega variações (campo `dia` pra rotação por dia).
 */

export interface ParcelaCobranca {
  vencimento: string;       // "2026-04-15"
  valor: number;            // 89.90
  parcela?: number;         // 2
  totalParcelas?: number;   // 4
  diasAtraso?: number;      // 12
}

export interface CobrancaContext {
  nome: string;
  parcelas: ParcelaCobranca[];
  lojaNome?: string;
}

function fmtBRL(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtData(iso: string): string {
  // "2026-04-15" → "15/04/2026"
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function firstName(full: string): string {
  if (!full) return 'Cliente';
  const clean = full.trim().split(/\s+/)[0] || 'Cliente';
  // Capitaliza
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

function listaParcelas(parcelas: ParcelaCobranca[], opts: { compact?: boolean } = {}): string {
  return parcelas
    .map((p) => {
      const dt = fmtData(p.vencimento);
      const v = fmtBRL(p.valor);
      const parc = p.parcela && p.totalParcelas ? ` (parc. ${p.parcela}/${p.totalParcelas})` : '';
      if (opts.compact) {
        return `• ${dt} — ${v}${parc}`;
      }
      return `▫️ Vencimento ${dt} — ${v}${parc}`;
    })
    .join('\n');
}

function totalGeral(parcelas: ParcelaCobranca[]): number {
  return parcelas.reduce((s, p) => s + (Number(p.valor) || 0), 0);
}

// =============== TEMPLATES ===============

export const TEMPLATES: Array<(c: CobrancaContext) => string> = [
  // 1 — Lembrete amigável
  (c) => {
    const nome = firstName(c.nome);
    const loja = c.lojaNome || `Lurd's Plus Size`;
    const lista = listaParcelas(c.parcelas);
    const total = fmtBRL(totalGeral(c.parcelas));
    return `Oi ${nome}! Aqui é da ${loja} 💗

Identificamos que ficou pendente o pagamento da(s) parcela(s) abaixo:

${lista}

*Total em aberto: ${total}*

Posso te ajudar a regularizar hoje? Qualquer dificuldade me avisa por aqui que a gente combina. 🙏`;
  },

  // 2 — Tom prático
  (c) => {
    const nome = firstName(c.nome);
    const lista = listaParcelas(c.parcelas, { compact: true });
    const total = fmtBRL(totalGeral(c.parcelas));
    return `Olá ${nome}, tudo bem?

Passando aqui pra avisar que sua parcela do crediário está em aberto:

${lista}

Total: ${total}

Se já efetuou o pagamento, desconsidere. Caso contrário, me avise como podemos resolver. 😊`;
  },

  // 3 — Direto ao ponto
  (c) => {
    const nome = firstName(c.nome);
    const lista = listaParcelas(c.parcelas);
    const total = fmtBRL(totalGeral(c.parcelas));
    const loja = c.lojaNome || `Lurd's Plus Size`;
    return `${nome}, tudo bem?

Aqui é da ${loja}. Vi que o pagamento abaixo ainda não consta no nosso sistema:

${lista}

Valor total: ${total}

Consegue me retornar pra alinharmos? Obrigado!`;
  },

  // 4 — Pergunta aberta
  (c) => {
    const nome = firstName(c.nome);
    const lista = listaParcelas(c.parcelas, { compact: true });
    const total = fmtBRL(totalGeral(c.parcelas));
    return `Oi ${nome} 💖

Como você está? Estou passando pra falar do crediário aqui na loja:

${lista}

São ${total} no total ainda em aberto. Posso te enviar o PIX por aqui? Ou prefere combinar de outro jeito?`;
  },

  // 5 — Empático
  (c) => {
    const nome = firstName(c.nome);
    const lista = listaParcelas(c.parcelas);
    const total = fmtBRL(totalGeral(c.parcelas));
    const loja = c.lojaNome || `Lurd's`;
    return `${nome}, oi!

Da ${loja} aqui. Sei que o mês corre, mas queria lembrar do(s) seu(s) pagamento(s) que estão pendentes:

${lista}

Saldo aberto: ${total}

Bora resolver? Estou disponível pra qualquer dúvida.`;
  },

  // 6 — Curto e cordial
  (c) => {
    const nome = firstName(c.nome);
    const lista = listaParcelas(c.parcelas, { compact: true });
    const total = fmtBRL(totalGeral(c.parcelas));
    return `${nome}, bom dia! ☀️

Sua parcela do crediário continua em aberto:

${lista}

Total: ${total}

Te aguardo aqui pra fecharmos. Obrigada!`;
  },
];

/**
 * Aplica placeholders num template-string (custom):
 *   {nome}            → primeiro nome capitalizado
 *   {nome_completo}   → nome do cadastro inteiro
 *   {parcelas}        → lista bonita (▫️ Vencimento dd/mm/aaaa — R$ X,XX (parc. N/M))
 *   {parcelas_compact} → versão compacta (• dd/mm/aaaa — R$ X,XX)
 *   {total}           → soma em R$
 *   {loja}            → c.lojaNome ou "Lurd's Plus Size"
 *   {qtd_parcelas}    → quantidade de parcelas em aberto
 *   {primeiro_venc}   → vencimento mais antigo dd/mm/aaaa
 *   {dias_atraso}     → dias do venc mais antigo até hoje
 */
function renderCustomTemplate(tmpl: string, c: CobrancaContext): string {
  const nome = firstName(c.nome);
  const loja = c.lojaNome || `Lurd's Plus Size`;
  const lista = listaParcelas(c.parcelas);
  const listaCompact = listaParcelas(c.parcelas, { compact: true });
  const total = fmtBRL(totalGeral(c.parcelas));
  const qtdParc = c.parcelas.length;
  let primeiroVenc = '';
  let diasAtraso = 0;
  if (c.parcelas.length) {
    const sorted = [...c.parcelas].sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)));
    const v = sorted[0]?.vencimento;
    primeiroVenc = v ? fmtData(String(v).slice(0, 10)) : '';
    if (v) {
      const d = new Date(String(v).slice(0, 10));
      diasAtraso = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
    }
  }
  return tmpl
    .replace(/\{nome_completo\}/g, c.nome || nome)
    .replace(/\{nome\}/g, nome)
    .replace(/\{parcelas_compact\}/g, listaCompact)
    .replace(/\{parcelas\}/g, lista)
    .replace(/\{total\}/g, total)
    .replace(/\{loja\}/g, loja)
    .replace(/\{qtd_parcelas\}/g, String(qtdParc))
    .replace(/\{primeiro_venc\}/g, primeiroVenc)
    .replace(/\{dias_atraso\}/g, String(diasAtraso));
}

/**
 * Renderiza mensagem de cobrança para um cliente.
 *
 * @param ctx           Dados do cliente + parcelas
 * @param seq           Índice (cliente N na fila) — pra rotacionar template
 * @param dayOffset     Quantos dias depois do disparo inicial (rotaciona +)
 * @param customTemplates  (opcional) — array de strings com placeholders.
 *                         Se passado, sobrescreve os 6 hardcoded.
 */
export function renderCobranca(
  ctx: CobrancaContext,
  seq: number,
  dayOffset: number = 0,
  customTemplates?: string[],
): { text: string; templateIndex: number } {
  if (customTemplates && customTemplates.length > 0) {
    const idx = ((seq + dayOffset) % customTemplates.length + customTemplates.length) % customTemplates.length;
    const t = customTemplates[idx] || TEMPLATES[0](ctx);
    return { text: renderCustomTemplate(t, ctx), templateIndex: idx };
  }
  const idx = ((seq + dayOffset) % TEMPLATES.length + TEMPLATES.length) % TEMPLATES.length;
  return { text: TEMPLATES[idx](ctx), templateIndex: idx };
}

/** Templates default em formato string (com placeholders) — pra UI de edição. */
export const DEFAULT_TEMPLATE_STRINGS: string[] = [
  // 1 — Lembrete amigável
  `Oi {nome}! Aqui é da {loja} 💗

Identificamos que ficou pendente o pagamento da(s) parcela(s) abaixo:

{parcelas}

*Total em aberto: {total}*

Posso te ajudar a regularizar hoje? Qualquer dificuldade me avisa por aqui que a gente combina. 🙏`,

  // 2 — Tom prático
  `Olá {nome}, tudo bem?

Passando aqui pra avisar que sua parcela do crediário está em aberto:

{parcelas_compact}

Total: {total}

Se já efetuou o pagamento, desconsidere. Caso contrário, me avise como podemos resolver. 😊`,

  // 3 — Direto ao ponto
  `{nome}, tudo bem?

Aqui é da {loja}. Vi que o pagamento abaixo ainda não consta no nosso sistema:

{parcelas}

Valor total: {total}

Consegue me retornar pra alinharmos? Obrigado!`,

  // 4 — Pergunta aberta
  `Oi {nome} 💖

Como você está? Estou passando pra falar do crediário aqui na loja:

{parcelas_compact}

São {total} no total ainda em aberto. Posso te enviar o PIX por aqui? Ou prefere combinar de outro jeito?`,

  // 5 — Empático
  `{nome}, oi!

Da {loja} aqui. Sei que o mês corre, mas queria lembrar do(s) seu(s) pagamento(s) que estão pendentes:

{parcelas}

Saldo aberto: {total}

Bora resolver? Estou disponível pra qualquer dúvida.`,

  // 6 — Curto e cordial
  `{nome}, bom dia! ☀️

Sua parcela do crediário continua em aberto:

{parcelas_compact}

Total: {total}

Te aguardo aqui pra fecharmos. Obrigada!`,
];
