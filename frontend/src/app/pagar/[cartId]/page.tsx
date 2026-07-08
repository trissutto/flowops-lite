'use client';

/**
 * /pagar/<cartId> — página PÚBLICA de fechamento da compra da cliente da live.
 *
 * A apresentadora manda esse link. A cliente:
 *   1. confere as peças e o subtotal
 *   2. informa o CEP → calcula o frete (SP 9,99 · Sul/Sudeste 19,99 · demais 39,99)
 *   3. escolhe PIX (PagBank) ou Cartão até 12x sem juros (link Pagar.me)
 * A confirmação do pagamento é automática (mesmo cron/webhook da live).
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

const GOLD = '#B8912B';

function brl(cents: number): string {
  return ((cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function maskCep(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}
function parseErr(e: any): string {
  const raw = String(e?.message || '');
  const i = raw.indexOf(': ');
  const tail = i >= 0 ? raw.slice(i + 2) : raw;
  try {
    const j = JSON.parse(tail);
    if (j?.message) return Array.isArray(j.message) ? j.message[0] : j.message;
  } catch { /* texto puro */ }
  return 'Algo deu errado. Tenta de novo em instantes.';
}

type Item = { descricao: string; ref: string; cor: string | null; tamanho: string | null; qty: number; priceCents: number };
type Endereco = { endereco: string; numero: string; complemento: string; bairro: string; cidade: string; uf: string };
type Summary = {
  cartId: string; firstName: string; status: string; paymentMethod: string | null;
  subtotalCents: number; freteCents: number; totalCents: number; cep: string | null;
  endereco?: Endereco;
  storeName: string | null; paid: boolean; pixAvailable: boolean; items: Item[];
  pix: { qrCodeText: string; qrCodeImageUrl: string } | null; paymentUrl: string | null;
};

