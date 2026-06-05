'use client';

/**
 * /loja/pedidos-compra/novo — Criar novo pedido de compra.
 *
 * Estrutura:
 *  - Header: fornecedor (autocomplete Wincred), data prevista, NF, observações
 *  - Items: adiciona REF + descricao + categoria + grade cor×tamanho com qty
 *
 * Quando recebe a mercadoria depois, dispara auto-cadastro Wincred.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Plus, Trash2, Loader2, Save, Package,
  AlertCircle, Copy, X, Eye,
} from 'lucide-react';
import { api } from '@/lib/api';

type Fornecedor = { cnpj: string; nome: string; fantasia?: string };
type Grupo = { codigo: number; nome: string };
type Categoria = {
  descricaoBase: string;
  grupoCode: number;
  grupoNome: string;
  subgrupoCode: number;
  subgrupoNome: string;
  ncmDefault: string | null;
  cfopDefault: string | null;
  plusSizeDefault: boolean;
};

type ItemForm = {
  tempId: string;
  ref: string;
  descricaoBase: string;
  grupoCode: number | null;
  grupoNome: string;
  subgrupoCode: number | null;
  subgrupoNome: string;
  ncm: string;
  cfop: string;
  plusSize: boolean;
  custoUnit: string;
  precoUnit: string;
  tributoPct: string;
  descontoPct: string;
  markup: string; // markup proprio do item (sobrescreve o global)
  cores: string[];
  tamanhos: string[];
  // matriz: { "PRETO|46": 21, "PRETO|48": 21, ... }
  grade: Record<string, string>;
};

const TAMANHOS_PLUS = ['46', '48', '50', '52', '54', '56', '58', '60'];

// NCM padrao pra vestuario feminino (61062000 = camisas/blusas de malha algodao)
const NCM_DEFAULT = '61062000';

// Markup padrao POR TIPO de grade
const MARKUP_PLUS = '2.75';
const MARKUP_REGULAR = '2.35';

// Grades pre-prontas — clique pra aplicar (classes estaticas pra Tailwind JIT)
const GRADE_PRESETS: Array<{ id: string; label: string; tamanhos: string[]; plusSize: boolean; markup: string; clsActive: string; clsIdle: string }> = [
  {
    id: 'reg-letras', label: 'Reg Letras', tamanhos: ['P','M','G','GG','XGG'], plusSize: false, markup: MARKUP_REGULAR,
    clsActive: 'bg-sky-600 text-white border-sky-700',
    clsIdle: 'bg-white text-sky-700 border-sky-300 hover:bg-sky-50',
  },
  {
    id: 'reg-num', label: 'Reg Num', tamanhos: ['36','38','40','42','44','46','48'], plusSize: false, markup: MARKUP_REGULAR,
    clsActive: 'bg-emerald-600 text-white border-emerald-700',
    clsIdle: 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50',
  },
  {
    id: 'plus', label: 'Plus 46→60', tamanhos: ['46','48','50','52','54','56','58','60'], plusSize: true, markup: MARKUP_PLUS,
    clsActive: 'bg-violet-600 text-white border-violet-700',
    clsIdle: 'bg-white text-violet-700 border-violet-300 hover:bg-violet-50',
  },
  {
    id: 'plus-unif', label: 'Plus 46/48→60', tamanhos: ['46/48','50','52','54','56','58','60'], plusSize: true, markup: MARKUP_PLUS,
    clsActive: 'bg-fuchsia-600 text-white border-fuchsia-700',
    clsIdle: 'bg-white text-fuchsia-700 border-fuchsia-300 hover:bg-fuchsia-50',
  },
];

const newTempId = () => Math.random().toString(36).slice(2, 10);

export default function NovoPedidoPage() {
  const router = useRouter();

  // Lookups
  const [fornecedores, setFornecedores] = useState<Fornecedor[]>([]);
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);

  // Header
  const [fornecedorNome, setFornecedorNome] = useState('');
  const [fornecedorCnpj, setFornecedorCnpj] = useState('');
  const [marca, setMarca] = useState('');
  const [dataPrevista, setDataPrevista] = useState('');
  const [nfNumero, setNfNumero] = useState('');
  const [observacoes, setObservacoes] = useState('');
  const [showFornDropdown, setShowFornDropdown] = useState(false);
  // Markup global do pedido (default 2.5x = 250%) — persiste em localStorage
  const [markup, setMarkup] = useState<string>(() => {
    if (typeof window === 'undefined') return '2.5';
    return localStorage.getItem('pc:markup') || '2.5';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('pc:markup', markup);
  }, [markup]);

  // Items
  const [items, setItems] = useState<ItemForm[]>([]);

  // Estado
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Fornecedor[]>('/purchase-orders/lookups/fornecedores').then(setFornecedores).catch(() => {});
    api<Grupo[]>('/purchase-orders/lookups/grupos').then(setGrupos).catch(() => {});
    api<Categoria[]>('/purchase-orders/categorias').then(setCategorias).catch(() => {});
  }, []);

  // Refetch da lista de grupos (chamado após criar grupo novo inline)
  const refetchGrupos = async () => {
    try {
      const r = await api<Grupo[]>('/purchase-orders/lookups/grupos');
      setGrupos(r);
      return r;
    } catch {
      return [];
    }
  };

  const fornecedoresFiltered = useMemo(() => {
    // Filtra fornecedores que tem NOME real (ignora os que so tem CNPJ)
    const comNome = fornecedores.filter((f) => {
      const nome = (f.nome || '').trim();
      const cnpj = (f.cnpj || '').trim();
      if (!nome) return false;
      // Se nome === cnpj, e porque o banco nao tem nome cadastrado
      const semCnpj = nome.replace(/\D/g, '');
      const cnpjNum = cnpj.replace(/\D/g, '');
      if (semCnpj === cnpjNum && cnpjNum.length >= 11) return false;
      return true;
    });
    if (!fornecedorNome.trim()) {
      // Sem busca: ordena fornecedores com FANTASIA primeiro (sao os relevantes)
      const comFant = comNome.filter((f) => (f.fantasia || '').trim());
      const semFant = comNome.filter((f) => !(f.fantasia || '').trim());
      return [...comFant, ...semFant].slice(0, 100);
    }
    const q = fornecedorNome.trim().toUpperCase();
    // Busca prioritariamente em FANTASIA (= MARCA)
    return comNome
      .filter((f) =>
        (f.fantasia || '').toUpperCase().includes(q) ||
        f.nome.toUpperCase().includes(q),
      )
      .sort((a, b) => {
        // Itens cuja FANTASIA bate a busca vem primeiro
        const aFant = (a.fantasia || '').toUpperCase().includes(q) ? 0 : 1;
        const bFant = (b.fantasia || '').toUpperCase().includes(q) ? 0 : 1;
        return aFant - bFant;
      })
      .slice(0, 30);
  }, [fornecedores, fornecedorNome]);

  const escolherFornecedor = (f: Fornecedor) => {
    // FANTASIA = MARCA. Mostra fantasia no campo principal, e marca = fantasia.
    const fant = (f.fantasia || '').trim();
    const nomeReal = (f.nome || '').trim();
    setFornecedorNome(fant || nomeReal);
    setFornecedorCnpj(f.cnpj);
    setMarca(fant || nomeReal);
    setShowFornDropdown(false);
  };

  // Quando o user digita um nome que nao esta na lista, ja preenche MARCA automaticamente
  // (porque FANTASIA = MARCA = nome do fornecedor cadastrado livremente)
  const handleFornecedorBlur = () => {
    const digitado = fornecedorNome.trim().toUpperCase();
    if (digitado && !marca.trim()) {
      setMarca(digitado);
    }
  };

  const adicionarItem = () => {
    setItems((prev) => {
      // HERDA tudo do ultimo item: Grupo/Subgrupo/NCM/CFOP/PlusSize/Markup/Desc/Imp/Tamanhos
      // (REF, custo, preco, cores e qtys ficam em branco — sao especificos por peca)
      const last = prev[prev.length - 1];
      return [
        ...prev,
        {
          tempId: newTempId(),
          ref: '',
          descricaoBase: last?.descricaoBase ?? '',
          grupoCode: last?.grupoCode ?? null,
          grupoNome: last?.grupoNome ?? '',
          subgrupoCode: last?.subgrupoCode ?? null,
          subgrupoNome: last?.subgrupoNome ?? '',
          ncm: last?.ncm ?? '',
          cfop: last?.cfop || '5102',
          plusSize: last?.plusSize ?? true,
          custoUnit: '',
          precoUnit: '',
          tributoPct: last?.tributoPct ?? '0',
          descontoPct: last?.descontoPct ?? '0',
          markup: last?.markup ?? MARKUP_PLUS,
          cores: [],
          tamanhos: last?.tamanhos ? [...last.tamanhos] : [...TAMANHOS_PLUS],
          grade: {},
        },
      ];
    });
  };

  const removerItem = (tempId: string) => {
    setItems((prev) => prev.filter((i) => i.tempId !== tempId));
  };

  const duplicarItem = (tempId: string) => {
    const original = items.find((i) => i.tempId === tempId);
    if (!original) return;
    setItems((prev) => [...prev, { ...original, tempId: newTempId(), grade: { ...original.grade } }]);
  };

  const updateItem = (tempId: string, patch: Partial<ItemForm>) => {
    setItems((prev) => prev.map((i) => (i.tempId === tempId ? { ...i, ...patch } : i)));
  };

  // Quando muda descricaoBase, tenta auto-preencher categoria
  const aplicarCategoriaSeExistir = (tempId: string, descricao: string) => {
    const desc = descricao.trim().toUpperCase();
    if (!desc) return;
    const cat = categorias.find((c) => c.descricaoBase === desc);
    if (cat) {
      updateItem(tempId, {
        descricaoBase: desc,
        grupoCode: cat.grupoCode,
        grupoNome: cat.grupoNome,
        subgrupoCode: cat.subgrupoCode,
        subgrupoNome: cat.subgrupoNome,
        ncm: cat.ncmDefault || NCM_DEFAULT,
        cfop: cat.cfopDefault || '5102',
        plusSize: cat.plusSizeDefault,
      });
    }
  };

  const adicionarCor = (tempId: string, cor: string) => {
    const c = cor.trim().toUpperCase();
    if (!c) return;
    const item = items.find((i) => i.tempId === tempId);
    if (!item || item.cores.includes(c)) return;
    updateItem(tempId, { cores: [...item.cores, c] });
  };

  const removerCor = (tempId: string, cor: string) => {
    const item = items.find((i) => i.tempId === tempId);
    if (!item) return;
    const newGrade = { ...item.grade };
    for (const k of Object.keys(newGrade)) {
      if (k.startsWith(`${cor}|`)) delete newGrade[k];
    }
    updateItem(tempId, {
      cores: item.cores.filter((c) => c !== cor),
      grade: newGrade,
    });
  };

  const adicionarTamanho = (tempId: string, tam: string) => {
    const t = tam.trim().toUpperCase();
    if (!t) return;
    const item = items.find((i) => i.tempId === tempId);
    if (!item || item.tamanhos.includes(t)) return;
    updateItem(tempId, { tamanhos: [...item.tamanhos, t] });
  };

  const removerTamanho = (tempId: string, tam: string) => {
    const item = items.find((i) => i.tempId === tempId);
    if (!item) return;
    const newGrade = { ...item.grade };
    for (const k of Object.keys(newGrade)) {
      if (k.endsWith(`|${tam}`)) delete newGrade[k];
    }
    updateItem(tempId, {
      tamanhos: item.tamanhos.filter((t) => t !== tam),
      grade: newGrade,
    });
  };

  const setGradeCell = (tempId: string, cor: string, tam: string, valor: string) => {
    const item = items.find((i) => i.tempId === tempId);
    if (!item) return;
    const key = `${cor}|${tam}`;
    updateItem(tempId, {
      grade: { ...item.grade, [key]: valor.replace(/\D/g, '') },
    });
  };

  const calcularTotalItem = (item: ItemForm) => {
    let qty = 0;
    for (const c of item.cores) {
      for (const t of item.tamanhos) {
        qty += Number(item.grade[`${c}|${t}`] || 0);
      }
    }
    return qty;
  };

  const totalPecas = useMemo(
    () => items.reduce((s, i) => s + calcularTotalItem(i), 0),
    [items],
  );
  const totalCusto = useMemo(
    () =>
      items.reduce(
        (s, i) => s + calcularTotalItem(i) * (Number(i.custoUnit.replace(',', '.')) || 0),
        0,
      ),
    [items],
  );

  const salvar = async () => {
    setError(null);
    if (!fornecedorNome.trim()) {
      setError('Fornecedor obrigatório');
      return;
    }
    if (items.length === 0) {
      setError('Adicione ao menos 1 item');
      return;
    }
    // Valida cada item
    for (const it of items) {
      if (!it.ref.trim()) {
        setError(`Item sem REF`);
        return;
      }
      if (!it.grupoCode || !it.subgrupoCode) {
        setError(`REF ${it.ref}: Grupo e Subgrupo obrigatórios pra montar a descrição`);
        return;
      }
      if (!it.custoUnit || !it.precoUnit) {
        setError(`REF ${it.ref}: Custo e Preço obrigatórios`);
        return;
      }
      if (it.cores.length === 0 || it.tamanhos.length === 0) {
        setError(`REF ${it.ref}: adicione cores e tamanhos`);
        return;
      }
      if (calcularTotalItem(it) === 0) {
        setError(`REF ${it.ref}: total = 0, informe quantidades na grade`);
        return;
      }
    }

    setSaving(true);
    try {
      // Salva novas categorias (se grupo+subgrupo ainda não existirem)
      for (const it of items) {
        const descBase = `${it.grupoNome} ${it.subgrupoNome}`.trim().toUpperCase();
        const exists = categorias.find((c) => c.descricaoBase === descBase);
        if (!exists && it.grupoCode && it.subgrupoCode) {
          try {
            await api('/purchase-orders/categorias', {
              method: 'POST',
              body: JSON.stringify({
                descricaoBase: descBase,
                grupoCode: it.grupoCode,
                grupoNome: it.grupoNome,
                subgrupoCode: it.subgrupoCode,
                subgrupoNome: it.subgrupoNome,
                ncmDefault: it.ncm || null,
                cfopDefault: it.cfop || '5102',
                plusSizeDefault: it.plusSize,
              }),
            });
          } catch {
            // Não bloqueia salvar pedido se categoria falhar
          }
        }
      }

      // Monta items pro POST: 1 ItemForm pode virar VÁRIOS items (1 por cor)
      const apiItems: any[] = [];
      for (const it of items) {
        const descBase = `${it.grupoNome} ${it.subgrupoNome}`.trim().toUpperCase();
        for (const cor of it.cores) {
          const tamanhosQty: Record<string, number> = {};
          for (const t of it.tamanhos) {
            const q = Number(it.grade[`${cor}|${t}`] || 0);
            if (q > 0) tamanhosQty[t] = q;
          }
          if (Object.keys(tamanhosQty).length === 0) continue; // pula cores sem qty
          apiItems.push({
            ref: it.ref,
            descricaoBase: descBase,
            cor,
            grupoCode: it.grupoCode,
            grupoNome: it.grupoNome,
            subgrupoCode: it.subgrupoCode,
            subgrupoNome: it.subgrupoNome,
            ncm: it.ncm || null,
            cfop: it.cfop || '5102',
            plusSize: it.plusSize,
            custoUnit: Number(it.custoUnit.replace(',', '.')),
            precoUnit: Number(it.precoUnit.replace(',', '.')),
            tributoPct: Number(it.tributoPct.replace(',', '.') || 0),
            descontoPct: Number(it.descontoPct.replace(',', '.') || 0),
            tamanhosQty,
          });
        }
      }

      const r = await api<{ id: string }>('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          fornecedorNome,
          fornecedorCnpj,
          marca,
          dataPrevista: dataPrevista || null,
          nfNumero,
          observacoes,
          items: apiItems,
        }),
      });
      router.push(`/loja/pedidos-compra/${r.id}`);
    } catch (e: any) {
      setError(e?.message || 'Erro ao salvar');
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja/pedidos-compra" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-violet-600 flex items-center justify-center">
            <Package className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Novo pedido de compra</h1>
            <p className="text-xs text-slate-500">{items.length} REF(s) · <b>{totalPecas}</b> peças · R$ {totalCusto.toFixed(2)}</p>
          </div>
          <button
            onClick={salvar}
            disabled={saving || items.length === 0}
            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg shadow-md disabled:opacity-40"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar pedido
          </button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-4 space-y-4">
        {error && (
          <div className="bg-rose-50 border border-rose-300 text-rose-700 rounded-lg p-3 flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            <span className="text-sm font-bold">{error}</span>
          </div>
        )}

        {/* Header do pedido */}
        <section className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <h2 className="text-sm font-black text-violet-700 uppercase tracking-wider">Fornecedor & NF</h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Fornecedor autocomplete */}
            <div className="relative sm:col-span-2">
              <label className="text-xs font-bold text-slate-600 mb-1 block">
                Fornecedor
                <span className="text-[10px] text-slate-400 font-normal ml-2">
                  ({fornecedores.length} no Wincred, {fornecedoresFiltered.length} mostrados)
                </span>
              </label>
              <input
                value={fornecedorNome}
                onChange={(e) => {
                  setFornecedorNome(e.target.value);
                  setShowFornDropdown(true);
                }}
                onFocus={() => setShowFornDropdown(true)}
                onBlur={() => {
                  setTimeout(() => setShowFornDropdown(false), 200);
                  handleFornecedorBlur();
                }}
                placeholder="Digite a MARCA do fornecedor (ex: MARRIE, MALWEE)..."
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
              {showFornDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border-2 border-violet-200 rounded-lg shadow-xl max-h-72 overflow-y-auto z-10">
                  {fornecedoresFiltered.length > 0 ? (
                    fornecedoresFiltered.map((f) => (
                      <button
                        key={f.cnpj + f.nome}
                        type="button"
                        onClick={() => escolherFornecedor(f)}
                        className="w-full text-left px-3 py-2 hover:bg-violet-50 border-b border-slate-100 last:border-b-0"
                      >
                        <div className="font-bold text-sm text-violet-900">
                          {f.fantasia || f.nome}
                          {f.fantasia && (
                            <span className="ml-2 text-[9px] font-bold uppercase text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                              MARCA
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {f.fantasia && f.nome !== f.fantasia && <span>{f.nome} · </span>}
                          {f.cnpj && <span>CNPJ {f.cnpj}</span>}
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-3 text-xs text-slate-500">
                      <div className="font-bold text-slate-700 mb-1">Nao achou na lista?</div>
                      Digite o nome livremente no campo acima — vai ser salvo como o nome do fornecedor.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="text-xs font-bold text-slate-600 mb-1 block">Marca (na descrição)</label>
              <input
                value={marca}
                onChange={(e) => setMarca(e.target.value.toUpperCase())}
                placeholder="Ex: MARRIE"
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono uppercase"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-bold text-slate-600 mb-1 block">Data prevista</label>
              <input
                type="date"
                value={dataPrevista}
                onChange={(e) => setDataPrevista(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-600 mb-1 block">NF (opcional)</label>
              <input
                value={nfNumero}
                onChange={(e) => setNfNumero(e.target.value)}
                placeholder="Número da NF"
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-emerald-700 mb-1 block">
                Markup (multiplicador)
              </label>
              <div className="relative">
                <input
                  value={markup}
                  onChange={(e) => setMarkup(e.target.value.replace(',', '.'))}
                  placeholder="2.5"
                  inputMode="decimal"
                  className="w-full px-3 py-2 border-2 border-emerald-300 rounded-lg text-sm font-mono font-bold bg-emerald-50"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-emerald-700 font-bold pointer-events-none">
                  ×
                </span>
              </div>
              <div className="text-[10px] text-slate-500 mt-1">
                Custo líquido × markup = preço sugerido
              </div>
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-slate-600 mb-1 block">Observações</label>
            <textarea
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
        </section>

        {/* Items */}
        <section className="space-y-3">
          {items.map((item, idx) => (
            <ItemEditor
              key={item.tempId}
              item={item}
              index={idx + 1}
              grupos={grupos}
              categorias={categorias}
              markup={markup}
              onRefreshGrupos={refetchGrupos}
              onUpdate={(patch) => updateItem(item.tempId, patch)}
              onRemove={() => removerItem(item.tempId)}
              onDuplicate={() => duplicarItem(item.tempId)}
              onAplicarCategoria={(desc) => aplicarCategoriaSeExistir(item.tempId, desc)}
              onAddCor={(c) => adicionarCor(item.tempId, c)}
              onRemoveCor={(c) => removerCor(item.tempId, c)}
              onAddTam={(t) => adicionarTamanho(item.tempId, t)}
              onRemoveTam={(t) => removerTamanho(item.tempId, t)}
              onGrade={(c, t, v) => setGradeCell(item.tempId, c, t, v)}
              onAdicionarNova={idx === items.length - 1 ? adicionarItem : undefined}
            />
          ))}

          <button
            onClick={adicionarItem}
            className="w-full py-4 border-2 border-dashed border-violet-300 hover:border-violet-500 hover:bg-violet-50 rounded-xl text-violet-600 font-bold flex items-center justify-center gap-2 transition"
          >
            <Plus className="w-5 h-5" />
            Adicionar nova REF
          </button>
        </section>
      </main>
    </div>
  );
}

// ─── ItemEditor ─────────────────────────────────────────────────────────
function ItemEditor({
  item, index, grupos, categorias, markup,
  onUpdate, onRemove, onDuplicate, onAplicarCategoria,
  onAddCor, onRemoveCor, onAddTam, onRemoveTam, onGrade,
  onAdicionarNova, onRefreshGrupos,
}: {
  item: ItemForm;
  index: number;
  grupos: Grupo[];
  categorias: Categoria[];
  markup: string;
  onUpdate: (patch: Partial<ItemForm>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onAplicarCategoria: (desc: string) => void;
  onAddCor: (c: string) => void;
  onRemoveCor: (c: string) => void;
  onAddTam: (t: string) => void;
  onRemoveTam: (t: string) => void;
  onGrade: (c: string, t: string, v: string) => void;
  onAdicionarNova?: () => void;
  onRefreshGrupos?: () => Promise<Grupo[]>;
}) {
  // Flag pra saber se o preço foi mexido manualmente (não auto-sobrescrever)
  const [precoEditadoManual, setPrecoEditadoManual] = useState(false);
  const [subgrupos, setSubgrupos] = useState<Grupo[]>([]);
  const [novaCor, setNovaCor] = useState('');
  const [novoTam, setNovoTam] = useState('');
  const [criandoGrupo, setCriandoGrupo] = useState(false);
  const [criandoSubgrupo, setCriandoSubgrupo] = useState(false);

  const handleCriarGrupo = async () => {
    const nome = prompt('Nome do novo grupo:')?.trim();
    if (!nome) return;
    setCriandoGrupo(true);
    try {
      const novo = await api<Grupo>('/purchase-orders/lookups/grupo', {
        method: 'POST',
        body: JSON.stringify({ nome }),
      });
      if (onRefreshGrupos) await onRefreshGrupos();
      onUpdate({ grupoCode: novo.codigo, grupoNome: novo.nome, subgrupoCode: null, subgrupoNome: '' });
    } catch (e: any) {
      alert('Erro ao criar grupo: ' + (e?.message || ''));
    } finally {
      setCriandoGrupo(false);
    }
  };

  const handleCriarSubgrupo = async () => {
    if (!item.grupoCode) { alert('Escolha um grupo antes'); return; }
    const nome = prompt('Nome do novo subgrupo:')?.trim();
    if (!nome) return;
    setCriandoSubgrupo(true);
    try {
      const novo = await api<Grupo>('/purchase-orders/lookups/subgrupo', {
        method: 'POST',
        body: JSON.stringify({ grupo: item.grupoCode, nome }),
      });
      const lista = await api<Grupo[]>(`/purchase-orders/lookups/subgrupos?grupo=${item.grupoCode}`);
      setSubgrupos(lista);
      onUpdate({ subgrupoCode: novo.codigo, subgrupoNome: novo.nome });
    } catch (e: any) {
      alert('Erro ao criar subgrupo: ' + (e?.message || ''));
    } finally {
      setCriandoSubgrupo(false);
    }
  };

  // Carrega subgrupos do grupo selecionado
  useEffect(() => {
    if (!item.grupoCode) {
      setSubgrupos([]);
      return;
    }
    api<Grupo[]>(`/purchase-orders/lookups/subgrupos?grupo=${item.grupoCode}`)
      .then(setSubgrupos)
      .catch(() => setSubgrupos([]));
  }, [item.grupoCode]);

  // Total da linha
  let totalLinha = 0;
  for (const c of item.cores) {
    for (const t of item.tamanhos) {
      totalLinha += Number(item.grade[`${c}|${t}`] || 0);
    }
  }
  const custoNum = Number((item.custoUnit || '').toString().replace(',', '.')) || 0;
  const descNum = Number((item.descontoPct || '0').toString().replace(',', '.')) || 0;
  const tribNum = Number((item.tributoPct || '0').toString().replace(',', '.')) || 0;
  const markupNum = Number(((item.markup || markup) || '0').toString().replace(',', '.')) || 0;

  // Cálculo: CUSTO − DESCONTO + IMPOSTO = CUSTO LÍQUIDO
  const custoLiquido = custoNum * (1 - descNum / 100) * (1 + tribNum / 100);
  // Preço sugerido = custoLiquido × markup
  const precoSugerido = custoLiquido * markupNum;
  // Arredondar pra .90 (sugestão comercial)
  const precoSugeridoRedondo = Math.round(precoSugerido) - 0.10 > 0
    ? Math.round(precoSugerido) - 0.10
    : precoSugerido;

  // Auto-preenche preco se ainda não foi editado manualmente
  useEffect(() => {
    if (!precoEditadoManual && custoLiquido > 0 && markupNum > 0) {
      const sugerido = precoSugeridoRedondo.toFixed(2).replace('.', ',');
      if (sugerido !== item.precoUnit) {
        onUpdate({ precoUnit: sugerido });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custoNum, descNum, tribNum, markupNum]);

  const custoTotal = totalLinha * custoNum;
  const custoLiquidoTotal = totalLinha * custoLiquido;
  const precoVendaNum = Number((item.precoUnit || '').toString().replace(',', '.')) || 0;
  const margemReal = custoLiquido > 0 ? (precoVendaNum / custoLiquido) : 0;
  const lucroUnit = precoVendaNum - custoLiquido;

  return (
    <div className="bg-white border-2 border-slate-200 rounded-2xl p-4 space-y-3">
      {/* Header da REF */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-black text-violet-700 uppercase tracking-wider">
          Item #{index}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">
            <b>{totalLinha}</b> peças · R$ {custoTotal.toFixed(2)}
          </span>
          <button onClick={onDuplicate} className="p-1.5 hover:bg-slate-100 rounded" title="Duplicar">
            <Copy className="w-4 h-4 text-slate-500" />
          </button>
          <button onClick={onRemove} className="p-1.5 hover:bg-rose-50 text-rose-500 rounded" title="Remover">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Linha 1: REF */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
        <div className="sm:col-span-1">
          <label className="text-[10px] font-bold text-slate-600 uppercase">REF *</label>
          <input
            value={item.ref}
            onChange={(e) => onUpdate({ ref: e.target.value.toUpperCase() })}
            placeholder="7031"
            className="w-full px-2 py-2 border rounded text-sm font-mono uppercase font-bold"
          />
        </div>
      </div>

      {/* Linha 2: Grupo + Subgrupo + NCM + CFOP */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 bg-slate-50 p-2 rounded-lg">
        <div className="sm:col-span-2">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold text-slate-600 uppercase">Grupo *</label>
            <button type="button" onClick={handleCriarGrupo} disabled={criandoGrupo}
              title="Criar novo grupo no Wincred"
              className="text-[10px] font-bold text-violet-600 hover:text-violet-800 disabled:opacity-40">
              {criandoGrupo ? '...' : '+ novo'}
            </button>
          </div>
          <select
            value={item.grupoCode || ''}
            onChange={(e) => {
              const code = Number(e.target.value);
              const g = grupos.find((x) => x.codigo === code);
              const patch: any = { grupoCode: code, grupoNome: g?.nome || '', subgrupoCode: null, subgrupoNome: '' };
              if (!item.ncm) patch.ncm = NCM_DEFAULT;
              onUpdate(patch);
            }}
            className="w-full px-2 py-2 border rounded text-sm bg-white"
          >
            <option value="">— selecione —</option>
            {grupos.map((g) => (
              <option key={g.codigo} value={g.codigo}>{g.nome}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold text-slate-600 uppercase">Subgrupo *</label>
            <button type="button" onClick={handleCriarSubgrupo} disabled={criandoSubgrupo || !item.grupoCode}
              title="Criar novo subgrupo no grupo atual"
              className="text-[10px] font-bold text-violet-600 hover:text-violet-800 disabled:opacity-40">
              {criandoSubgrupo ? '...' : '+ novo'}
            </button>
          </div>
          <select
            value={item.subgrupoCode || ''}
            onChange={(e) => {
              const code = Number(e.target.value);
              const s = subgrupos.find((x) => x.codigo === code);
              onUpdate({ subgrupoCode: code, subgrupoNome: s?.nome || (item.subgrupoCode === code ? item.subgrupoNome : '') });
            }}
            disabled={!item.grupoCode}
            className="w-full px-2 py-2 border rounded text-sm bg-white disabled:opacity-50"
          >
            <option value="">— selecione —</option>
            {/* Option fantasma: subgrupo herdado pode nao estar na lista ainda (race) */}
            {item.subgrupoCode != null && !subgrupos.find((s) => s.codigo === item.subgrupoCode) && (
              <option value={item.subgrupoCode}>{item.subgrupoNome || `(codigo ${item.subgrupoCode})`}</option>
            )}
            {subgrupos.map((s) => (
              <option key={s.codigo} value={s.codigo}>{s.nome}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">NCM</label>
          <input
            value={item.ncm}
            onChange={(e) => onUpdate({ ncm: e.target.value.replace(/\D/g, '').slice(0, 8) })}
            placeholder="00000000"
            className="w-full px-2 py-2 border rounded text-sm font-mono"
          />
        </div>
      </div>

      {/* Linha 3: CFOP + PlusSize */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">CFOP</label>
          <input
            value={item.cfop}
            onChange={(e) => onUpdate({ cfop: e.target.value.replace(/\D/g, '').slice(0, 4) })}
            placeholder="5102"
            className="w-full px-2 py-2 border rounded text-sm font-mono"
          />
        </div>
        <label className="flex items-end gap-1.5 cursor-pointer sm:col-span-4">
          <input
            type="checkbox"
            checked={item.plusSize}
            onChange={(e) => onUpdate({ plusSize: e.target.checked })}
            className="accent-violet-600 w-4 h-4 mb-2"
          />
          <span className="text-xs font-bold text-violet-700 mb-2">PLUS SIZE</span>
        </label>
      </div>

      {/* PRECIFICAÇÃO — Custo → Desconto → Imposto → Líquido → Sugerido → Preço */}
      <div className="bg-gradient-to-r from-slate-50 to-emerald-50 border border-emerald-200 rounded-lg p-3">
        <div className="text-[10px] font-black uppercase text-emerald-700 tracking-wider mb-2">
          Precificação
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
          {/* Custo */}
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">Custo R$ *</label>
            <input
              value={item.custoUnit}
              onChange={(e) => onUpdate({ custoUnit: e.target.value })}
              placeholder="10,00"
              inputMode="decimal"
              className="w-full px-2 py-2 border rounded text-sm font-mono bg-white"
            />
          </div>
          {/* Desconto */}
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">− Desc %</label>
            <input
              value={item.descontoPct}
              onChange={(e) => onUpdate({ descontoPct: e.target.value })}
              placeholder="0"
              inputMode="decimal"
              className="w-full px-2 py-2 border rounded text-sm font-mono bg-white"
            />
          </div>
          {/* Tributo */}
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">+ Imp %</label>
            <input
              value={item.tributoPct}
              onChange={(e) => onUpdate({ tributoPct: e.target.value })}
              placeholder="0"
              inputMode="decimal"
              className="w-full px-2 py-2 border rounded text-sm font-mono bg-white"
            />
          </div>
          {/* Custo líquido (calc) */}
          <div>
            <label className="text-[10px] font-bold text-emerald-700 uppercase">= Líquido</label>
            <div className="w-full px-2 py-2 border-2 border-emerald-300 rounded text-sm font-mono font-bold bg-emerald-50 text-emerald-900 text-right tabular-nums">
              R$ {custoLiquido.toFixed(2).replace('.', ',')}
            </div>
          </div>
          {/* Sugerido + Markup editavel por item */}
          <div>
            <label className="text-[10px] font-bold text-violet-700 uppercase flex items-center gap-1">
              × 
              <input
                value={item.markup}
                onChange={(e) => { onUpdate({ markup: e.target.value }); setPrecoEditadoManual(false); }}
                placeholder={markup}
                inputMode="decimal"
                className="w-12 px-1 py-0.5 border border-violet-300 rounded text-xs font-mono font-bold text-center bg-white"
                title={`Markup do item. Plus=${MARKUP_PLUS}, Reg=${MARKUP_REGULAR}`}
              />
              × Sugerido
            </label>
            <button
              type="button"
              onClick={() => {
                onUpdate({ precoUnit: precoSugeridoRedondo.toFixed(2).replace('.', ',') });
                setPrecoEditadoManual(false);
              }}
              className="w-full px-2 py-2 border-2 border-violet-300 rounded text-sm font-mono font-bold bg-violet-50 text-violet-900 text-right tabular-nums hover:bg-violet-100"
              title="Clique pra aplicar"
            >
              R$ {precoSugeridoRedondo.toFixed(2).replace('.', ',')}
            </button>
          </div>
          {/* Preço editável */}
          <div>
            <label className="text-[10px] font-bold text-emerald-800 uppercase">Preço Venda *</label>
            <input
              value={item.precoUnit}
              onChange={(e) => {
                setPrecoEditadoManual(true);
                onUpdate({ precoUnit: e.target.value });
              }}
              placeholder="0,00"
              inputMode="decimal"
              className="w-full px-2 py-2 border-2 border-emerald-500 rounded text-sm font-mono font-black bg-white text-emerald-800 text-right tabular-nums"
            />
          </div>
        </div>
        {/* Resumo de margem */}
        {precoVendaNum > 0 && custoLiquido > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
            <span className="text-slate-600">
              Markup real: <b className={margemReal >= markupNum ? 'text-emerald-700' : 'text-amber-700'}>{margemReal.toFixed(2)}×</b>
            </span>
            <span className="text-slate-600">
              Lucro/peça: <b className="text-emerald-700">R$ {lucroUnit.toFixed(2).replace('.', ',')}</b>
            </span>
            {totalLinha > 0 && (
              <span className="text-slate-600">
                Lucro total: <b className="text-emerald-700">R$ {(lucroUnit * totalLinha).toFixed(2).replace('.', ',')}</b>
              </span>
            )}
            <span className="text-slate-500 ml-auto">
              Custo total: R$ {custoLiquidoTotal.toFixed(2).replace('.', ',')}
            </span>
          </div>
        )}
      </div>

      {/* Tamanhos (chips) */}
      <div className="space-y-1">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-[10px] font-bold text-slate-600 uppercase">Tamanhos da grade</div>
          <div className="flex flex-wrap gap-1">
            {GRADE_PRESETS.map((g) => {
              const active = item.tamanhos.length === g.tamanhos.length
                && item.tamanhos.every((t, i) => t === g.tamanhos[i]);
              const cls = active ? g.clsActive : g.clsIdle;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onUpdate({ tamanhos: [...g.tamanhos], plusSize: g.plusSize, grade: {}, markup: g.markup })}
                  className={`px-2 py-1 border-2 rounded text-[10px] font-black uppercase ${cls}`}
                  title={`Aplicar: ${g.tamanhos.join(' • ')}`}
                >
                  {g.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          {item.tamanhos.map((t) => (
            <span key={t} className="bg-violet-100 text-violet-700 px-2 py-1 rounded text-xs font-bold font-mono flex items-center gap-1">
              {t}
              <button onClick={() => onRemoveTam(t)} className="hover:text-rose-600">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <input
            value={novoTam}
            onChange={(e) => setNovoTam(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onAddTam(novoTam);
                setNovoTam('');
              }
            }}
            placeholder="+ tam"
            className="px-2 py-1 border rounded text-xs w-20 font-mono"
          />
        </div>
      </div>

      {/* Cores (chips) */}
      <div className="space-y-1">
        <div className="text-[10px] font-bold text-slate-600 uppercase">Cores</div>
        <div className="flex flex-wrap gap-1 items-center">
          {item.cores.map((c) => (
            <span key={c} className="bg-amber-100 text-amber-800 px-2 py-1 rounded text-xs font-bold flex items-center gap-1">
              {c}
              <button onClick={() => onRemoveCor(c)} className="hover:text-rose-600">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <input
            value={novaCor}
            onChange={(e) => setNovaCor(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onAddCor(novaCor);
                setNovaCor('');
              }
            }}
            placeholder="+ cor"
            className="px-2 py-1 border rounded text-xs w-32 uppercase"
          />
        </div>
      </div>

      {/* Grade cor x tamanho */}
      {item.cores.length > 0 && item.tamanhos.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left text-[10px] font-bold uppercase text-slate-500 p-1">Cor</th>
                {item.tamanhos.map((t) => (
                  <th key={t} className="p-1 text-center text-[10px] font-mono text-violet-700">{t}</th>
                ))}
                <th className="p-1 text-center text-[10px] text-violet-700">TOT</th>
              </tr>
            </thead>
            <tbody>
              {item.cores.map((c) => {
                let total = 0;
                for (const t of item.tamanhos) total += Number(item.grade[`${c}|${t}`] || 0);
                return (
                  <tr key={c}>
                    <td className="p-1 font-bold text-amber-700 text-xs">{c}</td>
                    {item.tamanhos.map((t) => (
                      <td key={t} className="p-0.5">
                        <input
                          value={item.grade[`${c}|${t}`] || ''}
                          onChange={(e) => onGrade(c, t, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const inputs = Array.from(
                                document.querySelectorAll<HTMLInputElement>(`[data-grade="${item.tempId}"]`),
                              );
                              const idx = inputs.indexOf(e.currentTarget);
                              const next = inputs[idx + 1];
                              if (next) {
                                next.focus();
                              } else if (onAdicionarNova) {
                                // Ultimo input - cria nova REF e foca no campo REF
                                onAdicionarNova();
                                setTimeout(() => {
                                  const refs = document.querySelectorAll<HTMLInputElement>('input[placeholder="7031"]');
                                  const last = refs[refs.length - 1];
                                  if (last) last.focus();
                                }, 50);
                              }
                            }
                          }}
                          data-grade={item.tempId}
                          placeholder="0"
                          inputMode="numeric"
                          className="w-12 px-1 py-1 border rounded text-center font-mono text-sm"
                        />
                      </td>
                    ))}
                    <td className="p-1 text-center font-black text-violet-700 tabular-nums text-sm">{total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Aviso de tamanhos com qty 0 — esses serao ignorados no cadastro */}
          {(() => {
            const zerados = new Set<string>();
            for (const t of item.tamanhos) {
              let temQty = false;
              for (const co of item.cores) {
                if (Number(item.grade[`${co}|${t}`] || 0) > 0) { temQty = true; break; }
              }
              if (!temQty) zerados.add(t);
            }
            if (zerados.size === 0) return null;
            return (
              <div className="mt-2 text-[11px] bg-amber-50 border border-amber-300 rounded px-2 py-1 text-amber-800">
                <b>Tamanhos sem qty (nao serao cadastrados):</b>{' '}
                <span className="font-mono font-bold">{Array.from(zerados).join(' • ')}</span>
              </div>
            );
          })()}
        </div>
      )}

      {/* PREVIEW DESCRICAO - auto-gerada (ultimo campo) */}
      <DescricaoPreview item={item} />
    </div>
  );
}

// --- Preview da descricao auto-gerada -----------------------------------
function DescricaoPreview({ item }: { item: ItemForm }) {
  const marca = (typeof window !== 'undefined'
    ? (document.querySelector<HTMLInputElement>('input[placeholder="Ex: MARRIE"]')?.value || '')
    : ''
  ).toUpperCase();

  const partes = [
    item.grupoNome?.trim().toUpperCase(),
    item.subgrupoNome?.trim().toUpperCase(),
    item.plusSize ? 'PLUS SIZE' : '',
    item.ref?.trim().toUpperCase(),
  ].filter(Boolean);

  const cor = item.cores[0] || 'COR';
  const tam = item.tamanhos[0] || 'TAM';
  const descricaoExemplo = [...partes, cor, tam, marca || 'MARCA'].filter(Boolean).join(' ');

  let combinacoes = 0;
  for (const c of item.cores) {
    for (const t of item.tamanhos) {
      if (Number(item.grade[`${c}|${t}`] || 0) > 0) combinacoes++;
    }
  }

  if (!item.grupoNome && !item.subgrupoNome) {
    return (
      <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-lg p-3 text-xs text-slate-400 italic">
        <Eye className="w-3.5 h-3.5 inline mr-1" />
        Selecione Grupo e Subgrupo pra ver a descricao final...
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-r from-violet-50 to-emerald-50 border-2 border-violet-200 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1">
        <Eye className="w-3.5 h-3.5 text-violet-600" />
        <span className="text-[10px] font-black uppercase text-violet-700 tracking-wider">
          Descricao que vai pro cadastro
        </span>
        {combinacoes > 0 && (
          <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
            {combinacoes} SKU(s)
          </span>
        )}
      </div>
      <div className="font-mono text-sm font-black text-slate-800 break-all">
        {descricaoExemplo}
      </div>
      <div className="text-[10px] text-slate-500 mt-1">
        Cada cor x tamanho gera um SKU com sua propria descricao. Acima e so um exemplo.
      </div>
    </div>
  );
}
