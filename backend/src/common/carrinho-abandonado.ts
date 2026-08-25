/**
 * REGRAS DO CARRINHO ABANDONADO QUE VALEM NOS DOIS LADOS (dono, 25/08/2026).
 *
 * A mesma fila é lida por duas telas com código separado:
 *   • retaguarda — `AbandonedCartsService.listEcommercePending` (junta 4 fontes);
 *   • PDV        — `PdvService.listarCarrinhosAbandonados` (só o site novo).
 *
 * Enquanto a regra de "o que é abandono" morou em cada uma delas, as duas
 * discordaram: o piso de idade existia num ramo só de uma e em nenhum da outra,
 * e a tela que o dono abriu às 11:55 mostrava carrinho das 11:41 — cliente
 * ainda na tela de pagamento, com botão de WhatsApp do lado pra cobrar.
 *
 * Aqui não há DI de propósito: são funções puras + um punhado que recebe o
 * `prisma` por parâmetro. `PdvModule` já quebrou o boot do backend uma vez por
 * causa de import de módulo novo (07/08) — não vale pagar esse risco pra
 * compartilhar 100 linhas.
 */

/**
 * A ESPERA ANTES DE CHAMAR UM CARRINHO DE "ABANDONADO" — 1 hora.
 *
 * Conta do NASCIMENTO da linha ("início da inserção dos dados", palavras do
 * dono), não do último toque: a captura do checkout regrava a cada tecla, e
 * contar pelo último toque deixaria o carrinho invisível justo enquanto ela
 * mexe nele — e visível quando ela para, que é tarde demais.
 *
 * Env `CARRINHO_ESPERA_MIN` pra ajustar sem deploy. `0` desliga a espera.
 */