export default function PagarPage() {
  const params = useParams();
  const cartId = String((params as any)?.cartId || '');

  const [sum, setSum] = useState<Summary | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [cep, setCep] = useState('');
  const [frete, setFrete] = useState<{ freteCents: number; totalCents: number; freteServico: string; freteRegiao: string } | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);
  // Endereço de entrega — a loja recebe o pedido pronto pra postar
  const [rua, setRua] = useState('');
  const [numero, setNumero] = useState('');
  const [complemento, setComplemento] = useState('');
  const [bairro, setBairro] = useState('');
  const [cidade, setCidade] = useState('');
  const [uf, setUf] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [method, setMethod] = useState<'pix' | 'card' | null>(null);
  const [pix, setPix] = useState<{ qrCodeText: string; qrCodeImageUrl: string } | null>(null);
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<'pix' | 'card' | null>(null);
  const [paid, setPaid] = useState(false);
  const [copied, setCopied] = useState(false);

  const calcFrete = useCallback(async (cepVal: string) => {
    const digits = cepVal.replace(/\D/g, '');
    if (digits.length !== 8) return;
    setCalcLoading(true); setErr(null);
    try {
      const r = await api<any>(`/public/live-pay/${cartId}/frete`, { method: 'POST', body: JSON.stringify({ cep: digits }) });
      setFrete({ freteCents: r.freteCents, totalCents: r.totalCents, freteServico: r.freteServico || '', freteRegiao: r.freteRegiao || '' });
    } catch (e: any) { setErr(parseErr(e)); setFrete(null); }
    finally { setCalcLoading(false); }
    // Preenche rua/bairro/cidade/UF pelo CEP (ViaCEP) — a cliente só confere e põe o número
    try {
      const v = await fetch(`https://viacep.com.br/ws/${digits}/json/`).then((x) => x.json());
      if (!v?.erro) {
        setRua((prev) => prev || v.logradouro || '');
        setBairro((prev) => prev || v.bairro || '');
        setCidade((prev) => prev || v.localidade || '');
        setUf((prev) => prev || String(v.uf || '').toUpperCase());
      }
    } catch { /* ViaCEP fora — cliente digita na mão */ }
  }, [cartId]);

  const enderecoOk =
    rua.trim().length > 0 && numero.trim().length > 0 && cidade.trim().length > 0 && uf.trim().length === 2;

  // Salva o endereço no carrinho (obrigatório antes de gerar o pagamento)
  const saveEndereco = useCallback(async () => {
    await api(`/public/live-pay/${cartId}/endereco`, {
      method: 'POST',
      body: JSON.stringify({ endereco: rua, numero, complemento, bairro, cidade, uf }),
    });
  }, [cartId, rua, numero, complemento, bairro, cidade, uf]);

  const load = useCallback(async () => {
    try {
      const s = await api<Summary>(`/public/live-pay/${cartId}`);
      setSum(s);
      if (s.paid) setPaid(true);
      if (s.pix?.qrCodeText) { setPix(s.pix); setMethod('pix'); }
      if (s.paymentMethod === 'link' && s.paymentUrl) { setCardUrl(s.paymentUrl); setMethod('card'); }
      if (s.cep) { setCep(maskCep(s.cep)); calcFrete(s.cep); }
      if (s.endereco) {
        setRua((prev) => prev || s.endereco!.endereco || '');
        setNumero((prev) => prev || s.endereco!.numero || '');
        setComplemento((prev) => prev || s.endereco!.complemento || '');
        setBairro((prev) => prev || s.endereco!.bairro || '');
        setCidade((prev) => prev || s.endereco!.cidade || '');
        setUf((prev) => prev || s.endereco!.uf || '');
      }
    } catch { setLoadErr('Não encontramos essa compra. Confira o link com a loja. 💜'); }
  }, [cartId, calcFrete]);
  useEffect(() => { if (cartId) load(); }, [cartId, load]);

  // Poll de confirmação: assim que a cliente inicia um pagamento, checa a cada 5s.
  useEffect(() => {
    if (!method || paid) return;
    const t = setInterval(async () => {
      try {
        const r = await api<{ paid: boolean }>(`/public/live-pay/${cartId}/status`);
        if (r?.paid) setPaid(true);
      } catch { /* ignora — tenta de novo */ }
    }, 5000);
    return () => clearInterval(t);
  }, [method, paid, cartId]);

  async function payPix() {
    if (busy) return;
    if (sum && sum.pixAvailable === false) {
      setErr('O PIX dessa loja é combinado direto com a vendedora 💜. Pra pagar na hora, use o Cartão até 12x aqui embaixo.');
      return;
    }
    setBusy('pix'); setErr(null);
    try {
      await saveEndereco(); // endereço vai junto — a loja recebe pronto pra postar
      const r = await api<any>(`/public/live-pay/${cartId}/pix`, { method: 'POST' });
      setPix({ qrCodeText: r.qrCodeText, qrCodeImageUrl: r.qrCodeImageUrl });
      setCardUrl(null);
      setMethod('pix');
    } catch (e: any) { setErr(parseErr(e)); }
    finally { setBusy(null); }
  }
  async function payCard() {
    if (busy) return;
    setBusy('card'); setErr(null);
    try {
      await saveEndereco();
      const r = await api<any>(`/public/live-pay/${cartId}/card`, { method: 'POST' });
      setCardUrl(r.paymentUrl);
      setPix(null);
      setMethod('card');
    } catch (e: any) { setErr(parseErr(e)); }
    finally { setBusy(null); }
  }

  async function copyPix() {
    if (!pix?.qrCodeText) return;
    try { await navigator.clipboard.writeText(pix.qrCodeText); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* clipboard bloqueado */ }
  }

  const card = 'w-full max-w-[440px] bg-white border border-[#EDE7D6] rounded-3xl shadow-[0_10px_30px_rgba(140,115,37,0.08)]';

  if (loadErr) {
    return (
      <div className="min-h-screen bg-[#FAFAF7] flex items-start justify-center px-4 pt-[8vh]">
        <div className={`${card} p-6 text-center`}>
          <div className="text-4xl mb-2">🔎</div>
          <p className="text-[#7A7264]">{loadErr}</p>
        </div>
      </div>
    );
  }
  if (!sum) {
    return <div className="min-h-screen bg-[#FAFAF7] flex items-start justify-center px-4 pt-[10vh] text-[#7A7264] text-sm">Carregando sua compra…</div>;
  }
  if (paid) {
    return (
      <div className="min-h-screen bg-[#FAFAF7] flex items-start justify-center px-4 pt-[6vh] pb-12">
        <div className={`${card} p-6 text-center`}>
          <div className="w-[68px] h-[68px] mx-auto mb-4 rounded-full bg-[#FBF6E6] text-[#B8912B] text-4xl font-extrabold flex items-center justify-center">✓</div>
          <h1 className="text-[23px] font-extrabold text-[#2A2620]">Pagamento confirmado! 💜</h1>
          <p className="text-[#7A7264] text-[15px] mt-1">Obrigada, {sum.firstName}! Já estamos separando seu pedido.</p>
        </div>
      </div>
    );
  }

  const total = frete ? frete.totalCents : sum.subtotalCents;
  const canPay = !!frete && enderecoOk && !busy;
  const inputCls =
    'w-full box-border px-3.5 py-3 text-base rounded-xl bg-[#FCFBF7] border-[1.5px] border-[#E4DDCB] outline-none focus:border-[#B8912B] focus:ring-2 focus:ring-[#EBD9A6]';

  return (
    <div className="min-h-screen bg-[#FAFAF7] flex items-start justify-center px-4 pt-[5vh] pb-12 font-sans text-[#2A2620]">
      <div className={`${card} p-6`}>
        <div className="text-[13px] font-extrabold tracking-wide uppercase mb-1" style={{ color: GOLD }}>
          Lurd&apos;s <span className="text-[#C9A94E] font-semibold">Plus Size</span>
        </div>
        <h1 className="text-2xl font-extrabold mb-1">Fechar compra</h1>
        <p className="text-[#7A7264] text-[15px] mb-4">Oi, {sum.firstName}! Confere seu pedido{sum.storeName ? ` · ${sum.storeName}` : ''} 💜</p>

        {/* Itens */}
        <div className="rounded-2xl border border-[#EDE7D6] divide-y divide-[#F3EFE4] mb-3">
          {sum.items.map((it, idx) => (
            <div key={idx} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{it.descricao}</div>
                <div className="text-[11px] text-[#8C8676]">
                  {[it.cor, it.tamanho].filter(Boolean).join(' · ')}{it.qty > 1 ? ` · ${it.qty}x` : ''}
                </div>
              </div>
              <div className="text-sm font-bold tabular-nums">{brl(it.priceCents * it.qty)}</div>
            </div>
          ))}
        </div>

        {/* Totais */}
        <div className="space-y-1 text-sm mb-4">
          <div className="flex justify-between text-[#7A7264]"><span>Subtotal</span><span className="tabular-nums">{brl(sum.subtotalCents)}</span></div>
          <div className="flex justify-between text-[#7A7264]">
            <span>Frete{frete?.freteServico ? ` (${frete.freteServico})` : ''}</span>
            <span className="tabular-nums">{frete ? brl(frete.freteCents) : '—'}</span>
          </div>
          <div className="flex justify-between text-lg font-extrabold pt-1 border-t border-[#EDE7D6] mt-1">
            <span>Total</span><span className="tabular-nums">{brl(total)}</span>
          </div>
        </div>

        {/* CEP / frete */}
        <label className="block mb-4">
          <span className="block text-[13px] font-bold text-[#6B6456] mb-1.5">Seu CEP (pro frete)</span>
          <input
            value={cep}
            onChange={(e) => { const v = maskCep(e.target.value); setCep(v); if (v.replace(/\D/g, '').length === 8) calcFrete(v); }}
            placeholder="00000-000"
            inputMode="numeric"
            className="w-full box-border px-3.5 py-3 text-base rounded-xl bg-[#FCFBF7] border-[1.5px] border-[#E4DDCB] outline-none focus:border-[#B8912B] focus:ring-2 focus:ring-[#EBD9A6]"
          />
          {calcLoading && <span className="text-[11px] text-[#A08A4E]">calculando frete…</span>}
          {frete && !calcLoading && (
            <span className="text-[11px] text-[#8C7325]">
              {frete.freteServico} · {frete.freteRegiao} — {brl(frete.freteCents)}
            </span>
          )}
        </label>

        {/* Endereço de entrega — preenchido pelo CEP; a cliente confere e põe o número */}
        {frete && (
          <div className="mb-4">
            <span className="block text-[13px] font-bold text-[#6B6456] mb-1.5">Endereço de entrega 📦</span>
            <div className="space-y-2">
              <input value={rua} onChange={(e) => setRua(e.target.value)} placeholder="Rua / avenida" className={inputCls} />
              <div className="grid grid-cols-[110px_1fr] gap-2">
                <input value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="Número" inputMode="numeric" className={inputCls} />
                <input value={complemento} onChange={(e) => setComplemento(e.target.value)} placeholder="Complemento (opcional)" className={inputCls} />
              </div>
              <input value={bairro} onChange={(e) => setBairro(e.target.value)} placeholder="Bairro" className={inputCls} />
              <div className="grid grid-cols-[1fr_80px] gap-2">
                <input value={cidade} onChange={(e) => setCidade(e.target.value)} placeholder="Cidade" className={inputCls} />
                <input value={uf} onChange={(e) => setUf(e.target.value.toUpperCase().slice(0, 2))} placeholder="UF" maxLength={2} className={`${inputCls} uppercase`} />
              </div>
            </div>
            {!enderecoOk && (
              <span className="mt-1 block text-[11px] text-[#A69E8C]">
                Confere a rua e coloca o <b>número</b> pra gente postar seu pedido certinho 💜
              </span>
            )}
          </div>
        )}

        {err && <div className="bg-[#FDECEC] border border-[#F3C0C0] text-[#9B2C2C] rounded-lg px-3 py-2.5 text-sm mb-3">{err}</div>}

        {/* PIX gerado */}
        {method === 'pix' && pix && (
          <div className="rounded-2xl border-2 border-[#ECD9A0] bg-[#FBF6E6]/60 p-4 mb-3 text-center">
            <div className="text-sm font-bold text-[#8C7325] mb-2">Pague com PIX — {brl(total)}</div>
            {pix.qrCodeImageUrl && <img src={pix.qrCodeImageUrl} alt="QR Code PIX" className="mx-auto w-44 h-44 rounded-lg bg-white p-1" />}
            <button onClick={copyPix} className="mt-3 w-full rounded-xl border border-[#D4AF37] bg-white py-2.5 text-sm font-bold text-[#8C7325] hover:bg-[#FBF6E6]">
              {copied ? 'Copiado! ✓' : 'Copiar código PIX (copia e cola)'}
            </button>
            <div className="mt-2 text-[11px] text-[#A08A4E]">Assim que você pagar, esta tela confirma sozinha. Pode deixar aberta. 💜</div>
          </div>
        )}

        {/* Cartão gerado */}
        {method === 'card' && cardUrl && (
          <div className="rounded-2xl border-2 border-[#ECD9A0] bg-[#FBF6E6]/60 p-4 mb-3 text-center">
            <div className="text-sm font-bold text-[#8C7325] mb-2">Cartão até 12x sem juros — {brl(total)}</div>
            <a href={cardUrl} target="_blank" rel="noopener noreferrer" className="block w-full rounded-xl bg-[#B8912B] py-3 text-[15px] font-extrabold text-white hover:bg-[#A07F22]">
              Ir para o pagamento no cartão →
            </a>
            <div className="mt-2 text-[11px] text-[#A08A4E]">Abre numa nova aba. Depois de pagar, volte aqui — a confirmação é automática. 💜</div>
          </div>
        )}

        {/* Botões de escolha */}
        <div className="grid grid-cols-1 gap-2.5">
          <button
            onClick={payPix}
            disabled={!canPay}
            className="w-full py-3.5 text-[16px] font-extrabold text-white rounded-xl disabled:opacity-50 transition-colors"
            style={{ background: '#2E7D46' }}
          >
            {busy === 'pix' ? 'Gerando PIX…' : `Pagar com PIX · ${brl(total)}`}
          </button>
          <button
            onClick={payCard}
            disabled={!canPay}
            className="w-full py-3.5 text-[16px] font-extrabold text-white rounded-xl bg-[#B8912B] hover:bg-[#A07F22] disabled:opacity-50 transition-colors"
          >
            {busy === 'card' ? 'Gerando link…' : 'Cartão até 12x sem juros'}
          </button>
        </div>
        {!frete && (
          <p className="text-center text-[11px] text-[#A69E8C] mt-3">Informe seu CEP acima pra liberar o pagamento.</p>
        )}
        {frete && !enderecoOk && (
          <p className="text-center text-[11px] text-[#A69E8C] mt-3">Complete o endereço de entrega pra liberar o pagamento.</p>
        )}
        {frete && sum.pixAvailable === false && (
          <p className="text-center text-[11px] text-[#A69E8C] mt-2">PIX dessa loja é combinado com a vendedora · Cartão até 12x é na hora, aqui 💜</p>
        )}
      </div>
    </div>
  );
}
