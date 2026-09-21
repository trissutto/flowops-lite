'use client';

/**
 * /loja/pedidos-compra/vitalicios — a aba "Vitalícios" de PEDIDOS (21/09/2026).
 *
 * Pedido do dono: uma tela pra decidir a compra das peças que a rede SEMPRE
 * repõe. Mostra, por REF vitalícia e cor, a grade TENHO · MÍNIMO · IDEAL ·
 * COMPRAR e gera, com um clique, UM PEDIDO POR MARCA em rascunho — que cai na
 * lista de PEDIDOS igual ao lançado à mão (o PDF de sempre vai pro WhatsApp do
 * representante).
 *
 * Decisões dele (duas rodadas de perguntas):
 *  - VITALÍCIO é a REF inteira; mínimo e IDEAL por cor e tamanho, total da
 *    rede (os mesmos da matriz da ficha do produto);
 *  - TENHO = estoque da rede inteira (franquias inclusive) + peças em
 *    trânsito entre lojas + o que já foi pedido e não chegou;
 *  - entra no pedido TODO tamanho abaixo do IDEAL; peça avulsa, sem arredondar.
 *
 * A conta mora no servidor (`common/compra-vitalicios.ts`) — esta tela só
 * mostra, deixa ajustar e manda. O COMPRAR ajustado aqui vale só pro pedido
 * que vai sair: não mexe no IDEAL.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, CheckCircle2, FileText, Loader2, Plus, Repeat, Save, Search, ShoppingCart, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { PoShell } from '../PoShell';

type Situacao = 'sem_ideal' | 'abaixo_minimo' | 'abaixo_ideal' | 'ok' | 'encalhe';

type Celula = {
  tamanho: string;
  estoque: number;
  transito: number;
  emPedido: number;
  pedidos: Array<{ numero: number; qtd: number }>;
  minimo: number | null;
  ideal: number | null;
  tenho: number;
  comprar: number | null;
  situacao: Situacao;
};

type Cor = {
  cor: string;
  situacao: Situacao;
  comprar: number;
  custoUnit: number | null;
  precoUnit: number | null;
  tamanhos: Celula[];
};

type RefVit = {
  ref: string;
  marca: string;
  descricao: string;
  grupo: string | null;
  marcadoPor: string | null;
  marcadoEm: string;
  situacao: Situacao;
  comprar: number;
  custoComprar: number;
  cores: Cor[];
  /** Cor sem estoque, trânsito, pedido nem mínimo/ideal — com a grade e os valores dela. */
  coresSemMovimento: Array<{ cor: string; tamanhos: string[]; custoUnit: number | null; precoUnit: number | null }>;
};

type Resposta = { refs: RefVit[]; marcas: string[]; geradoEm: string };

type ResultadoGeracao = {
  pedidos: Array<{ id: string; numero: number; marca: string; fornecedorNome: string; pecas: number; totalCusto: number; semCnpj: boolean }>;
  ignorados: Array<{ ref: string; marca: string; cor: string; motivo: string }>;
  erros: Array<{ marca: string; erro: string }>;
};

type Achado = { ref: string; marca: string; descricao: string; cores: string[]; vitalicio: boolean };

const SIT: Record<Situacao, { label: string; badge: string; cell: string }> = {
  abaixo_minimo: { label: 'Abaixo do mínimo', badge: 'bg-rose-100 text-rose-800 border-rose-300', cell: 'bg-rose-50 text-rose-800' },
  abaixo_ideal: { label: 'Abaixo do ideal', badge: 'bg-amber-100 text-amber-800 border-amber-300', cell: 'bg-amber-50 text-amber-800' },
  encalhe: { label: 'Encalhe', badge: 'bg-slate-200 text-slate-700 border-slate-300', cell: 'bg-slate-100 text-slate-500' },
  ok: { label: 'OK', badge: 'bg-emerald-100 text-emerald-800 border-emerald-300', cell: 'bg-emerald-50 text-emerald-700' },
  sem_ideal: { label: 'Sem ideal', badge: 'bg-slate-100 text-slate-500 border-slate-300', cell: 'text-slate-400' },
};

const GRADE_DA_CASA = ['46', '48', '50', '52', '54', '56', '58', '60'];

