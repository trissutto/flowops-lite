import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

/**
 * ESQUECI A SENHA — o código chega no WhatsApp e no e-mail da cliente. Duas
 * etapas na mesma rota:
 *   POST { cpf }                    → pede o código
 *   POST { cpf, codigo, novaSenha } → troca a senha
 *
 * ── ESTA ROTA NÃO MENTE MAIS (02/10/2026) ──
 *
 * Ela respondia "código enviado" pra QUALQUER coisa: CPF sem conta, conta sem
 * telefone, WhatsApp fora, backend fora, limite de tentativas estourado. A
 * intenção era não virar verificador de quem é cliente — só que "Criar conta"
 * já responde "este CPF já tem cadastro", então o segredo não existia e quem
 * pagava era a cliente, esperando um código que nunca ia chegar.
 *
 * E a troca tinha as mensagens cruzadas: senha curta voltava "código inválido"
 * (o backend recusava com 400) e código errado voltava "não consegui concluir"
 * (401 caía no genérico). Agora a frase do backend chega inteira na tela.
 */

export const dynamic = 'force-dynamic';

interface PedidoCodigo {
  sent?: boolean;
  motivo?: 'sem_conta' | 'sem_contato' | 'falha_envio' | 'aguarde';
  phoneMasked?: string;
  emailMasked?: string;
}

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

  // Só dígitos: quem copia o código do WhatsApp traz espaço e asterisco junto.
  const codigo = String(corpo?.codigo ?? '').replace(/\D/g, '');
  const novaSenha = String(corpo?.novaSenha ?? '');
  const trocando = !!codigo || !!novaSenha;

  try {
    if (trocando) {
      if (codigo.length !== 6) {
        return NextResponse.json({ erro: 'O código tem 6 números. Confira e tente de novo.' }, { status: 400 });
      }
      if (novaSenha.length < 4) {
        return NextResponse.json({ erro: 'A senha precisa ter ao menos 4 dígitos.' }, { status: 400 });
      }
      await api('/customers/app/reset-password', {
        method: 'POST',
        body: { cpf, code: codigo, password: novaSenha },
      });
      return NextResponse.json({ ok: true, etapa: 'trocada' });
    }

    const r = await api<PedidoCodigo>('/customers/app/forgot-password', { method: 'POST', body: { cpf } });

    if (r?.sent === false) {
      if (r.motivo === 'sem_conta') {
        return NextResponse.json(
          { erro: 'Não encontramos conta com este CPF. Toque em “Criar conta” — leva um minuto.', motivo: 'sem_conta' },
          { status: 404 },
        );
      }
      return NextResponse.json(
        {
          erro:
            r.motivo === 'sem_contato'
              ? 'Sua conta não tem WhatsApp nem e-mail cadastrados, então não temos pra onde mandar o código. Fale com a gente que resolvemos na hora.'
              : 'Não conseguimos enviar o código agora. Tente de novo em instantes — ou fale com a gente.',
          motivo: r.motivo ?? 'falha_envio',
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      etapa: 'codigo-enviado',
      whatsapp: r?.phoneMasked ?? null,
      email: r?.emailMasked ?? null,
      aguarde: r?.motivo === 'aguarde',
    });
  } catch (e) {
    if (e instanceof ApiError && [400, 401, 429].includes(e.status)) {
      const padrao =
        e.status === 429
          ? 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.'
          : 'Código inválido ou expirado. Peça um código novo.';
      return NextResponse.json({ erro: e.mensagemDoBackend ?? padrao }, { status: e.status });
    }
    console.error('[conta] senha:', e);
    return NextResponse.json(
      {
        erro: trocando
          ? 'Não consegui trocar a senha agora. Tente de novo em instantes.'
          : 'Não consegui enviar o código agora. Tente de novo em instantes.',
      },
      { status: 502 },
    );
  }
}
