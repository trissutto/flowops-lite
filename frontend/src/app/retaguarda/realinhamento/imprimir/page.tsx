'use client';

/**
 * /retaguarda/realinhamento/imprimir — Página imprimível do plano de realinhamento.
 *
 * Recebe o payload via sessionStorage (chave "realinhamento_print_payload"),
 * gerado pela tela principal ao clicar em "Gerar PDF".
 *
 * Renderiza 1 folha por loja ORIGEM (page-break-after: always), com:
 *   - Cabeçalho LURDS + data + observação
 *   - Lista de peças a enviar agrupadas por DESTINO e por REF
 *   - Total de unidades e movimentações da loja
 *
 * Dispara window.print() automaticamente após montar. Usuário escolhe
 * "Salvar como PDF" no diálogo do navegador.
 */

import { useEffect, useMemo, useState } from 'react';

interface PlanLine {
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  desc: string;
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  qty: number;
  stockFromBefore: number;
  stockToBefore: number;
  stockFromAfter: number;
  stockToAfter: number;
}

interface Payload {
  generatedAt: string;
  note: string | null;
  lines: PlanLine[];
}

export default function ImprimirRealinhamentoPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      // Tenta localStorage primeiro (compartilhado entre abas), depois sessionStorage
      // como fallback pra compatibilidade.
      const raw =
        localStorage.getItem('realinhamento_print_payload') ||
        sessionStorage.getItem('realinhamento_print_payload');
      if (!raw) {
        setError('Nenhum plano encontrado. Volte pra tela de realinhamento e clique em "Gerar PDF" novamente.');
        return;
      }
      const data = JSON.parse(raw) as Payload;
      setPayload(data);
      // Não apago o storage aqui — assim o usuário pode dar F5 ou reimprimir
      // sem precisar gerar de novo. Ele é sobrescrito na próxima geração.
    } catch (e: any) {
      setError(`Erro lendo plano: ${e?.message || e}`);
    }
  }, []);

  useEffect(() => {
    if (payload && !error) {
      // pequeno delay pra garantir render completo
      const t = setTimeout(() => {
        try {
          window.print();
        } catch {}
      }, 400);
      return () => clearTimeout(t);
    }
  }, [payload, error]);

  const byOrigin = useMemo(() => {
    if (!payload) return [] as Array<{ code: string; name: string; lines: PlanLine[] }>;
    const map = new Map<string, { code: string; name: string; lines: PlanLine[] }>();
    for (const line of payload.lines) {
      if (!map.has(line.fromCode)) {
        map.set(line.fromCode, { code: line.fromCode, name: line.fromName, lines: [] });
      }
      map.get(line.fromCode)!.lines.push(line);
    }
    return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [payload]);

  const generatedLabel = useMemo(() => {
    if (!payload) return '';
    try {
      return new Date(payload.generatedAt).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return payload.generatedAt;
    }
  }, [payload]);

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4">
          {error}
        </div>
      </div>
    );
  }

  if (!payload) {
    return <div className="p-8 text-slate-500">Carregando plano...</div>;
  }

  return (
    <div className="print-root">
      {/* CSS de impressão */}
      <style>{`
        @media print {
          @page {
            size: A4;
            margin: 14mm 12mm;
          }
          body {
            background: white !important;
          }
          .no-print {
            display: none !important;
          }
          .page {
            page-break-after: always;
          }
          .page:last-child {
            page-break-after: auto;
          }
        }
        .print-root {
          background: #f8fafc;
          min-height: 100vh;
          padding: 20px 0;
        }
        @media print {
          .print-root {
            background: white;
            padding: 0;
          }
        }
        .page {
          background: white;
          width: 210mm;
          min-height: 297mm;
          margin: 0 auto 20px;
          padding: 16mm 14mm;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #0f172a;
          font-size: 11pt;
          line-height: 1.35;
          box-sizing: border-box;
        }
        @media print {
          .page {
            box-shadow: none;
            margin: 0;
            width: auto;
            min-height: auto;
            padding: 0;
          }
        }
        .page h1 { margin: 0 0 4px 0; font-size: 18pt; font-weight: 800; letter-spacing: -0.3px; }
        .page h2 { margin: 18px 0 6px 0; font-size: 13pt; font-weight: 700; border-bottom: 2px solid #0f172a; padding-bottom: 3px; }
        .page h3 { margin: 12px 0 4px 0; font-size: 11pt; font-weight: 700; color: #1e40af; }
        .page .muted { color: #64748b; font-size: 10pt; }
        .page table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 10pt; }
        .page th { text-align: left; border-bottom: 1.5px solid #0f172a; padding: 4px 6px; font-weight: 700; background: #f1f5f9; }
        .page td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
        .page .num { text-align: center; font-variant-numeric: tabular-nums; }
        .page .ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }
        .page .qty { font-weight: 800; color: #6d28d9; font-size: 12pt; text-align: center; }
        .page .header-bar { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #0f172a; padding-bottom: 6px; margin-bottom: 8px; }
        .page .kpi { display: inline-block; margin-right: 14px; font-size: 10pt; }
        .page .kpi b { font-size: 13pt; }
        .page .dest-block { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; margin: 10px 0; }
        .page .dest-block .dest-head { display: flex; justify-content: space-between; align-items: center; font-weight: 700; font-size: 11.5pt; margin-bottom: 4px; }
        .page .note { margin-top: 6px; padding: 6px 10px; background: #fef3c7; border-left: 3px solid #f59e0b; border-radius: 3px; font-size: 10pt; }
        .page .footer { margin-top: 18px; border-top: 1px dashed #cbd5e1; padding-top: 8px; font-size: 9pt; color: #64748b; display: flex; justify-content: space-between; }
        .controls { position: fixed; top: 10px; right: 10px; display: flex; gap: 8px; z-index: 100; }
        .controls button { background: #4f46e5; color: white; border: 0; padding: 8px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.15); }
        .controls button:hover { background: #4338ca; }
        .controls button.secondary { background: #475569; }
        .controls button.secondary:hover { background: #334155; }
      `}</style>

      {/* Barra de ações (some na impressão) */}
      <div className="controls no-print">
        <button onClick={() => window.print()}>Imprimir / Salvar PDF</button>
        <button className="secondary" onClick={() => window.close()}>Fechar</button>
      </div>

      {/* 1 folha por loja origem */}
      {byOrigin.map((origin) => {
        const totalUnits = origin.lines.reduce((a, l) => a + l.qty, 0);
        const totalMoves = origin.lines.length;

        // agrupa por destino
        const destMap = new Map<string, { code: string; name: string; lines: PlanLine[] }>();
        for (const l of origin.lines) {
          if (!destMap.has(l.toCode)) destMap.set(l.toCode, { code: l.toCode, name: l.toName, lines: [] });
          destMap.get(l.toCode)!.lines.push(l);
        }
        const dests = Array.from(destMap.values()).sort((a, b) => a.code.localeCompare(b.code));

        return (
          <div className="page" key={origin.code}>
            <div className="header-bar">
              <div>
                <h1>REALINHAMENTO DE ESTOQUE</h1>
                <div className="muted">LURDS Plus Size · ORDER ONE</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="muted">Gerado em {generatedLabel}</div>
                <div style={{ fontWeight: 700, fontSize: '13pt', marginTop: 2 }}>
                  Loja ORIGEM: <span className="ref">{origin.code}</span> · {origin.name}
                </div>
              </div>
            </div>

            <div style={{ margin: '6px 0 14px' }}>
              <span className="kpi">
                <span className="muted">Destinos:</span> <b>{dests.length}</b>
              </span>
              <span className="kpi">
                <span className="muted">Movimentações:</span> <b>{totalMoves}</b>
              </span>
              <span className="kpi">
                <span className="muted">Total de peças a enviar:</span> <b>{totalUnits}</b>
              </span>
            </div>

            {payload.note && (
              <div className="note">
                <b>Observação:</b> {payload.note}
              </div>
            )}

            <h2>Peças a enviar</h2>

            {dests.map((dest) => {
              const destTotal = dest.lines.reduce((a, l) => a + l.qty, 0);
              return (
                <div className="dest-block" key={dest.code}>
                  <div className="dest-head">
                    <div>
                      → Para <span className="ref">{dest.code}</span> · {dest.name}
                    </div>
                    <div className="muted">{dest.lines.length} item(ns) · {destTotal} peça(s)</div>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: '80px' }}>REF</th>
                        <th>Descrição</th>
                        <th style={{ width: '90px' }}>Cor</th>
                        <th style={{ width: '50px' }}>Tam</th>
                        <th className="num" style={{ width: '60px' }}>Qty</th>
                        <th style={{ width: '60px' }}>OK?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dest.lines.map((l, i) => (
                        <tr key={i}>
                          <td className="ref">{l.ref || l.sku}</td>
                          <td>{l.desc || '—'}</td>
                          <td>{l.cor || '—'}</td>
                          <td>{l.tamanho || '—'}</td>
                          <td className="qty">{l.qty}</td>
                          <td style={{ textAlign: 'center', fontSize: '14pt' }}>☐</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}

            <div className="footer">
              <span>_____________________________________</span>
              <span>Assinatura responsável loja {origin.code}</span>
            </div>
          </div>
        );
      })}

      {byOrigin.length === 0 && (
        <div className="page">
          <h1>Nenhuma movimentação no plano.</h1>
          <p className="muted">Volte pra tela de realinhamento e recalcule o plano.</p>
        </div>
      )}
    </div>
  );
}
