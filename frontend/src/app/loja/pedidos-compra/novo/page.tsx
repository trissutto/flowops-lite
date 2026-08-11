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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, Trash2, Loader2, Save,
  AlertCircle, Copy, X, Eye, Check, Printer, ChevronDown,
  Tag, FilePlus2, Search, Clock3, Shirt, CheckCircle2,
} from 'lucide-react';
import { PoShell } from '../PoShell';
import { api } from '@/lib/api';
import { ordemTamanho } from '@/lib/ordem-tamanho';
import {
  applyPurchaseOrderCollection,
  completeGradeAndPrepareNext,
  getNextGradeInputIndex,
  getPurchaseOrderCollection,
  isPurchaseOrderItemCollapsed,
  toggleExpandedPurchaseOrderItem,
} from '@/lib/purchase-order-item-accordion.mjs';
import {
  SelectAtributoPeca, type Atributo, type AtributosPorTipo, type TipoAtributo,
} from '@/components/SelectAtributoPeca';

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
  // Classificação da peça (Cadastros → Classificação da Peça). Preenchida aqui,
  // na compra, porque quem compra tem a peça na mão e sabe o tecido — evita a
  // segunda passada em milhares de itens depois.
  tecidoId: string;
  colecaoId: string;
  ocasiaoIds: string[];
  modelagemIds: string[];
  custoUnit: string;
  precoUnit: string;
  tributoPct: string;
  descontoPct: string;
  markup: string; // markup proprio do item (sobrescreve o global)
  gradePresetId: string | null; // id do preset (Plus 46→60, etc) — pra herdar destaque
  cores: string[];
  tamanhos: string[];
  // matriz: { "PRETO|46": 21, "PRETO|48": 21, ... }
  grade: Record<string, string>;
  // Preenchido quando a REF foi CONFERIDA durante o lançamento (recebimento
  // parcial): já existe no servidor com estoque lançado e etiquetas geradas —
  // o Salvar final NÃO reenvia este item.
  conferido?: { orderId: string; pecas: number; skusNovos: number; erros: number };
  // Ids dos PurchaseOrderItem no servidor que este card representa (modo
  // "reabrir pedido"). Ao conferir/salvar, os antigos são apagados e o card é
  // regravado — edição vira delete+recreate, sem PATCH campo a campo.
  serverItemIds?: string[];
  // true = não deixar o auto-preço sobrescrever o precoUnit carregado do
  // servidor (pedido reaberto mantém o preço salvo até alguém mexer).
  precoTravado?: boolean;
};

const TAMANHOS_PLUS = ['46', '48', '50', '52', '54', '56', '58', '60'];

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
  {
    id: 'g1-g5', label: 'G1→G5', tamanhos: ['G1','G2','G3','G4','G5'], plusSize: false, markup: MARKUP_REGULAR,
    clsActive: 'bg-amber-600 text-white border-amber-700',
    clsIdle: 'bg-white text-amber-700 border-amber-300 hover:bg-amber-50',
  },
];

const newTempId = () => Math.random().toString(36).slice(2, 10);