export function carrinhoEsperaMin(): number {
  const v = Number(process.env.CARRINHO_ESPERA_MIN);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

/** Ainda no forno: nasceu há menos que a espera, então não é abandono. */
export function carrinhoNoForno(nascimento: Date | string | null | undefined): boolean {
  const t = nascimento instanceof Date ? nascimento.getTime() : Date.parse(String(nascimento ?? ''));
  if (!Number.isFinite(t)) return false; // sem data: melhor mostrar do que sumir
  return Date.now() - t < carrinhoEsperaMin() * 60_000;
}

/** Corte de data pronto pra query: só linhas nascidas ANTES disto são abandono. */
export function carrinhoTetoNascimento(): Date {
  return new Date(Date.now() - carrinhoEsperaMin() * 60_000);
}

/**
 * CHAVE ESTÁVEL DA LINHA — ver o model `CarrinhoDesfecho`.
 *
 * A baixa é sobre AQUELE carrinho, não sobre a cliente: quem abandonar de novo
 * semana que vem volta pra fila. E não pode ser o `id` da lista: a linha de
 * contato capturado tem id SINTÉTICO (970.000.000 + posição), que muda a cada
 * carregamento — dar baixa por ele daria baixa em outra pessoa amanhã.
 */
export const chaveCarrinhoPedido = (wcOrderId: unknown) => `pedido:${String(wcOrderId ?? '')}`;
export const chaveCarrinhoContato = (recoveryId: unknown) => `contato:${String(recoveryId ?? '')}`;

/**
 * MOTIVOS DA BAIXA — lista fechada, porque é o que vira relatório.
 *
 * Texto livre não soma: "achou caro", "tava caro" e "preço" viram três coisas
 * diferentes no fim do mês. O slug conta; o caso mora na observação. `outro`
 * EXIGE observação — sem isso ele vira o ralo pra onde tudo vai.
 */
export const MOTIVOS_BAIXA: Array<{ slug: string; label: string }> = [
  { slug: 'preco', label: 'Achou caro' },
  { slug: 'frete', label: 'Frete caro ou demorado' },
  { slug: 'sem_tamanho', label: 'Não tinha o tamanho/cor' },
  { slug: 'so_pesquisando', label: 'Só estava pesquisando' },
  { slug: 'comprou_loja', label: 'Vai comprar na loja física' },
  { slug: 'comprou_fora', label: 'Comprou em outro lugar' },
  { slug: 'pagamento', label: 'Problema no pagamento' },
  { slug: 'sem_resposta', label: 'Não respondeu' },
  { slug: 'desistiu', label: 'Desistiu / adiou a compra' },
  { slug: 'contato_errado', label: 'Telefone errado / não é ela' },
  { slug: 'outro', label: 'Outro (explique)' },
];

const soDigitosFone = (v: unknown) =>
  String(v ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');

export function desfechoPublico(d: any) {
  return {
    chave: d.chave,
    telefone: d.telefone ?? null,
    motivo: d.motivo,
    motivoLabel: MOTIVOS_BAIXA.find((m) => m.slug === d.motivo)?.label ?? d.motivo,
    observacao: d.observacao ?? null,
    por: d.usuarioNome,
    em: d.criadoEm?.toISOString?.() ?? null,
    valor: d.valor != null ? Number(d.valor) : null,
  };
}

export type BaixaCarrinho = ReturnType<typeof desfechoPublico>;

/** As baixas de um lote de linhas, pra tirar da fila quem já foi resolvido. */
export async function baixasPorChave(
  prisma: any,
  chaves: string[],
  aviso?: (msg: string) => void,
): Promise<Map<string, BaixaCarrinho>> {
  const mapa = new Map<string, BaixaCarrinho>();
  const limpas = chaves.filter(Boolean);
  if (!limpas.length) return mapa;
  try {
    const linhas = await prisma.carrinhoDesfecho.findMany({ where: { chave: { in: limpas } } });
    for (const d of linhas) mapa.set(d.chave, desfechoPublico(d));
  } catch (e: any) {
    // Tabela ainda não aplicada (deploy em andamento) não pode derrubar a
    // lista — no pior caso a linha com baixa reaparece até o deploy terminar.
    aviso?.(`[carrinhos] não consegui ler as baixas: ${e?.message ?? e}`);
  }
  return mapa;
}

/** Lista as baixas do período (a tela usa pra pintar motivo e permitir desfazer). */
export async function listarBaixas(prisma: any, since?: string, aviso?: (msg: string) => void) {
  try {
    const where: any = {};
    if (since) where.criadoEm = { gte: new Date(since + 'T00:00:00') };
    const linhas = await prisma.carrinhoDesfecho.findMany({
      where,
      orderBy: { criadoEm: 'desc' },
      take: 2_000,
    });
    return { ok: true, motivos: MOTIVOS_BAIXA, itens: linhas.map(desfechoPublico) };
  } catch (e: any) {
    aviso?.(`[carrinhos] não consegui ler as baixas: ${e?.message ?? e}`);
    return { ok: true, motivos: MOTIVOS_BAIXA, itens: [] };
  }
}

/**
 * DÁ BAIXA: este carrinho não vai virar venda, e fica registrado o porquê.
 *
 * Apaga o atendimento da cliente junto, de propósito. A tag "em atendimento"
 * não vence mais no relógio (o dono cancelou as 2h em 25/08), então a baixa é
 * a ÚNICA porta de saída: caso encerrado, telefone liberado. Se ela abandonar
 * de novo, a linha nova nasce limpa.
 */
export async function registrarBaixaCarrinho(
  prisma: any,
  body: any,
  user: any,
  aviso?: (msg: string) => void,
) {
  const chave = String(body?.chave ?? '').trim().slice(0, 80);
  const motivo = String(body?.motivo ?? '').trim().slice(0, 40);
  const observacao = String(body?.observacao ?? '').trim().slice(0, 400);
  if (!chave || !/^[a-z]+:.+$/.test(chave)) {
    return { ok: false, error: 'Carrinho inválido pra dar baixa.' };
  }
  if (!MOTIVOS_BAIXA.some((m) => m.slug === motivo)) {
    return { ok: false, error: 'Escolha um motivo da lista.' };
  }
  if (motivo === 'outro' && observacao.length < 3) {
    return { ok: false, error: 'No motivo "Outro" escreva o que aconteceu.' };
  }
  const telefone = soDigitosFone(body?.telefone);
  const valorNum = Number(body?.valor);
  const dados = {
    telefone: telefone.length >= 10 ? telefone : null,
    nomeCliente: String(body?.nome ?? '').trim().slice(0, 120) || null,
    valor: Number.isFinite(valorNum) && valorNum > 0 ? valorNum : null,
    motivo,
    observacao: observacao || null,
    usuarioId: user?.sub || user?.id || null,
    usuarioNome: String(user?.name || user?.email || 'Matriz').trim().slice(0, 120),
    criadoEm: new Date(),
  };
  try {
    // Upsert: dar baixa de novo é CORRIGIR o motivo, não empilhar registro.
    const salvo = await prisma.carrinhoDesfecho.upsert({
      where: { chave },
      create: { chave, ...dados },
      update: dados,
    });
    if (dados.telefone) {
      try {
        await prisma.carrinhoAtendimento.delete({ where: { telefone: dados.telefone } });
      } catch {
        /* não tinha atendimento aberto — a baixa vale do mesmo jeito */
      }
    }
    return { ok: true, desfecho: desfechoPublico(salvo) };
  } catch (e: any) {
    aviso?.(`[carrinhos] não consegui dar baixa em ${chave}: ${e?.message ?? e}`);
    return { ok: false, error: 'Não consegui registrar a baixa.' };
  }
}

/** Desfaz a baixa — a linha volta pra fila. Baixa errada tem que ter volta. */
export async function reabrirCarrinhoBaixado(prisma: any, chaveRaw: string) {
  const chave = String(chaveRaw ?? '').trim().slice(0, 80);
  if (!chave) return { ok: false, error: 'Carrinho inválido.' };
  try {
    await prisma.carrinhoDesfecho.delete({ where: { chave } });
  } catch {
    // Já não existia: o resultado que o usuário queria (linha na fila) é este.
  }
  return { ok: true, chave };
}
