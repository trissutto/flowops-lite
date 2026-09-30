/**
 * Etiquetas do que ACABOU de entrar (dono, 30/09/2026).
 *
 * Recebia-se uma cor, imprimia; depois chegava a outra cor da mesma REF e o
 * botão "Etiquetas" imprimia a REF inteira de novo — a cor já etiquetada saía
 * em dobro. A tela de etiquetas só sabia filtrar por REF.
 *
 * Aqui fica a lista dos CÓDIGOS (EAN) que este computador deu entrada e ainda
 * não mandou imprimir, por pedido. O recebimento acrescenta; o "Imprimir" da
 * tela de etiquetas tira. A chave é o código, não a cor: o nome da cor no SKU
 * gerado pode não ser letra por letra o do item do pedido.
 *
 * É conveniência de tela (localStorage): sem ela, ou em outro PC, a tela de
 * etiquetas mostra tudo, como sempre mostrou.
 */

const chave = (orderId: string) => `po-etiquetas-novas:${orderId}`;

export function lerRecemRecebidas(orderId: string): string[] {
  try {
    const raw = localStorage.getItem(chave(orderId));
    const lista = raw ? JSON.parse(raw) : [];
    return Array.isArray(lista) ? lista.map(String) : [];
  } catch {
    return [];
  }
}

function gravar(orderId: string, codigos: string[]) {
  try {
    if (codigos.length === 0) localStorage.removeItem(chave(orderId));
    else localStorage.setItem(chave(orderId), JSON.stringify(codigos));
  } catch { /* sem storage: a tela de etiquetas mostra tudo */ }
}

export function marcarRecemRecebidas(orderId: string, codigos: string[]) {
  const atual = new Set(lerRecemRecebidas(orderId));
  for (const c of codigos) if (c) atual.add(String(c));
  gravar(orderId, Array.from(atual));
}

export function tirarRecemRecebidas(orderId: string, codigos: string[]) {
  const sai = new Set(codigos.map(String));
  gravar(orderId, lerRecemRecebidas(orderId).filter((c) => !sai.has(c)));
}

/** Códigos com peça (qty > 0) dos itens informados — aceita skusGerados nos dois formatos gravados. */
export function codigosDosItens(items: any[], itemIds: string[]): string[] {
  const ids = new Set(itemIds);
  const out: string[] = [];
  for (const it of items || []) {
    if (!ids.has(it.id)) continue;
    let parsed: any = it.skusGerados;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    const skus: any[] = Array.isArray(parsed) ? parsed : (parsed?.skus || []);
    for (const s of skus) if (s?.codigo && Number(s.qty) > 0) out.push(String(s.codigo));
  }
  return out;
}
