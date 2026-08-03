import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';
import { apagarToken, gravarToken, getClienteLogada } from '@/lib/conta';

/**
 * SESSÃO DA CLIENTE — login, cadastro e sair.
 *
 * POST { acao: 'login' | 'cadastro', ... } → grava o cookie httpOnly
 * DELETE                                   → derruba a sessão
 * GET                                      → quem está logada (ou null)
 *
 * O token do CRM nunca chega ao navegador: fica no cookie, e o navegador só
 * recebe os dados públicos da cliente.
 */

export const dynamic = 'force-dynamic';

interface RespostaLogin {
  token: string;
  customer: Record<string, unknown>;
}

/** Erro do backend em português, sem vazar detalhe de infraestrutura. */
function mensagem(e: unknown, padrao: string): { texto: string; status: number } {
  if (e instanceof ApiError) {
    if (e.status === 401) return { texto: 'CPF ou senha não conferem.', status: 401 };
    if (e.status === 409) return { texto: 'Este CPF já tem cadastro. Tente entrar.', status: 409 };
    if (e.status === 400) return { texto: 'Confira os dados informados.', status: 400 };
    if (e.status === 503) return { texto: 'Sistema em manutenção — tente em instantes.', status: 503 };
  }
  console.error('[conta] falha:', e);
  return { texto: padrao, status: 502 };
}

export async function GET() {
  try {
    const cliente = await getClienteLogada();
    return NextResponse.json({ cliente });
  } catch {
    // Backend fora não pode derrubar o header do site inteiro.
    return NextResponse.json({ cliente: null });
  }
}

export async function POST(request: Request) {
  let corpo: Record<string, unknown>;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: 'Requisição inválida.' }, { status: 400 });
  }

  const cpf = String(corpo?.cpf ?? '').replace(/\D/g, '');
  const senha = String(corpo?.senha ?? '');
  if (cpf.length !== 11) {
    return NextResponse.json({ erro: 'O CPF precisa ter 11 dígitos.' }, { status: 400 });
  }
  if (senha.length < 4) {
    return NextResponse.json({ erro: 'A senha precisa ter ao menos 4 dígitos.' }, { status: 400 });
  }

  const cadastro = corpo?.acao === 'cadastro';
  try {
    const resposta = await api<RespostaLogin>(
      cadastro ? '/customers/app/register' : '/customers/app/login',
      {
        method: 'POST',
        body: cadastro
          ? {
              cpf,
              password: senha,
              name: String(corpo?.nome ?? '').trim(),
              phone: String(corpo?.telefone ?? '').replace(/\D/g, ''),
              email: String(corpo?.email ?? '').trim() || undefined,
              birthDate: String(corpo?.nascimento ?? '').trim() || undefined,
            }
          : { cpf, password: senha },
      },
    );

    if (!resposta?.token) {
      return NextResponse.json({ erro: 'Não consegui abrir a sessão.' }, { status: 502 });
    }
    await gravarToken(resposta.token);
    return NextResponse.json({ cliente: resposta.customer ?? null });
  } catch (e) {
    const { texto, status } = mensagem(e, cadastro ? 'Não consegui criar a conta.' : 'Não consegui entrar.');
    return NextResponse.json({ erro: texto }, { status });
  }
}

export async function DELETE() {
  await apagarToken();
  return NextResponse.json({ ok: true });
}
