import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

/**
 * ESQUECI A SENHA — o código chega no WhatsApp da cliente (fluxo que o app
 * já usa). Duas etapas na mesma rota:
 *   POST { cpf }                    → pede o código
 *   POST { cpf, codigo, novaSenha } → troca a senha
 *
 * A resposta do pedido é sempre igual, exista ou não o CPF: dizer "não achei"
 * transformaria o formulário num verificador de quem é cliente da loja.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let corpo: Record<string, unknown>;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: 'Requisição inválida.' }, { status: 400 });
  }

  const cpf = String(corpo?.cpf ?? '').replace(/\D/g, '');
  if (cpf.length !== 11) {
    return NextResponse.json({ erro: 'O CPF precisa ter 11 dígitos.' }, { status: 400 });
  }

  const codigo = String(corpo?.codigo ?? '').trim();
  const novaSenha = String(corpo?.novaSenha ?? '');

  try {
    if (codigo && novaSenha) {
      if (novaSenha.length < 4) {
        return NextResponse.json({ erro: 'A senha precisa ter ao menos 4 dígitos.' }, { status: 400 });
      }
      await api('/customers/app/reset-password', {
        method: 'POST',
        body: { cpf, code: codigo, password: novaSenha },
      });
      return NextResponse.json({ ok: true, etapa: 'trocada' });
    }

    await api('/customers/app/forgot-password', { method: 'POST', body: { cpf } });
    return NextResponse.json({ ok: true, etapa: 'codigo-enviado' });
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      return NextResponse.json({ erro: 'Código inválido ou expirado.' }, { status: 400 });
    }
    console.error('[conta] senha:', e);
    // Pedido de código nunca revela se o CPF existe.
    if (!codigo) return NextResponse.json({ ok: true, etapa: 'codigo-enviado' });
    return NextResponse.json({ erro: 'Não consegui concluir.' }, { status: 502 });
  }
}
