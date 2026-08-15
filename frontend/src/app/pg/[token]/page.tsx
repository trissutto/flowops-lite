'use client';

/**
 * /pg/<token> — a porta de entrada do link de pagamento da loja.
 *
 * A URL crua da Pagar.me é de USO ÚNICO: assim que a cobrança é paga,
 * cancelada ou vence, o checkout deixa de existir e a cliente vê
 * "Oops — não encontramos seu pedido · 404". Ela não sabe se pagou, não tem
 * link novo e não tem com quem falar. (Caso Moema 15/08: link pago no dia
 * anterior, reaberto no outro dia.)
 *
 * Esta página fica NA FRENTE do checkout:
 *   válido    → manda direto pra Pagar.me (a cliente nem percebe)
 *   pago      → "Pagamento confirmado", com o valor
 *   vencido   → "esse link expirou" + WhatsApp da loja pra pedir outro
 *   cancelado → mesmo tratamento do vencido
 *
 * Página PÚBLICA: nada de login, nada de dado sensível na resposta.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

const GOLD = '#B8912B';

type Estado = 'valido' | 'pago' | 'vencido' | 'cancelado' | 'inexistente';
type Resposta = {
  estado: Estado;
  paymentUrl?: string;
  valor?: number;
  lojaNome?: string;
  lojaWhatsapp?: string | null;
  expiraEm?: string | null;
  pagoEm?: string | null;
};

function brl(v: number): string {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function PagamentoLinkPage() {
  const params = useParams();
  const token = String((params as any)?.token || '');
  const [r, setR] = useState<Resposta | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!token) return;
    let vivo = true;
    (async () => {
      try {
        const res = await api<Resposta>(`/public/pagar-link/${encodeURIComponent(token)}`);
        if (!vivo) return;
        setR(res);
        // Link vivo: nem mostra esta página — vai direto pro checkout.
        // `replace` pra que o "voltar" do celular não caia aqui de novo.
        if (res.estado === 'valido' && res.paymentUrl) {
          window.location.replace(res.paymentUrl);
        }
      } catch {
        if (vivo) setErro('Não consegui abrir seu link agora. Tenta de novo em instantes 💜');
      }
    })();
    return () => { vivo = false; };
  }, [token]);

  const whatsUrl = (msg: string) =>
    r?.lojaWhatsapp ? `https://wa.me/${r.lojaWhatsapp}?text=${encodeURIComponent(msg)}` : null;

  return (
    <main
      style={{
        minHeight: '100dvh',
        background: '#FAFAF7',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: '#fff',
          borderRadius: 18,
          padding: '32px 24px',
          boxShadow: '0 10px 40px rgba(0,0,0,.08)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 13, letterSpacing: 2, color: GOLD, fontWeight: 700, marginBottom: 24 }}>
          LURD&apos;S PLUS SIZE
        </div>

        {erro && <p style={{ color: '#B3261E', fontSize: 15 }}>{erro}</p>}

        {!r && !erro && <p style={{ color: '#6B6B6B', fontSize: 15 }}>Abrindo seu pagamento…</p>}

        {r?.estado === 'valido' && (
          <>
            <p style={{ color: '#6B6B6B', fontSize: 15, marginBottom: 20 }}>
              Levando você pro pagamento seguro…
            </p>
            {r.paymentUrl && (
              <a
                href={r.paymentUrl}
                style={{
                  display: 'block', background: GOLD, color: '#fff', fontWeight: 700,
                  padding: '15px 20px', borderRadius: 12, textDecoration: 'none', fontSize: 16,
                }}
              >
                Pagar {r.valor ? brl(r.valor) : ''}
              </a>
            )}
          </>
        )}

        {r?.estado === 'pago' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#2E7D46', margin: '0 0 10px' }}>
              Pagamento confirmado!
            </h1>
            <p style={{ color: '#444', fontSize: 16, lineHeight: 1.5 }}>
              {r.valor ? <>Recebemos {brl(r.valor)}. </> : null}
              Esse link já foi usado — por isso ele não abre mais.
            </p>
            <p style={{ color: '#6B6B6B', fontSize: 15, lineHeight: 1.5, marginTop: 10 }}>
              Suas peças já estão sendo separadas. A gente avisa no WhatsApp quando postar 💜
            </p>
            {whatsUrl('Oi! Quero saber do meu pedido.') && (
              <a
                href={whatsUrl('Oi! Quero saber do meu pedido.')!}
                style={{
                  display: 'inline-block', marginTop: 22, color: GOLD, fontWeight: 600,
                  fontSize: 15, textDecoration: 'none', borderBottom: `1px solid ${GOLD}`,
                }}
              >
                Falar com a loja {r.lojaNome ? `(${r.lojaNome})` : ''}
              </a>
            )}
          </>
        )}

        {(r?.estado === 'vencido' || r?.estado === 'cancelado') && (
          <>
            <div style={{ fontSize: 48, marginBottom: 8 }}>⏰</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1C1C1C', margin: '0 0 10px' }}>
              {r.estado === 'vencido' ? 'Esse link expirou' : 'Esse link foi cancelado'}
            </h1>
            <p style={{ color: '#444', fontSize: 16, lineHeight: 1.5 }}>
              {r.valor ? <>A cobrança de {brl(r.valor)} não está mais válida. </> : null}
              Fica tranquila: <strong>nada foi cobrado</strong>. É só pedir um link novo.
            </p>
            {whatsUrl(
              `Oi! Meu link de pagamento${r.valor ? ` de ${brl(r.valor)}` : ''} expirou. Pode mandar outro?`,
            ) ? (
              <a
                href={whatsUrl(
                  `Oi! Meu link de pagamento${r.valor ? ` de ${brl(r.valor)}` : ''} expirou. Pode mandar outro?`,
                )!}
                style={{
                  display: 'block', marginTop: 22, background: '#2E7D46', color: '#fff',
                  fontWeight: 700, padding: '15px 20px', borderRadius: 12,
                  textDecoration: 'none', fontSize: 16,
                }}
              >
                Pedir link novo no WhatsApp
              </a>
            ) : (
              <p style={{ color: '#6B6B6B', fontSize: 15, marginTop: 18 }}>
                Chama a loja {r.lojaNome ? <strong>{r.lojaNome}</strong> : null} que ela manda outro link 💜
              </p>
            )}
          </>
        )}

        {r?.estado === 'inexistente' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 8 }}>🔎</div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1C1C1C', margin: '0 0 10px' }}>
              Link não encontrado
            </h1>
            <p style={{ color: '#444', fontSize: 16, lineHeight: 1.5 }}>
              Confere se o endereço veio inteiro na mensagem. Se veio, chama a loja que ela
              manda um novo — <strong>nada foi cobrado</strong>.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
