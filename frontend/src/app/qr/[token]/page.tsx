'use client';

/**
 * /qr/<token> — a página que a cliente abre pra pagar o PIX da venda online.
 * (/pix/<token> já era do crediário — por isso /qr/.)
 *
 * POR QUE EXISTE: o WhatsApp levava o copia-e-cola CRU. O código EMV da
 * PagBank tem uma URL no meio (api.pagseguro.com/pix/v2/...) e o WhatsApp
 * pinta esse trecho de azul sozinho — a cliente toca no azul (gesto natural),
 * cai numa página inútil da PagBank e acha que era ali que pagava. Não paga.
 * (Caso Itanhaém 21/08.)
 *
 * Agora a mensagem leva SÓ este link. Tocar no azul virou o caminho certo:
 * aqui tem o valor, o QR e um botão grandão "Copiar código PIX".
 *
 * A página faz polling do estado a cada 10s — SÓ no nosso backend (que lê do
 * Postgres, atualizado por webhook + reconciliador). Nunca consulta a PagBank
 * daqui: polling per-browser no gateway foi o flood que derrubou a live de
 * 01/07.
 *
 * Página PÚBLICA: nada de login, nada de dado sensível na resposta.
 */

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

const GOLD = '#B8912B';

type Estado = 'aguardando' | 'pago' | 'vencido' | 'cancelado' | 'inexistente';
type Resposta = {
  estado: Estado;
  /** Só no `vencido`: true = reconciliador confirmou com a PagBank que não
   *  houve pagamento. False = venceu só pelo relógio — quem pagou na boca do
   *  vencimento ainda pode virar `pago`, então o polling continua. */
  definitivo?: boolean;
  valor?: number;
  qrCodeText?: string;
  qrCodeImageB64?: string;
  lojaNome?: string;
  lojaWhatsapp?: string | null;
  expiraEm?: string | null;
  pagoEm?: string | null;
};