export default function NovoPedidoPage() {
  const router = useRouter();

  // Lookups
  const [fornecedores, setFornecedores] = useState<Fornecedor[]>([]);
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [atributos, setAtributos] = useState<AtributosPorTipo>({});
  const [categorias, setCategorias] = useState<Categoria[]>([]);

  // Header
  const [fornecedorNome, setFornecedorNome] = useState('');
  const [fornecedorCnpj, setFornecedorCnpj] = useState('');
  const [marca, setMarca] = useState('');
  // A colecao pertence ao contexto da compra: escolhe uma vez junto da marca
  // e todas as REFs pendentes recebem o mesmo valor.
  const [colecaoPedidoId, setColecaoPedidoId] = useState('');
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
  const inicializouPedidoRef = useRef(false);
  // Referencias conferidas nascem recolhidas. So uma pode ser reaberta por vez;
  // e um estado puramente visual, sem alterar o pedido salvo no servidor.
  const [conferidoAbertoId, setConferidoAbertoId] = useState<string | null>(null);

  // Conferência durante o lançamento: o pedido é criado (rascunho) no 1º
  // "Conferir + etiquetas" e cada REF conferida já entra no estoque na hora.
  const [orderId, setOrderId] = useState<string | null>(null);
  const [conferindoId, setConferindoId] = useState<string | null>(null);
  const conferindoIdRef = useRef<string | null>(null);
  const [focusRefId, setFocusRefId] = useState<string | null>(null);
  const [carregandoPedido, setCarregandoPedido] = useState(false);

  // Depois do ultimo Enter da grade, a nova REF nasce no fim da lista. O foco
  // acontece somente depois que o React montou o novo campo no DOM.
  useEffect(() => {
    if (!focusRefId) return;
    const frame = window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(`[data-ref-input="${focusRefId}"]`);
      if (!input) return;
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input.focus({ preventScroll: true });
      input.select();
      setFocusRefId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRefId, items]);

  // Cache de subgrupos por grupoCode (compartilhado entre itens) — elimina race
  // quando item novo herda grupoCode+subgrupoCode do anterior.
  const [subgruposCache, setSubgruposCache] = useState<Record<number, Grupo[]>>({});
  const getSubgrupos = async (grupoCode: number): Promise<Grupo[]> => {
    if (subgruposCache[grupoCode]) return subgruposCache[grupoCode];
    try {
      const lista = await api<Grupo[]>(`/purchase-orders/lookups/subgrupos?grupo=${grupoCode}`);
      setSubgruposCache((p) => ({ ...p, [grupoCode]: lista }));
      return lista;
    } catch { return []; }
  };

  // Estado
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Erro sempre visível: com 30 REFs na tela o banner (que fica no topo)
  // passava despercebido — a vendedora achava que salvou e fechava a aba.
  const errorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [error]);

  // ── RASCUNHO AUTOMÁTICO (caso das 30 REFs, 11/08) ─────────────────────
  // REF digitada morava SÓ no estado do React: F5, deploy do Vercel ou aba
  // fechada no meio do lançamento = tudo que não foi Conferido/Salvo sumia
  // (caso real: 28 de 30 REFs perdidas). Agora TODA mudança vai pro
  // localStorage (com debounce) e volta sozinha ao reabrir a tela — inclusive
  // o orderId, então o Conferir continua no MESMO pedido em vez de abrir
  // um pedido novo depois de um reload.
  const DRAFT_KEY = 'pc:draft:novo';
  const draftProntoRef = useRef(false);
  const [draftRestauradoEm, setDraftRestauradoEm] = useState<string | null>(null);

  const itemTemConteudo = (i: ItemForm) =>
    !!(i.ref.trim() || i.cores.length > 0 || i.custoUnit.trim() || Object.keys(i.grade).length > 0);

  useEffect(() => {
    if (!draftProntoRef.current) return;
    const t = setTimeout(() => {
      try {
        const temAlgo = items.some(itemTemConteudo) || fornecedorNome.trim();
        if (!temAlgo) { localStorage.removeItem(DRAFT_KEY); return; }
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          fornecedorNome, fornecedorCnpj, marca, colecaoPedidoId,
          dataPrevista, nfNumero, observacoes, orderId, items,
          savedAt: new Date().toISOString(),
        }));
      } catch { /* localStorage cheio/indisponível — segue sem rascunho */ }
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, fornecedorNome, fornecedorCnpj, marca, colecaoPedidoId, dataPrevista, nfNumero, observacoes, orderId]);

  const descartarRascunho = () => {
    if (!confirm('Descartar o rascunho recuperado? As REFs não salvas serão perdidas.')) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    setDraftRestauradoEm(null);
    setFornecedorNome(''); setFornecedorCnpj(''); setMarca('');
    setColecaoPedidoId(''); setDataPrevista(''); setNfNumero(''); setObservacoes('');
    setOrderId(null);
    setItems([]);
    adicionarItem();
  };

  // Cinto e suspensório: além do rascunho, avisa antes de fechar/recarregar
  // a aba com REF pendente (o rascunho recupera, mas o aviso evita o susto).
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (items.some((i) => !i.conferido && itemTemConteudo(i))) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  useEffect(() => {
    api<Fornecedor[]>('/purchase-orders/lookups/fornecedores').then(setFornecedores).catch(() => {});
    api<Grupo[]>('/purchase-orders/lookups/grupos').then(setGrupos).catch(() => {});
    api<Categoria[]>('/purchase-orders/categorias').then(setCategorias).catch(() => {});
    // Classificação da peça. Se o cadastro estiver vazio os selects aparecem
    // vazios — e classificar é opcional aqui, então nunca trava o pedido.
    api<AtributosPorTipo>('/atributos-peca').then(setAtributos).catch(() => {});
  }, []);

  /** Cadastro criado pelo "+ novo" entra na lista sem recarregar a tela. */
  const aoCriarAtributo = (tipo: TipoAtributo, novo: Atributo) => {
    setAtributos((p) => ({ ...p, [tipo]: [...(p[tipo] ?? []), novo] }));
  };

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
  // E TAMBEM: se o nome bate com algum fornecedor cadastrado, puxa o CNPJ
  // automaticamente — evita o user esquecer de clicar no autocomplete.
  const handleFornecedorBlur = () => {
    const digitado = fornecedorNome.trim().toUpperCase();
    if (!digitado) return;
    if (!marca.trim()) setMarca(digitado);

    // Auto-match CNPJ se nome bater EXATO com fantasia ou nome do fornecedor
    if (!fornecedorCnpj.trim()) {
      const match = fornecedores.find((f) => {
        const fant = (f.fantasia || '').trim().toUpperCase();
        const nome = (f.nome || '').trim().toUpperCase();
        return fant === digitado || nome === digitado;
      });
      if (match) {
        setFornecedorCnpj(match.cnpj);
        const fant = (match.fantasia || '').trim();
        const nomeReal = (match.nome || '').trim();
        setFornecedorNome(fant || nomeReal);
        setMarca(fant || nomeReal);
        return;
      }
      // Fallback: tenta match parcial (nome digitado é substring única)
      const partial = fornecedores.filter((f) => {
        const fant = (f.fantasia || '').trim().toUpperCase();
        const nome = (f.nome || '').trim().toUpperCase();
        return fant.includes(digitado) || nome.includes(digitado);
      });
      if (partial.length === 1) {
        const m = partial[0];
        setFornecedorCnpj(m.cnpj);
        const fant = (m.fantasia || '').trim();
        const nomeReal = (m.nome || '').trim();
        setFornecedorNome(fant || nomeReal);
        setMarca(fant || nomeReal);
      }
    }
  };

  const adicionarItem = (tempId = newTempId()) => {
    setItems((prev) => {
      // HERDA tudo do ultimo item, exceto NCM: cada nova REF é classificada
      // pelo backend com IA e validada contra a tabela vigente do Siscomex.
      // (REF, custo, preco, cores e qtys ficam em branco — sao especificos por peca)
      const last = prev[prev.length - 1];
      return [
        ...prev,
        {
          tempId,
          ref: '',
          descricaoBase: last?.descricaoBase ?? '',
          grupoCode: last?.grupoCode ?? null,
          grupoNome: last?.grupoNome ?? '',
          subgrupoCode: last?.subgrupoCode ?? null,
          subgrupoNome: last?.subgrupoNome ?? '',
          ncm: '',
          cfop: last?.cfop || '5102',
          plusSize: last?.plusSize ?? true,
          // Herda a classificação: numa mesma compra o fornecedor costuma
          // mandar várias REFs do mesmo tecido e da mesma coleção.
          tecidoId: last?.tecidoId ?? '',
          colecaoId: colecaoPedidoId || last?.colecaoId || '',
          ocasiaoIds: last?.ocasiaoIds ? [...last.ocasiaoIds] : [],
          modelagemIds: last?.modelagemIds ? [...last.modelagemIds] : [],
          custoUnit: '',
          precoUnit: '',
          tributoPct: last?.tributoPct ?? '0',
          descontoPct: last?.descontoPct ?? '0',
          markup: last?.markup ?? MARKUP_PLUS,
          gradePresetId: last?.gradePresetId ?? 'plus',
          cores: [],
          tamanhos: last?.tamanhos ? [...last.tamanhos] : [...TAMANHOS_PLUS],
          grade: {},
        },
      ];
    });
  };

  const removerItem = (tempId: string) => {
    // Card pendente reaberto do servidor: remove lá também (senão vira item
    // fantasma quando o pedido for salvo/recebido de novo).
    const alvo = items.find((i) => i.tempId === tempId);
    if (!alvo?.conferido) {
      for (const sid of alvo?.serverItemIds || []) {
        api(`/purchase-orders/items/${sid}`, { method: 'DELETE' }).catch(() => {});
      }
    }
    setItems((prev) => prev.filter((i) => i.tempId !== tempId));
  };

  const duplicarItem = (tempId: string) => {
    const original = items.find((i) => i.tempId === tempId);
    if (!original) return;
    setItems((prev) => [...prev, { ...original, tempId: newTempId(), ncm: '', grade: { ...original.grade }, conferido: undefined, serverItemIds: undefined }]);
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
        ncm: '',
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
    // Edicao manual: limpa marca de preset
    updateItem(tempId, { tamanhos: [...item.tamanhos, t], gradePresetId: null });
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

  // ── Compartilhado entre Salvar e "Conferir + etiquetas" ──────────────────

  /** CNPJ do fornecedor (auto-match pelo nome se não clicou no autocomplete).
   *  null = bloqueado — o erro já foi mostrado. */
  const resolverCnpjFornecedor = (): string | null => {
    if (!fornecedorNome.trim()) {
      setError('Fornecedor obrigatório');
      return null;
    }
    let cnpjFinal = fornecedorCnpj.trim();
    if (!cnpjFinal && fornecedores.length > 0) {
      const digitado = fornecedorNome.trim().toUpperCase();
      const exact = fornecedores.find((f) => {
        const fant = (f.fantasia || '').trim().toUpperCase();
        const nome = (f.nome || '').trim().toUpperCase();
        return fant === digitado || nome === digitado;
      });
      const partial = !exact ? fornecedores.filter((f) => {
        const fant = (f.fantasia || '').trim().toUpperCase();
        const nome = (f.nome || '').trim().toUpperCase();
        return fant.includes(digitado) || nome.includes(digitado);
      }) : [];
      const match = exact || (partial.length === 1 ? partial[0] : null);
      if (match) {
        cnpjFinal = match.cnpj;
        setFornecedorCnpj(match.cnpj);
      }
    }
    // FIX #3: bloqueia sem CNPJ (usuario digitou nome sem clicar no autocomplete).
    if (!cnpjFinal) {
      setError(
        `CNPJ do fornecedor "${fornecedorNome}" não encontrado. Selecione o fornecedor da lista (autocomplete dropdown abaixo do campo) pra pegar o CNPJ. Sem CNPJ o sistema não consegue cadastrar produtos no Wincred.`,
      );
      return null;
    }
    return cnpjFinal;
  };

  const validarItemForm = (it: ItemForm): string | null => {
    if (!it.ref.trim()) return 'Item sem REF';
    if (!it.grupoCode || !it.subgrupoCode) return `REF ${it.ref}: Grupo e Subgrupo obrigatórios pra montar a descrição`;
    if (!it.custoUnit || !it.precoUnit) return `REF ${it.ref}: Custo e Preço obrigatórios`;
    if (it.cores.length === 0 || it.tamanhos.length === 0) return `REF ${it.ref}: adicione cores e tamanhos`;
    if (calcularTotalItem(it) === 0) return `REF ${it.ref}: total = 0, informe quantidades na grade`;
    return null;
  };

  /** Salva a categoria (grupo+subgrupo) se ainda não existir — não bloqueia. */
  const salvarCategoriaSeNova = async (it: ItemForm) => {
    const descBase = `${it.grupoNome} ${it.subgrupoNome}`.trim().toUpperCase();
    const exists = categorias.find((c) => c.descricaoBase === descBase);
    if (exists || !it.grupoCode || !it.subgrupoCode) return;
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
  };

  /** 1 ItemForm pode virar VÁRIOS items da API (1 por cor com qty na grade). */
  const montarApiItems = (it: ItemForm): any[] => {
    const descBase = `${it.grupoNome} ${it.subgrupoNome}`.trim().toUpperCase();
    const out: any[] = [];
    for (const cor of it.cores) {
      const tamanhosQty: Record<string, number> = {};
      for (const t of it.tamanhos) {
        const q = Number(it.grade[`${cor}|${t}`] || 0);
        if (q > 0) tamanhosQty[t] = q;
      }
      if (Object.keys(tamanhosQty).length === 0) continue; // pula cores sem qty
      out.push({
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
        // Só os ids — o backend resolve o nome pelo cadastro, pra não
        // gravar no pedido um texto que veio do navegador.
        tecidoId: it.tecidoId || null,
        colecaoId: it.colecaoId || null,
        ocasiaoIds: it.ocasiaoIds,
        modelagemIds: it.modelagemIds,
      });
    }
    return out;
  };

  const headerPayload = (cnpjFinal: string) => ({
    fornecedorNome,
    fornecedorCnpj: cnpjFinal,
    marca,
    dataPrevista: dataPrevista || null,
    nfNumero,
    observacoes,
  });

  /** Garante o pedido criado no servidor (rascunho, só cabeçalho). */
  const ensureOrder = async (cnpjFinal: string): Promise<string> => {
    if (orderId) return orderId;
    const r = await api<{ id: string }>('/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ ...headerPayload(cnpjFinal), items: [] }),
    });
    setOrderId(r.id);
    return r.id;
  };

  // ── REABRIR pedido no MESMO formato de lançamento (dono 06/08) ───────────
  // /loja/pedidos-compra/novo?id=<pedido> carrega um pedido existente AQUI:
  // itens agrupados por REF como no lançamento; recebidos viram cards
  // travados (✓ Conferida), pendentes voltam 100% editáveis.
  const carregarPedido = async (id: string) => {
    setCarregandoPedido(true);
    setError(null);
    try {
      const o = await api<any>(`/purchase-orders/${id}`);
      setFornecedorNome(o.fornecedorNome || '');
      setFornecedorCnpj(o.fornecedorCnpj || '');
      setMarca(o.marca || '');
      setDataPrevista(o.dataPrevista ? String(o.dataPrevista).slice(0, 10) : '');
      setNfNumero(o.nfNumero || '');
      setObservacoes(o.observacoes || '');

      const parse = (v: any, fb: any) => {
        if (v == null) return fb;
        if (typeof v !== 'string') return v;
        try { return JSON.parse(v); } catch { return fb; }
      };
      // Agrupa por REF, separando recebidos (card travado) dos pendentes
      // (card editável) — REF meio-recebida ("Receber cor") vira DOIS cards.
      const grupos = new Map<string, any[]>();
      for (const si of o.items || []) {
        const key = `${si.ref}::${si.itemStatus === 'recebido' ? 'ok' : 'pend'}`;
        if (!grupos.has(key)) grupos.set(key, []);
        grupos.get(key)!.push(si);
      }
      const cards: ItemForm[] = [];
      for (const [key, sis] of grupos) {
        const recebido = key.endsWith('::ok');
        const first = sis[0];
        const cores: string[] = [];
        const tamSet = new Set<string>();
        const grade: Record<string, string> = {};
        let pecas = 0;
        for (const si of sis) {
          if (!cores.includes(si.cor)) cores.push(si.cor);
          const tq = parse(si.tamanhosQty, {}) as Record<string, number>;
          for (const [t, q] of Object.entries(tq)) {
            tamSet.add(t);
            grade[`${si.cor}|${t}`] = String(q);
            pecas += Number(q) || 0;
          }
        }
        cards.push({
          tempId: newTempId(),
          ref: first.ref || '',
          descricaoBase: first.descricaoBase || '',
          grupoCode: first.grupoCode ?? null,
          grupoNome: first.grupoNome || '',
          subgrupoCode: first.subgrupoCode ?? null,
          subgrupoNome: first.subgrupoNome || '',
          ncm: first.ncm || '',
          cfop: first.cfop || '5102',
          plusSize: first.plusSize ?? true,
          tecidoId: first.tecidoId || '',
          colecaoId: first.colecaoId || '',
          ocasiaoIds: (parse(first.ocasioes, []) as any[]).map((x) => x?.id).filter(Boolean),
          modelagemIds: (parse(first.modelagens, []) as any[]).map((x) => x?.id).filter(Boolean),
          custoUnit: String(first.custoUnit ?? '').replace('.', ','),
          precoUnit: String(first.precoUnit ?? '').replace('.', ','),
          tributoPct: String(first.tributoPct ?? 0).replace('.', ','),
          descontoPct: String(first.descontoPct ?? 0).replace('.', ','),
          markup: '',
          gradePresetId: null,
          cores,
          tamanhos: Array.from(tamSet).sort((a, b) => ordemTamanho(a) - ordemTamanho(b)),
          grade,
          conferido: recebido ? { orderId: id, pecas, skusNovos: 0, erros: 0 } : undefined,
          serverItemIds: sis.map((x: any) => x.id),
          precoTravado: true,
        });
      }
      // Conferidas primeiro (travadas), pendentes depois — ordem de lançamento
      cards.sort((a, b) => Number(!!b.conferido) - Number(!!a.conferido));
      setItems(cards);
      setColecaoPedidoId(getPurchaseOrderCollection(cards));
      setOrderId(id);
    } catch (e: any) {
      setError(`Não consegui carregar o pedido: ${e?.message || 'erro'}`);
    } finally {
      setCarregandoPedido(false);
    }
  };

  useEffect(() => {
    if (inicializouPedidoRef.current) return;
    inicializouPedidoRef.current = true;
    const id = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('id')
      : null;
    if (id) {
      // Reabertura explícita (?id=): a verdade é o servidor — não salva nem
      // restaura rascunho aqui, senão o rascunho de um pedido antigo vazaria
      // pro próximo lançamento.
      carregarPedido(id);
      return;
    }
    // Lançamento novo: tenta recuperar o rascunho salvo (F5/deploy/aba fechada)
    let restaurou = false;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (Array.isArray(d?.items) && d.items.some((i: ItemForm) => itemTemConteudo(i))) {
          setFornecedorNome(d.fornecedorNome || '');
          setFornecedorCnpj(d.fornecedorCnpj || '');
          setMarca(d.marca || '');
          setColecaoPedidoId(d.colecaoPedidoId || '');
          setDataPrevista(d.dataPrevista || '');
          setNfNumero(d.nfNumero || '');
          setObservacoes(d.observacoes || '');
          setOrderId(d.orderId || null);
          setItems(d.items);
          setDraftRestauradoEm(d.savedAt || null);
          restaurou = true;
        }
      }
    } catch { /* rascunho corrompido — começa em branco */ }
    if (!restaurou) adicionarItem();
    draftProntoRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * CONFERIR durante o lançamento (dono 06/08): cria o pedido (rascunho) na
   * 1ª vez, adiciona SÓ esta REF e recebe ela na hora via recebimento
   * parcial — auto-cadastro + estoque. O pedido continua aberto pras
   * próximas REFs.
   *
   * `abrirEtiquetas` (11/08): a aba de etiquetas SÓ abre no botão
   * "Etiquetas". Antes o conferir SEMPRE abria a aba — inclusive no Enter da
   * última célula da grade — e a aba roubando o foco fez a vendedora parar
   * de usar o Enter e clicar em "Adicionar nova REF" direto... que não
   * salva nada. Foi assim que 28 de 30 REFs se perderam no caso de 11/08.
   */
  const conferirAgora = async (
    tempId: string,
    opts?: { abrirEtiquetas?: boolean },
  ): Promise<boolean> => {
    if (conferindoIdRef.current) return false;
    const it = items.find((i) => i.tempId === tempId);
    if (!it || it.conferido) return false;
    setError(null);
    const vErr = validarItemForm(it);
    if (vErr) { setError(vErr); return false; }
    const cnpjFinal = resolverCnpjFornecedor();
    if (!cnpjFinal) return false;
    conferindoIdRef.current = tempId;
    setConferindoId(tempId);
    try {
      const oid = await ensureOrder(cnpjFinal);
      // Regrava com o que está na tela — edição = delete+recreate (tolerante
      // a id velho; ver apagarItensPendentesDaRef).
      await apagarItensPendentesDaRef(oid, it.ref, it.serverItemIds || []);
      await salvarCategoriaSeNova(it);
      const apiItems = montarApiItems(it);
      if (apiItems.length === 0) {
        setError(`REF ${it.ref}: grade sem quantidades`);
        return false;
      }
      const itemIds: string[] = [];
      for (const ai of apiItems) {
        const criado = await api<{ id: string }>(`/purchase-orders/${oid}/items`, {
          method: 'POST',
          body: JSON.stringify(ai),
        });
        if (criado?.id) itemIds.push(criado.id);
      }
      const r = await api<any>(`/purchase-orders/${oid}/receive`, {
        method: 'POST',
        body: JSON.stringify({ itemIds }),
      });
      const erros = Array.isArray(r?.errors) ? r.errors.length : 0;
      updateItem(tempId, {
        serverItemIds: itemIds,
        conferido: {
          orderId: oid,
          pecas: Number(r?.totalPecas || 0) || calcularTotalItem(it),
          skusNovos: Number(r?.totalSkusInseridos || 0),
          erros,
        },
      });
      // A REF so recolhe depois que o servidor confirmou cadastro + estoque.
      setConferidoAbertoId(null);
      if (erros > 0) {
        setError(
          `REF ${it.ref} conferida com ${erros} erro(s) de cadastro — resolva depois na tela do pedido (Cadastrar faltantes).`,
        );
      }
      // Aba de etiquetas SÓ quando pedida (botão "Etiquetas") — no fluxo do
      // Enter ela roubava o foco e quebrava o ritmo do lançamento.
      if (opts?.abrirEtiquetas) {
        window.open(
          `/loja/pedidos-compra/${oid}/etiquetas?ref=${encodeURIComponent(it.ref.trim().toUpperCase())}`,
          '_blank',
        );
      }
      return true;
    } catch (e: any) {
      setError(`Conferir REF ${it.ref}: ${e?.message || 'erro'}`);
      return false;
    } finally {
      conferindoIdRef.current = null;
      setConferindoId(null);
    }
  };

  /**
   * SALVA a REF no pedido SEM receber (11/08, dono): é isto que o Enter da
   * última célula da grade chama. Cria o pedido (rascunho) na 1ª vez e grava
   * os itens desta REF como PENDENTES — sem `/receive`, sem estoque, sem aba
   * de etiquetas. Recebimento é outro momento (botão Conferir, ou a tela do
   * pedido quando a mercadoria chegar): pedido futuro (ex: coleção
   * Primavera/Verão com entrega marcada) NÃO pode ganhar estoque no
   * lançamento. REF já salva antes é regravada (delete+recreate).
   */
  /**
   * Apaga do servidor os itens PENDENTES que este card representa, antes de
   * regravar (delete+recreate).
   *
   * BLINDADO CONTRA ID VELHO (caso REF 9829, 11/08): depois de um "Salvar"
   * que regravou os itens (ids novos), o rascunho local podia ficar com os
   * ids ANTIGOS — o DELETE tomava 404 "Item não encontrado" e abortava o
   * Conferir/Enter. Agora: 404 no id rastreado é ignorado (o item já não
   * existe — que é o estado desejado) e, além dos rastreados, apaga QUALQUER
   * item pendente da MESMA REF no pedido — senão a regravação criaria a REF
   * duplicada ao lado da versão órfã.
   */
  const apagarItensPendentesDaRef = async (oid: string, ref: string, tracked: string[]) => {
    const ids = new Set<string>(tracked.filter(Boolean));
    try {
      const o = await api<any>(`/purchase-orders/${oid}`);
      for (const si of (o?.items || []) as any[]) {
        if (
          String(si.ref || '').trim().toUpperCase() === ref.trim().toUpperCase() &&
          si.itemStatus !== 'recebido'
        ) ids.add(si.id);
      }
    } catch { /* sem a lista, segue só com os rastreados */ }
    for (const sid of ids) {
      try {
        await api(`/purchase-orders/items/${sid}`, { method: 'DELETE' });
      } catch (e: any) {
        if (!/^404/.test(String(e?.message || ''))) throw e;
      }
    }
  };

  const salvarRefNoPedido = async (tempId: string): Promise<boolean> => {
    if (conferindoIdRef.current) return false;
    const it = items.find((i) => i.tempId === tempId);
    if (!it || it.conferido) return false;
    setError(null);
    const vErr = validarItemForm(it);
    if (vErr) { setError(vErr); return false; }
    const cnpjFinal = resolverCnpjFornecedor();
    if (!cnpjFinal) return false;
    conferindoIdRef.current = tempId;
    setConferindoId(tempId);
    try {
      const oid = await ensureOrder(cnpjFinal);
      await apagarItensPendentesDaRef(oid, it.ref, it.serverItemIds || []);
      await salvarCategoriaSeNova(it);
      const apiItems = montarApiItems(it);
      if (apiItems.length === 0) {
        setError(`REF ${it.ref}: grade sem quantidades`);
        return false;
      }
      const itemIds: string[] = [];
      for (const ai of apiItems) {
        const criado = await api<{ id: string }>(`/purchase-orders/${oid}/items`, {
          method: 'POST',
          body: JSON.stringify(ai),
        });
        if (criado?.id) itemIds.push(criado.id);
      }
      updateItem(tempId, { serverItemIds: itemIds });
      // Recolhe a REF salva (vira o barzinho compacto). Com 40+ REFs na tela,
      // manter todo card aberto — grade + selects + precificação — deixava o
      // navegador de joelhos (caso 11/08: 43 REFs = digitação travando).
      // Só o card em edição fica montado por inteiro.
      setConferidoAbertoId(null);
      return true;
    } catch (e: any) {
      setError(`Salvar REF ${it.ref}: ${e?.message || 'erro'}`);
      return false;
    } finally {
      conferindoIdRef.current = null;
      setConferindoId(null);
    }
  };

  /**
   * CORRIGIR REF CONFERIDA (11/08, dono): estorna a conferência no servidor
   * (as peças saem do estoque — Flow + Giga via outbox) e o card volta a ser
   * editável como pendente. Pra consertar conferência acidental (o Enter
   * antigo conferia) ou dado errado numa REF já recebida.
   */
  const corrigirRefConferida = async (tempId: string) => {
    const it = items.find((i) => i.tempId === tempId);
    if (!it?.conferido || !it.serverItemIds?.length) return;
    if (!confirm(
      `Corrigir a REF ${it.ref}?\n\n` +
      `As ${it.conferido.pecas} peça(s) SAEM do estoque e a REF volta a ser ` +
      `editável (pendente). Confira de novo quando a mercadoria chegar.`,
    )) return;
    setError(null);
    try {
      const r = await api<{ ok: boolean; errors: string[] }>(
        `/purchase-orders/${it.conferido.orderId}/unreceive`,
        { method: 'POST', body: JSON.stringify({ itemIds: it.serverItemIds }) },
      );
      if (!r.ok && r.errors?.length) {
        setError(`Corrigir REF ${it.ref}: ${r.errors.join(' · ')}`);
        return;
      }
      updateItem(tempId, { conferido: undefined, precoTravado: true });
      setConferidoAbertoId(null);
    } catch (e: any) {
      setError(`Corrigir REF ${it.ref}: ${e?.message || 'erro'}`);
    }
  };

  const salvarRefEAdicionarProxima = async (tempId: string) => {
    await completeGradeAndPrepareNext(
      () => salvarRefNoPedido(tempId),
      () => {
        const novaRefId = newTempId();
        adicionarItem(novaRefId);
        return novaRefId;
      },
      setFocusRefId,
    );
  };

  const salvar = async () => {
    setError(null);
    const cnpjFinal = resolverCnpjFornecedor();
    if (!cnpjFinal) return;
    if (items.length === 0) {
      setError('Adicione ao menos 1 item');
      return;
    }
    // REFs conferidas JÁ estão no pedido (servidor) — o Salvar cuida do resto.
    const pendentes = items.filter((i) => !i.conferido);
    for (const it of pendentes) {
      const vErr = validarItemForm(it);
      if (vErr) { setError(vErr); return; }
    }

    setSaving(true);
    try {
      // Salva novas categorias (se grupo+subgrupo ainda não existirem)
      for (const it of pendentes) await salvarCategoriaSeNova(it);
      // Monta items pro POST: 1 ItemForm pode virar VÁRIOS items (1 por cor)
      const apiItems: any[] = pendentes.flatMap((it) => montarApiItems(it));

      if (orderId) {
        // Pedido já existe (criado no 1º Conferir ou reaberto): atualiza o
        // cabeçalho e regrava só o que ainda não foi conferido.
        await api(`/purchase-orders/${orderId}`, {
          method: 'PATCH',
          body: JSON.stringify(headerPayload(cnpjFinal)),
        });
        // Cards pendentes são regravados: apaga os antigos antes (tolerante a
        // id velho + limpa órfãos da mesma REF — ver apagarItensPendentesDaRef).
        for (const it of pendentes) {
          await apagarItensPendentesDaRef(orderId, it.ref, it.serverItemIds || []);
        }
        for (const ai of apiItems) {
          await api(`/purchase-orders/${orderId}/items`, { method: 'POST', body: JSON.stringify(ai) });
        }
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        router.push(`/loja/pedidos-compra/${orderId}`);
        return;
      }

      const r = await api<{ id: string }>('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({ ...headerPayload(cnpjFinal), items: apiItems }),
      });
      try { localStorage.removeItem(DRAFT_KEY); } catch {}
      router.push(`/loja/pedidos-compra/${r.id}`);
    } catch (e: any) {
      setError(e?.message || 'Erro ao salvar');
      setSaving(false);
    }
  };

  return (
    <PoShell
      crumbs={[
        { label: 'Loja', href: '/loja' },
        { label: 'Pedidos de compra', href: '/loja/pedidos-compra' },
        { label: orderId ? 'Lançamento' : 'Novo pedido' },
      ]}
    >
          {/* Cabeçalho da página */}
          <div className="po-page-head">
            <div className="po-page-icon">
              <FilePlus2 className="w-6 h-6" />
            </div>
            <h1 className="po-page-title">Pedido de Compra</h1>
            <span className="po-page-badge">{orderId ? 'Pedido salvo' : 'Novo pedido'}</span>
            <div className="po-page-stats">
              <div className="po-page-stat">
                <b>{items.length}</b>
                <span>referência{items.length === 1 ? '' : 's'}</span>
              </div>
              <div className="po-page-stat">
                <b>{totalPecas}</b>
                <span>peças</span>
              </div>
              <div className="po-page-stat">
                <b>R$ {totalCusto.toFixed(2).replace('.', ',')}</b>
                <span>valor total</span>
              </div>
            </div>
            <div className="po-page-actions">
              <button
                onClick={salvar}
                disabled={saving || !!conferindoId || carregandoPedido || items.length === 0}
                className="po-btn-secondary"
                title="Salva o pedido como está (rascunho no servidor)"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Salvar rascunho
              </button>
              <button
                onClick={salvar}
                disabled={saving || !!conferindoId || carregandoPedido || items.length === 0}
                className="po-save-button"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {orderId && items.every((i) => i.conferido) ? 'Abrir pedido' : 'Salvar pedido'}
              </button>
            </div>
          </div>

          <main className="space-y-5">
        {carregandoPedido && (
          <div className="rounded-xl border border-[#e4e8ee] bg-white p-3 text-sm font-bold text-[#16233a] shadow-sm">
            Carregando pedido…
          </div>
        )}
        {error && (
          <div ref={errorRef} className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-3 flex items-center gap-2">
            <AlertCircle className="w-5 h-5" />
            <span className="text-sm font-bold">{error}</span>
          </div>
        )}

        {draftRestauradoEm && (
          <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-xl p-3 flex flex-wrap items-center gap-3">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span className="text-sm font-bold flex-1 min-w-[240px]">
              Rascunho recuperado
              {(() => {
                try {
                  const d = new Date(draftRestauradoEm);
                  return isNaN(d.getTime()) ? '' : ` (salvo às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})`;
                } catch { return ''; }
              })()}
              {' '}— as REFs que você digitou estão de volta. Confira e clique em <u>Salvar pedido</u>.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDraftRestauradoEm(null)}
                className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700"
              >
                Continuar daqui
              </button>
              <button
                type="button"
                onClick={descartarRascunho}
                className="px-3 py-1.5 rounded-lg border border-amber-400 text-amber-800 text-xs font-bold hover:bg-amber-100"
              >
                Descartar rascunho
              </button>
            </div>
          </div>
        )}

        {/* Header do pedido */}
        <section className="po-panel">
          <div className="po-panel-head">
            <div>
              <h2 className="po-panel-title">Dados do pedido</h2>
              <p className="po-panel-subtitle">Informações comerciais e fornecedor</p>
            </div>
            <span className="po-panel-hint hidden sm:inline-flex">
              <Clock3 />
              Defina fornecedor, marca e coleção uma única vez
            </span>
          </div>
          <div className="space-y-4">

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            {/* Fornecedor autocomplete */}
            <div className="relative lg:col-span-4">
              <label className="po-label">
                Fornecedor
                <span className="text-[10px] text-slate-400 font-normal ml-2">
                  ({fornecedores.length} no Wincred, {fornecedoresFiltered.length} mostrados)
                </span>
                {fornecedorNome.trim() && !fornecedorCnpj.trim() && (
                  <span className="ml-2 text-[10px] font-black text-rose-600 bg-rose-50 px-2 py-0.5 rounded uppercase">
                    ⚠ CNPJ vazio — selecione da lista
                  </span>
                )}
                {fornecedorCnpj.trim() && (
                  <span className="ml-2 text-[10px] font-black text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded uppercase">
                    ✓ CNPJ {fornecedorCnpj}
                  </span>
                )}
              </label>
              <div className="po-input-icon-wrap">
                <input
                  value={fornecedorNome}
                  onChange={(e) => {
                    setFornecedorNome(e.target.value);
                    // Se user editou nome, invalida CNPJ ate clicar no autocomplete
                    if (fornecedorCnpj) setFornecedorCnpj('');
                    setShowFornDropdown(true);
                  }}
                  onFocus={() => setShowFornDropdown(true)}
                  onBlur={() => {
                    setTimeout(() => setShowFornDropdown(false), 200);
                    handleFornecedorBlur();
                  }}
                  placeholder="Digite a MARCA do fornecedor (ex: MARRIE, MALWEE)..."
                  className={`po-input ${
                    fornecedorNome.trim() && !fornecedorCnpj.trim()
                      ? 'border-rose-400 bg-rose-50'
                      : fornecedorCnpj.trim()
                      ? 'border-emerald-300 bg-emerald-50'
                      : ''
                  }`}
                />
                <Search />
              </div>
              {showFornDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[#e4e8ee] rounded-xl shadow-2xl max-h-72 overflow-y-auto z-10">
                  {fornecedoresFiltered.length > 0 ? (
                    fornecedoresFiltered.map((f) => (
                      <button
                        key={f.cnpj + f.nome}
                        type="button"
                        onClick={() => escolherFornecedor(f)}
                        className="w-full text-left px-3 py-2 hover:bg-[#fbf4e3] border-b border-slate-100 last:border-b-0"
                      >
                        <div className="font-bold text-sm text-[#16233a]">
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

            <div className="lg:col-span-2">
              <label className="po-label">Marca</label>
              <input
                value={marca}
                onChange={(e) => setMarca(e.target.value.toUpperCase())}
                placeholder="Ex: MARRIE"
                className="po-input font-mono uppercase"
              />
            </div>

            <div className="lg:col-span-2">
              <SelectAtributoPeca
                tipo="colecao"
                label="Coleção"
                opcoes={atributos.colecao}
                value={colecaoPedidoId}
                onCriado={aoCriarAtributo}
                onChange={(v) => {
                  setColecaoPedidoId(v);
                  setItems((atuais) => applyPurchaseOrderCollection(atuais, v));
                }}
              />
            </div>

            <div className="lg:col-span-2">
              <label className="po-label">Data prevista</label>
              <input
                type="date"
                value={dataPrevista}
                onChange={(e) => setDataPrevista(e.target.value)}
                className="po-input"
              />
            </div>
            <div className="lg:col-span-2">
              <label className="po-label">NF (opcional)</label>
              <input
                value={nfNumero}
                onChange={(e) => setNfNumero(e.target.value)}
                placeholder="Número da NF"
                className="po-input"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            <div className="lg:col-span-2">
              <label className="po-label">Fator padrão</label>
              <div className="relative">
                <input
                  value={markup}
                  onChange={(e) => setMarkup(e.target.value.replace(',', '.'))}
                  placeholder="2,35"
                  inputMode="decimal"
                  className="po-input font-mono font-bold"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#a6afbd] font-bold pointer-events-none">
                  ×
                </span>
              </div>
              <div className="text-[11px] text-[#8a94a3] mt-1">
                Custo líquido × markup = preço sugerido
              </div>
            </div>
            <div className="lg:col-span-10">
              <label className="po-label">Observações</label>
              <textarea
                value={observacoes}
                onChange={(e) => setObservacoes(e.target.value)}
                rows={2}
                placeholder="Observações sobre o pedido, fornecedor ou condições comerciais..."
                className="po-input po-observations"
              />
              <div className="po-char-counter">{observacoes.length}/500</div>
            </div>
          </div>
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
              atributos={atributos}
              onCriarAtributo={aoCriarAtributo}
              markup={markup}
              getSubgrupos={getSubgrupos}
              onRefreshGrupos={refetchGrupos}
              onUpdate={(patch) => updateItem(item.tempId, patch)}
              onRemove={() => removerItem(item.tempId)}
              onDuplicate={() => duplicarItem(item.tempId)}
              onConferir={() => conferirAgora(item.tempId)}
              onConferirEtiquetas={() => conferirAgora(item.tempId, { abrirEtiquetas: true })}
              onConferirEAvancar={() => salvarRefEAdicionarProxima(item.tempId)}
              onCorrigir={() => corrigirRefConferida(item.tempId)}
              conferindo={conferindoId === item.tempId}
              onAplicarCategoria={(desc) => aplicarCategoriaSeExistir(item.tempId, desc)}
              onAddCor={(c) => adicionarCor(item.tempId, c)}
              onRemoveCor={(c) => removerCor(item.tempId, c)}
              onAddTam={(t) => adicionarTamanho(item.tempId, t)}
              onRemoveTam={(t) => removerTamanho(item.tempId, t)}
              onGrade={(c, t, v) => setGradeCell(item.tempId, c, t, v)}
              expanded={!isPurchaseOrderItemCollapsed(
                // REF salva no pedido (Enter) recolhe igual à conferida — com
                // 40+ REFs, cards abertos matavam a performance da tela.
                !!item.conferido || (item.serverItemIds?.length ?? 0) > 0,
                conferidoAbertoId,
                item.tempId,
              )}
              onToggleExpanded={() =>
                setConferidoAbertoId((atual) =>
                  toggleExpandedPurchaseOrderItem(atual, item.tempId),
                )
              }
            />
          ))}

          <button
            onClick={() => adicionarItem()}
            className="po-add-ref"
          >
            <Plus className="w-5 h-5" />
            Adicionar nova REF
          </button>
        </section>
      </main>
    </PoShell>
  );
}

// ─── ItemEditor ─────────────────────────────────────────────────────────
function ItemEditor({
  item, index, grupos, categorias, markup,
  getSubgrupos,
  onUpdate, onRemove, onDuplicate, onAplicarCategoria,
  onAddCor, onRemoveCor, onAddTam, onRemoveTam, onGrade,
  onRefreshGrupos, atributos, onCriarAtributo,
  onConferir, onConferirEtiquetas, onConferirEAvancar, onCorrigir, conferindo, expanded, onToggleExpanded,
}: {
  item: ItemForm;
  index: number;
  grupos: Grupo[];
  categorias: Categoria[];
  atributos: AtributosPorTipo;
  onCriarAtributo: (tipo: TipoAtributo, novo: Atributo) => void;
  markup: string;
  getSubgrupos: (grupoCode: number) => Promise<Grupo[]>;
  onUpdate: (patch: Partial<ItemForm>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onConferir: () => Promise<boolean>;
  onConferirEtiquetas: () => Promise<boolean>;
  onConferirEAvancar: () => Promise<void>;
  onCorrigir: () => Promise<void>;
  conferindo: boolean;
  onAplicarCategoria: (desc: string) => void;
  onAddCor: (c: string) => void;
  onRemoveCor: (c: string) => void;
  onAddTam: (t: string) => void;
  onRemoveTam: (t: string) => void;
  onGrade: (c: string, t: string, v: string) => void;
  onRefreshGrupos?: () => Promise<Grupo[]>;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  // Flag pra saber se o preço foi mexido manualmente (não auto-sobrescrever)
  const [precoEditadoManual, setPrecoEditadoManual] = useState(!!item.precoTravado);
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

  // Carrega subgrupos do grupo selecionado (usa cache do parent)
  useEffect(() => {
    if (!item.grupoCode) {
      setSubgrupos([]);
      return;
    }
    getSubgrupos(item.grupoCode).then(setSubgrupos);
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

  // REF salva no pedido pelo Enter (pendente, sem estoque) também recolhe —
  // performance: 40+ cards abertos travavam a digitação (caso 11/08).
  const salvaNoPedido = !item.conferido && (item.serverItemIds?.length ?? 0) > 0;

  if ((item.conferido || salvaNoPedido) && !expanded) {
    return (
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={false}
        aria-controls={`pedido-item-corpo-${item.tempId}`}
        aria-label={`Reabrir REF ${item.ref.trim().toUpperCase()}`}
        className="po-collapsed-ref group focus:outline-none focus:ring-2 focus:ring-[#d3ac52] focus:ring-offset-2"
      >
        <span className="po-collapsed-bar" aria-hidden="true" />
        <span className="flex flex-1 items-center justify-between gap-3 px-5 py-3">
          <span className="inline-flex items-center gap-2 text-base font-extrabold uppercase tracking-wide text-[#16233a]">
            {item.conferido ? (
              <CheckCircle2 className="h-4.5 w-4.5 text-emerald-600" aria-hidden="true" />
            ) : (
              <Check className="h-4.5 w-4.5 text-sky-600" aria-hidden="true" />
            )}
            REF {item.ref.trim().toUpperCase()}
          </span>
          <span className="ml-auto flex items-center gap-3">
            <span className="text-[11px] font-bold text-[#8a94a3] normal-case tracking-normal">
              {item.conferido
                ? `Conferida · ${item.conferido.pecas} pç no estoque`
                : `Salva no pedido · ${totalLinha} pç — clique pra editar`}
            </span>
            <ChevronDown
              className="h-5 w-5 shrink-0 text-[#c19a2e] transition-transform group-hover:translate-y-0.5"
              aria-hidden="true"
            />
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className={`po-item-card ${item.conferido ? 'border-[#d3ac52]' : ''}`}>
      {/* Header da REF */}
      <div className="po-item-toolbar">
        {item.conferido || salvaNoPedido ? (
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={true}
            aria-controls={`pedido-item-corpo-${item.tempId}`}
            className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm font-extrabold uppercase tracking-wide text-[#16233a] hover:bg-[#fbf4e3] focus:outline-none focus:ring-2 focus:ring-[#d3ac52]"
            title="Recolher esta referencia"
          >
            <ChevronDown className="h-4 w-4 rotate-180 text-[#c19a2e]" aria-hidden="true" />
            REF {item.ref.trim().toUpperCase()}
          </button>
        ) : (
          <div className="po-item-title">
            <Tag aria-hidden="true" />
            Item {String(index).padStart(2, '0')}
            {item.ref.trim() && <span className="font-bold text-[#55647a]">— Ref. {item.ref.trim().toUpperCase()}</span>}
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <span className="po-item-summary">
            <b>{totalLinha}</b> peças <span className="mx-1 text-[#c9cfd8]">•</span> R$ {custoTotal.toFixed(2).replace('.', ',')}
          </span>
          {item.conferido ? (
            <>
              <span
                className="text-[11px] font-extrabold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1.5 rounded-lg"
                title="REF conferida: cadastrada e com estoque lançado. Pra editar, use o Corrigir (estorna o estoque e libera o card)."
              >
                ✓ Conferida · {item.conferido.pecas} pç no estoque
                {item.conferido.erros > 0 ? ` · ${item.conferido.erros} erro(s)` : ''}
              </span>
              <button
                type="button"
                onClick={onCorrigir}
                className="po-action-secondary"
                title="Estorna a conferência: as peças saem do estoque e a REF volta a ser editável"
              >
                Corrigir
              </button>
              <button
                onClick={() =>
                  window.open(
                    `/loja/pedidos-compra/${item.conferido!.orderId}/etiquetas?ref=${encodeURIComponent(item.ref.trim().toUpperCase())}`,
                    '_blank',
                  )
                }
                className="po-icon-action"
                title="Reabrir etiquetas desta REF"
              >
                <Printer className="w-4 h-4" />
              </button>
              <button type="button" onClick={onDuplicate} className="po-icon-action" title="Duplicar referência" aria-label="Duplicar referência">
                <Copy className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              {(item.serverItemIds?.length ?? 0) > 0 && (
                <span
                  className="text-[11px] font-extrabold text-sky-700 bg-sky-50 border border-sky-200 px-2.5 py-1.5 rounded-lg"
                  title="REF gravada no pedido (pendente de recebimento — estoque só entra no Conferir)"
                >
                  ✓ Salva no pedido
                </span>
              )}
              <button
                type="button"
                onClick={onConferirEtiquetas}
                disabled={conferindo}
                className="po-action-secondary"
                title="Conferir e gerar etiquetas desta REF (abre a aba de etiquetas)"
              >
                <Tag className="w-4 h-4" />
                Etiquetas
              </button>
              <button type="button" onClick={onDuplicate} className="po-action-secondary" title="Duplicar referência">
                <Copy className="w-4 h-4" />
                Duplicar
              </button>
              <button type="button" onClick={onRemove} className="po-delete-action" title="Excluir referência" aria-label="Excluir referência">
                <Trash2 className="w-4 h-4" />
                <span>Excluir</span>
              </button>
              <button
                type="button"
                onClick={onConferir}
                disabled={conferindo}
                title="Confere a REF e lança o estoque"
                className="po-action"
              >
                {conferindo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Conferir
              </button>
            </>
          )}
        </div>
      </div>

      {/* Corpo travado após conferir — a partir daí a verdade é o servidor */}
      <fieldset
        id={`pedido-item-corpo-${item.tempId}`}
        disabled={!!item.conferido}
        className={`min-w-0 border-0 p-0 m-0 space-y-3 ${item.conferido ? 'opacity-55 pointer-events-none' : ''}`}
      >
      <section className="po-item-section">
        <div className="po-subsection">Produto</div>
        <div className="space-y-5">

      {/* Linha 1: REF destacada + Plus Size compacto */}
      <div className="po-identity-primary grid grid-cols-1 items-end gap-4 sm:grid-cols-[minmax(240px,320px)_minmax(240px,300px)_1fr]">
        <div className="po-ref-box">
          <span className="po-ref-box-label">Referência *</span>
          <input
            value={item.ref}
            onChange={(e) => onUpdate({ ref: e.target.value.toUpperCase() })}
            placeholder="7031"
            data-ref-input={item.tempId}
            className="po-ref-input"
          />
        </div>
        <label className={`po-plus-toggle ${item.plusSize ? 'is-active' : ''}`}>
          <input
            type="checkbox"
            checked={item.plusSize}
            onChange={(e) => onUpdate({ plusSize: e.target.checked })}
          />
          <span className="po-plus-symbol" aria-hidden="true"><Shirt /></span>
          <span className="po-plus-copy">
            <strong>Plus Size</strong>
            <small>Grade 46–60</small>
          </span>
          <span className="po-plus-switch" aria-hidden="true"><span /></span>
        </label>
      </div>

      {/* Linha 2: classificação principal, sem campos fiscais visíveis */}
      <div className="po-classification-grid grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <div className="flex items-center justify-between">
            <label className="po-label">Grupo *</label>
            <button type="button" onClick={handleCriarGrupo} disabled={criandoGrupo}
              title="Criar novo grupo no Wincred"
              className="po-new-link">
              {criandoGrupo ? '...' : '+ novo'}
            </button>
          </div>
          <select
            value={item.grupoCode || ''}
            onChange={(e) => {
              const code = Number(e.target.value);
              const g = grupos.find((x) => x.codigo === code);
              onUpdate({
                grupoCode: code,
                grupoNome: g?.nome || '',
                subgrupoCode: null,
                subgrupoNome: '',
                ncm: '',
              });
            }}
            className="po-select"
          >
            <option value="">— selecione —</option>
            {grupos.map((g) => (
              <option key={g.codigo} value={g.codigo}>{g.nome}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="po-label">Subgrupo *</label>
            <button type="button" onClick={handleCriarSubgrupo} disabled={criandoSubgrupo || !item.grupoCode}
              title="Criar novo subgrupo no grupo atual"
              className="po-new-link">
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
            className="po-select disabled:opacity-50"
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
        <SelectAtributoPeca
          tipo="tecido"
          label="Tecido"
          opcoes={atributos.tecido}
          value={item.tecidoId}
          onCriado={onCriarAtributo}
          onChange={(v) => onUpdate({ tecidoId: v })}
        />
        <SelectAtributoPeca
          tipo="modelagem"
          label="Modelagem"
          multiplo
          opcoes={atributos.modelagem}
          values={item.modelagemIds}
          onCriado={onCriarAtributo}
          onChangeMany={(v) => onUpdate({ modelagemIds: v })}
        />
        <SelectAtributoPeca
          tipo="ocasiao"
          label="Ocasião"
          multiplo
          opcoes={atributos.ocasiao}
          values={item.ocasiaoIds}
          onCriado={onCriarAtributo}
          onChangeMany={(v) => onUpdate({ ocasiaoIds: v })}
        />
      </div>
        </div>
      </section>

      {/* PRECIFICAÇÃO — custo e venda em destaque, ajustes compactos */}
      <section className="po-item-section">
        <div className="po-subsection">Precificação</div>
      <div className="po-price-band">
        <div className="grid grid-cols-2 gap-2 items-end md:grid-cols-6 lg:grid-cols-12">
          {/* Custo */}
          <div className="lg:col-span-2">
            <label className="po-label">Custo R$ *<span className="po-info" title="Custo unitário de compra da peça">ⓘ</span></label>
            <input
              value={item.custoUnit}
              onChange={(e) => onUpdate({ custoUnit: e.target.value })}
              placeholder="10,00"
              inputMode="decimal"
              className="po-money-input po-cost-input"
            />
          </div>
          {/* Desconto */}
          <div className="po-compact-price lg:col-span-1">
            <label className="po-label">− Desc %</label>
            <input
              value={item.descontoPct}
              onChange={(e) => onUpdate({ descontoPct: e.target.value })}
              placeholder="0"
              inputMode="decimal"
              className="po-compact-input"
            />
          </div>
          {/* Tributo */}
          <div className="po-compact-price lg:col-span-1">
            <label className="po-label">+ Imp %</label>
            <input
              value={item.tributoPct}
              onChange={(e) => onUpdate({ tributoPct: e.target.value })}
              placeholder="0"
              inputMode="decimal"
              className="po-compact-input"
            />
          </div>
          {/* Custo líquido (calc) */}
          <div className="lg:col-span-1">
            <label className="po-label">Líquido<span className="po-info" title="Custo − desconto + imposto">ⓘ</span></label>
            <div className="po-calculated-value">
              {custoLiquido.toFixed(2).replace('.', ',')}
            </div>
          </div>
          {/* Fator compacto */}
          <div className="po-compact-price lg:col-span-1">
            <label className="po-label">Fator<span className="po-info" title={`Markup do item. Plus=${MARKUP_PLUS}, Reg=${MARKUP_REGULAR}`}>ⓘ</span></label>
            <input
              value={item.markup}
              onChange={(e) => { onUpdate({ markup: e.target.value }); setPrecoEditadoManual(false); }}
              placeholder={markup}
              inputMode="decimal"
              className="po-compact-input"
              title={`Markup do item. Plus=${MARKUP_PLUS}, Reg=${MARKUP_REGULAR}`}
            />
          </div>
          {/* Sugerido */}
          <div className="lg:col-span-2">
            <label className="po-label">Preço sugerido<span className="po-info" title="Custo líquido × fator, arredondado pra ,90 — clique pra aplicar">ⓘ</span></label>
            <button
              type="button"
              onClick={() => {
                onUpdate({ precoUnit: precoSugeridoRedondo.toFixed(2).replace('.', ',') });
                setPrecoEditadoManual(false);
              }}
              className="po-suggested-value"
              title="Clique pra aplicar"
            >
              {precoSugeridoRedondo.toFixed(2).replace('.', ',')}
            </button>
          </div>
          {/* Preço editável */}
          <div className="col-span-2 md:col-span-2 lg:col-span-4">
            <div className="po-sale-box">
              <span className="po-sale-box-label">Preço de venda <span className="po-info" title="É o preço que sai na etiqueta">ⓘ</span></span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[19px] font-extrabold text-[#c19a2e]">R$</span>
                <input
                  value={item.precoUnit}
                  onChange={(e) => {
                    setPrecoEditadoManual(true);
                    onUpdate({ precoUnit: e.target.value });
                  }}
                  placeholder="0,00"
                  inputMode="decimal"
                  className="po-money-input po-sale-input"
                />
              </div>
            </div>
          </div>
        </div>
        {/* Resumo de margem */}
        {precoVendaNum > 0 && custoLiquido > 0 && (
          <div className="po-margin-summary">
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

      </section>

      <section className="po-item-section">
        <div className="po-grade-bar">
          <div className="po-subsection !my-0">Grade e cores</div>
          <div className="po-grade-presets">
            {GRADE_PRESETS.map((g) => {
              const active = item.gradePresetId
                ? item.gradePresetId === g.id
                : (item.tamanhos.length === g.tamanhos.length
                   && item.tamanhos.every((t, i) => t === g.tamanhos[i]));
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => onUpdate({ tamanhos: [...g.tamanhos], plusSize: g.plusSize, grade: {}, markup: g.markup, gradePresetId: g.id })}
                  className={`po-preset ${active ? 'is-active' : ''}`}
                  title={`Aplicar: ${g.tamanhos.join(' • ')}`}
                >
                  {g.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-4">

      {/* Tamanhos (chips) */}
      <div className="po-grade-options-row">
        <div className="po-grade-row-label">Tamanhos da grade</div>
        <div className="flex flex-wrap gap-1 items-center">
          {item.tamanhos.map((t) => (
            <span key={t} className="po-size-chip">
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
            className="po-inline-add w-20 font-mono"
          />
        </div>
      </div>

      {/* Cores (chips) */}
      <div className="po-grade-options-row">
        <div className="po-grade-row-label">Cores</div>
        <div className="flex flex-wrap gap-1 items-center">
          {item.cores.map((c) => (
            <span key={c} className="po-color-chip">
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
            className="po-inline-add w-32 uppercase"
          />
        </div>
      </div>

      {/* Grade cor x tamanho */}
      {item.cores.length > 0 && item.tamanhos.length > 0 && (
        <div className="overflow-x-auto">
          <table className="po-grade-table w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left text-[10px] font-bold uppercase p-2">Cor</th>
                {item.tamanhos.map((t) => (
                  <th key={t} className="p-2 text-center text-[10px] font-mono">{t}</th>
                ))}
                <th className="p-2 text-center text-[10px]">TOT</th>
              </tr>
            </thead>
            <tbody>
              {item.cores.map((c) => {
                let total = 0;
                for (const t of item.tamanhos) total += Number(item.grade[`${c}|${t}`] || 0);
                return (
                  <tr key={c}>
                    <td className="p-2 font-black text-[#16233a] text-xs">{c}</td>
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
                              const nextIndex = getNextGradeInputIndex(idx, inputs.length);
                              if (nextIndex !== null) {
                                inputs[nextIndex]?.focus();
                              } else {
                                // Ultima quantidade: aguarda cadastro + estoque,
                                // recolhe a atual, cria outra REF e foca nela.
                                void onConferirEAvancar();
                              }
                            }
                          }}
                          data-grade={item.tempId}
                          placeholder="0"
                          inputMode="numeric"
                          className="po-grade-input"
                        />
                      </td>
                    ))}
                    <td className="p-2 text-center font-black text-[#16233a] tabular-nums text-sm">{total}</td>
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
      </section>
      </fieldset>
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
    <div className="bg-[#fdf9ee] border border-[#e8d9ab] rounded-xl p-3.5">
      <div className="flex items-center gap-2 mb-1">
        <Eye className="w-3.5 h-3.5 text-[#c19a2e]" />
        <span className="text-[11px] font-extrabold text-[#8a6d1f]">
          Descrição que vai pro cadastro
        </span>
        {combinacoes > 0 && (
          <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
            {combinacoes} SKU(s)
          </span>
        )}
      </div>
      <div className="font-mono text-sm font-extrabold text-[#16233a] break-all">
        {descricaoExemplo}
      </div>
      <div className="text-[11px] text-[#8a94a3] mt-1">
        Cada cor x tamanho gera um SKU com sua propria descricao. Acima e so um exemplo.
      </div>
    </div>
  );
}
