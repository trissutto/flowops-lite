'use client';

/**
 * /minha-loja/pdv/vale-presente/<code> — CERTIFICADO imprimível do vale
 * presente. Abre do popup "Venda Finalizada" (botão 🎁) e imprime bonito
 * na térmica (80mm) ou A4: marca, valor, código em destaque, QR e validade.
 *
 * Dados via GET /pdv/devolucao/credito/:code (mesma consulta do vale-troca).
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import QRCode from 'qrcode';
import { api } from '@/lib/api';

const GOLD = '#B8912B';

type Voucher = {
  code: string;
  valor: number;
  status: string;
  source?: string;
  motivo?: string | null;
  validade?: string | null;
  vencido?: boolean;
  usado?: boolean;
  customerName?: string | null;
  origem?: { store?: string; storeName?: string };
  createdAt?: string;
};

function brl(v: number): string {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function ValePresentePrintPage() {
  const params = useParams();
  const code = decodeURIComponent(String((params as any)?.code || ''));
  const [v, setV] = useState<Voucher | null>(null);
  const [qrUrl, setQrUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<Voucher>(`/pdv/devolucao/credito/${encodeURIComponent(code)}`);
      setV(r);
      try {
        setQrUrl(await QRCode.toDataURL(r.code, { margin: 1, width: 220 }));
      } catch { /* QR é bônus — segue sem */ }
      // Auto-print quando tudo renderizou (uma via já sai; Ctrl+P pra mais)
      setTimeout(() => window.print(), 600);
    } catch (e: any) {
      setErr('Vale não encontrado ou ainda não ativado (finalize a venda primeiro).');
    }
  }, [code]);
  useEffect(() => { if (code) load(); }, [code, load]);

  // Extrai "comprado por X para Y" do motivo (quando informado na venda)
  const comprador = v?.motivo?.match(/comprado por ([^·]+?)(?: para |$| ·)/)?.[1]?.trim() || null;
  const presenteado = v?.customerName || v?.motivo?.match(/ para ([^·]+?)(?:$| ·)/)?.[1]?.trim() || null;

  if (err) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-slate-600 text-sm">{err}</div>
    );
  }
  if (!v) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-slate-400 text-sm">
        Carregando vale…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 flex items-start justify-center p-4 print:bg-white print:p-0">
      <style>{`
        @media print {
          @page { margin: 4mm; }
          body { background: white !important; }
        }
      `}</style>

      <div className="w-full max-w-[340px]">
        {/* Botões — só na tela, nunca no papel */}
        <div className="mb-3 flex gap-2 print:hidden">
          <button
            onClick={() => window.print()}
            className="flex-1 rounded-lg bg-[#B8912B] py-2.5 text-sm font-bold text-white hover:bg-[#A07F22]"
          >
            🖨 Imprimir
          </button>
          <button
            onClick={() => window.close()}
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-white"
          >
            Fechar
          </button>
        </div>

        {/* ── CERTIFICADO ── */}
        <div
          className="rounded-2xl border-2 bg-white p-5 text-center shadow-sm print:rounded-none print:border-0 print:shadow-none"
          style={{ borderColor: '#ECD9A0' }}
        >
          <div className="text-[13px] font-extrabold uppercase tracking-widest" style={{ color: GOLD }}>
            Lurd&apos;s <span className="font-semibold text-[#C9A94E]">Plus Size</span>
          </div>
          <div className="mt-2 text-4xl leading-none">🎁</div>
          <h1 className="mt-1 text-xl font-black tracking-wide text-[#2A2620]">VALE PRESENTE</h1>

          <div className="mt-3 text-4xl font-black tabular-nums" style={{ color: '#2E7D46' }}>
            {brl(v.valor)}
          </div>

          {(presenteado || comprador) && (
            <div className="mt-3 space-y-0.5 text-[13px] text-[#6B6456]">
              {presenteado && (
                <div>
                  Para: <b className="text-[#2A2620]">{presenteado}</b>
                </div>
              )}
              {comprador && (
                <div>
                  De: <b className="text-[#2A2620]">{comprador}</b>
                </div>
              )}
            </div>
          )}

          {/* Código — grande, monoespaçado, em caixa */}
          <div
            className="mx-auto mt-4 rounded-xl border-2 border-dashed px-3 py-2.5 font-mono text-xl font-black tracking-wider text-[#2A2620]"
            style={{ borderColor: GOLD, background: '#FBF6E6' }}
          >
            {v.code}
          </div>

          {qrUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrUrl} alt={`QR ${v.code}`} className="mx-auto mt-3 h-36 w-36" />
          )}

          <div className="mt-3 text-[12px] font-semibold text-[#8C7325]">
            {v.validade
              ? `Válido até ${new Date(v.validade).toLocaleDateString('pt-BR')}`
              : 'Sem validade impressa'}
          </div>

          <div className="mt-3 border-t border-dashed border-[#E4DDCB] pt-2 text-left text-[10px] leading-snug text-[#8C8676]">
            • Vale em <b>qualquer loja Lurd&apos;s Plus Size</b> — apresente este código no caixa.
            <br />• Uso parcial: o saldo vira um novo vale na hora.
            <br />• Não é trocado por dinheiro e não gera troco.
            <br />
            {v.origem?.storeName && (
              <>• Emitido em {v.origem.storeName}
                {v.createdAt ? ` em ${new Date(v.createdAt).toLocaleDateString('pt-BR')}` : ''}.
              </>
            )}
          </div>

          <div className="mt-3 text-[11px] font-bold" style={{ color: GOLD }}>
            💜 Presenteie quem você ama com moda que veste bem.
          </div>
        </div>
      </div>
    </div>
  );
}
