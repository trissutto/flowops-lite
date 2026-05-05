'use client';

/**
 * /retaguarda/cadastro-produtos — CADASTRO DINÂMICO DE PRODUTOS.
 *
 * Replica a tela legada do Wincred (Cadastro Dinâmico) com gravação direta
 * na tabela `produtos` do gigasistemas21 (Wincred).
 *
 * Fluxo:
 *   1. Usuário preenche o form principal (Grupo, SubGrupo, Ref, Fornecedor,
 *      Custo, Tributo, Preço, Margem, CFOP, Plus Size, NCM).
 *   2. Abre modais pra escolher Cores e Tamanhos (lista do Wincred + criar
 *      novos manualmente).
 *   3. Clica "Gerar" → backend devolve a matriz cor×tamanho com EAN-13
 *      gerado (prefixo 8) e descrição automática. Mostra na grid.
 *   4. Confere e clica "Processar Cadastro" → backend grava tudo no Wincred
 *      em transação MySQL (todos caem ou nada cai).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Package, Tags, Ruler, FolderOpen, Sparkles,
  Save, Trash2, AlertTriangle, X, Plus, Check,
} from 'lucide-react';
import { api } from '@/lib/api';

// ════════════════════════════════════════════════════════════════════════
// Tipos do contrato com o backend
// ════════════════════════════════════════════════════════════════════════

interface Grupo { codigo: number; nome: string; }
interface Subgrupo { codigo: number; nome: string; }
interface Fornecedor { cnpj: string; nome: string; }

interface CatalogoResp {
  grupos: Grupo[];
  cores: string[];
  tamanhos: string[];
  fornecedores: Fornecedor[];
}

interface ItemGerado {
  codigo: string;
  descricaoCompleta: string;
  descricaoPdv?: string;
  cor: string;
  tamanho: string;
  custo: number;
  precoVenda: number;
  margem: number;
  ref: string;
}

interface PreviewResp {
  seqInicial: string;
  total: number;
  itens: ItemGerado[];
}

interface ProcessarResp {
  inseridos: number;
  ignorados: number;
  total: number;
  seqInicial: string;
  seqFinal: string;
  itens: Array<{ codigo: string; descricaoCompleta: string; cor: string; tamanho: string }>;
}

// ════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════

function calcMargem(custo: number, preco: number): number {
  if (!custo || custo <= 0) return 0;
  return Math.round(((preco - custo) / custo) * 10000) / 100;
}

function calcPrecoFromMargem(custo: number, margem: number): number {
  if (!custo || custo <= 0) return 0;
  return Math.round((custo * (1 + margem / 100)) * 100) / 100;
}

function fmtMoeda(v: number): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ════════════════════════════════════════════════════════════════════════
// Page
// ════════════════════════════════════════════════════════════════════════

export default function CadastroProdutosPage() {
  const router = useRouter();
  const [carregandoCatalogo, setCarregandoCatalogo] = useState(true);
  const [catalogo, setCatalogo] = useState<CatalogoResp | null>(null);

  // Form principal
  const [grupoCodigo, setGrupoCodigo] = useState<number | null>(null);
  const [grupoNome, setGrupoNome] = useState('');
  const [subgrupoCodigo, setSubgrupoCodigo] = useState<number | null>(null);
  const [subgrupoNome, setSubgrupoNome] = useState('');
  const [ref, setRef] = useState('');
  const [plusSize, setPlusSize] = useState(true); // default true (LURDS é Plus Size)
  const [fornecedorCnpj, setFornecedorCnpj] = useState('');
  const [fornecedorNome, setFornecedorNome] = useState('');
  const [ncm, setNcm] = useState('61062000');
  const [custo, setCusto] = useState<number>(0);
  const [tributo, setTributo] = useState<string>('0');
  const [precoVenda, setPrecoVenda] = useState<number>(0);
  const [margem, setMargem] = useState<number>(0);
  const [cfop, setCfop] = useState<number>(5102);
  const [marca, setMarca] = useState('');

  // Cores/Tamanhos selecionados
  const [coresSelecionadas, setCoresSelecionadas] = useState<string[]>([]);
  const [tamanhosSelecionados, setTamanhosSelecionados] = useState<string[]>([]);

  // Modais abertos
  const [modal, setModal] = useState<'cores' | 'tamanhos' | 'grupos' | null>(null);

  // Resultado preview / processamento
  const [itensGerados, setItensGerados] = useState<ItemGerado[]>([]);
  const [seqInicial, setSeqInicial] = useState<string>('');
  const [gerando, setGerando] = useState(false);
  const [processando, setProcessando] = useState(false);
  const [erro, setErro] = useState<string>('');
  const [sucessoMsg, setSucessoMsg] = useState<string>('');

  // ─── Carrega catálogo no mount ───────────────────────────────
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) { router.push('/login'); return; }
    api<CatalogoResp>('/product-registration/catalogo')
      .then((data) => setCatalogo(data))
      .catch((e) => setErro(`Falha ao carregar catálogo: ${e?.message || e}`))
      .finally(() => setCarregandoCatalogo(false));
  }, [router]);

  // ─── Recalcula margem quando custo/preço mudam ──────────────
  useEffect(() => {
    if (custo > 0 && precoVenda > 0) setMargem(calcMargem(custo, precoVenda));
  }, [custo, precoVenda]);

  // ─── Subgrupos do grupo selecionado ─────────────────────────
  const [subgrupos, setSubgrupos] = useState<Subgrupo[]>([]);
  useEffect(() => {
    if (!grupoCodigo) { setSubgrupos([]); return; }
    api<Subgrupo[]>(`/product-registration/subgrupos/${grupoCodigo}`)
      .then(setSubgrupos)
      .catch(() => setSubgrupos([]));
  }, [grupoCodigo]);

  // ─── Ações ──────────────────────────────────────────────────

  const totalCombinacoes = useMemo(
    () => coresSelecionadas.length * tamanhosSelecionados.length,
    [coresSelecionadas.length, tamanhosSelecionados.length],
  );

  async function handleGerar() {
    setErro(''); setSucessoMsg('');
    if (!validarForm()) return;
    setGerando(true);
    try {
      const resp = await api<PreviewResp>('/product-registration/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      setItensGerados(resp.itens);
      setSeqInicial(resp.seqInicial);
    } catch (e: any) {
      setErro(`Erro ao gerar: ${e?.message || e}`);
    } finally {
      setGerando(false);
    }
  }

  async function handleProcessar() {
    setErro(''); setSucessoMsg('');
    if (!itensGerados.length) {
      setErro('Clique em "Gerar" antes de processar.');
      return;
    }
    if (!confirm(`Confirma o cadastro de ${itensGerados.length} produto(s) no Wincred? Não dá pra desfazer pelo flowops.`)) return;
    setProcessando(true);
    try {
      const resp = await api<ProcessarResp>('/product-registration/processar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      setSucessoMsg(`✓ ${resp.inseridos} produto(s) cadastrado(s) no Wincred (${resp.ignorados} já existiam). EANs ${resp.seqInicial} → ${resp.seqFinal}.`);
      setItensGerados([]);
      setCoresSelecionadas([]);
      setTamanhosSelecionados([]);
      setRef('');
    } catch (e: any) {
      setErro(`Erro ao processar: ${e?.message || e}`);
    } finally {
      setProcessando(false);
    }
  }

  function handleLimpar() {
    if (!confirm('Limpar todo o cadastro? Vai perder o que foi preenchido.')) return;
    setGrupoCodigo(null); setGrupoNome('');
    setSubgrupoCodigo(null); setSubgrupoNome('');
    setRef(''); setMarca('');
    setFornecedorCnpj(''); setFornecedorNome('');
    setCusto(0); setPrecoVenda(0); setMargem(0);
    setCoresSelecionadas([]); setTamanhosSelecionados([]);
    setItensGerados([]); setSeqInicial('');
    setErro(''); setSucessoMsg('');
  }

  function validarForm(): boolean {
    if (!grupoCodigo || !grupoNome) { setErro('Escolha um Grupo.'); return false; }
    if (!ref.trim()) { setErro('Informe a Referência.'); return false; }
    if (!fornecedorCnpj.trim()) { setErro('Escolha um Fornecedor.'); return false; }
    if (!custo || custo <= 0) { setErro('Custo precisa ser > 0.'); return false; }
    if (!precoVenda || precoVenda <= 0) { setErro('Preço de venda precisa ser > 0.'); return false; }
    if (!coresSelecionadas.length) { setErro('Escolha ao menos 1 cor.'); return false; }
    if (!tamanhosSelecionados.length) { setErro('Escolha ao menos 1 tamanho.'); return false; }
    return true;
  }

  function buildPayload() {
    return {
      grupoCodigo: grupoCodigo!,
      grupoNome: grupoNome.toUpperCase(),
      subgrupoCodigo: subgrupoCodigo ?? undefined,
      subgrupoNome: subgrupoNome ? subgrupoNome.toUpperCase() : undefined,
      ref: ref.trim().toUpperCase(),
      fornecedorCnpj: fornecedorCnpj.trim(),
      fornecedorNome: fornecedorNome.trim().toUpperCase() || undefined,
      custo,
      precoVenda,
      plusSize,
      ncm: ncm || undefined,
      cfop: cfop || undefined,
      tributo: tributo || undefined,
      marca: marca ? marca.toUpperCase() : undefined,
      cores: coresSelecionadas,
      tamanhos: tamanhosSelecionados,
    };
  }

  // ─── Render ─────────────────────────────────────────────────

  if (carregandoCatalogo) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400">
        Carregando catálogo Wincred…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-900">
            <ArrowLeft size={20} />
          </Link>
          <Package className="text-purple-600" size={22} />
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Cadastro Dinâmico de Produtos</h1>
            <p className="text-xs text-slate-500">Gera SKUs no Wincred (gigasistemas21) · EAN-13 prefixo 8</p>
          </div>
        </div>
      </header>

      {/* Mensagens */}
      <div className="max-w-7xl mx-auto px-4 pt-4 space-y-2">
        {erro && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 px-4 py-3 rounded-lg flex items-start gap-2">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <div className="text-sm">{erro}</div>
            <button onClick={() => setErro('')} className="ml-auto text-rose-400 hover:text-rose-700"><X size={16} /></button>
          </div>
        )}
        {sucessoMsg && (
          <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg flex items-start gap-2">
            <Check size={18} className="mt-0.5 shrink-0" />
            <div className="text-sm">{sucessoMsg}</div>
            <button onClick={() => setSucessoMsg('')} className="ml-auto text-green-400 hover:text-green-700"><X size={16} /></button>
          </div>
        )}
      </div>

      {/* Form principal */}
      <main className="max-w-7xl mx-auto px-4 py-4">
        <section className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Coluna 1 */}
            <div className="space-y-3">
              <FormRow label="Grupo">
                <div className="flex gap-2">
                  <select
                    value={grupoCodigo ?? ''}
                    onChange={(e) => {
                      const cod = Number(e.target.value);
                      const g = catalogo?.grupos.find((x) => x.codigo === cod);
                      setGrupoCodigo(cod || null);
                      setGrupoNome(g?.nome || '');
                      setSubgrupoCodigo(null); setSubgrupoNome('');
                    }}
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                  >
                    <option value="">— escolha —</option>
                    {catalogo?.grupos.map((g) => (
                      <option key={g.codigo} value={g.codigo}>{g.nome}</option>
                    ))}
                  </select>
                </div>
              </FormRow>

              <FormRow label="Sub Grupo">
                <select
                  value={subgrupoCodigo ?? ''}
                  onChange={(e) => {
                    const cod = Number(e.target.value);
                    const sg = subgrupos.find((x) => x.codigo === cod);
                    setSubgrupoCodigo(cod || null);
                    setSubgrupoNome(sg?.nome || '');
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                  disabled={!grupoCodigo}
                >
                  <option value="">— escolha —</option>
                  {subgrupos.map((sg) => (
                    <option key={sg.codigo} value={sg.codigo}>{sg.nome}</option>
                  ))}
                </select>
              </FormRow>

              <FormRow label="Referência">
                <div className="flex items-center gap-3">
                  <input
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm uppercase"
                    placeholder="ex: 13050"
                  />
                  <label className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={plusSize}
                      onChange={(e) => setPlusSize(e.target.checked)}
                      className="rounded"
                    />
                    Plus Size
                  </label>
                </div>
              </FormRow>

              <FormRow label="Fornecedor">
                <select
                  value={fornecedorCnpj}
                  onChange={(e) => {
                    const cnpj = e.target.value;
                    const f = catalogo?.fornecedores.find((x) => x.cnpj === cnpj);
                    setFornecedorCnpj(cnpj);
                    setFornecedorNome(f?.nome || cnpj);
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                >
                  <option value="">— escolha —</option>
                  {catalogo?.fornecedores.map((f) => (
                    <option key={f.cnpj} value={f.cnpj}>{f.nome}</option>
                  ))}
                </select>
              </FormRow>

              <FormRow label="Código NCM">
                <input
                  value={ncm}
                  onChange={(e) => setNcm(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                  placeholder="61062000"
                />
              </FormRow>

              <FormRow label="Marca (opcional)">
                <input
                  value={marca}
                  onChange={(e) => setMarca(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm uppercase"
                  placeholder="ex: LURDS"
                />
              </FormRow>
            </div>

            {/* Coluna 2 */}
            <div className="space-y-3">
              <FormRow label="Custo R$">
                <input
                  type="number"
                  step="0.01"
                  value={custo || ''}
                  onChange={(e) => setCusto(Number(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                />
              </FormRow>

              <FormRow label="Tributo %">
                <input
                  value={tributo}
                  onChange={(e) => setTributo(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                  placeholder="0"
                />
              </FormRow>

              <FormRow label="Preço R$">
                <input
                  type="number"
                  step="0.01"
                  value={precoVenda || ''}
                  onChange={(e) => setPrecoVenda(Number(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                />
              </FormRow>

              <FormRow label="Margem %">
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="0.01"
                    value={margem || ''}
                    onChange={(e) => {
                      const m = Number(e.target.value) || 0;
                      setMargem(m);
                      if (custo > 0) setPrecoVenda(calcPrecoFromMargem(custo, m));
                    }}
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                  />
                  <span className="px-3 py-2 text-xs text-slate-500 bg-slate-50 rounded-lg border border-slate-200 self-center">
                    auto
                  </span>
                </div>
              </FormRow>

              <FormRow label="CFOP">
                <input
                  type="number"
                  value={cfop || ''}
                  onChange={(e) => setCfop(Number(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                  placeholder="5102"
                />
              </FormRow>
            </div>
          </div>

          {/* Botões de ação principal */}
          <div className="mt-4 pt-4 border-t border-slate-200 flex flex-wrap gap-2 items-center">
            <button
              onClick={() => setModal('cores')}
              className="px-4 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-sm font-medium flex items-center gap-2"
            >
              <Tags size={16} />
              Cores ({coresSelecionadas.length})
            </button>
            <button
              onClick={() => setModal('tamanhos')}
              className="px-4 py-2 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-lg text-sm font-medium flex items-center gap-2"
            >
              <Ruler size={16} />
              Tamanhos ({tamanhosSelecionados.length})
            </button>

            <div className="text-sm text-slate-500 ml-2">
              {totalCombinacoes > 0 && <>Vai gerar <strong>{totalCombinacoes}</strong> SKU(s)</>}
            </div>

            <button
              onClick={handleGerar}
              disabled={gerando || !totalCombinacoes}
              className="ml-auto px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium flex items-center gap-2"
            >
              <Sparkles size={16} />
              {gerando ? 'Gerando…' : 'Gerar'}
            </button>
          </div>
        </section>

        {/* Grid de Produtos Gerados */}
        <section className="mt-4 bg-white border border-slate-200 rounded-xl shadow-sm">
          <div className="p-4 border-b border-slate-200 flex items-center gap-3">
            <FolderOpen size={18} className="text-purple-600" />
            <h2 className="font-semibold text-slate-900">Produtos Gerados</h2>
            {seqInicial && (
              <span className="text-xs text-slate-500">EAN inicial: {seqInicial}</span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                onClick={handleLimpar}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium flex items-center gap-1.5"
              >
                <Trash2 size={14} />
                Limpar
              </button>
              <button
                onClick={handleProcessar}
                disabled={processando || !itensGerados.length}
                className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold flex items-center gap-1.5"
              >
                <Save size={14} />
                {processando ? 'Processando…' : 'Processar Cadastro'}
              </button>
            </div>
          </div>

          {!itensGerados.length ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              Preencha o formulário, escolha cores/tamanhos e clique em <strong>Gerar</strong>.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2 text-left">Código (EAN-13)</th>
                    <th className="px-3 py-2 text-left">Descrição</th>
                    <th className="px-3 py-2 text-right">Custo</th>
                    <th className="px-3 py-2 text-right">Margem</th>
                    <th className="px-3 py-2 text-right">Preço</th>
                    <th className="px-3 py-2 text-left">Cor</th>
                    <th className="px-3 py-2 text-left">Tam.</th>
                    <th className="px-3 py-2 text-left">Ref</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {itensGerados.map((it) => (
                    <tr key={it.codigo} className="hover:bg-slate-50">
                      <td className="px-3 py-1.5 font-mono">{it.codigo}</td>
                      <td className="px-3 py-1.5">{it.descricaoCompleta}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtMoeda(it.custo)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtMoeda(it.margem)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{fmtMoeda(it.precoVenda)}</td>
                      <td className="px-3 py-1.5">{it.cor}</td>
                      <td className="px-3 py-1.5">{it.tamanho}</td>
                      <td className="px-3 py-1.5 font-mono">{it.ref}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {/* Modal de Cores */}
      {modal === 'cores' && (
        <ModalSelecao
          titulo="Cores"
          icone={<Tags size={18} className="text-rose-600" />}
          opcoesSugeridas={catalogo?.cores || []}
          selecionados={coresSelecionadas}
          onChange={setCoresSelecionadas}
          onClose={() => setModal(null)}
        />
      )}

      {/* Modal de Tamanhos */}
      {modal === 'tamanhos' && (
        <ModalSelecao
          titulo="Tamanhos"
          icone={<Ruler size={18} className="text-amber-600" />}
          opcoesSugeridas={catalogo?.tamanhos || []}
          selecionados={tamanhosSelecionados}
          onChange={setTamanhosSelecionados}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Componentes auxiliares
// ════════════════════════════════════════════════════════════════════════

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

interface ModalSelecaoProps {
  titulo: string;
  icone: React.ReactNode;
  opcoesSugeridas: string[];
  selecionados: string[];
  onChange: (s: string[]) => void;
  onClose: () => void;
}

function ModalSelecao({ titulo, icone, opcoesSugeridas, selecionados, onChange, onClose }: ModalSelecaoProps) {
  const [busca, setBusca] = useState('');
  const [novo, setNovo] = useState('');

  const opcoesFiltradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return opcoesSugeridas;
    return opcoesSugeridas.filter((o) => o.toLowerCase().includes(q));
  }, [busca, opcoesSugeridas]);

  function toggle(opt: string) {
    if (selecionados.includes(opt)) onChange(selecionados.filter((s) => s !== opt));
    else onChange([...selecionados, opt]);
  }

  function adicionarNovo() {
    const v = novo.trim().toUpperCase();
    if (!v) return;
    if (!selecionados.includes(v)) onChange([...selecionados, v]);
    setNovo('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[80vh] flex flex-col shadow-xl">
        <div className="p-4 border-b border-slate-200 flex items-center gap-2">
          {icone}
          <h3 className="font-semibold">{titulo}</h3>
          <span className="text-xs text-slate-500 ml-auto">{selecionados.length} selecionado(s)</span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>

        {/* Selecionados (chips) */}
        {selecionados.length > 0 && (
          <div className="px-4 py-2 border-b border-slate-200 flex flex-wrap gap-1.5">
            {selecionados.map((s) => (
              <span
                key={s}
                onClick={() => toggle(s)}
                className="px-2 py-0.5 bg-purple-100 text-purple-800 text-xs rounded-full cursor-pointer hover:bg-purple-200 flex items-center gap-1"
              >
                {s} <X size={10} />
              </span>
            ))}
          </div>
        )}

        {/* Adicionar novo */}
        <div className="p-3 border-b border-slate-200 flex gap-2">
          <input
            value={novo}
            onChange={(e) => setNovo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') adicionarNovo(); }}
            placeholder={`Digitar ${titulo.toLowerCase()} novo…`}
            className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm uppercase"
          />
          <button
            onClick={adicionarNovo}
            disabled={!novo.trim()}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-300 text-white rounded-lg text-sm flex items-center gap-1"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Busca + lista */}
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Filtrar sugestões…"
          className="mx-4 mt-3 px-3 py-1.5 border border-slate-300 rounded-lg text-sm"
        />
        <div className="flex-1 overflow-y-auto p-2">
          {!opcoesFiltradas.length ? (
            <div className="p-4 text-center text-xs text-slate-400">Sem sugestões. Use o campo acima pra adicionar.</div>
          ) : (
            <div className="grid grid-cols-2 gap-1">
              {opcoesFiltradas.map((opt) => (
                <button
                  key={opt}
                  onClick={() => toggle(opt)}
                  className={`px-3 py-1.5 text-xs rounded-lg border text-left ${
                    selecionados.includes(opt)
                      ? 'bg-purple-50 border-purple-400 text-purple-800 font-medium'
                      : 'bg-white border-slate-200 text-slate-700 hover:border-slate-400'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-slate-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
