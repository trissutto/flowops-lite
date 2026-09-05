'use client';

/**
 * /minha-loja/pdv/recebimentos/extrato/[codCliente] — EXTRATO A4 das parcelas
 * em aberto do cliente (crediário). Impresso pela loja pra entregar/conferir
 * com a cliente. Documento NÃO fiscal.
 *
 * Layout aprovado pelo dono (05/08, simulação v2): observação em COLUNA
 * própria entre a promissória e o vencimento; resumo no rodapé com total em
 * aberto; juros calculados na DATA DE EMISSÃO.
 *
 * Chega aqui via routePrint kind='extrato_crediario' (perfil A4) com
 * ?autoprint=1 — mesmo esquema do recibo (notifyPrintReady no Electron).
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

type Installment = {
  registro: string;
  controle: string;
  numeroCompra: string | null;
  parcela: number | null;
  totalParcelas: number | null;
  vencimento: string;
  valorParcela: number;
  diasAtraso: number;
  jurosCalculado: number;
  valorComJuros: number;
  codCliente: string;
  nome: string | null;
  telefone: string | null;
  obs: string | null;
};

type Me = { name?: string | null; storeCode?: string | null; storeName?: string | null };

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDate = (iso: string) => {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('pt-BR');
  } catch {
    return iso;
  }
};

// Telefone vem cru do cadastro ("5513997016072", "13997016072", "1334221234").
// Tira o 55 do país e formata (DD) NNNNN-NNNN.
const fmtPhone = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(raw).trim() || null;
};

export default function ExtratoCrediarioPage() {
  return (
    <Suspense fallback={<div style={{ padding: 16, fontFamily: 'sans-serif' }}>Carregando…</div>}>
      <ExtratoCrediarioInner />
    </Suspense>
  );
}

function ExtratoCrediarioInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const codCliente = decodeURIComponent(String(params.codCliente || ''));
  const autoprint = searchParams?.get('autoprint') === '1';
  const nomeQuery = searchParams?.get('nome') || '';
  const telQuery = searchParams?.get('tel') || '';

  const [parcelas, setParcelas] = useState<Installment[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Installment[]>(`/crediarios/baixa/parcelas?codCliente=${encodeURIComponent(codCliente)}`)
      .then((list) => {
        const arr = Array.isArray(list) ? [...list] : [];
        arr.sort((a, b) => (a.vencimento < b.vencimento ? -1 : a.vencimento > b.vencimento ? 1 : 0));
        setParcelas(arr);
      })
      .catch((e) => setError(e?.message || String(e)));
    api<Me>('/auth/me').then(setMe).catch(() => {});
  }, [codCliente]);

  // Auto-print — mesmo fluxo do recibo (Electron hidden window espera notifyPrintReady)
  useEffect(() => {
    if (!parcelas) return;
    const t = setTimeout(() => {
      const electron = (window as any).electronAPI;
      if (autoprint && electron?.notifyPrintReady) {
        try {
          electron.notifyPrintReady();
        } catch {
          window.print();
        }
      } else if (autoprint) {
        window.print();
      }
    }, 350);
    return () => clearTimeout(t);
  }, [parcelas, autoprint]);

  useEffect(() => {
    function handleAfterPrint() {
      setTimeout(() => {
        if (window.opener || autoprint) {
          try { window.close(); } catch {}
        }
      }, 300);
    }
    window.addEventListener('afterprint', handleAfterPrint);
    return () => window.removeEventListener('afterprint', handleAfterPrint);
  }, [autoprint]);

  const nomeCliente = parcelas?.find((p) => p.nome)?.nome || nomeQuery || `Cód. ${codCliente}`;
  const telCliente = fmtPhone(parcelas?.find((p) => p.telefone)?.telefone || telQuery);

  const resumo = useMemo(() => {
    const list = parcelas || [];
    const atrasadas = list.filter((p) => p.diasAtraso > 0);
    return {
      qtd: list.length,
      atrasadasQtd: atrasadas.length,
      atrasadasTotal: atrasadas.reduce((s, p) => s + p.valorComJuros, 0),
      juros: list.reduce((s, p) => s + p.jurosCalculado, 0),
      total: list.reduce((s, p) => s + p.valorComJuros, 0),
    };
  }, [parcelas]);

  if (error) {
    return <div style={{ padding: 16, fontFamily: 'sans-serif' }}>Erro ao carregar parcelas: {error}</div>;
  }
  if (!parcelas) {
    return <div style={{ padding: 16, fontFamily: 'sans-serif' }}>Carregando…</div>;
  }

  const agora = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <>
      <style jsx global>{`
        @page {
          /* Margem FOLGADA (dono 05/08: "tá cortando quando imprimi" +
             "deixe mais borda lateral e top e base"). A HP Laser da loja tem
             área não-imprimível maior que os 12mm que estavam aqui e comia a
             borda do documento. 18mm laterais / 16mm topo e base dão folga
             pra qualquer impressora da rede. */
          size: A4 portrait;
          margin: 16mm 18mm;
        }
        @media print {
          html, body {
            background: #fff !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .no-print { display: none !important; }
          .folha {
            box-shadow: none !important;
            margin: 0 !important;
            /* respiro extra além da margem da @page — nada encosta no corte */
            padding: 2mm 1mm !important;
            width: auto !important;
            max-width: 100% !important;
          }
          /* Nada pode estourar a largura da folha (era o que cortava a coluna
             TOTAL na direita quando a observação vinha comprida). */
          table { table-layout: fixed; width: 100% !important; }
          td, th { overflow-wrap: anywhere; }
          .obs { max-width: 100%; white-space: normal; }
          /* Linha nunca parte no meio; cabeçalho da tabela (com a faixa de
             identificação do cliente) repete em TODA página — sem isso, a
             página 2 e 3 chegavam na mão da cliente sem dizer de quem são. */
          tr { page-break-inside: avoid; break-inside: avoid; }
          thead { display: table-header-group; }
          tfoot { display: table-footer-group; }
          .resumo, .rodape { page-break-inside: avoid; break-inside: avoid; }
          /* Compacta pra caber mais parcela por folha (57 parcelas: 3 folhas
             com a última quase vazia → 2 folhas cheias). */
          table { font-size: 10.5px; line-height: 1.25; }
          tbody td { padding: 2.5px 6px; }
          thead th { padding: 4px 6px; }
          .obs { padding: 1px 6px; font-size: 10px; }
          .folha { padding-bottom: 0 !important; }
        }
        body {
          margin: 0;
          background: #e5e5e0;
          font-family: 'Segoe UI', Arial, sans-serif;
          color: #1a1a1a;
        }
        .folha {
          width: 780px;
          margin: 24px auto;
          background: #fff;
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
          padding: 40px 44px;
          box-sizing: border-box;
        }
        .cabecalho { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #d4af37; padding-bottom: 14px; }
        .marca { font-size: 20px; font-weight: 800; letter-spacing: 0.5px; color: #b8912b; }
        .marca small { display: block; font-size: 11px; font-weight: 600; color: #777; letter-spacing: 2px; margin-top: 2px; }
        .doc-info { text-align: right; font-size: 12px; color: #555; line-height: 1.5; }
        .doc-info b { color: #1a1a1a; }
        .titulo { margin-top: 18px; font-size: 15px; font-weight: 800; letter-spacing: 1px; }
        .cliente-box { margin-top: 10px; background: #fafaf7; border: 1px solid #e5e0d5; border-radius: 8px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
        .cliente-box .nome { font-size: 16px; font-weight: 800; }
        .cliente-box .meta { font-size: 12px; color: #555; margin-top: 2px; }
        .badge { background: #fbf6e6; border: 1px solid #d4af37; color: #8c7325; font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 999px; white-space: nowrap; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12.5px; }
        thead th { text-align: left; font-size: 10.5px; letter-spacing: 0.8px; color: #8c7325; border-bottom: 2px solid #d4af37; padding: 8px; text-transform: uppercase; }
        thead th.faixa-cliente { text-transform: none; letter-spacing: 0; border-bottom: 1px solid #e8d9a0; background: #fbf6e6; color: #6b5a1e; font-size: 11px; padding: 5px 8px; }
        thead th.faixa-cliente span { float: right; font-weight: 600; color: #8c7325; }
        thead th.num, tbody td.num { text-align: right; }
        tbody td { padding: 9px 8px; border-bottom: 1px solid #eeebe2; vertical-align: middle; }
        .promissoria { font-weight: 700; font-family: 'Courier New', monospace; }
        .parcela-de { color: #888; font-size: 11px; }
        .atraso { color: #b3261e; font-size: 11px; font-weight: 700; }
        .juros { color: #b3261e; font-size: 11px; }
        .total-cell { font-weight: 800; color: #2e7d46; }
        .obs { display: inline-block; background: #fbf6e6; border: 1px solid #e8d9a0; color: #6b5a1e; border-radius: 5px; font-size: 11px; padding: 3px 8px; max-width: 180px; }
        .sem-obs { color: #ccc; }
        .resumo { margin-top: 18px; margin-left: auto; width: 300px; font-size: 13px; }
        .resumo .linha { display: flex; justify-content: space-between; padding: 5px 0; color: #555; }
        .resumo .linha.destaque { border-top: 2px solid #d4af37; margin-top: 4px; padding-top: 9px; font-size: 15px; font-weight: 800; color: #2e7d46; }
        .rodape { margin-top: 40px; border-top: 1px dashed #c9c4b8; padding-top: 12px; display: flex; justify-content: space-between; font-size: 10.5px; color: #999; }
        .toolbar { position: fixed; top: 8px; right: 8px; display: flex; gap: 6px; }
        .toolbar button { font-family: sans-serif; font-size: 12px; padding: 6px 12px; border: 1px solid #ccc; background: #fff; cursor: pointer; border-radius: 4px; }
      `}</style>

      <div className="toolbar no-print">
        <button onClick={() => window.print()}>🖨 Imprimir</button>
        <button onClick={() => window.close()}>Fechar</button>
      </div>

      <div className="folha">
        <div className="cabecalho">
          <div className="marca">
            LURD&apos;S PLUS SIZE
            <small>
              {(me?.storeName || '').toUpperCase()}
              {me?.storeCode ? ` · LOJA ${me.storeCode}` : ''}
            </small>
          </div>
          <div className="doc-info">
            Emitido em <b>{agora}</b>
            <br />
            {me?.name && (
              <>
                Operador: <b>{me.name}</b>
                <br />
              </>
            )}
            Documento sem valor fiscal
          </div>
        </div>

        <div className="titulo">PARCELAS EM ABERTO — CREDIÁRIO</div>

        <div className="cliente-box">
          <div>
            <div className="nome">{nomeCliente}</div>
            <div className="meta">
              Cód: {codCliente}
              {telCliente ? ` · Tel: ${telCliente}` : ''}
            </div>
          </div>
          <div className="badge">
            {resumo.qtd} PARCELA{resumo.qtd !== 1 ? 'S' : ''} EM ABERTO
          </div>
        </div>

        {parcelas.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', color: '#777' }}>
            Nenhuma parcela em aberto pra esse cliente. 🎉
          </div>
        ) : (
          <table>
            {/* Larguras fixas: com table-layout:fixed no print, sem isso as 6
                colunas sairiam iguais e a data quebraria em duas linhas. */}
            <colgroup>
              <col style={{ width: '18%' }} />
              <col style={{ width: '19%' }} />
              <col style={{ width: '23%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '14%' }} />
            </colgroup>
            <thead>
              {/* Repete em toda folha (display:table-header-group) — a página 2
                  sozinha na mão da cliente precisa dizer de quem é. */}
              <tr>
                <th className="faixa-cliente" colSpan={6}>
                  {nomeCliente} · Cód {codCliente}
                  <span>
                    {resumo.qtd} parcela{resumo.qtd !== 1 ? 's' : ''} · {brl(resumo.total)}
                  </span>
                </th>
              </tr>
              <tr>
                <th>Promissória</th>
                <th>Observação</th>
                <th>Vencimento</th>
                <th className="num">Valor</th>
                <th className="num">Juros</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {parcelas.map((p) => (
                <tr key={`${p.registro}/${p.controle}`}>
                  <td>
                    <span className="promissoria">
                      {p.numeroCompra || '—'}/{p.parcela ?? '—'}
                    </span>{' '}
                    {p.totalParcelas ? <span className="parcela-de">de {p.totalParcelas}</span> : null}
                  </td>
                  <td>{p.obs ? <span className="obs">{p.obs}</span> : <span className="sem-obs">—</span>}</td>
                  <td>
                    {fmtDate(p.vencimento)}
                    {p.diasAtraso > 0 && <span className="atraso"> · {p.diasAtraso}d atraso</span>}
                  </td>
                  <td className="num">{brl(p.valorParcela)}</td>
                  <td className="num">
                    {p.jurosCalculado > 0 ? <span className="juros">{brl(p.jurosCalculado)}</span> : '—'}
                  </td>
                  <td className="num total-cell">{brl(p.valorComJuros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="resumo">
          <div className="linha">
            <span>Parcelas em aberto</span>
            <span>{resumo.qtd}</span>
          </div>
          {resumo.atrasadasQtd > 0 && (
            <div className="linha">
              <span>Em atraso</span>
              <span style={{ color: '#b3261e', fontWeight: 700 }}>
                {resumo.atrasadasQtd} · {brl(resumo.atrasadasTotal)}
              </span>
            </div>
          )}
          {resumo.juros > 0 && (
            <div className="linha">
              <span>Juros acumulados</span>
              <span>{brl(resumo.juros)}</span>
            </div>
          )}
          <div className="linha destaque">
            <span>TOTAL EM ABERTO</span>
            <span>{brl(resumo.total)}</span>
          </div>
        </div>

        <div className="rodape">
          <span>FlowOps · crm.lurdsplussize.com.br</span>
          <span>Valores de juros calculados na data de emissão</span>
        </div>
      </div>
    </>
  );
}
