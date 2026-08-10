import { NextResponse } from 'next/server';
import { ApiError } from '@/lib/api';
import { chamarTrocas, resolverDoc } from '@/lib/trocas';

/**
 * BFF DO PORTAL DE TROCAS — uma porta só pras ações do FlowOps.
 *
 * Rota única com `[acao]` em vez de seis arquivos quase idênticos: todas as
 * ações têm o mesmo formato (POST, corpo JSON, resolve o `doc`, repassa,
 * traduz o erro). Seis cópias divergiriam na primeira correção feita em uma
 * só — e a que mais importa é justamente a resolução do `doc`.
 *
 * ⚠️ O `doc` do corpo é IGNORADO quando há sessão (ver `resolverDoc`). Sem
 * isso, quem estivesse logada poderia trocar o CPF no corpo da requisição e
 * enxergar o pedido de outra pessoa.
 *
 * A lista branca de ações existe porque o caminho vem da URL: sem ela, um
 * `/api/trocas/qualquer-coisa` viraria proxy aberto pro backend.
 */

const ACOES = new Set([
  'buscar',
  'localizar',
  'solicitar',
  'solicitar-novamente',
  'variacoes',
  'decidir',
  'rastreio',
]);

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ acao: string }> }) {
  const { acao } = await ctx.params;
  if (!ACOES.has(acao)) {
    return NextResponse.json({ ok: false, error: 'Ação desconhecida.' }, { status: 404 });
  }

  let corpo: Record<string, unknown> = {};
  try {
    corpo = (await req.json()) as Record<string, unknown>;
  } catch {
    /* corpo vazio é válido pra `buscar` de cliente logada */
  }

  const doc = await resolverDoc(corpo.doc as string | undefined);
  if (!doc) {
    return NextResponse.json(
      { ok: false, error: 'Informe o CPF, celular ou e-mail usado na compra.' },
      { status: 400 },
    );
  }

  try {
    const r = await chamarTrocas<unknown>(acao, { ...corpo, doc });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof ApiError) {
      /**
       * O portal responde 400 com mensagem PRONTA PRA CLIENTE ("pedido fora do
       * prazo de troca", "muitas tentativas"). Repassar o texto dele é melhor
       * que inventar um genérico aqui — a regra é dele, a explicação também.
       */
      const texto =
        e.mensagemDoBackend ||
        (e.status === 400
          ? 'Não conseguimos localizar essa compra. Confira os dados e tente de novo.'
          : 'Não conseguimos abrir o portal de trocas agora. Tente em instantes. 💜');
      return NextResponse.json({ ok: false, error: texto }, { status: e.status === 400 ? 400 : 502 });
    }
    console.error('[trocas] falha:', e);
    return NextResponse.json(
      { ok: false, error: 'Não conseguimos abrir o portal de trocas agora. Tente em instantes. 💜' },
      { status: 502 },
    );
  }
}
