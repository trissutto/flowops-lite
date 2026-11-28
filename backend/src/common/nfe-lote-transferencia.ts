/**
 * NF-e DE TRANSFERÊNCIA EM LOTE — régua pura (dono, 28/11/2026).
 *
 * Pedido: "gerar nota fiscal de tudo que Campinas recebeu nos últimos 3 meses
 * — eu não gerei e está com erro fiscal — juntando as remessas pra não sair um
 * monte de notas". As remessas EXISTEM, foram bipadas peça a peça e já
 * moveram o estoque; o que faltou foi o documento. Esta régua decide COMO
 * agrupar as remessas em notas — nunca inventa item: cada nota carrega
 * exatamente as linhas das remessas que ela cobre.
 *
 * Regras:
 *  - Uma remessa pertence a UMA nota só (a nota cita as remessas que cobre e
 *    a remessa aponta pra nota — nunca "metade da caixa" em cada nota).
 *  - Mesma nota = mesmo emitente (CNPJ) E mesmo destinatário.
 *  - Teto de ITENS DISTINTOS por nota (det): o schema aceita 990, mas a
 *    mensagem da SEFAZ tem limite de 500 KB e cada item de transferência
 *    ocupa ~1 KB assinado — o padrão de 300 deixa folga larga.
 *  - Remessa que sozinha passa do teto vira nota própria (não se parte).
 */

export interface RemessaDoLote {
  id: string;
  code: string;
  emitenteCnpj: string;
  destinoCnpj: string;
  receivedAt: Date | string | null;
  /** SKU (código da peça) → quantidade, já sem linhas canceladas. */
  pecas: Map<string, number>;
}

export interface NotaPlanejada {
  emitenteCnpj: string;
  destinoCnpj: string;
  remessas: RemessaDoLote[];
  skus: Set<string>;
}

export const MAX_ITENS_POR_NOTA_PADRAO = 300;

export function maxItensPorNota(env: string | undefined): number {
  const n = Math.floor(Number(env));
  if (!Number.isFinite(n) || n < 1) return MAX_ITENS_POR_NOTA_PADRAO;
  return Math.min(n, 900);
}

function quando(d: Date | string | null): number {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Agrupa as remessas em notas: por (emitente, destino), na ordem em que
 *  chegaram, enchendo cada nota até o teto de itens distintos. */
export function planejarNotas(remessas: RemessaDoLote[], maxItens = MAX_ITENS_POR_NOTA_PADRAO): NotaPlanejada[] {
  const ordenadas = [...remessas].sort(
    (a, b) => quando(a.receivedAt) - quando(b.receivedAt) || a.code.localeCompare(b.code),
  );
  const abertas = new Map<string, NotaPlanejada>();
  const notas: NotaPlanejada[] = [];
  for (const r of ordenadas) {
    if (!r.pecas.size) continue;
    const chave = `${r.emitenteCnpj}>${r.destinoCnpj}`;
    let nota = abertas.get(chave);
    if (nota) {
      let novos = 0;
      for (const sku of r.pecas.keys()) if (!nota.skus.has(sku)) novos++;
      if (nota.skus.size + novos > maxItens) nota = undefined;
    }
    if (!nota) {
      nota = { emitenteCnpj: r.emitenteCnpj, destinoCnpj: r.destinoCnpj, remessas: [], skus: new Set() };
      notas.push(nota);
      abertas.set(chave, nota);
    }
    nota.remessas.push(r);
    for (const sku of r.pecas.keys()) nota.skus.add(sku);
  }
  return notas;
}

/** Soma as peças de todas as remessas da nota por SKU. */
export function pecasDaNota(nota: NotaPlanejada): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of nota.remessas) {
    for (const [sku, q] of r.pecas) out.set(sku, (out.get(sku) || 0) + q);
  }
  return out;
}

function dataBr(d: Date | string | null): string {
  if (!d) return '?';
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return '?';
  return dt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/** Informação complementar da nota: diz que é emitida DEPOIS da circulação
 *  e quais remessas cobre (infCpl tem teto de 5000 caracteres). */
export function textoInfCplLote(nota: NotaPlanejada): string {
  const datas = nota.remessas.map((r) => quando(r.receivedAt)).filter((t) => t > 0);
  const de = datas.length ? dataBr(new Date(Math.min(...datas))) : '?';
  const ate = datas.length ? dataBr(new Date(Math.max(...datas))) : '?';
  const codigos = nota.remessas.map((r) => r.code).join(', ');
  const texto =
    `Transferencia de mercadoria entre estabelecimentos do mesmo titular. ` +
    `Nota emitida em regularizacao de ${nota.remessas.length} remessa(s) recebida(s) ` +
    `de ${de} a ${ate}: ${codigos}`;
  return texto.length > 4900 ? texto.slice(0, 4897) + '...' : texto;
}

/** Todas as remessas que uma nota cobre (a avulsa usa shipmentId; a do lote,
 *  shipmentIds). */
export function remessasDaNota(d: { shipmentId?: string | null; shipmentIds?: string[] | null }): string[] {
  const ids = [d.shipmentId, ...(d.shipmentIds || [])].filter((x): x is string => !!x);
  return [...new Set(ids)];
}

/** Filtro Prisma: notas que cobrem alguma destas remessas (avulsa ou lote). */
export function ondeNotaDasRemessas(ids: string[]) {
  return { OR: [{ shipmentId: { in: ids } }, { shipmentIds: { hasSome: ids } }] };
}