const brl = (n: number) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const kRef = (ref: string, marca: string) => `${ref}|${marca}`;
const kCor = (ref: string, marca: string, cor: string) => `${ref}|${marca}|${cor}`;
const kTam = (ref: string, marca: string, cor: string, tam: string) => `${ref}|${marca}|${cor}|${tam}`;
const soDigitos = (v: string) => v.replace(/\D/g, '').slice(0, 3);

/** Mensagem do servidor (Nest devolve `{ message }`), sem o "400:" na frente. */
function msgErro(e: any, padrao: string): string {
  const m = e?.body?.message;
  if (typeof m === 'string' && m.trim()) return m;
  if (Array.isArray(m) && m.length) return String(m[0]);
  return e?.message || padrao;
}

export default function VitaliciosPage() {
  const router = useRouter();
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [busca, setBusca] = useState('');
  const [buscaDeb, setBuscaDeb] = useState('');
  const [marca, setMarca] = useState('');
  const [situacao, setSituacao] = useState<'' | Situacao>('');

  /** COMPRAR ajustado à mão, por célula ("" = zero, ausente = o calculado). */
  const [ajustes, setAjustes] = useState<Record<string, string>>({});
  /** Mínimo/IDEAL digitados e ainda não salvos, por cor → tamanho. */
  const [rascunho, setRascunho] = useState<Record<string, Record<string, { minimo?: string; ideal?: string }>>>({});
  const [salvandoCor, setSalvandoCor] = useState<string | null>(null);
  /** Cores sem movimento que a pessoa abriu pra configurar. */
  const [coresAbertas, setCoresAbertas] = useState<Record<string, string[]>>({});

  const [gerando, setGerando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoGeracao | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [adicionando, setAdicionando] = useState(false);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) router.push('/login?redirect=/loja/pedidos-compra/vitalicios');
  }, [router]);

  useEffect(() => {
    const t = setTimeout(() => setBuscaDeb(busca), 350);
    return () => clearTimeout(t);
  }, [busca]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const qs = new URLSearchParams();
      if (marca) qs.set('marca', marca);
      if (buscaDeb.trim()) qs.set('busca', buscaDeb.trim());
      const r = await api<Resposta>(`/compras-vitalicios?${qs}`);
      setDados(r);
    } catch (e: any) {
      setErro(msgErro(e, 'Não deu pra carregar os vitalícios'));
    } finally {
      setCarregando(false);
    }
  }, [marca, buscaDeb]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const refs = useMemo(
    () => (dados?.refs || []).filter((r) => !situacao || r.situacao === situacao || r.cores.some((c) => c.situacao === situacao)),
    [dados, situacao],
  );

  /**
   * As cores da REF na tela: as que têm movimento + as sem movimento que a
   * pessoa abriu pra configurar (somem no recarregar se continuarem sem ideal).
   */
  const coresDaRef = useCallback(
    (r: RefVit): Cor[] => {
      const abertas = coresAbertas[kRef(r.ref, r.marca)] || [];
      return [
        ...r.cores,
        ...r.coresSemMovimento
          .filter((s) => abertas.includes(s.cor))
          .map<Cor>((s) => ({
            cor: s.cor,
            situacao: 'sem_ideal',
            comprar: 0,
            custoUnit: s.custoUnit ?? null,
            precoUnit: s.precoUnit ?? null,
            tamanhos: (s.tamanhos.length ? s.tamanhos : GRADE_DA_CASA).map((t) => ({
              tamanho: t, estoque: 0, transito: 0, emPedido: 0, pedidos: [], minimo: null, ideal: null, tenho: 0, comprar: null, situacao: 'sem_ideal' as Situacao,
            })),
          })),
      ];
    },
    [coresAbertas],
  );

  /** O COMPRAR que vale pra célula: o ajuste da tela ganha do calculado. */
  const qtdDe = useCallback(
    (r: RefVit, c: Cor, cel: Celula): number => {
      const a = ajustes[kTam(r.ref, r.marca, c.cor, cel.tamanho)];
      if (a !== undefined) return Number(a || 0);
      return cel.comprar ?? 0;
    },
    [ajustes],
  );

  /**
   * O que vai virar pedido, agrupado por marca (só o que está na tela).
   *
   * `fora` = peça de cor sem custo ou sem preço: o servidor não põe linha de
   * R$ 0 no pedido (devolve em "ignorados"), então a tela já avisa ANTES e
   * não conta essas peças no total.
   */
  const porMarca = useMemo(() => {
    const m = new Map<string, { marca: string; pecas: number; fora: number; custo: number; itens: Array<{ ref: string; marca: string; cor: string; tamanhos: Record<string, number> }> }>();
    for (const r of refs) {
      for (const c of coresDaRef(r)) {
        const tamanhos: Record<string, number> = {};
        let pecas = 0;
        for (const cel of c.tamanhos) {
          const q = qtdDe(r, c, cel);
          if (q > 0) {
            tamanhos[cel.tamanho] = q;
            pecas += q;
          }
        }
        if (!pecas) continue;
        const g = m.get(r.marca) || { marca: r.marca, pecas: 0, fora: 0, custo: 0, itens: [] };
        if ((c.custoUnit || 0) > 0 && (c.precoUnit || 0) > 0) {
          g.pecas += pecas;
          g.custo += pecas * (c.custoUnit || 0);
        } else {
          g.fora += pecas;
        }
        g.itens.push({ ref: r.ref, marca: r.marca, cor: c.cor, tamanhos });
        m.set(r.marca, g);
      }
    }
    return [...m.values()].sort((a, b) => b.pecas - a.pecas || b.fora - a.fora);
  }, [refs, qtdDe, coresDaRef]);

  const totalPecas = porMarca.reduce((s, g) => s + g.pecas, 0);
  const totalCusto = porMarca.reduce((s, g) => s + g.custo, 0);

  const gerar = async (marcas: string[]) => {
    const grupos = porMarca.filter((g) => marcas.includes(g.marca));
    const itens = grupos.flatMap((g) => g.itens);
    const nPedidos = grupos.filter((g) => g.pecas > 0).length;
    if (!itens.length || !nPedidos || gerando) return;
    const resumo = grupos
      .map((g) =>
        [
          g.pecas ? `${g.marca}: ${g.pecas} peças (${brl(g.custo)})` : `${g.marca}: nenhum pedido`,
          g.fora ? `   ${g.fora} peça(s) sem custo ou preço ficam FORA — lance à mão no pedido` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n');
    if (!confirm(`Gerar ${nPedidos} pedido(s) em RASCUNHO?\n\n${resumo}\n\nDepois é só abrir o PDF e mandar pro representante.`)) return;
    setGerando(true);
    setAviso(null);
    try {
      const r = await api<ResultadoGeracao>('/compras-vitalicios/gerar-pedidos', {
        method: 'POST',
        body: JSON.stringify({ itens }),
      });
      setResultado(r);
      // Os ajustes dessas marcas viraram pedido: a tela volta ao calculado.
      setAjustes((prev) => {
        const n = { ...prev };
        for (const key of Object.keys(n)) if (marcas.includes(key.split('|')[1])) delete n[key];
        return n;
      });
      await carregar();
    } catch (e: any) {
      setAviso({ tipo: 'erro', texto: msgErro(e, 'Não deu pra gerar o pedido') });
    } finally {
      setGerando(false);
    }
  };

  const valorCfg = (r: RefVit, cor: string, cel: Pick<Celula, 'tamanho' | 'minimo' | 'ideal'>, campo: 'minimo' | 'ideal'): string => {
    const rasc = rascunho[kCor(r.ref, r.marca, cor)]?.[cel.tamanho]?.[campo];
    if (rasc !== undefined) return rasc;
    const v = campo === 'minimo' ? cel.minimo : cel.ideal;
    return v === null || v === undefined ? '' : String(v);
  };

  const digitarCfg = (r: RefVit, cor: string, tam: string, campo: 'minimo' | 'ideal', v: string) => {
    const kc = kCor(r.ref, r.marca, cor);
    setRascunho((prev) => ({ ...prev, [kc]: { ...(prev[kc] || {}), [tam]: { ...(prev[kc]?.[tam] || {}), [campo]: soDigitos(v) } } }));
  };

  /**
   * Grava o mínimo/IDEAL da cor pela MESMA rota da matriz da ficha. Manda os
   * DOIS campos de cada tamanho mexido — a rota trata tamanho sem campo
   * nenhum como "não mexer", e mandar só um poderia apagar o outro.
   */
  const salvarCfg = async (r: RefVit, cor: string, celulas: Array<Pick<Celula, 'tamanho' | 'minimo' | 'ideal'>>) => {
    const kc = kCor(r.ref, r.marca, cor);
    const rasc = rascunho[kc] || {};
    const tamanhos = Object.keys(rasc).map((tam) => {
      const cel = celulas.find((c) => c.tamanho === tam) || { tamanho: tam, minimo: null, ideal: null };
      const min = valorCfg(r, cor, cel, 'minimo');
      const ide = valorCfg(r, cor, cel, 'ideal');
      return { tamanho: tam, minimoTotal: min === '' ? null : Number(min), idealTotal: ide === '' ? null : Number(ide) };
    });
    const invertido = tamanhos.find((t) => t.minimoTotal !== null && t.idealTotal !== null && t.idealTotal < t.minimoTotal);
    if (invertido) {
      setAviso({ tipo: 'erro', texto: `${r.ref} ${cor} ${invertido.tamanho}: o ideal não pode ser menor que o mínimo.` });
      return;
    }
    if (!tamanhos.length) return;
    setSalvandoCor(kc);
    setAviso(null);
    try {
      const qs = new URLSearchParams({ ref: r.ref, marca: r.marca, cor });
      await api(`/produto-ficha/reposicao?${qs}`, { method: 'PUT', body: JSON.stringify({ tamanhos }) });
      setRascunho((prev) => {
        const n = { ...prev };
        delete n[kc];
        return n;
      });
      setAviso({ tipo: 'ok', texto: `Mínimo e ideal de ${r.ref} ${cor} salvos.` });
      await carregar();
    } catch (e: any) {
      const m = msgErro(e, 'Não deu pra salvar');
      setAviso({ tipo: 'erro', texto: /403|admin/i.test(m) ? 'Só administrador grava mínimo e ideal.' : m });
    } finally {
      setSalvandoCor(null);
    }
  };

  const desmarcar = async (r: RefVit) => {
    if (!confirm(`Tirar a REF ${r.ref} (${r.marca}) dos vitalícios?\n\nO mínimo e o ideal ficam guardados na ficha do produto.`)) return;
    try {
      await api('/compras-vitalicios/desmarcar', { method: 'POST', body: JSON.stringify({ itens: [{ ref: r.ref, marca: r.marca }] }) });
      await carregar();
    } catch (e: any) {
      setAviso({ tipo: 'erro', texto: msgErro(e, 'Não deu pra desmarcar') });
    }
  };

  const CEL = 'px-1.5 py-1 text-center tabular-nums text-xs';
  const CAIXA =
    'w-11 px-1 py-0.5 text-center text-xs tabular-nums font-bold rounded border focus:outline-none focus:ring-2';

  return (
    <PoShell
      crumbs={[{ label: 'Loja', href: '/loja' }, { label: 'Pedidos de compra', href: '/loja/pedidos-compra' }, { label: 'Vitalícios' }]}
      activeNav="Vitalícios"
    >
      <div className="po-page-head">
        <div className="po-page-icon">
          <Repeat className="w-6 h-6" />
        </div>
        <h1 className="po-page-title">Vitalícios</h1>
        <span className="po-page-badge">{dados?.refs.length ?? 0} REF{(dados?.refs.length ?? 0) === 1 ? '' : 's'}</span>
        <div className="po-page-actions">
          <button type="button" className="po-btn-secondary !inline-flex items-center gap-1.5" onClick={() => setAdicionando(true)}>
            <Plus className="w-4 h-4" />
            Adicionar vitalício
          </button>
          <button
            type="button"
            className="po-save-button disabled:opacity-50"
            disabled={!totalPecas || gerando}
            onClick={() => void gerar(porMarca.map((g) => g.marca))}
            title="Um pedido por marca, em rascunho, na lista de PEDIDOS"
          >
            {gerando ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShoppingCart className="w-4 h-4" />}
            Gerar pedidos · {totalPecas} peças · {brl(totalCusto)}
          </button>
        </div>
      </div>

      <p className="text-xs text-[#5c6778] leading-relaxed -mt-2">
        <b>TENHO</b> = estoque da rede inteira (franquias inclusive) + peças em trânsito entre lojas + o que já foi pedido e
        não chegou. <b>COMPRAR</b> = IDEAL − TENHO, em todo tamanho abaixo do ideal. O COMPRAR pode ser ajustado antes de
        gerar — vale só pro pedido, não muda o ideal.
      </p>

      <div className="flex gap-2 text-sm">
        <Link href="/loja/pedidos-compra" className="px-3 py-1.5 rounded-lg border border-[#e4e8ee] bg-white text-[#5c6778] hover:border-[#d3ac52]">
          Pedidos
        </Link>
        <span className="px-3 py-1.5 rounded-lg border border-[#16263d] bg-[#16263d] text-white font-bold">Vitalícios</span>
      </div>

      {aviso && (
        <div
          className={`rounded-xl p-3 text-sm flex items-start gap-2 border ${
            aviso.tipo === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          {aviso.tipo === 'ok' ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          <span className="flex-1">{aviso.texto}</span>
          <button type="button" onClick={() => setAviso(null)} aria-label="Fechar aviso"><X className="w-4 h-4" /></button>
        </div>
      )}

      {resultado && (
        <div className="po-panel !p-4 space-y-2 border-2 !border-emerald-300">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            <div className="font-bold text-[#16233a]">
              {resultado.pedidos.length
                ? `${resultado.pedidos.length} pedido(s) gerado(s) em rascunho`
                : 'Nenhum pedido gerado'}
            </div>
            <button type="button" className="ml-auto" onClick={() => setResultado(null)} aria-label="Fechar"><X className="w-4 h-4" /></button>
          </div>
          {resultado.pedidos.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm bg-white border border-[#e4e8ee] rounded-lg px-3 py-2">
              <span className="font-black text-[#16233a]">#{p.numero}</span>
              <span className="font-bold">{p.marca}</span>
              <span className="text-[#5c6778]">{p.fornecedorNome}</span>
              <span className="tabular-nums">{p.pecas} peças · {brl(p.totalCusto)}</span>
              {p.semCnpj && (
                <span className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-300 rounded px-1.5 py-0.5">
                  sem CNPJ do fornecedor — confira no pedido antes de receber
                </span>
              )}
              <span className="ml-auto flex gap-2">
                <Link href={`/loja/pedidos-compra/${p.id}`} className="po-btn-secondary !min-h-[32px] !py-1 !px-3 !text-xs">Abrir pedido</Link>
                <Link href={`/loja/pedidos-compra/${p.id}/imprimir`} className="po-save-button !min-h-[32px] !py-1 !px-3 !text-xs">
                  <FileText className="w-3.5 h-3.5" /> PDF
                </Link>
              </span>
            </div>
          ))}
          {resultado.ignorados.map((i, n) => (
            <div key={`ig-${n}`} className="text-xs text-amber-800">
              ⚠ {i.ref} {i.cor} ({i.marca}) ficou fora: {i.motivo}
            </div>
          ))}
          {resultado.erros.map((e, n) => (
            <div key={`er-${n}`} className="text-xs text-rose-700">✖ {e.marca}: {e.erro}</div>
          ))}
        </div>
      )}

      <div className="po-panel !p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#a6afbd]" />
          <input
            type="text"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar REF ou descrição..."
            className="po-input !pl-9"
          />
        </div>
        <select value={marca} onChange={(e) => setMarca(e.target.value)} className="po-select !w-auto min-w-[160px]">
          <option value="">Todas as marcas</option>
          {(dados?.marcas || []).map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select value={situacao} onChange={(e) => setSituacao(e.target.value as any)} className="po-select !w-auto min-w-[170px]">
          <option value="">Todas as situações</option>
          {(['abaixo_minimo', 'abaixo_ideal', 'encalhe', 'ok', 'sem_ideal'] as Situacao[]).map((s) => (
            <option key={s} value={s}>{SIT[s].label}</option>
          ))}
        </select>
      </div>

      {porMarca.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {porMarca.map((g) => (
            <div key={g.marca} className="bg-white border border-[#e4e8ee] rounded-xl px-3 py-2 flex items-center gap-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-[#8a94a3]">{g.marca}</div>
                <div className="text-sm font-bold text-[#16233a] tabular-nums">
                  {g.pecas ? <>{g.pecas} peças · {brl(g.custo)}</> : 'nenhuma peça com custo'}
                </div>
                {g.fora > 0 && (
                  <div className="text-[11px] font-bold text-amber-700" title="Cor sem custo ou sem preço de venda: não entra no pedido automático — lance à mão no pedido">
                    + {g.fora} sem custo/preço (fica fora)
                  </div>
                )}
              </div>
              <button
                type="button"
                className="po-btn-secondary !min-h-[32px] !py-1 !px-3 !text-xs disabled:opacity-50"
                disabled={gerando || !g.pecas}
                onClick={() => void gerar([g.marca])}
              >
                Gerar só esta
              </button>
            </div>
          ))}
        </div>
      )}

      <main className="space-y-3">
        {carregando && !dados ? (
          <div className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-[#c19a2e] mx-auto" />
          </div>
        ) : erro ? (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-4">
            <AlertCircle className="w-5 h-5 inline mr-2" />
            {erro}
          </div>
        ) : !refs.length ? (
          <div className="po-panel !p-12 text-center">
            <Repeat className="w-12 h-12 text-[#c9cfd8] mx-auto" />
            <div className="text-base font-bold text-[#16233a] mt-3">
              {dados?.refs.length ? 'Nada com esse filtro' : 'Nenhuma REF vitalícia ainda'}
            </div>
            <div className="text-xs text-[#8a94a3] mt-1">
              Marque as peças que a rede sempre repõe em "Adicionar vitalício" (ou no botão ☆ da matriz, na ficha do produto).
            </div>
          </div>
        ) : (
          refs.map((r) => (
            <section key={kRef(r.ref, r.marca)} className="bg-white border border-[#e4e8ee] rounded-2xl shadow-[0_1px_2px_rgba(16,24,40,.04)]">
              <header className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[#eef1f5]">
                <span className="font-black text-[#16233a]">REF {r.ref}</span>
                <span className="text-sm text-[#5c6778] truncate max-w-[340px]" title={r.descricao}>{r.descricao}</span>
                <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">{r.marca}</span>
                {r.grupo && <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{r.grupo}</span>}
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${SIT[r.situacao].badge}`}>{SIT[r.situacao].label}</span>
                <span className="ml-auto text-sm tabular-nums">
                  comprar <b>{r.comprar}</b> peças{r.custoComprar ? <> · <b>{brl(r.custoComprar)}</b></> : null}
                </span>
                <button
                  type="button"
                  onClick={() => void desmarcar(r)}
                  className="p-1.5 rounded hover:bg-rose-50 text-rose-500"
                  title="Tirar dos vitalícios"
                  aria-label={`Tirar ${r.ref} dos vitalícios`}
                >
                  <X className="w-4 h-4" />
                </button>
              </header>

              <div className="p-3 space-y-3">
                {coresDaRef(r).map((c) => {
                  const kc = kCor(r.ref, r.marca, c.cor);
                  const sujo = !!rascunho[kc] && Object.keys(rascunho[kc]).length > 0;
                  const pecasCor = c.tamanhos.reduce((s, cel) => s + qtdDe(r, c, cel), 0);
                  return (
                    <div key={kc} className="border border-[#eef1f5] rounded-xl overflow-x-auto">
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-[#f7f8fa] border-b border-[#eef1f5]">
                        <span className="font-bold text-[#16233a] text-sm">{c.cor}</span>
                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded border ${SIT[c.situacao].badge}`}>{SIT[c.situacao].label}</span>
                        <span className="text-xs text-[#5c6778] tabular-nums">
                          comprar <b>{pecasCor}</b>
                          {c.custoUnit ? <> · custo {brl(c.custoUnit)}</> : <> · <span className="text-amber-700 font-bold">sem custo</span></>}
                          {!c.precoUnit && <> · <span className="text-amber-700 font-bold">sem preço de venda</span></>}
                        </span>
                        {sujo && (
                          <button
                            type="button"
                            className="ml-auto po-save-button !min-h-[32px] !py-1 !px-3 !text-xs disabled:opacity-50"
                            disabled={salvandoCor === kc}
                            onClick={() => void salvarCfg(r, c.cor, c.tamanhos)}
                          >
                            {salvandoCor === kc ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            Salvar mínimo/ideal
                          </button>
                        )}
                      </div>
                      <table className="min-w-full">
                        <thead>
                          <tr className="text-[10px] uppercase text-[#8a94a3]">
                            <th className="px-2 py-1 text-left w-20" />
                            {c.tamanhos.map((cel) => (
                              <th key={cel.tamanho} className={CEL}>{cel.tamanho}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className="px-2 py-1 text-[10px] font-bold uppercase text-[#5c6778]">Tenho</td>
                            {c.tamanhos.map((cel) => (
                              <td
                                key={cel.tamanho}
                                className={`${CEL} font-bold ${cel.situacao === 'sem_ideal' ? 'text-[#16233a]' : SIT[cel.situacao].cell}`}
                                title={
                                  `Estoque na rede: ${cel.estoque}` +
                                  (cel.transito ? ` · em trânsito: ${cel.transito}` : '') +
                                  (cel.emPedido
                                    ? ` · já pedido: ${cel.emPedido} (${cel.pedidos.map((p) => `#${p.numero}: ${p.qtd}`).join(', ')})`
                                    : '')
                                }
                              >
                                {cel.tenho}
                                {(cel.transito > 0 || cel.emPedido > 0) && <span className="text-[9px] align-super text-violet-600">*</span>}
                              </td>
                            ))}
                          </tr>
                          {(['minimo', 'ideal'] as const).map((campo) => (
                            <tr key={campo}>
                              <td className="px-2 py-1 text-[10px] font-bold uppercase text-[#5c6778]">{campo === 'minimo' ? 'Mínimo' : 'Ideal'}</td>
                              {c.tamanhos.map((cel) => (
                                <td key={cel.tamanho} className={CEL}>
                                  <input
                                    inputMode="numeric"
                                    value={valorCfg(r, c.cor, cel, campo)}
                                    onChange={(e) => digitarCfg(r, c.cor, cel.tamanho, campo, e.target.value)}
                                    aria-label={`${campo === 'minimo' ? 'Mínimo' : 'Ideal'} ${r.ref} ${c.cor} ${cel.tamanho}`}
                                    className={`${CAIXA} border-amber-300 bg-amber-50 text-amber-900 focus:ring-amber-400`}
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                          <tr>
                            <td className="px-2 py-1 text-[10px] font-bold uppercase text-[#16233a]">Comprar</td>
                            {c.tamanhos.map((cel) => {
                              const key = kTam(r.ref, r.marca, c.cor, cel.tamanho);
                              const ajustado = ajustes[key] !== undefined;
                              return (
                                <td key={cel.tamanho} className={CEL}>
                                  <input
                                    inputMode="numeric"
                                    value={ajustado ? ajustes[key] : cel.comprar === null ? '' : String(cel.comprar)}
                                    placeholder={cel.comprar === null ? '—' : ''}
                                    onChange={(e) => setAjustes((prev) => ({ ...prev, [key]: soDigitos(e.target.value) }))}
                                    title={
                                      cel.comprar === null
                                        ? 'Sem IDEAL configurado — digite o ideal acima (ou uma quantidade aqui, só pra este pedido)'
                                        : ajustado
                                          ? `Ajustado à mão (o calculado era ${cel.comprar})`
                                          : 'IDEAL − TENHO'
                                    }
                                    aria-label={`Comprar ${r.ref} ${c.cor} ${cel.tamanho}`}
                                    className={`${CAIXA} ${
                                      ajustado
                                        ? 'border-violet-400 bg-violet-50 text-violet-900 focus:ring-violet-400'
                                        : 'border-emerald-300 bg-emerald-50 text-emerald-900 focus:ring-emerald-400'
                                    }`}
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  );
                })}

                {r.coresSemMovimento.filter((s) => !(coresAbertas[kRef(r.ref, r.marca)] || []).includes(s.cor)).length > 0 && (
                  <div className="text-xs text-[#8a94a3] flex flex-wrap items-center gap-1.5">
                    <span>Cores sem estoque, sem pedido e sem ideal:</span>
                    {r.coresSemMovimento
                      .map((s) => s.cor)
                      .filter((c) => !(coresAbertas[kRef(r.ref, r.marca)] || []).includes(c))
                      .map((c) => (
                        <button
                          key={c}
                          type="button"
                          className="px-1.5 py-0.5 rounded border border-[#e4e8ee] bg-white hover:border-[#d3ac52] text-[#5c6778]"
                          title="Abrir esta cor pra configurar mínimo e ideal"
                          onClick={() =>
                            setCoresAbertas((prev) => ({ ...prev, [kRef(r.ref, r.marca)]: [...(prev[kRef(r.ref, r.marca)] || []), c] }))
                          }
                        >
                          + {c}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </section>
          ))
        )}
      </main>

      {adicionando && (
        <ModalAdicionar
          onFechar={() => setAdicionando(false)}
          onMarcou={() => void carregar()}
        />
      )}
    </PoShell>
  );
}

/** "Adicionar vitalício": busca por REF ou descrição e marca a REF inteira. */
function ModalAdicionar({ onFechar, onMarcou }: { onFechar: () => void; onMarcou: () => void }) {
  const [q, setQ] = useState('');
  const [achados, setAchados] = useState<Achado[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [marcando, setMarcando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setAchados(null);
      return;
    }
    let vivo = true;
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await api<Achado[]>(`/compras-vitalicios/buscar?q=${encodeURIComponent(q.trim())}`);
        if (vivo) setAchados(r);
      } catch (e: any) {
        if (vivo) setErro(msgErro(e, 'Não deu pra buscar'));
      } finally {
        if (vivo) setBuscando(false);
      }
    }, 350);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [q]);

  const marcar = async (a: Achado) => {
    const k = kRef(a.ref, a.marca);
    setMarcando(k);
    setErro(null);
    try {
      await api('/compras-vitalicios/marcar', { method: 'POST', body: JSON.stringify({ itens: [{ ref: a.ref, marca: a.marca }] }) });
      setAchados((prev) => (prev || []).map((x) => (kRef(x.ref, x.marca) === k ? { ...x, vitalicio: true } : x)));
      onMarcou();
    } catch (e: any) {
      setErro(msgErro(e, 'Não deu pra marcar'));
    } finally {
      setMarcando(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 pt-[10vh]" onClick={onFechar}>
      <div
        className="w-full max-w-xl bg-white rounded-2xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Adicionar vitalício"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#eef1f5]">
          <Repeat className="w-5 h-5 text-[#c19a2e]" />
          <div className="font-bold text-[#16233a]">Adicionar vitalício</div>
          <button type="button" className="ml-auto" onClick={onFechar} aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="REF ou pedaço da descrição (ex.: 7031, casaco soft)"
            className="w-full rounded-lg border border-[#d9dee5] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#d3ac52]"
          />
          <p className="text-[11px] text-[#8a94a3]">A REF inteira entra: todas as cores e tamanhos dela.</p>
          {erro && <div className="text-xs text-rose-700">{erro}</div>}
          {buscando && <Loader2 className="w-5 h-5 animate-spin text-[#c19a2e]" />}
          <div className="max-h-[50vh] overflow-y-auto divide-y divide-[#eef1f5]">
            {(achados || []).map((a) => {
              const k = kRef(a.ref, a.marca);
              return (
                <div key={k} className="py-2 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-[#16233a]">
                      REF {a.ref} <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded ml-1">{a.marca}</span>
                    </div>
                    <div className="text-xs text-[#5c6778] truncate">{a.descricao}</div>
                    <div className="text-[11px] text-[#8a94a3] truncate">{a.cores.join(' · ')}</div>
                  </div>
                  {a.vitalicio ? (
                    <span className="text-xs font-bold text-emerald-700">★ vitalícia</span>
                  ) : (
                    <button
                      type="button"
                      className="po-save-button !min-h-[32px] !py-1 !px-3 !text-xs disabled:opacity-50"
                      disabled={marcando === k}
                      onClick={() => void marcar(a)}
                    >
                      {marcando === k ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      Marcar
                    </button>
                  )}
                </div>
              );
            })}
            {achados && !achados.length && !buscando && (
              <div className="py-6 text-center text-sm text-[#8a94a3]">Nenhuma peça com esse termo</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
