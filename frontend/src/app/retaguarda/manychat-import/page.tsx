'use client';

/**
 * /retaguarda/manychat-import — importa o CSV de CONTATOS do ManyChat
 * (Contatos → Exportar) e vincula cada assinante ao cadastro do Flow pelo @.
 *
 * O CSV traz o user_id (ID do assinante) + o @ do Instagram. Com o vínculo
 * salvo, o "🤖 Enviar automático" da live alcança a cliente sempre que ela
 * estiver na janela de 24h (comentou/mandou DM). Rodar depois de cada live
 * pega quem comentou mas não completou o cadastro pelo link.
 *
 * Parse 100% no navegador; só os pares {sid, ig} vão pro backend, em lotes.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ArrowLeft, FileUp, Check, AlertCircle, Loader2 } from 'lucide-react';

// Parser CSV simples com suporte a aspas e separador , ou ;
function parseCsv(text: string): string[][] {
  const sep = (text.split('\n')[0] || '').split(';').length > (text.split('\n')[0] || '').split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(cur); cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const SID_HINTS = ['user_id', 'user id', 'subscriber_id', 'subscriber id', 'psid', 'id'];
const IG_HINTS = ['ig_username', 'ig username', 'instagram username', 'nome de usuário do instagram', 'instagram', 'username'];

function detectCol(headers: string[], hints: string[]): number {
  const h = headers.map((x) => x.trim().toLowerCase());
  for (const hint of hints) {
    const i = h.findIndex((x) => x === hint);
    if (i >= 0) return i;
  }
  for (const hint of hints) {
    const i = h.findIndex((x) => x.includes(hint));
    if (i >= 0) return i;
  }
  return -1;
}

export default function ManychatImportPage() {
  const [rows, setRows] = useState<string[][]>([]);
  const [fileName, setFileName] = useState('');
  const [sidCol, setSidCol] = useState(-1);
  const [igCol, setIgCol] = useState(-1);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ processados: number; vinculados: number; semCadastro: number; exemplosSemCadastro: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  const links = useMemo(() => {
    if (sidCol < 0 || igCol < 0) return [];
    const out: Array<{ sid: string; ig: string }> = [];
    for (const r of dataRows) {
      const sid = String(r[sidCol] || '').trim();
      const ig = String(r[igCol] || '').trim().replace(/^@/, '');
      if (sid && ig) out.push({ sid, ig });
    }
    return out;
  }, [dataRows, sidCol, igCol]);

  async function onFile(f: File | null) {
    setResult(null);
    setErr(null);
    if (!f) return;
    setFileName(f.name);
    const text = await f.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) { setErr('Arquivo vazio ou sem linhas de dados.'); setRows([]); return; }
    setRows(parsed);
    setSidCol(detectCol(parsed[0], SID_HINTS));
    setIgCol(detectCol(parsed[0], IG_HINTS));
  }

  async function importar() {
    if (!links.length || importing) return;
    setImporting(true);
    setErr(null);
    setResult(null);
    try {
      // Lotes de 1000 pra não estourar payload; soma os resultados
      const total = { processados: 0, vinculados: 0, semCadastro: 0, exemplosSemCadastro: [] as string[] };
      for (let i = 0; i < links.length; i += 1000) {
        const r = await api<typeof total>('/live-pdv/manychat/import-links', {
          method: 'POST',
          body: JSON.stringify({ links: links.slice(i, i + 1000) }),
        });
        total.processados += r.processados;
        total.vinculados += r.vinculados;
        total.semCadastro += r.semCadastro;
        if (total.exemplosSemCadastro.length < 12) {
          total.exemplosSemCadastro.push(...(r.exemplosSemCadastro || []).slice(0, 12 - total.exemplosSemCadastro.length));
        }
      }
      setResult(total);
    } catch (e: any) {
      setErr(e?.message || 'Falha na importação');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-violet-100 flex items-center justify-center text-xl">🤖</div>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-800">Importar IDs do ManyChat</h1>
            <p className="text-xs text-slate-500">CSV de Contatos → vincula pelo @ → habilita a DM automática da live</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-4">
        <section className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
          <div className="text-sm text-slate-600">
            <b>Como exportar:</b> ManyChat → <b>Contatos</b> → selecionar todos → <b>Exportar</b> (CSV).
            O arquivo precisa ter as colunas do <b>ID do contato</b> (user_id) e do <b>@ do Instagram</b>.
          </div>
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-violet-300 bg-violet-50/50 px-4 py-8 text-violet-700 hover:bg-violet-50">
            <FileUp className="h-5 w-5" />
            <span className="font-semibold">{fileName || 'Clique pra escolher o CSV exportado'}</span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0] || null)}
            />
          </label>
        </section>

        {rows.length > 1 && (
          <section className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
            <div className="text-sm font-bold text-slate-700">Colunas detectadas (ajuste se precisar):</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-semibold text-slate-500">Coluna do ID (user_id)</span>
                <select
                  value={sidCol}
                  onChange={(e) => setSidCol(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value={-1}>— escolher —</option>
                  {headers.map((h, i) => (
                    <option key={i} value={i}>{h || `(coluna ${i + 1})`}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-500">Coluna do @ do Instagram</span>
                <select
                  value={igCol}
                  onChange={(e) => setIgCol(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value={-1}>— escolher —</option>
                  {headers.map((h, i) => (
                    <option key={i} value={i}>{h || `(coluna ${i + 1})`}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-600">
              {links.length > 0
                ? <>Prontos pra importar: <b>{links.length}</b> contato(s) com ID + @ (de {dataRows.length} linhas).</>
                : 'Escolha as duas colunas acima — nenhum par ID+@ válido ainda.'}
            </div>
            <button
              onClick={importar}
              disabled={!links.length || importing}
              className="w-full rounded-xl bg-violet-600 py-3 font-bold text-white hover:bg-violet-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {importing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
              {importing ? 'Importando…' : `Importar e vincular (${links.length})`}
            </button>
          </section>
        )}

        {err && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}

        {result && (
          <section className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 text-sm text-emerald-900 space-y-1">
            <div className="font-bold text-base">✓ Importação concluída</div>
            <div><b>{result.vinculados}</b> cliente(s) vinculadas (DM automática habilitada pra elas)</div>
            <div>{result.semCadastro} contato(s) do ManyChat ainda sem cadastro no Flow (normal — só quem já tem cadastro com @ é vinculada)</div>
            {result.exemplosSemCadastro.length > 0 && (
              <div className="text-xs text-emerald-700">
                Ex. sem cadastro: {result.exemplosSemCadastro.map((x) => `@${x}`).join(', ')}
              </div>
            )}
            <div className="pt-1 text-xs text-emerald-700">
              Pode rodar de novo quando quiser — reimportar só atualiza, não duplica nada.
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
