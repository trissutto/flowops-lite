'use client';

/**
 * /retaguarda/editor-produtos — EDITOR DE PRODUTOS (só admin).
 *
 * Objetivo: padronizar REFERÊNCIAS, alterar PREÇOS em bloco e corrigir
 * DESCRIÇÕES em bloco, com os campos SEPARADOS (SKU · REF · DESCRIÇÃO ·
 * MARCA · COR · TAMANHO · PREÇO).
 *
 * Tudo grava NO GIGA (fonte da verdade) e reflete nos espelhos na hora.
 * Toda ação em bloco passa por PREVIEW ANTES→DEPOIS antes de confirmar.
 * SKU (código) nunca é editável — é a chave do bipe/etiqueta/estoque.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Search, Pencil, Tags, DollarSign, ReplaceAll, Loader2,
  AlertTriangle, Check, X, Lock, History,
} from 'lucide-react';
import { api } from '@/lib/api';

type Row = {
  codigo: string;
  ref: string;
  descricao: string;
  marca: string | null;
  cor: string;
  tamanho: string;
  preco: number | null;
  estoque: number | null;
};

type SearchResp = {
  rows: Row[];
  fonte: 'giga' | 'espelho';
  shadowMode?: boolean;
  warnings: {
    legendaAtiva: Array<{ refCode: string; atalho: string }>;
    classificacao: Array<{ ref: string; tipoProduto: number }>;
  };
};

type Changes = {
  ref?: string;
  descricao?: string;
  marca?: string;
  cor?: string;
  tamanho?: string;
  preco?: number;
};

const LIMITS: Record<string, number> = { ref: 10, descricao: 100, marca: 30, cor: 15, tamanho: 20 };

const brl = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const parsePreco = (s: string): number => {
  const t = (s || '').trim();
  if (!t) return NaN;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return Number(norm);
};

export default function EditorProdutosPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [meta, setMeta] = useState<Omit<SearchResp, 'rows'> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');

  // Edições pendentes: codigo → campos alterados
  const [pending, setPending] = useState<Map<string, Changes>>(new Map());
  // Seleção pra ações em bloco
  const [sel, setSel] = useState<Set<string>>(new Set());

  // Modais
  const [modalRef, setModalRef] = useState(false);
  const [modalPreco, setModalPreco] = useState(false);
  const [modalDesc, setModalDesc] = useState(false);
  const [preview, setPreview] = useState<Array<{ codigo: string; ref: string; field: string; antes: string; depois: string }> | null>(null);
  const [applying, setApplying] = useState(false);

  // Inputs dos modais
  const [novaRef, setNovaRef] = useState('');
  const [refColisao, setRefColisao] = useState<{ existentes: number; exemploDescricao: string | null } | null>(null);
  const [precoModo, setPrecoModo] = useState<'fixar' | 'percentual'>('fixar');
  const [precoValor, setPrecoValor] = useState('');
  const [descDe, setDescDe] = useState('');
  const [descPara, setDescPara] = useState('');

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((me) => {
        if (me.role !== 'admin') { router.push('/'); return; }
        setAllowed(true);
      })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buscar = async () => {
    const term = q.trim();
    if (!term) return;
    setBusy(true); setErr(''); setOkMsg('');
    setPending(new Map()); setSel(new Set());
    try {
      const r = await api<SearchResp>(`/products-editor/search?q=${encodeURIComponent(term)}`);
      setRows(r.rows || []);
      setMeta(r);
      if (!r.rows?.length) setErr(`Nada encontrado pra "${term}"`);
    } catch (e: any) {
      setErr(e?.message || 'Falha na busca');
    } finally {
      setBusy(false);
    }
  };

  // Valor efetivo da célula (pendente > original)
  const val = (row: Row, field: keyof Changes): string => {
    const p = pending.get(row.codigo);
    if (p && p[field] !== undefined) return String(p[field]);
    if (field === 'preco') return row.preco != null ? String(row.preco).replace('.', ',') : '';
    return String((row as any)[field] ?? '');
  };

  const setField = (codigo: string, field: keyof Changes, value: string, original: Row) => {
    setPending((prev) => {
      const next = new Map(prev);
      const cur = { ...(next.get(codigo) || {}) };
      if (field === 'preco') {
        (cur as any)[field] = value as any; // guarda como digitado; valida no preview
      } else {
        (cur as any)[field] = value;
      }
      // Se voltou pro valor original, limpa o campo pendente
      const orig = field === 'preco'
        ? (original.preco != null ? String(original.preco).replace('.', ',') : '')
        : String((original as any)[field] ?? '');
      if (String(value) === orig) delete (cur as any)[field];
      if (Object.keys(cur).length) next.set(codigo, cur);
      else next.delete(codigo);
      return next;
    });
  };

  const grupos = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of rows) {
      const k = r.ref || '(SEM REF)';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return Array.from(map.entries());
  }, [rows]);

  const toggleSel = (codigo: string) =>
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(codigo)) n.delete(codigo); else n.add(codigo);
      return n;
    });

  const toggleSelRef = (refRows: Row[]) =>
    setSel((prev) => {
      const n = new Set(prev);
      const all = refRows.every((r) => n.has(r.codigo));
      for (const r of refRows) { if (all) n.delete(r.codigo); else n.add(r.codigo); }
      return n;
    });

  // ── Ações em bloco → alimentam `pending` ──────────────────────────────────
  const aplicarRenomearRef = () => {
    const target = novaRef.trim().toUpperCase();
    if (!target) return;
    setPending((prev) => {
      const next = new Map(prev);
      for (const r of rows) {
        if (!sel.has(r.codigo)) continue;
        const cur = { ...(next.get(r.codigo) || {}) };
        if (target === r.ref) delete (cur as any).ref; else cur.ref = target;
        if (Object.keys(cur).length) next.set(r.codigo, cur); else next.delete(r.codigo);
      }
      return next;
    });
    setModalRef(false); setNovaRef(''); setRefColisao(null);
  };

  const aplicarPreco = () => {
    const v = parsePreco(precoValor);
    if (!isFinite(v)) return;
    setPending((prev) => {
      const next = new Map(prev);
      for (const r of rows) {
        if (!sel.has(r.codigo)) continue;
        const cur = { ...(next.get(r.codigo) || {}) };
        let novo: number;
        if (precoModo === 'fixar') novo = v;
        else novo = Math.round(((r.preco || 0) * (1 + v / 100)) * 100) / 100;
        if (novo > 0 && novo !== r.preco) (cur as any).preco = String(novo).replace('.', ',');
        if (Object.keys(cur).length) next.set(r.codigo, cur); else next.delete(r.codigo);
      }
      return next;
    });
    setModalPreco(false); setPrecoValor('');
  };

  const aplicarSubstituicao = () => {
    const de = descDe.trim();
    if (!de) return;
    const re = new RegExp(de.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    setPending((prev) => {
      const next = new Map(prev);
      for (const r of rows) {
        if (!sel.has(r.codigo)) continue;
        const atual = (next.get(r.codigo)?.descricao ?? r.descricao) || '';
        if (!re.test(atual)) { re.lastIndex = 0; continue; }
        re.lastIndex = 0;
        const nova = atual.replace(re, descPara.toUpperCase());
        const cur = { ...(next.get(r.codigo) || {}) };
        if (nova === r.descricao) delete (cur as any).descricao; else cur.descricao = nova;
        if (Object.keys(cur).length) next.set(r.codigo, cur); else next.delete(r.codigo);
      }
      return next;
    });
    setModalDesc(false); setDescDe(''); setDescPara('');
  };

  // ── Preview + aplicar ─────────────────────────────────────────────────────
  const montarPreview = () => {
    setErr('');
    const linhas: Array<{ codigo: string; ref: string; field: string; antes: string; depois: string }> = [];
    for (const [codigo, ch] of pending) {
      const row = rows.find((r) => r.codigo === codigo);
      if (!row) continue;
      for (const [field, value] of Object.entries(ch)) {
        if (field === 'preco') {
          const n = parsePreco(String(value));
          if (!isFinite(n) || n <= 0) { setErr(`Preço inválido no código ${codigo}: "${value}"`); return; }
          linhas.push({ codigo, ref: row.ref, field: 'PREÇO', antes: brl(row.preco), depois: brl(n) });
        } else {
          const max = LIMITS[field] || 100;
          if (String(value).trim().length > max) {
            setErr(`${field.toUpperCase()} passa de ${max} caracteres no código ${codigo}`); return;
          }
          linhas.push({
            codigo, ref: row.ref, field: field.toUpperCase(),
            antes: String((row as any)[field] ?? ''), depois: String(value).toUpperCase(),
          });
        }
      }
    }
    if (!linhas.length) { setErr('Nenhuma alteração pendente'); return; }
    setPreview(linhas);
  };

  const confirmarAplicar = async () => {
    setApplying(true); setErr('');
    try {
      const edits = Array.from(pending.entries()).map(([codigo, ch]) => {
        const changes: any = { ...ch };
        if (changes.preco !== undefined) changes.preco = parsePreco(String(changes.preco));
        return { codigo, changes };
      });
      const r = await api<{ ok: boolean; shadow: boolean; atualizados: number; planejados: number }>(
        '/products-editor/apply',
        { method: 'POST', body: JSON.stringify({ edits }) },
      );
      setPreview(null);
      setPending(new Map());
      setSel(new Set());
      setOkMsg(
        r.shadow
          ? `SHADOW MODE: ${r.planejados} alterações registradas na auditoria SEM gravar no Giga (EDITOR_PRODUTOS_WRITE=0).`
          : `✓ ${r.atualizados} variações gravadas no Giga e refletidas no Flow.`,
      );
      await buscar(); // recarrega fresco
    } catch (e: any) {
      setErr(e?.message || 'Falha ao aplicar');
    } finally {
      setApplying(false);
    }
  };

  // Checa colisão da REF destino ao digitar no modal
  useEffect(() => {
    if (!modalRef) return;
    const target = novaRef.trim().toUpperCase();
    if (!target) { setRefColisao(null); return; }
    const t = setTimeout(() => {
      const exclude = Array.from(sel).join(',');
      api<{ existentes: number; exemploDescricao: string | null }>(
        `/products-editor/ref-info?ref=${encodeURIComponent(target)}&exclude=${encodeURIComponent(exclude)}`,
      )
        .then(setRefColisao)
        .catch(() => setRefColisao(null));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novaRef, modalRef]);

  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">Carregando…</div>;
  }

  const legendaAvisos = meta?.warnings?.legendaAtiva || [];
  const classifAvisos = meta?.warnings?.classificacao || [];
  const nPend = Array.from(pending.values()).reduce((s, c) => s + Object.keys(c).length, 0);

  return (
    <div className="min-h-screen bg-slate-50 pb-32">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></Link>
          <Pencil className="w-5 h-5 text-amber-600" />
          <h1 className="font-bold text-slate-800 text-lg">Editor de Produtos</h1>
          <span className="text-[11px] text-slate-500">grava no GIGA · SKU nunca muda · preview antes de aplicar</span>
          {meta?.shadowMode && (
            <span className="text-[10px] font-bold uppercase bg-amber-500 text-white px-2 py-0.5 rounded-full">
              Shadow mode — não grava
            </span>
          )}
          <div className="flex-1" />
          <Link href="#" onClick={(e) => { e.preventDefault(); alert('Auditoria: GET /products-editor/audit (tela na v2 — cada alteração já fica registrada ANTES→DEPOIS).'); }}
            className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1">
            <History className="w-3.5 h-3.5" /> auditado
          </Link>
        </div>
        <div className="max-w-7xl mx-auto px-4 pb-3 flex gap-2">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && buscar()}
              placeholder="REF, código, ou palavras da descrição (ex: VESTIDO MARIE)…"
              className="w-full pl-9 pr-3 py-2.5 border-2 border-slate-200 rounded-xl focus:border-amber-400 focus:outline-none text-sm"
            />
          </div>
          <button
            onClick={buscar}
            disabled={busy || !q.trim()}
            className="px-5 py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-40 flex items-center gap-2"
            style={{ background: '#B8912B' }}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Buscar
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-4">
        {err && (
          <div className="mb-3 bg-rose-50 border-2 border-rose-200 text-rose-800 px-4 py-2.5 rounded-xl text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {err}
          </div>
        )}
        {okMsg && (
          <div className="mb-3 bg-emerald-50 border-2 border-emerald-200 text-emerald-800 px-4 py-2.5 rounded-xl text-sm flex items-center gap-2">
            <Check className="w-4 h-4 shrink-0" /> {okMsg}
          </div>
        )}

        {/* Avisos de efeito colateral */}
        {legendaAvisos.length > 0 && (
          <div className="mb-3 bg-amber-50 border border-amber-200 text-amber-800 px-4 py-2 rounded-xl text-xs">
            ⚠️ REF em <b>legenda de live ativa</b>: {legendaAvisos.map((l) => `${l.refCode} (atalho ${l.atalho})`).join(' · ')} — renomear quebra o atalho da live.
          </div>
        )}
        {classifAvisos.length > 0 && (
          <div className="mb-3 bg-sky-50 border border-sky-200 text-sky-800 px-4 py-2 rounded-xl text-xs">
            ℹ️ REF com classificação: {classifAvisos.map((c) => `${c.ref} (${c.tipoProduto === 1 ? 'BÁSICO' : 'MODA'})`).join(' · ')} — ao renomear, reclassifique a REF nova em Cadastros → Classificação.
          </div>
        )}

        {/* Barra de ações em bloco */}
        {rows.length > 0 && (
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-500">{sel.size} selecionada(s)</span>
            <button onClick={() => setModalRef(true)} disabled={!sel.size}
              className="px-3 py-1.5 rounded-lg border-2 border-amber-300 bg-amber-50 text-amber-900 text-xs font-bold disabled:opacity-40 flex items-center gap-1.5">
              <Tags className="w-3.5 h-3.5" /> Renomear REF
            </button>
            <button onClick={() => setModalPreco(true)} disabled={!sel.size}
              className="px-3 py-1.5 rounded-lg border-2 border-emerald-300 bg-emerald-50 text-emerald-900 text-xs font-bold disabled:opacity-40 flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5" /> Preço em bloco
            </button>
            <button onClick={() => setModalDesc(true)} disabled={!sel.size}
              className="px-3 py-1.5 rounded-lg border-2 border-sky-300 bg-sky-50 text-sky-900 text-xs font-bold disabled:opacity-40 flex items-center gap-1.5">
              <ReplaceAll className="w-3.5 h-3.5" /> Substituir na descrição
            </button>
            <div className="flex-1" />
            {meta?.fonte === 'espelho' && (
              <span className="text-[10px] text-amber-600 font-semibold">Giga fora do ar — dados do espelho (marca pode faltar)</span>
            )}
          </div>
        )}

        {/* Tabela agrupada por REF */}
        {grupos.map(([ref, refRows]) => (
          <div key={ref} className="mb-4 bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-3 py-2 bg-slate-100 flex items-center gap-2">
              <input type="checkbox"
                checked={refRows.every((r) => sel.has(r.codigo))}
                onChange={() => toggleSelRef(refRows)}
                className="w-4 h-4 accent-amber-600" />
              <span className="font-mono font-black text-slate-800">{ref}</span>
              <span className="text-[11px] text-slate-500">{refRows.length} variação(ões)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
                    <th className="w-8" />
                    <th className="text-left px-2 py-1.5">SKU</th>
                    <th className="text-left px-2 py-1.5">REF</th>
                    <th className="text-left px-2 py-1.5 min-w-[280px]">Descrição</th>
                    <th className="text-left px-2 py-1.5">Marca</th>
                    <th className="text-left px-2 py-1.5">Cor</th>
                    <th className="text-left px-2 py-1.5">Tam</th>
                    <th className="text-right px-2 py-1.5">Preço (R$)</th>
                    <th className="text-right px-2 py-1.5">Est.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {refRows.map((r) => {
                    const dirty = pending.get(r.codigo) || {};
                    const cell = (field: keyof Changes, w: string, alignRight = false, maxLen?: number) => (
                      <input
                        value={val(r, field)}
                        maxLength={maxLen}
                        onChange={(e) => setField(r.codigo, field, e.target.value, r)}
                        className={`${w} px-2 py-1 rounded border text-sm font-medium ${
                          (dirty as any)[field] !== undefined
                            ? 'border-amber-400 bg-amber-50 text-amber-900'
                            : 'border-transparent bg-transparent hover:border-slate-200'
                        } focus:border-amber-400 focus:bg-white focus:outline-none ${alignRight ? 'text-right tabular-nums' : ''}`}
                      />
                    );
                    return (
                      <tr key={r.codigo} className={sel.has(r.codigo) ? 'bg-amber-50/40' : ''}>
                        <td className="px-2">
                          <input type="checkbox" checked={sel.has(r.codigo)} onChange={() => toggleSel(r.codigo)}
                            className="w-4 h-4 accent-amber-600" />
                        </td>
                        <td className="px-2 py-1 font-mono text-xs text-slate-500 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">{r.codigo} <Lock className="w-3 h-3 text-slate-300" /></span>
                        </td>
                        <td className="px-1 py-1">{cell('ref', 'w-28', false, LIMITS.ref)}</td>
                        <td className="px-1 py-1">{cell('descricao', 'w-full min-w-[280px]', false, LIMITS.descricao)}</td>
                        <td className="px-1 py-1">{cell('marca', 'w-28', false, LIMITS.marca)}</td>
                        <td className="px-1 py-1">{cell('cor', 'w-24', false, LIMITS.cor)}</td>
                        <td className="px-1 py-1">{cell('tamanho', 'w-16', false, LIMITS.tamanho)}</td>
                        <td className="px-1 py-1">{cell('preco', 'w-24', true)}</td>
                        <td className="px-2 py-1 text-right text-xs text-slate-500 tabular-nums">{r.estoque ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {!rows.length && !busy && !err && (
          <div className="text-center text-slate-400 text-sm py-16">
            Busca uma REF, código ou descrição pra começar.<br />
            <span className="text-xs">Ex.: <b>VMM-003</b> · <b>VESTIDO MARIE</b> · código bipado</span>
          </div>
        )}
      </main>

      {/* Barra fixa de salvar */}
      {nPend > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-30 bg-white border-t-2 border-amber-300 shadow-2xl">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
            <span className="text-sm font-semibold text-slate-700">
              {nPend} alteração(ões) pendente(s) em {pending.size} variação(ões)
            </span>
            <div className="flex-1" />
            <button onClick={() => { setPending(new Map()); setErr(''); }}
              className="px-4 py-2 rounded-xl border-2 border-slate-300 text-slate-600 text-sm font-bold">
              Descartar
            </button>
            <button onClick={montarPreview}
              className="px-5 py-2 rounded-xl text-white text-sm font-black flex items-center gap-2"
              style={{ background: '#B8912B' }}>
              Revisar e aplicar →
            </button>
          </div>
        </div>
      )}

      {/* ── Modal: Renomear REF ── */}
      {modalRef && (
        <Modal title="Renomear REF (padronizar)" onClose={() => setModalRef(false)}>
          <p className="text-xs text-slate-500 mb-2">
            As {sel.size} variações selecionadas passam a usar a REF nova. O SKU (código) não muda — etiquetas e bipe continuam funcionando.
          </p>
          <input value={novaRef} maxLength={10}
            onChange={(e) => setNovaRef(e.target.value.toUpperCase())}
            placeholder="REF nova (máx 10)"
            className="w-full px-3 py-2.5 border-2 border-slate-200 rounded-xl font-mono font-bold uppercase focus:border-amber-400 focus:outline-none" />
          {refColisao && refColisao.existentes > 0 && (
            <div className="mt-2 bg-amber-50 border border-amber-300 text-amber-900 px-3 py-2 rounded-lg text-xs">
              ⚠️ Já existem <b>{refColisao.existentes}</b> variações com a REF <b>{novaRef.trim().toUpperCase()}</b>
              {refColisao.exemploDescricao ? <> (ex.: {refColisao.exemploDescricao})</> : null}.
              Renomear vai <b>FUNDIR</b> com esse produto — confirme se é isso mesmo.
            </div>
          )}
          <ModalActions
            okLabel="Aplicar às selecionadas"
            okDisabled={!novaRef.trim()}
            onOk={aplicarRenomearRef}
            onCancel={() => setModalRef(false)}
          />
        </Modal>
      )}

      {/* ── Modal: Preço em bloco ── */}
      {modalPreco && (
        <Modal title="Preço em bloco" onClose={() => setModalPreco(false)}>
          <div className="flex gap-2 mb-3">
            <button onClick={() => setPrecoModo('fixar')}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold border-2 ${precoModo === 'fixar' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-500'}`}>
              Fixar valor (R$)
            </button>
            <button onClick={() => setPrecoModo('percentual')}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold border-2 ${precoModo === 'percentual' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-500'}`}>
              Ajuste percentual (%)
            </button>
          </div>
          <input value={precoValor}
            onChange={(e) => setPrecoValor(e.target.value)}
            placeholder={precoModo === 'fixar' ? 'Ex.: 129,90' : 'Ex.: -20 (baixa 20%) ou 10 (sobe 10%)'}
            inputMode="decimal"
            className="w-full px-3 py-2.5 border-2 border-slate-200 rounded-xl font-bold tabular-nums focus:border-emerald-400 focus:outline-none" />
          <p className="text-[11px] text-slate-500 mt-1.5">
            {precoModo === 'fixar'
              ? `Todas as ${sel.size} variações selecionadas ficam com esse preço (em REAIS).`
              : `Aplica o percentual sobre o preço atual de cada uma das ${sel.size} selecionadas.`}
          </p>
          <ModalActions
            okLabel="Calcular e revisar"
            okDisabled={!isFinite(parsePreco(precoValor))}
            onOk={aplicarPreco}
            onCancel={() => setModalPreco(false)}
          />
        </Modal>
      )}

      {/* ── Modal: Substituir na descrição ── */}
      {modalDesc && (
        <Modal title="Substituir na descrição (em bloco)" onClose={() => setModalDesc(false)}>
          <label className="text-[11px] font-bold uppercase text-slate-500">Localizar</label>
          <input value={descDe} onChange={(e) => setDescDe(e.target.value.toUpperCase())}
            placeholder="Ex.: MARRIE"
            className="w-full px-3 py-2.5 border-2 border-slate-200 rounded-xl font-semibold uppercase focus:border-sky-400 focus:outline-none mb-2" />
          <label className="text-[11px] font-bold uppercase text-slate-500">Substituir por</label>
          <input value={descPara} onChange={(e) => setDescPara(e.target.value.toUpperCase())}
            placeholder="Ex.: MARIE (vazio = remover)"
            className="w-full px-3 py-2.5 border-2 border-slate-200 rounded-xl font-semibold uppercase focus:border-sky-400 focus:outline-none" />
          <p className="text-[11px] text-slate-500 mt-1.5">
            Troca em todas as {sel.size} selecionadas que contêm o texto (sem diferenciar maiúsculas).
          </p>
          <ModalActions
            okLabel="Aplicar às selecionadas"
            okDisabled={!descDe.trim()}
            onOk={aplicarSubstituicao}
            onCancel={() => setModalDesc(false)}
          />
        </Modal>
      )}

      {/* ── Modal: PREVIEW ANTES→DEPOIS ── */}
      {preview && (
        <Modal title={`Revisar ${preview.length} alteração(ões)`} onClose={() => !applying && setPreview(null)} wide>
          <div className="max-h-[55vh] overflow-y-auto border border-slate-200 rounded-lg">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-100">
                <tr className="text-[10px] uppercase text-slate-500">
                  <th className="text-left px-2 py-1.5">SKU</th>
                  <th className="text-left px-2 py-1.5">REF</th>
                  <th className="text-left px-2 py-1.5">Campo</th>
                  <th className="text-left px-2 py-1.5">Antes</th>
                  <th className="text-left px-2 py-1.5">Depois</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.map((p, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1.5 font-mono text-slate-500">{p.codigo}</td>
                    <td className="px-2 py-1.5 font-mono">{p.ref}</td>
                    <td className="px-2 py-1.5 font-bold">{p.field}</td>
                    <td className="px-2 py-1.5 text-rose-700 line-through decoration-rose-300">{p.antes || '(vazio)'}</td>
                    <td className="px-2 py-1.5 text-emerald-700 font-semibold">{p.depois}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            Grava no <b>GIGA</b> (fonte da verdade) e reflete no Flow na hora. Tudo fica auditado (quem/quando/antes/depois).
          </p>
          <div className="flex gap-2 mt-3">
            <button onClick={() => setPreview(null)} disabled={applying}
              className="flex-1 px-4 py-3 rounded-xl border-2 border-slate-300 text-slate-600 font-bold text-sm">
              <X className="w-4 h-4 inline mr-1" /> Voltar
            </button>
            <button onClick={confirmarAplicar} disabled={applying}
              className="flex-[2] px-4 py-3 rounded-xl text-white font-black text-sm flex items-center justify-center gap-2"
              style={{ background: '#2E7D46' }}>
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Confirmar e gravar
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose, wide }: {
  title: string; children: React.ReactNode; onClose: () => void; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`bg-white rounded-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-md'} p-5 shadow-2xl`}>
        <h2 className="font-bold text-slate-800 mb-3">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function ModalActions({ okLabel, okDisabled, onOk, onCancel }: {
  okLabel: string; okDisabled?: boolean; onOk: () => void; onCancel: () => void;
}) {
  return (
    <div className="flex gap-2 mt-4">
      <button onClick={onCancel}
        className="flex-1 px-4 py-2.5 rounded-xl border-2 border-slate-300 text-slate-600 font-bold text-sm">
        Cancelar
      </button>
      <button onClick={onOk} disabled={okDisabled}
        className="flex-[2] px-4 py-2.5 rounded-xl text-white font-black text-sm disabled:opacity-40"
        style={{ background: '#B8912B' }}>
        {okLabel}
      </button>
    </div>
  );
}