function brl(v: number): string {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function PixLinkPage() {
  const params = useParams();
  const token = String((params as any)?.token || '');
  const [r, setR] = useState<Resposta | null>(null);
  const [erro, setErro] = useState('');
  const [copiado, setCopiado] = useState(false);
  // Guarda o QR/código da primeira resposta: o polling de "pago?" não precisa
  // retrafegar o PNG base64 a cada 10s, e se uma resposta falhar não apagamos
  // o que a cliente está vendo.
  const qrRef = useRef<{ qrCodeText: string; qrCodeImageB64: string } | null>(null);

  useEffect(() => {
    if (!token) return;
    let vivo = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const consulta = async () => {
      try {
        const res = await api<Resposta>(`/public/pix/${encodeURIComponent(token)}`);
        if (!vivo) return;
        if (res.qrCodeText) {
          qrRef.current = {
            qrCodeText: res.qrCodeText,
            qrCodeImageB64: res.qrCodeImageB64 || '',
          };
        }
        setR(res);
        setErro('');
        // Continua perguntando enquanto o pagamento não define o destino.
        // Vencido NÃO-definitivo também segue: pagamento na boca do
        // vencimento ainda pode virar "pago" quando o webhook chegar.
        if (res.estado === 'aguardando' || (res.estado === 'vencido' && !res.definitivo)) {
          timer = setTimeout(consulta, 10_000);
        }
      } catch {
        if (!vivo) return;
        // Primeira carga falhou → mostra erro. Polling falhou → mantém a tela
        // e tenta de novo (rede de celular oscila).
        if (!qrRef.current) {
          setErro('Não consegui abrir seu PIX agora. Tenta de novo em instantes 💜');
        }
        timer = setTimeout(consulta, 15_000);
      }
    };
    void consulta();
    return () => {
      vivo = false;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  const codigo = r?.qrCodeText || qrRef.current?.qrCodeText || '';
  const qrImg = r?.qrCodeImageB64 || qrRef.current?.qrCodeImageB64 || '';

  const copiar = async () => {
    if (!codigo) return;
    try {
      await navigator.clipboard.writeText(codigo);
    } catch {
      // Clipboard API pode faltar em navegador embutido (webview do Instagram
      // etc.) — fallback com textarea invisível + execCommand.
      const ta = document.createElement('textarea');
      ta.value = codigo;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
    setCopiado(true);
    setTimeout(() => setCopiado(false), 3000);
  };

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

        {erro && !r && <p style={{ color: '#B3261E', fontSize: 15 }}>{erro}</p>}

        {!r && !erro && <p style={{ color: '#6B6B6B', fontSize: 15 }}>Abrindo seu PIX…</p>}

        {r?.estado === 'aguardando' && (
          <>
            <p style={{ color: '#444', fontSize: 15, margin: '0 0 4px' }}>Pagamento via PIX</p>
            <p style={{ fontSize: 30, fontWeight: 800, color: '#1C1C1C', margin: '0 0 18px' }}>
              {r.valor ? brl(r.valor) : ''}
            </p>

            <button
              type="button"
              onClick={() => void copiar()}
              style={{
                display: 'block', width: '100%', border: 'none', cursor: 'pointer',
                background: copiado ? '#2E7D46' : GOLD, color: '#fff', fontWeight: 700,
                padding: '16px 20px', borderRadius: 12, fontSize: 17,
              }}
            >
              {copiado ? '✓ Código copiado!' : 'Copiar código PIX'}
            </button>
            <p style={{ color: '#6B6B6B', fontSize: 13.5, lineHeight: 1.5, marginTop: 10 }}>
              Depois é só abrir o app do seu banco, escolher{' '}
              <strong>PIX copia e cola</strong> e colar o código.
            </p>

            {qrImg && (
              <>
                <p style={{ color: '#9A9A9A', fontSize: 12, margin: '20px 0 8px' }}>
                  — ou pague pelo QR Code em outro aparelho —
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/png;base64,${qrImg}`}
                  alt="QR Code do PIX"
                  style={{
                    width: 180, height: 180, borderRadius: 10,
                    border: '1px solid #EBE7DA', background: '#fff',
                  }}
                />
              </>
            )}

            <div
              style={{
                marginTop: 18, background: '#FBF6E6', border: '1px solid #EBDDB3',
                borderRadius: 10, padding: '10px 12px', color: '#8C7325',
                fontSize: 13, fontWeight: 600,
              }}
            >
              Assim que o pagamento cair, esta página confirma sozinha ✨
            </div>
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
              Suas peças já estão sendo separadas 💜
            </p>
            {whatsUrl('Oi! Acabei de pagar meu PIX. Quero saber do meu pedido.') && (
              <a
                href={whatsUrl('Oi! Acabei de pagar meu PIX. Quero saber do meu pedido.')!}
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
              {r.estado === 'vencido' ? 'Esse PIX expirou' : 'Esse PIX foi cancelado'}
            </h1>
            <p style={{ color: '#444', fontSize: 16, lineHeight: 1.5 }}>
              {r.valor ? <>A cobrança de {brl(r.valor)} não está mais válida. </> : null}
              {r.estado === 'vencido' && !r.definitivo ? (
                // Ainda pode virar "pago" (webhook a caminho) — não afirmar
                // que nada foi cobrado nem empurrar um PIX novo com pressa.
                <>Se você <strong>acabou de pagar</strong>, espera um instante — a
                confirmação aparece aqui sozinha. Se não pagou, é só pedir um código novo.</>
              ) : (
                <>Fica tranquila: <strong>nada foi cobrado</strong>. É só pedir um código novo.</>
              )}
            </p>
            {whatsUrl(
              `Oi! Meu PIX${r.valor ? ` de ${brl(r.valor)}` : ''} expirou. Pode mandar outro?`,
            ) ? (
              <a
                href={whatsUrl(
                  `Oi! Meu PIX${r.valor ? ` de ${brl(r.valor)}` : ''} expirou. Pode mandar outro?`,
                )!}
                style={{
                  display: 'block', marginTop: 22, background: '#2E7D46', color: '#fff',
                  fontWeight: 700, padding: '15px 20px', borderRadius: 12,
                  textDecoration: 'none', fontSize: 16,
                }}
              >
                Pedir um PIX novo no WhatsApp
              </a>
            ) : (
              <p style={{ color: '#6B6B6B', fontSize: 15, marginTop: 18 }}>
                Chama a loja {r.lojaNome ? <strong>{r.lojaNome}</strong> : null} que ela manda outro 💜
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
