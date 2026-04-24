'use client';

/**
 * /retaguarda/realinhamento/imprimir — Página imprimível do plano de realinhamento.
 *
 * Formato: 1 folha por loja ORIGEM. Dentro de cada folha, seção por DESTINO,
 * e dentro de cada destino, 1 GRADE por REF (cor × tamanho) — igual a tela
 * /consultar, pra facilitar a separação física.
 *
 * Recebe o payload via 3 canais (postMessage, localStorage, sessionStorage) —
 * o primeiro que entregar o dado ganha.
 *
 * Auto-dispara window.print() após montar. Usuário escolhe "Salvar como PDF"
 * no diálogo do navegador.
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

// Ordena tamanhos: numéricos ascendentes, depois P/M/G/GG/etc, depois alfabético
function sortSizes(sizes: string[]): string[] {
  const sizeOrderTxt = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG'];
  return [...sizes].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNum = !isNaN(na);
    const bNum = !isNaN(nb);
    if (aNum && bNum) return na - nb;
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    const ia = sizeOrderTxt.indexOf(a.toUpperCase());
    const ib = sizeOrderTxt.indexOf(b.toUpperCase());
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

export default function ImprimirRealinhamentoPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Estratégia tripla de recebimento:
    //   1) postMessage da aba que abriu esta (mais confiável)
    //   2) localStorage (compartilhado entre abas)
    //   3) sessionStorage (fallback)
    let done = false;

    const onMessage = (ev: MessageEvent) => {
      if (done) return;
      if (ev.origin !== window.location.origin) return;
      const data = ev.data;
      if (data && data.type === 'realinhamento_print_payload' && data.payload) {
        done = true;
        setPayload(data.payload as Payload);
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage('realinhamento_print_ack', window.location.origin);
          }
        } catch {}
      }
    };
    window.addEventListener('message', onMessage);

    try {
      const raw =
        localStorage.getItem('realinhamento_print_payload') ||
        sessionStorage.getItem('realinhamento_print_payload');
      if (raw) {
        done = true;
        setPayload(JSON.parse(raw) as Payload);
      }
    } catch {}

    const timeout = setTimeout(() => {
      if (!done) {
        setError(
          'Nenhum plano encontrado. Volte pra tela de realinhamento, atualize a página com Ctrl+F5 e clique em "Gerar PDF" novamente.',
        );
      }
    }, 2500);

    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (payload && !error) {
      const t = setTimeout(() => {
        try { window.print(); } catch {}
      }, 500);
      return () => clearTimeout(t);
    }
  }, [payload, error]);

  // Monta estrutura aninhada: origem → destino → REF → grid (cor × tam)
  const byOrigin = useMemo(() => {
    if (!payload) return [];

    type RefGrid = {
      ref: string;
      desc: string;
      cores: string[];
      tamanhos: string[];
      // matrix[cor][tamanho] = qty
      matrix: Record<string, Record<string, number>>;
      total: number;
    };

    type DestSection = {
      code: string;
      name: string;
      refs: RefGrid[];
      total: number;
    };

    type OriginSheet = {
      code: string;
      name: string;
      dests: DestSection[];
      total: number;
    };

    const originMap = new Map<string, OriginSheet>();

    for (const line of payload.lines) {
      const refKey = line.ref || line.sku;
      const cor = line.cor || '—';
      const tam = line.tamanho || '—';

      // garante estrutura até o ref
      if (!originMap.has(line.fromCode)) {
        originMap.set(line.fromCode, { code: line.fromCode, name: line.fromName, dests: [], total: 0 });
      }
      const origin = originMap.get(line.fromCode)!;

      let dest = origin.dests.find((d) => d.code === line.toCode);
      if (!dest) {
        dest = { code: line.toCode, name: line.toName, refs: [], total: 0 };
        origin.dests.push(dest);
      }

      let refGrid = dest.refs.find((r) => r.ref === refKey);
      if (!refGrid) {
        refGrid = {
          ref: refKey,
          desc: line.desc || '',
          cores: [],
          tamanhos: [],
          matrix: {},
          total: 0,
        };
        dest.refs.push(refGrid);
      }

      if (!refGrid.cores.includes(cor)) refGrid.cores.push(cor);
      if (!refGrid.tamanhos.includes(tam)) refGrid.tamanhos.push(tam);
      if (!refGrid.matrix[cor]) refGrid.matrix[cor] = {};
      refGrid.matrix[cor][tam] = (refGrid.matrix[cor][tam] || 0) + line.qty;
      refGrid.total += line.qty;
      dest.total += line.qty;
      origin.total += line.qty;
    }

    // Ordena tudo
    const out = Array.from(originMap.values()).sort((a, b) => a.code.localeCompare(b.code));
    for (const origin of out) {
      origin.dests.sort((a, b) => a.code.localeCompare(b.code));
      for (const dest of origin.dests) {
        dest.refs.sort((a, b) => a.ref.localeCompare(b.ref));
        for (const refGrid of dest.refs) {
          refGrid.tamanhos = sortSizes(refGrid.tamanhos);
          refGrid.cores.sort((a, b) => a.localeCompare(b));
        }
      }
    }
    return out;
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
      <style>{`
        @media print {
          @page {
            size: A4;
            margin: 12mm 10mm;
          }
          body { background: white !important; }
          .no-print { display: none !important; }
          .page { page-break-after: always; }
          .page:last-child { page-break-after: auto; }
          .dest-block { page-break-inside: avoid; }
        }
        .print-root {
          background: #f8fafc;
          min-height: 100vh;
          padding: 20px 0;
        }
        @media print {
          .print-root { background: white; padding: 0; }
        }
        .page {
          background: white;
          width: 210mm;
          min-height: 297mm;
          margin: 0 auto 20px;
          padding: 14mm 12mm;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #0f172a;
          font-size: 10.5pt;
          line-height: 1.3;
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
        .page h1 { margin: 0 0 2px 0; font-size: 17pt; font-weight: 800; letter-spacing: -0.3px; }
        .page h2 { margin: 14px 0 4px 0; font-size: 12pt; font-weight: 700; border-bottom: 2px solid #0f172a; padding-bottom: 2px; }
        .page .muted { color: #64748b; font-size: 9.5pt; }
        .page .header-bar { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #0f172a; padding-bottom: 5px; margin-bottom: 6px; }
        .page .kpi { display: inline-block; margin-right: 14px; font-size: 9.5pt; }
        .page .kpi b { font-size: 12pt; }
        .page .note { margin-top: 4px; padding: 5px 8px; background: #fef3c7; border-left: 3px solid #f59e0b; border-radius: 3px; font-size: 9.5pt; }
        .page .ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }

        .dest-block {
          border: 1.5px solid #0f172a;
          border-radius: 6px;
          padding: 8px 10px;
          margin: 10px 0;
        }
        .dest-head {
          display: flex; justify-content: space-between; align-items: center;
          font-size: 12pt; font-weight: 800; margin-bottom: 6px;
          background: #0f172a; color: white; padding: 4px 8px; border-radius: 4px;
          margin: -8px -10px 8px;
        }

        .ref-block {
          border: 1px solid #cbd5e1;
          border-radius: 4px;
          margin: 6px 0 10px;
          overflow: hidden;
        }
        .ref-head {
          background: #ecfdf5;
          border-bottom: 1px solid #bbf7d0;
          padding: 4px 8px;
          display: flex; justify-content: space-between; align-items: center;
        }
        .ref-head .ref-title {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-weight: 800; font-size: 11pt;
        }
        .ref-head .ref-desc {
          font-size: 9.5pt; color: #475569; margin-left: 8px;
        }
        .ref-head .ref-total {
          background: #059669; color: white; font-weight: 800;
          padding: 1px 8px; border-radius: 3px; font-size: 10pt;
        }

        .grid {
          width: 100%;
          border-collapse: collapse;
          font-size: 10pt;
        }
        .grid th, .grid td {
          border: 1px solid #cbd5e1;
          padding: 5px 6px;
          text-align: center;
          vertical-align: middle;
          font-variant-numeric: tabular-nums;
        }
        .grid thead th {
          background: #f1f5f9;
          font-weight: 700;
          font-size: 10pt;
        }
        .grid tbody td.cor-label {
          text-align: left;
          font-weight: 600;
          background: #f8fafc;
          white-space: nowrap;
        }
        .grid tbody td.qty {
          font-weight: 800;
          font-size: 11pt;
          color: #6d28d9;
        }
        .grid tbody td.zero {
          color: #cbd5e1;
        }
        .grid tbody td.total,
        .grid tfoot td {
          font-weight: 800;
          background: #f1f5f9;
        }
        .grid tfoot td {
          border-top: 2px solid #0f172a;
        }

        .footer { margin-top: 14px; border-top: 1px dashed #cbd5e1; padding-top: 6px; font-size: 9pt; color: #64748b; display: flex; justify-content: space-between; }

        .controls { position: fixed; top: 10px; right: 10px; display: flex; gap: 8px; z-index: 100; }
        .controls button { background: #4f46e5; color: white; border: 0; padding: 8px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.15); }
        .controls button:hover { background: #4338ca; }
        .controls button.secondary { background: #475569; }
        .controls button.secondary:hover { background: #334155; }
      `}</style>

      <div className="controls no-print">
        <button onClick={() => window.print()}>Imprimir / Salvar PDF</button>
        <button className="secondary" onClick={() => window.close()}>Fechar</button>
      </div>

      {byOrigin.map((origin) => (
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

          <div style={{ margin: '4px 0 10px' }}>
            <span className="kpi"><span className="muted">Destinos:</span> <b>{origin.dests.length}</b></span>
            <span className="kpi"><span className="muted">REFs:</span> <b>{origin.dests.reduce((a, d) => a + d.refs.length, 0)}</b></span>
            <span className="kpi"><span className="muted">Total de peças a enviar:</span> <b>{origin.total}</b></span>
          </div>

          {payload.note && (
            <div className="note">
              <b>Observação:</b> {payload.note}
            </div>
          )}

          {origin.dests.map((dest) => (
            <div className="dest-block" key={dest.code}>
              <div className="dest-head">
                <span>→ Enviar pra {dest.code} · {dest.name}</span>
                <span style={{ fontSize: '10pt', fontWeight: 600 }}>
                  {dest.refs.length} REF(s) · {dest.total} peça(s)
                </span>
              </div>

              {dest.refs.map((refGrid) => {
                const allSizes = refGrid.tamanhos;
                // Total por tamanho (rodapé)
                const sizeTotals: Record<string, number> = {};
                for (const t of allSizes) {
                  sizeTotals[t] = refGrid.cores.reduce(
                    (a, c) => a + (refGrid.matrix[c]?.[t] || 0),
                    0,
                  );
                }
                return (
                  <div className="ref-block" key={refGrid.ref}>
                    <div className="ref-head">
                      <div>
                        <span className="ref-title">{refGrid.ref}</span>
                        {refGrid.desc && <span className="ref-desc">{refGrid.desc}</span>}
                      </div>
                      <span className="ref-total">{refGrid.total} un</span>
                    </div>
                    <table className="grid">
                      <thead>
                        <tr>
                          <th style={{ width: '130px', textAlign: 'left' }}>Cor</th>
                          {allSizes.map((t) => (
                            <th key={t}>{t}</th>
                          ))}
                          <th style={{ width: '50px' }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {refGrid.cores.map((cor) => {
                          const rowTotal = allSizes.reduce(
                            (a, t) => a + (refGrid.matrix[cor]?.[t] || 0),
                            0,
                          );
                          return (
                            <tr key={cor}>
                              <td className="cor-label">{cor}</td>
                              {allSizes.map((t) => {
                                const q = refGrid.matrix[cor]?.[t] || 0;
                                return (
                                  <td key={t} className={q > 0 ? 'qty' : 'zero'}>
                                    {q > 0 ? q : '—'}
                                  </td>
                                );
                              })}
                              <td className="total">{rowTotal}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td style={{ textAlign: 'left' }}>Total</td>
                          {allSizes.map((t) => (
                            <td key={t}>{sizeTotals[t] || 0}</td>
                          ))}
                          <td>{refGrid.total}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                );
              })}
            </div>
          ))}

          <div className="footer">
            <span>_____________________________________</span>
            <span>Assinatura responsável loja {origin.code}</span>
          </div>
        </div>
      ))}

      {byOrigin.length === 0 && (
        <div className="page">
          <h1>Nenhuma movimentação no plano.</h1>
          <p className="muted">Volte pra tela de realinhamento e recalcule o plano.</p>
        </div>
      )}
    </div>
  );
}
