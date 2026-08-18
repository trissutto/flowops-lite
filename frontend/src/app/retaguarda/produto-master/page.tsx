'use client';

/**
 * TELA MASTER DE PRODUTOS — a ficha completa de uma peça, num lugar só.
 *
 * Cascata de três níveis (desenho do dono, 02/08):
 *   1. REF em destaque + nome curto        → seta pro lado abre o que é COMUM
 *   2. cores                               → seta pra baixo abre a cascata
 *   3. grade de estoque por loja           → ao clicar na cor
 *
 * O que é comum fica no nível 1 (tecido, modelagem, coleção, ocasião, medidas,
 * elasticidade, descrição); o que muda por cor fica no nível 2 (título, vídeo,
 * fotos, publicação). Sem essa divisão, tecido e modelagem teriam que ser
 * redigitados em cada cor da mesma peça.
 *
 * ESTA TELA NÃO CRIA PRODUTO. O produto nasce no pedido de compra; aqui ele é
 * ENRIQUECIDO com o que o site precisa e não existe no catálogo.
 *
 * Convive com as telas de massa (editor-produtos, classificação BÁSICO/MODA):
 * master é profundidade, um produto por vez. Ninguém edita 65 mil registros num
 * formulário de ficha.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  ChevronDown, ChevronRight, Image as ImageIcon, Loader2, Package, Save, Search, Truck,
} from 'lucide-react';
import {
  SelectAtributoPeca, type Atributo, type AtributosPorTipo, type TipoAtributo,
} from '@/components/SelectAtributoPeca';
import FotosDaCor, { type FotoCor, type SwatchCor } from '@/components/FotosDaCor';

/* ─────────────────────────────── Tipos ─────────────────────────────── */

type SkuRow = {
  codigo: string;
  ref: string;
  descricao: string;
  marca: string | null;
  cor: string;
  tamanho: string;
  preco: number | null;
  estoque: number | null;
  estoqueLojas?: Record<string, number>;
};

type AtributoRef = { id: string; nome: string };

type Grade = { id: string; nome: string; linhas: unknown[] };

type FichaCor = {
  cor: string;
  tituloComercial: string | null;
  youtubeUrl: string | null;
  statusPublicacao: string;
  fotos: FotoCor[];
  /** Bolinha do seletor de cor do site — ver <FotosDaCor>. */
  swatchTipo: 'cor' | 'foto';
  corHex: string | null;
  swatchFocoX: number | null;
  swatchFocoY: number | null;
};

type Ficha = {
  ref: string;
  marca: string;
  nomeCurto: string | null;
  descricao: string | null;
  tecidoId: string | null;
  colecaoId: string | null;
  ocasioes: AtributoRef[];
  modelagens: AtributoRef[];
  gradeMedidasId: string | null;
  elasticidade: string | null;
  cores: FichaCor[];
};

/** Uma peça da cascata: REF + MARCA + COR, com seus tamanhos. */
type Produto = {
  chave: string;
  ref: string;
  marca: string;
  cor: string;
  nomeCurto: string;
  precos: number[];
  skus: SkuRow[];
};

const STATUS_LABEL: Record<string, { texto: string; cor: string }> = {
  publicado: { texto: 'No ar', cor: 'bg-green-100 text-green-800' },
  pronto: { texto: 'Pronto pra publicar', cor: 'bg-sky-100 text-sky-800' },
  sem_fotos: { texto: 'Faltam fotos', cor: 'bg-amber-100 text-amber-800' },
  nao_publicar: { texto: 'Fora do site', cor: 'bg-slate-100 text-slate-600' },
};

/**
 * Transferência JÁ AUTORIZADA e ainda não concluída — o que responde
 * "essa peça eu já pedi?". Vem de /realignment/pendencias e cobre TODA origem
 * (realinhamento automático, tela de realinhamento, esta ficha).
 *
 * `pending` = pedido, peça ainda na loja (estoque não baixou).
 * `in_transit` = já saiu (origem já baixou; falta a entrada no destino).
 */
type Pendencia = {
  codigo: string;
  de: string;
  para: string;
  qty: number;
  status: 'pending' | 'in_transit';
};

/**
 * Um movimento = UMA peça saindo de uma loja pra outra. Arrastar de novo
 * empilha outra linha; é assim que "de 1 em 1" fica literal e o desfazer
 * volta exatamente um passo.
 */
type Movimento = {
  codigo: string;
  ref: string;
  cor: string;
  tamanho: string;
  desc: string;
  de: string;
  para: string;
  /** Estoque na origem ANTES de qualquer movimento — o backend pede. */
  estoqueOrigemAntes: number;
};

const ELASTICIDADE_LABEL: [string, string][] = [
  ['', '— não informado —'],
  ['nao', 'Não estica'],
  ['pouco', 'Estica pouco'],
  ['muito', 'Estica muito'],
];

/**
 * Nome curto = descrição sem o que já tem coluna própria (cor, tamanho, ref e
 * marca). O sistema COMPÔS a descrição com esses pedaços no pedido de compra,
 * então tirar é seguro — e as descrições não são uniformes: uma já vem limpa,
 * outra carrega tudo embutido.
 */
function derivarNomeCurto(row: SkuRow): string {
  const partes = [row.cor, row.tamanho, row.ref, row.marca ?? ''].filter(Boolean);
  let texto = ` ${row.descricao} `.toUpperCase();
  for (const p of partes) {
    texto = texto.split(new RegExp(`\\b${p.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')).join(' ');
  }
  return texto.replace(/\s+/g, ' ').trim() || row.descricao;
}

export default function ProdutoMasterPage() {
  const [busca, setBusca] = useState('');
  const [linhas, setLinhas] = useState<SkuRow[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [atributos, setAtributos] = useState<AtributosPorTipo>({});
  const [grades, setGrades] = useState<Grade[]>([]);
  // A árvore do site é carregada UMA vez aqui e desce pro seletor de
  // vitrines: buscar por peça aberta repetiria a mesma consulta a cada clique.
  const [arvore, setArvore] = useState<ArvoreSite | null>(null);

  // Cascata: qual REF está com o painel comum aberto, quais cores expandidas
  const [refAberta, setRefAberta] = useState<string | null>(null);
  const [corAberta, setCorAberta] = useState<string | null>(null);

  const [fichas, setFichas] = useState<Record<string, Ficha | null>>({});

  // Rascunho de remessa: acumula os arrastos e só vira ordem quando autoriza.
  // Arrastar erra fácil e remessa mexe em peça física e no acerto entre lojas.
  const [movimentos, setMovimentos] = useState<Movimento[]>([]);
  /**
   * Espelho SÍNCRONO do rascunho. A guarda de saldo não pode ler o estado do
   * closure: dois arrastos rápidos chegam antes do re-render e os dois veem a
   * lista velha — foi assim que 3 peças passaram com 2 disponíveis no teste.
   * Toda mudança em `movimentos` passa por `mudarMovimentos`, que atualiza o
   * ref na hora; a guarda lê o ref e nunca vê passado.
   */
  const movimentosRef = useRef<Movimento[]>([]);
  const mudarMovimentos = useCallback((fn: (m: Movimento[]) => Movimento[]) => {
    movimentosRef.current = fn(movimentosRef.current);
    setMovimentos(movimentosRef.current);
  }, []);
  const [autorizando, setAutorizando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  /** Origem escolhida no modo clique (alternativa ao arrasto, serve em tablet). */
  const [origemSel, setOrigemSel] = useState<{ codigo: string; loja: string } | null>(null);

  /** Transferências abertas/em trânsito dos códigos em tela. */
  const [pendencias, setPendencias] = useState<Pendencia[]>([]);

  const carregarPendencias = useCallback(async (codigos: string[]) => {
    if (!codigos.length) { setPendencias([]); return; }
    try {
      setPendencias(await api<Pendencia[]>('/realignment/pendencias', {
        method: 'POST',
        body: JSON.stringify({ skus: codigos }),
      }));
    } catch {
      // Sem pendências ninguém fica travado; só perde o marcador visual.
      setPendencias([]);
    }
  }, []);

  /**
   * Código → sigla da loja. "03" não diz nada pra quem opera; "INDAI" diz.
   * Mesma abreviação do editor de produtos (5 letras, sem acento), pra as duas
   * telas mostrarem a mesma coisa.
   */
  const [lojaNomes, setLojaNomes] = useState<Map<string, string>>(new Map());
  /** Toda mensagem e caminho usa a SIGLA — codigo so em tooltip. */
  const sigla = useCallback((c: string) => lojaNomes.get(c) || c, [lojaNomes]);

  useEffect(() => {
    api<AtributosPorTipo>('/atributos-peca').then(setAtributos).catch(() => {});
    api<Grade[]>('/produto-ficha/grades').then(setGrades).catch(() => {});
    api<ArvoreSite>('/loja-catalog/classificacao/arvore').then(setArvore).catch(() => {});
    api<Array<{ code: string; name: string }>>('/stores')
      .then((lista) => {
        const m = new Map<string, string>();
        for (const s of lista || []) {
          const sigla = Array.from(String(s.name || '').normalize('NFD'))
            .filter((c) => { const cp = c.codePointAt(0) ?? 0; return cp < 0x0300 || cp > 0x036f; })
            .join('')
            .replace(/[^A-Za-z0-9 ]/g, '').trim().toUpperCase().slice(0, 5);
          if (s.code && sigla) m.set(String(s.code), sigla);
        }
        setLojaNomes(m);
      })
      .catch(() => {});
  }, []);

  const buscar = useCallback(async () => {
    const q = busca.trim();
    if (q.length < 2) { setErro('Digite ao menos 2 caracteres'); return; }
    setBuscando(true);
    setErro(null);
    try {
      // ⚠️ O endpoint devolve { rows, fonte, warnings } — NÃO o array puro.
      // Jogar a resposta inteira no estado fazia o `for...of` do useMemo
      // estourar ("a is not iterable") e derrubar a tela inteira no boundary
      // do Next, com "Application error" e nada mais.
      const resp = await api<{ rows?: SkuRow[] }>(`/products-editor/search?q=${encodeURIComponent(q)}`);
      let rows = resp?.rows ?? [];

      // Caso BMM-100 PRETO: a busca exige TODAS as palavras, e quem digita
      // "REF + cor" não acha nada quando a REF não tem aquela cor. A Consultar
      // resolve a REF primeiro — aqui, sem resultado e com mais de uma
      // palavra, tenta de novo só com a primeira e avisa o que aconteceu.
      const palavras = q.split(/\s+/).filter(Boolean);
      if (rows.length === 0 && palavras.length > 1) {
        const so1 = await api<{ rows?: SkuRow[] }>(
          `/products-editor/search?q=${encodeURIComponent(palavras[0])}`,
        );
        if (so1?.rows?.length) {
          rows = so1.rows;
          setAviso(
            `Nada bateu com "${q}" — mostrando "${palavras[0]}". ` +
            `Confira nas cores abaixo se "${palavras.slice(1).join(' ')}" existe nessa REF.`,
          );
        }
      }

      setLinhas(rows);
      if (rows.length === 0) setErro(`Nada encontrado pra "${q}"`);
      // Marca o que já tem transferência aberta — é o "já pedi?" da grade.
      void carregarPendencias([...new Set(rows.map((r) => r.codigo))]);
    } catch (e: any) {
      setErro(e?.message || 'Busca falhou');
      setLinhas([]);
    } finally {
      setBuscando(false);
    }
  }, [busca, carregarPendencias]);

  /**
   * CHEGOU DA FILA DA FICHA (`?busca=REF`) — já busca sozinho.
   *
   * Sem isto o botão "Preencher" da fila abriria a master vazia e a pessoa
   * teria que digitar de novo a REF que acabou de clicar. Fila que não leva ao
   * trabalho vira relatório, e relatório ninguém abre duas vezes.
   *
   * Lê de `window.location.search` em vez de `useSearchParams` de propósito:
   * o hook exige Suspense no App Router e derruba o build da página inteira —
   * aqui a leitura é uma vez, na montagem, num componente que já é client.
   */
  const [buscaDaUrl, setBuscaDaUrl] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('busca')?.trim();
    if (q && q.length >= 2) {
      setBusca(q);
      setBuscaDaUrl(q);
    }
  }, []);
  useEffect(() => {
    if (!buscaDaUrl || busca !== buscaDaUrl) return;
    setBuscaDaUrl(null); // dispara uma vez só
    void buscar();
  }, [buscaDaUrl, busca, buscar]);

  /**
   * Agrupa os SKUs em REF-BASE + MARCA → COR.
   *
   * BASE, não a REF do cadastro: no ERP a cor virou sufixo de REF na mão, e
   * "VMS-223", "VMS-223 MA", "VMS-223 MM", "VMS-223 P" são O MESMO VESTIDO em
   * quatro cadastros. Agrupando pela REF crua a tela mostrava quatro produtos
   * de uma cor cada — e o site herdaria isso, quando o objetivo desta tela é
   * exatamente o contrário: UM produto com quatro bolinhas de cor.
   *
   * MARCA continua na chave porque REF numérica é reciclada entre
   * fornecedores: dois "222" de marcas diferentes são peças diferentes.
   *
   * `refBase` é a mesma regra do backend (`common/ref-base.ts`): corta tudo
   * depois do último dígito. Se mudar lá, muda aqui.
   */
  const porRef = useMemo(() => {
    const refBase = (r: string) => {
      const up = String(r ?? '').trim().toUpperCase();
      return up.replace(/[^0-9]+$/, '') || up;
    };
    const mapa = new Map<string, { ref: string; marca: string; nomeCurto: string; produtos: Produto[] }>();
    // Guarda de forma: se a API mudar de formato de novo, a tela fica vazia em
    // vez de morrer inteira. Um useMemo que estoura sobe pro error boundary e
    // apaga a página — inclusive a busca, que é o único jeito de sair do erro.
    if (!Array.isArray(linhas)) return [];
    for (const row of linhas) {
      const marca = (row.marca || 'SEM MARCA').toUpperCase();
      const base = refBase(row.ref);
      const chaveRef = `${base}|${marca}`;
      if (!mapa.has(chaveRef)) {
        mapa.set(chaveRef, { ref: base, marca, nomeCurto: derivarNomeCurto(row), produtos: [] });
      }
      const grupo = mapa.get(chaveRef)!;
      const cor = (row.cor || 'ÚNICA').toUpperCase();
      let prod = grupo.produtos.find((p) => p.cor === cor);
      if (!prod) {
        // `ref` da cor é a BASE — é a chave de ficha e de foto. O cadastro
        // original de cada cor continua em `skus[].codigo`, que é o que a
        // edição de estoque e preço usa.
        prod = { chave: `${chaveRef}|${cor}`, ref: base, marca, cor, nomeCurto: grupo.nomeCurto, precos: [], skus: [] };
        grupo.produtos.push(prod);
      }
      prod.skus.push(row);
      if (row.preco != null) prod.precos.push(row.preco);
    }
    for (const g of mapa.values()) {
      g.produtos.sort((a, b) => a.cor.localeCompare(b.cor));
      for (const p of g.produtos) p.skus.sort((a, b) => a.tamanho.localeCompare(b.tamanho, 'pt-BR', { numeric: true }));
    }
    return [...mapa.entries()].map(([chave, v]) => ({ chave, ...v }));
  }, [linhas]);

  /**
   * Move UMA peça. Recusa quando origem = destino ou quando a origem já ficou
   * sem saldo — sem essa checagem dá pra arrastar estoque que não existe e a
   * ordem nasce impossível de separar.
   *
   * ⚠️ A checagem e o aviso ficam FORA do updater de propósito. Antes eu
   * calculava o saldo e chamava `setAviso` dentro do `setMovimentos(...)`:
   * updater com efeito colateral não é puro, o React pode reexecutá-lo, e o
   * mesmo arrasto entrava duas vezes — foi assim que apareceu estoque -1 numa
   * loja que só tinha 1 peça.
   */
  const moverUma = useCallback((row: SkuRow, de: string, para: string) => {
    if (de === para) return;
    // Já prometido a uma remessa ABERTA também sai do disponível — é a raiz do
    // "pedi duas vezes": o estoque só baixa no envio, mas a peça já tem dono.
    // (in_transit não desconta: a origem já baixou quando saiu.)
    const prometidas = pendencias
      .filter((p) => p.codigo === row.codigo && p.de === de && p.status === 'pending')
      .reduce((s, p) => s + p.qty, 0);
    // Lê o REF, não o estado: dois arrastos rápidos não podem ver o passado.
    const rascunho = movimentosRef.current;
    const saldoOrigem = (row.estoqueLojas?.[de] ?? 0)
      - prometidas
      - rascunho.filter((m) => m.codigo === row.codigo && m.de === de).length
      + rascunho.filter((m) => m.codigo === row.codigo && m.para === de).length;
    if (saldoOrigem <= 0) {
      setAviso(
        prometidas > 0
          ? `${row.tamanho} em ${sigla(de)}: o que resta já está prometido a uma transferência aberta`
          : `${row.tamanho} não tem mais saldo em ${sigla(de)}`,
      );
      return;
    }
    setAviso(null);
    mudarMovimentos((atuais) => [...atuais, {
      codigo: row.codigo, ref: row.ref, cor: row.cor, tamanho: row.tamanho,
      desc: row.descricao, de, para,
      estoqueOrigemAntes: row.estoqueLojas?.[de] ?? 0,
    }]);
  }, [pendencias, mudarMovimentos, sigla]);

  /** Clique: primeiro na origem, depois no destino. Arrasto não vai em tablet. */
  const aoClicarCelula = useCallback((row: SkuRow, loja: string) => {
    if (!origemSel || origemSel.codigo !== row.codigo) {
      setOrigemSel({ codigo: row.codigo, loja });
      return;
    }
    if (origemSel.loja === loja) { setOrigemSel(null); return; }
    moverUma(row, origemSel.loja, loja);
    setOrigemSel(null);
  }, [origemSel, moverUma]);

  /**
   * AJUSTE DE ESTOQUE — o número passa a ser editável e a diferença vira
   * entrada/saída com motivo AJUSTE (mesmo caminho do editor de produtos).
   *
   * Modo separado do "mover" de propósito: a célula não pode ser arrastável e
   * campo de digitação ao mesmo tempo, e as duas ações têm consequências bem
   * diferentes — mover gera ordem de separação, ajustar mexe no estoque agora.
   */
  const [modo, setModo] = useState<'mover' | 'ajustar'>('mover');
  /** `${codigo}|${loja}` → quantidade nova digitada. */
  const [ajustes, setAjustes] = useState<Record<string, number>>({});
  const [salvandoAjuste, setSalvandoAjuste] = useState(false);

  const definirAjuste = useCallback((row: SkuRow, loja: string, valor: number) => {
    const chave = `${row.codigo}|${loja}`;
    const base = row.estoqueLojas?.[loja] ?? 0;
    setAjustes((a) => {
      const proximo = { ...a };
      // Voltou pro valor original = não é mais ajuste.
      if (!Number.isFinite(valor) || valor < 0 || valor === base) delete proximo[chave];
      else proximo[chave] = valor;
      return proximo;
    });
  }, []);

  async function salvarAjustes() {
    const entradas = Object.entries(ajustes);
    if (!entradas.length) return;
    setSalvandoAjuste(true);
    setAviso(null);
    try {
      const porCodigo = new Map(linhas.map((l) => [l.codigo, l]));
      const movs = entradas.flatMap(([chave, novo]) => {
        const [codigo, loja] = chave.split('|');
        const base = porCodigo.get(codigo)?.estoqueLojas?.[loja] ?? 0;
        const delta = novo - base;
        if (!delta) return [];
        return [{
          codigo, loja, qtd: Math.abs(delta),
          tipo: (delta > 0 ? 'entrada' : 'saida') as 'entrada' | 'saida',
          motivo: 'AJUSTE',
        }];
      });
      await api('/products-editor/movimentar', {
        method: 'POST',
        body: JSON.stringify({ movimentos: movs }),
      });
      // Reflete o novo estoque na tela sem refazer a busca inteira.
      setLinhas((atuais) => atuais.map((l) => {
        const lojasNovas = { ...(l.estoqueLojas ?? {}) };
        let mexeu = false;
        for (const [chave, novo] of entradas) {
          const [codigo, loja] = chave.split('|');
          if (codigo === l.codigo) { lojasNovas[loja] = novo; mexeu = true; }
        }
        if (!mexeu) return l;
        const total = Object.values(lojasNovas).reduce((s, n) => s + n, 0);
        return { ...l, estoqueLojas: lojasNovas, estoque: total };
      }));
      setAjustes({});
      setAviso(`${movs.length} ajuste(s) de estoque salvo(s).`);
    } catch (e: any) {
      setAviso(e?.message || 'Não consegui salvar os ajustes');
    } finally {
      setSalvandoAjuste(false);
    }
  }

  /**
   * Vira ordens de separação. Agrupa por (sku, origem, destino) — cinco peças
   * do mesmo caminho viram UMA ordem de 5, não cinco ordens de 1.
   */
  async function autorizar() {
    if (!movimentos.length) return;
    setAutorizando(true);
    setAviso(null);
    try {
      const agrupado = new Map<string, { m: Movimento; qty: number }>();
      for (const m of movimentos) {
        const k = `${m.codigo}|${m.de}|${m.para}`;
        const atual = agrupado.get(k);
        if (atual) atual.qty += 1;
        else agrupado.set(k, { m, qty: 1 });
      }
      const plan = [...agrupado.values()].map(({ m, qty }) => ({
        sku: m.codigo, ref: m.ref, cor: m.cor, tamanho: m.tamanho, desc: m.desc,
        fromCode: m.de, toCode: m.para, qty, stockFromBefore: m.estoqueOrigemAntes,
      }));
      await api('/realignment/confirm', {
        method: 'POST',
        body: JSON.stringify({ plan, note: 'Realinhamento pela ficha do produto' }),
      });
      mudarMovimentos(() => []);
      setOrigemSel(null);
      setAviso(`${plan.length} ordem(ns) de separação gerada(s).`);
      // O que acabou de ser autorizado já entra como "pedido" na grade — é a
      // resposta ao "como sei que já pedi?": o marcador fica até a
      // transferência terminar.
      void carregarPendencias([...new Set(linhas.map((l) => l.codigo))]);
    } catch (e: any) {
      setAviso(e?.message || 'Não consegui gerar as ordens');
    } finally {
      setAutorizando(false);
    }
  }

  /** Cadastro criado pelo "+ novo" entra na lista sem recarregar a tela. */
  const aoCriarAtributo = useCallback((tipo: TipoAtributo, novo: Atributo) => {
    setAtributos((p) => ({ ...p, [tipo]: [...(p[tipo] ?? []), novo] }));
  }, []);

  const carregarFicha = useCallback(async (ref: string, marca: string) => {
    const chave = `${ref}|${marca}`;
    if (fichas[chave] !== undefined) return;
    try {
      const f = await api<Ficha | null>(`/produto-ficha/${encodeURIComponent(ref)}?marca=${encodeURIComponent(marca)}`);
      setFichas((p) => ({ ...p, [chave]: f }));
    } catch {
      setFichas((p) => ({ ...p, [chave]: null }));
    }
  }, [fichas]);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
      <header className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-700 grid place-items-center shrink-0">
          <Package className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-slate-900">Produto — ficha completa</h1>
          <p className="text-xs text-slate-500">
            Busque a REF · abra a cor · o que é comum à peça fica no primeiro nível
          </p>
        </div>
      </header>

      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void buscar(); }}
            placeholder="REF, descrição ou código"
            className="w-full pl-9 pr-3 py-2.5 border rounded-lg text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void buscar()}
          disabled={buscando}
          className="px-5 py-2.5 rounded-lg bg-violet-600 text-white text-sm font-bold hover:bg-violet-700 disabled:opacity-50"
        >
          {buscando ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Buscar'}
        </button>
      </div>

      {erro && (
        <div className="mb-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{erro}</div>
      )}
      {aviso && (
        <div className="mb-3 text-xs text-slate-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{aviso}</div>
      )}

      {porRef.length === 0 && !buscando && (
        <p className="text-center text-sm text-slate-400 py-12">
          Busque uma REF para abrir a ficha.
        </p>
      )}

      <ImportarTudo />

      <div className="space-y-2">
        {porRef.map((grupo) => {
          const abertaComum = refAberta === grupo.chave;
          const ficha = fichas[grupo.chave];
          return (
            <div key={grupo.chave} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              {/* NÍVEL 1 — REF */}
              <div className="flex items-center gap-2 px-3 py-3">
                <button
                  type="button"
                  title="Informações comuns a todas as cores"
                  onClick={() => {
                    const nova = abertaComum ? null : grupo.chave;
                    setRefAberta(nova);
                    if (nova) void carregarFicha(grupo.ref, grupo.marca);
                  }}
                  className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"
                >
                  {abertaComum ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-mono font-bold text-violet-700">{grupo.ref}</span>
                    <span className="text-slate-900"> {grupo.nomeCurto}</span>
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {grupo.marca} · {grupo.produtos.length} cor(es)
                  </p>
                </div>
                <ImportarFotosDoSite
                  ref_={grupo.ref}
                  onImportou={() => void carregarFicha(grupo.ref, grupo.marca)}
                />
              </div>

              {/* NÍVEL 1 — as vitrines do site: é o que o dono abre primeiro */}
              {abertaComum && <VitrinesDoSite ref_={grupo.ref} arvore={arvore} />}

              {/* NÍVEL 1 aberto — o que é COMUM */}
              {abertaComum && (
                <FichaComum
                  ref_={grupo.ref}
                  marca={grupo.marca}
                  ficha={ficha}
                  atributos={atributos}
                  grades={grades}
                  onCriarAtributo={aoCriarAtributo}
                  onSalvo={(f) => setFichas((p) => ({ ...p, [grupo.chave]: f }))}
                />
              )}


              {/* NÍVEL 2 — cores */}
              <div className="border-t border-slate-100">
                {grupo.produtos.map((prod) => {
                  const aberta = corAberta === prod.chave;
                  const fichaCor = ficha?.cores?.find((c) => c.cor.toUpperCase() === prod.cor);
                  // Status desconhecido não pode derrubar a tela — mesma lição
                  // do useMemo acima.
                  const status = STATUS_LABEL[fichaCor?.statusPublicacao ?? 'sem_fotos']
                    ?? STATUS_LABEL.sem_fotos;
                  const total = prod.skus.reduce((s, r) => s + (r.estoque || 0), 0);
                  return (
                    <div key={prod.chave} className="border-b border-slate-100 last:border-0">
                      <button
                        type="button"
                        onClick={() => {
                          setCorAberta(aberta ? null : prod.chave);
                          if (!aberta) void carregarFicha(prod.ref, prod.marca);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2.5 pl-10 hover:bg-slate-50 text-left"
                      >
                        {aberta ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                        <span className="text-sm font-medium text-slate-800 flex-1">{prod.cor}</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${status.cor}`}>{status.texto}</span>
                        <span className="text-[11px] text-slate-400 tabular-nums w-20 text-right">{total} un</span>
                      </button>

                      {/* NÍVEL 3 — grade + campos da cor */}
                      {aberta && (
                        <div className="pl-10 pr-3 pb-4 space-y-3">
                          {/* Mover e ajustar são ações bem diferentes — mover
                              gera ordem de separação, ajustar mexe no estoque
                              agora. Modo explícito evita fazer uma pensando na
                              outra, e a célula não pode ser arrastável e campo
                              de digitação ao mesmo tempo. */}
                          <div className="flex gap-1">
                            {(['mover', 'ajustar'] as const).map((m) => (
                              <button
                                key={m}
                                type="button"
                                onClick={() => setModo(m)}
                                className={`text-[10px] font-bold px-2.5 py-1 rounded ${
                                  modo === m
                                    ? 'bg-violet-600 text-white'
                                    : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
                                }`}
                              >
                                {m === 'mover' ? 'Mover entre lojas' : 'Ajustar estoque'}
                              </button>
                            ))}
                          </div>
                          <GradeEstoque
                            skus={prod.skus}
                            movimentos={movimentos}
                            origemSel={origemSel}
                            onMover={moverUma}
                            onClicarCelula={aoClicarCelula}
                            modo={modo}
                            ajustes={ajustes}
                            onAjustar={definirAjuste}
                            lojaNomes={lojaNomes}
                            pendencias={pendencias}
                          />
                          <FichaDaCor
                            ref_={prod.ref}
                            marca={prod.marca}
                            cor={prod.cor}
                            fichaCor={fichaCor}
                            onSalvo={(f) => setFichas((p) => ({ ...p, [`${prod.ref}|${prod.marca}`]: f }))}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Rascunho de remessa — só existe enquanto houver arrasto pendente.
          Nada sai daqui sem autorizar: remessa mexe em peça física e no acerto
          entre lojas, e arrasto erra fácil. */}
      {(movimentos.length > 0 || Object.keys(ajustes).length > 0) && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-violet-200 bg-white/95 backdrop-blur shadow-[0_-4px_16px_rgba(0,0,0,0.08)]">
          <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              {movimentos.length > 0 && (
                <>
                  <p className="text-xs font-bold text-slate-800">
                    {movimentos.length} peça(s) para mover — ainda não enviado
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {[...new Set(movimentos.map((m) => `${sigla(m.de)}→${sigla(m.para)}`))].join(' · ')}
                  </p>
                </>
              )}
              {Object.keys(ajustes).length > 0 && (
                <p className="text-xs font-bold text-amber-800">
                  {Object.keys(ajustes).length} ajuste(s) de estoque não salvo(s)
                </p>
              )}
            </div>

            {movimentos.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => { mudarMovimentos((m) => m.slice(0, -1)); setAviso(null); }}
                  className="text-xs font-bold px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50"
                >
                  Desfazer
                </button>
                <button
                  type="button"
                  onClick={() => { mudarMovimentos(() => []); setOrigemSel(null); setAviso(null); }}
                  className="text-xs font-bold px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50"
                >
                  Descartar tudo
                </button>
                <button
                  type="button"
                  onClick={() => void autorizar()}
                  disabled={autorizando}
                  className="inline-flex items-center gap-1.5 text-xs font-bold px-5 py-2.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {autorizando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Truck className="w-3.5 h-3.5" />}
                  Autorizar e gerar ordens
                </button>
              </>
            )}

            {Object.keys(ajustes).length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => { setAjustes({}); setAviso(null); }}
                  className="text-xs font-bold px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50"
                >
                  Descartar ajustes
                </button>
                <button
                  type="button"
                  onClick={() => void salvarAjustes()}
                  disabled={salvandoAjuste}
                  className="inline-flex items-center gap-1.5 text-xs font-bold px-5 py-2.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {salvandoAjuste ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Salvar ajuste de estoque
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────── Nível 1: as vitrines em que a peça aparece ─────────────── */

type ArvoreSite = {
  categorias: Array<{ slug: string; nome: string; ativo: boolean }>;
  subcategorias: Array<{ slug: string; nome: string; pai: string; ativo: boolean }>;
};

type VitrinesPeca = {
  ok?: boolean;
  erro?: string;
  refs?: string[];
  publicado?: boolean;
  categorias: string[];
  subcategorias: string[];
  principal?: string | null;
};

/**
 * EM QUE VITRINES ESTA PEÇA APARECE — árvore de checkbox (dono, 18/08/2026).
 *
 * A categoria sempre foi UMA só, e o efeito colateral era silencioso: mandar
 * uma blusa pra "Linha Conforto" a TIRAVA de "Blusas" — a cliente que navega
 * por Blusas deixava de achar a peça no dia em que ela entrou na campanha.
 *
 * O primeiro desenho pedia "categoria principal" num select e as outras em
 * chips; o dono cortou na hora — "só marco o checkbox de todas as categorias e
 * subcategorias que eu quero". Então aqui NÃO se escolhe principal: marca-se
 * tudo, e o backend deriva qual manda na PDP (a que já era, se seguir marcada;
 * senão a primeira na ordem do menu).
 *
 * Duas regras que a tela aplica na hora, pra marcação impossível não existir:
 *   · marcar SUBcategoria marca o pai — sub é filtro DENTRO da página do pai;
 *   · desmarcar a categoria desmarca as subs dela.
 *
 * Vale pra FAMÍLIA inteira (todas as cores): o site mostra um card por peça,
 * montado a partir do cadastro de UMA das REFs irmãs, e gravar só na REF
 * aberta daria "marquei e não apareceu" toda vez que a dona do card fosse
 * outra.
 */
function VitrinesDoSite({ ref_, arvore }: { ref_: string; arvore: ArvoreSite | null }) {
  const [dados, setDados] = useState<VitrinesPeca | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [subs, setSubs] = useState<string[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setErro(null);
    setSalvo(false);
    api<VitrinesPeca>(`/loja-catalog/classificacao/peca/${encodeURIComponent(ref_)}`)
      .then((d) => {
        if (!vivo) return;
        setDados(d);
        setCats(d?.categorias ?? []);
        setSubs(d?.subcategorias ?? []);
      })
      .catch((e: unknown) => {
        if (vivo) setErro((e as Error)?.message || 'Não consegui ler as vitrines');
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [ref_]);

  // As subcategorias de cada categoria, na ordem do menu — o desenho da árvore.
  const subsPorPai = useMemo(() => {
    const m = new Map<string, Array<{ slug: string; nome: string }>>();
    for (const s of arvore?.subcategorias ?? []) {
      if (!m.has(s.pai)) m.set(s.pai, []);
      m.get(s.pai)!.push({ slug: s.slug, nome: s.nome });
    }
    return m;
  }, [arvore]);

  function alternarCategoria(slug: string) {
    setSalvo(false);
    const marcando = !cats.includes(slug);
    setCats((a) => (marcando ? [...a, slug] : a.filter((c) => c !== slug)));
    // Desmarcar a categoria leva as subs dela junto: sub órfã apareceria num
    // chip de um menu que não lista a peça.
    if (!marcando) {
      const filhas = new Set((subsPorPai.get(slug) ?? []).map((s) => s.slug));
      setSubs((a) => a.filter((s) => !filhas.has(s)));
    }
  }

  function alternarSub(slug: string, pai: string) {
    setSalvo(false);
    const marcando = !subs.includes(slug);
    setSubs((a) => (marcando ? [...a, slug] : a.filter((s) => s !== slug)));
    // Marcar a sub marca o pai — é dentro da página dele que o chip vive.
    if (marcando) setCats((a) => (a.includes(pai) ? a : [...a, pai]));
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const r = await api<VitrinesPeca>(
        `/loja-catalog/classificacao/peca/${encodeURIComponent(ref_)}`,
        { method: 'POST', body: JSON.stringify({ categorias: cats, subcategorias: subs }) },
      );
      if (r?.ok === false) throw new Error(r?.erro || 'Não consegui salvar');
      setDados(r);
      setCats(r?.categorias ?? []);
      setSubs(r?.subcategorias ?? []);
      setSalvo(true);
    } catch (e: unknown) {
      setErro((e as Error)?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) {
    return (
      <div className="px-10 py-3 flex items-center gap-2 text-xs text-slate-400 bg-sky-50/50">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando vitrines…
      </div>
    );
  }

  if (dados?.ok === false) {
    return (
      <div className="px-10 py-3 bg-sky-50/50 text-xs text-slate-500">
        Esta peça ainda não tem cadastro no site — publique a REF antes de escolher as vitrines.
      </div>
    );
  }

  const marcadas = cats.length + subs.length;

  return (
    <div className="px-10 py-3 bg-sky-50/50 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="text-[10px] font-bold text-sky-700 uppercase">Vitrines do site</p>
        <p className="text-[10px] text-slate-400">
          marque TUDO onde esta peça deve aparecer · vale pras {dados?.refs?.length ?? 0} REF(s) da
          peça{dados?.publicado ? '' : ' · peça não publicada'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
        {(arvore?.categorias ?? []).map((c) => {
          const marcada = cats.includes(c.slug);
          const filhas = subsPorPai.get(c.slug) ?? [];
          return (
            <div key={c.slug} className="min-w-0">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={marcada}
                  onChange={() => alternarCategoria(c.slug)}
                  className="w-4 h-4 accent-sky-600"
                />
                <span className={`text-sm truncate ${marcada ? 'font-bold text-sky-900' : 'text-slate-700'}`}>
                  {c.nome}
                </span>
                {dados?.principal === c.slug && (
                  <span
                    title="É a categoria que a página do produto mostra"
                    className="text-[9px] font-bold uppercase text-sky-600 bg-sky-100 rounded px-1 py-0.5 shrink-0"
                  >
                    principal
                  </span>
                )}
              </label>
              {filhas.length > 0 && (
                <div className="ml-6 mt-0.5 space-y-0.5">
                  {filhas.map((s) => (
                    <label key={s.slug} className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={subs.includes(s.slug)}
                        onChange={() => alternarSub(s.slug, c.slug)}
                        className="w-3.5 h-3.5 accent-sky-600"
                      />
                      <span
                        className={`text-xs truncate ${
                          subs.includes(s.slug) ? 'text-sky-900 font-semibold' : 'text-slate-500'
                        }`}
                      >
                        {s.nome}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Salvar vitrines ({marcadas})
        </button>
        {salvo && <span className="text-xs text-emerald-700 font-semibold">Salvo — o site já mudou</span>}
      </div>
    </div>
  );
}

/* ─────────────── Nível 1: o que vale pra todas as cores ─────────────── */

function FichaComum({
  ref_, marca, ficha, atributos, grades, onSalvo, onCriarAtributo,
}: {
  ref_: string;
  marca: string;
  ficha: Ficha | null | undefined;
  atributos: AtributosPorTipo;
  grades: Grade[];
  onSalvo: (f: Ficha) => void;
  onCriarAtributo: (tipo: TipoAtributo, novo: Atributo) => void;
}) {
  const [form, setForm] = useState({
    descricao: '', tecidoId: '', colecaoId: '', gradeMedidasId: '', elasticidade: '',
    ocasiaoIds: [] as string[], modelagemIds: [] as string[],
  });
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Só hidrata quando a ficha chega — sem isto o form limparia o que o usuário
  // digitou a cada re-render do pai.
  const hidratado = useRef(false);

  useEffect(() => {
    if (ficha === undefined || hidratado.current) return;
    hidratado.current = true;
    setForm({
      descricao: ficha?.descricao ?? '',
      tecidoId: ficha?.tecidoId ?? '',
      colecaoId: ficha?.colecaoId ?? '',
      gradeMedidasId: ficha?.gradeMedidasId ?? '',
      elasticidade: ficha?.elasticidade ?? '',
      ocasiaoIds: ficha?.ocasioes?.map((o) => o.id) ?? [],
      modelagemIds: ficha?.modelagens?.map((m) => m.id) ?? [],
    });
  }, [ficha]);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const f = await api<Ficha>(
        `/produto-ficha/${encodeURIComponent(ref_)}?marca=${encodeURIComponent(marca)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            descricao: form.descricao || null,
            tecidoId: form.tecidoId || null,
            colecaoId: form.colecaoId || null,
            gradeMedidasId: form.gradeMedidasId || null,
            elasticidade: form.elasticidade || null,
            ocasiaoIds: form.ocasiaoIds,
            modelagemIds: form.modelagemIds,
          }),
        },
      );
      onSalvo(f);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  if (ficha === undefined) {
    return (
      <div className="px-10 pb-4 flex items-center gap-2 text-xs text-slate-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando ficha…
      </div>
    );
  }

  return (
    <div className="px-10 pb-4 bg-violet-50/40 pt-3 space-y-3">
      <p className="text-[10px] font-bold text-violet-700 uppercase">
        Comum a todas as cores desta REF
      </p>

      <div>
        <label className="text-[10px] font-bold text-slate-600 uppercase">
          Descrição de venda <span className="text-slate-400">(uma só, serve todas as cores)</span>
        </label>
        <textarea
          rows={3}
          value={form.descricao}
          onChange={(e) => setForm((f) => ({ ...f, descricao: e.target.value }))}
          className="w-full px-2 py-2 border rounded text-sm"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SelectAtributoPeca tipo="tecido" label="Tecido" opcoes={atributos.tecido}
          value={form.tecidoId} onCriado={onCriarAtributo}
          onChange={(v) => setForm((f) => ({ ...f, tecidoId: v }))} />
        <SelectAtributoPeca tipo="colecao" label="Coleção" opcoes={atributos.colecao}
          value={form.colecaoId} onCriado={onCriarAtributo}
          onChange={(v) => setForm((f) => ({ ...f, colecaoId: v }))} />
        <SelectAtributoPeca tipo="ocasiao" label="Ocasião" multiplo opcoes={atributos.ocasiao}
          values={form.ocasiaoIds} onCriado={onCriarAtributo}
          onChangeMany={(v) => setForm((f) => ({ ...f, ocasiaoIds: v }))} />
        <SelectAtributoPeca tipo="modelagem" label="Modelagem" multiplo opcoes={atributos.modelagem}
          values={form.modelagemIds} onCriado={onCriarAtributo}
          onChangeMany={(v) => setForm((f) => ({ ...f, modelagemIds: v }))} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">Grade de medidas</label>
          <select
            value={form.gradeMedidasId}
            onChange={(e) => setForm((f) => ({ ...f, gradeMedidasId: e.target.value }))}
            disabled={grades.length === 0}
            title={grades.length === 0 ? 'Nenhuma grade cadastrada ainda' : undefined}
            className="w-full px-2 py-2 border rounded text-sm bg-white disabled:opacity-50"
          >
            <option value="">— nenhuma —</option>
            {grades.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">Elasticidade</label>
          <select
            value={form.elasticidade}
            onChange={(e) => setForm((f) => ({ ...f, elasticidade: e.target.value }))}
            className="w-full px-2 py-2 border rounded text-sm bg-white"
          >
            {ELASTICIDADE_LABEL.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </div>
      </div>

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      <button
        type="button"
        onClick={() => void salvar()}
        disabled={salvando}
        className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
      >
        {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        Salvar dados da peça
      </button>
    </div>
  );
}

/* ─────────────── Nível 3: grade de estoque (leitura) ─────────────── */

function GradeEstoque({
  skus, movimentos, origemSel, onMover, onClicarCelula, modo, ajustes, onAjustar, lojaNomes,
  pendencias,
}: {
  skus: SkuRow[];
  movimentos: Movimento[];
  origemSel: { codigo: string; loja: string } | null;
  onMover: (row: SkuRow, de: string, para: string) => void;
  onClicarCelula: (row: SkuRow, loja: string) => void;
  modo: 'mover' | 'ajustar';
  ajustes: Record<string, number>;
  onAjustar: (row: SkuRow, loja: string, valor: number) => void;
  lojaNomes: Map<string, string>;
  pendencias: Pendencia[];
}) {
  const lojas = useMemo(() => {
    // TODAS as lojas cadastradas, mesmo zeradas (pedido do dono 03/08) —
    // mesma regra do editor de produtos. Coluna vazia é DESTINO válido: sem
    // ela não dá pra arrastar peça pra loja que ainda não tem essa cor.
    const s = new Set<string>(lojaNomes.keys());
    if (!s.size) for (const c of ['01', '02', '03', '05', '06', '08', '10', '15', '17', '18']) s.add(c);
    for (const r of skus) for (const l of Object.keys(r.estoqueLojas ?? {})) s.add(l);
    /**
     * MATRIZ, ITU e DEPÓSITO fora da grade (dono, 04/08).
     *
     * A grade existe pra mover peça ENTRE LOJAS QUE VENDEM. Essas três não
     * vendem — e coluna a mais aqui não é só ruído visual: cada uma é um
     * destino de arraste, e arrastar peça pra matriz por engano tira ela da
     * arara sem ninguém precisar dela.
     *
     * Filtra pela SIGLA (o mesmo texto do cabeçalho) e não por código: código
     * de loja eu não tenho como conferir daqui, e chutar código é esconder a
     * coluna errada.
     */
    // SITE entrou aqui em 04/08: é loja-canal, não arara. A peça vai pro site
    // pelo pedido (TransferOrder do canal), nunca arrastada nesta grade.
    const FORA_DA_GRADE = ['MATRI', 'ITU', 'DEPOS', 'SITE'];

    /**
     * ORDEM DO ITINERÁRIO DA ENTREGA (dono, 04/08) — não alfabética.
     *
     * A grade é usada pra decidir o que vai em cada caixa, e quem monta segue
     * a ordem do carro. Coluna em ordem alfabética obriga a pular de um lado
     * pro outro da tela a cada loja da rota.
     *
     * Casa pela SIGLA (o mesmo texto do cabeçalho), não por código: código de
     * loja eu não tenho como conferir daqui. Loja fora da rota (SITE, e
     * qualquer uma nova) vai pro fim, em ordem alfabética — melhor no fim do
     * que sumida.
     */
    const ITINERARIO = [
      'ITANH', 'PRAIA', 'SANTO', 'JUNDI', 'VINHE', 'CAMPI', 'LIMEI',
      'PIRAC', 'INDAI', 'SOROC', 'MOEMA', 'ANALI', 'SUZAN', 'SAO J',
    ];
    const posicao = (c: string) => {
      const i = ITINERARIO.indexOf((lojaNomes.get(c) || c).toUpperCase());
      return i < 0 ? ITINERARIO.length : i;
    };

    return [...s]
      .filter((c) => !FORA_DA_GRADE.includes((lojaNomes.get(c) || c).toUpperCase()))
      .sort((a, b) => {
        const d = posicao(a) - posicao(b);
        return d !== 0 ? d : a.localeCompare(b);
      });
  }, [skus, lojaNomes]);

  /**
   * As três camadas da célula:
   *   base      = estoque real
   *   rascunho  = arrastos ainda não autorizados (delta)
   *   pendência = transferência já AUTORIZADA e não concluída
   *
   * `pending` desconta do disponível (a peça ainda está aqui, mas tem dono);
   * `in_transit` NÃO desconta na origem (o estoque já baixou no envio) — na
   * direção do destino ele aparece como "a caminho".
   */
  function saldo(row: SkuRow, loja: string) {
    const base = row.estoqueLojas?.[loja] ?? 0;
    const saiu = movimentos.filter((m) => m.codigo === row.codigo && m.de === loja).length;
    const entrou = movimentos.filter((m) => m.codigo === row.codigo && m.para === loja).length;

    const minhas = pendencias.filter((p) => p.codigo === row.codigo);
    const soma = (lista: Pendencia[]) => lista.reduce((s, p) => s + p.qty, 0);
    const pedidoSai = soma(minhas.filter((p) => p.de === loja && p.status === 'pending'));
    const pedidoChega = soma(minhas.filter((p) => p.para === loja && p.status === 'pending'));
    const ruaChega = soma(minhas.filter((p) => p.para === loja && p.status === 'in_transit'));

    return {
      valor: base - pedidoSai - saiu + entrou,
      base,
      delta: entrou - saiu,
      pedidoSai,
      pedidoChega,
      ruaChega,
    };
  }

  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg bg-white">
      <table className="text-xs min-w-full">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-2 py-1.5 text-left font-bold">TAM</th>
            {/* Sigla na coluna, código no title — "03" não diz nada pra quem
                opera, mas quem confere nota às vezes precisa do número. */}
            {lojas.map((l) => (
              <th key={l} title={`Loja ${l}`} className="px-2 py-1.5 font-bold whitespace-nowrap">
                {lojaNomes.get(l) || l}
              </th>
            ))}
            <th className="px-2 py-1.5 font-bold">TOT</th>
          </tr>
        </thead>
        <tbody>
          {skus.map((r) => {
            const total = lojas.reduce((s, l) => s + saldo(r, l).valor, 0);
            return (
              <tr key={r.codigo} className="border-t border-slate-100">
                <td className="px-2 py-1.5 font-bold text-slate-700">{r.tamanho}</td>
                {lojas.map((l) => {
                  const { valor, base, delta, pedidoSai, pedidoChega, ruaChega } = saldo(r, l);
                  const selecionada = origemSel?.codigo === r.codigo && origemSel.loja === l;

                  if (modo === 'ajustar') {
                    const chave = `${r.codigo}|${l}`;
                    const base = r.estoqueLojas?.[l] ?? 0;
                    const atual = ajustes[chave] ?? base;
                    return (
                      <td key={l} className="px-1 py-1 text-center">
                        <input
                          type="number"
                          value={atual}
                          onChange={(e) => onAjustar(r, l, Number(e.target.value))}
                          className={`w-14 px-1 py-1 text-center text-xs tabular-nums border rounded ${
                            chave in ajustes
                              ? 'border-amber-400 bg-amber-50 font-bold text-amber-800'
                              : 'border-slate-200'
                          }`}
                        />
                      </td>
                    );
                  }
                  // Vermelho onde saiu, azul onde entrou — o preview pedido.
                  const temPendencia = pedidoSai > 0 || pedidoChega > 0 || ruaChega > 0;
                  const cor = delta < 0 ? 'text-rose-600 font-bold'
                    : delta > 0 ? 'text-blue-600 font-bold'
                    : valor ? 'text-slate-800' : 'text-slate-300';
                  const dicas = [
                    valor > 0 ? 'Arraste (ou clique aqui e depois no destino)' : '',
                    pedidoSai > 0 ? `${pedidoSai} já pedida(s) daqui — aguardando envio (disponível ${valor} de ${base})` : '',
                    pedidoChega > 0 ? `${pedidoChega} pedida(s) pra cá — aguardando envio` : '',
                    ruaChega > 0 ? `${ruaChega} a caminho daqui (já saiu da origem)` : '',
                  ].filter(Boolean).join(' · ');
                  return (
                    <td
                      key={l}
                      // Arrasta a peça; o drop decide o destino.
                      draggable={valor > 0}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', JSON.stringify({ codigo: r.codigo, de: l }));
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        try {
                          const d = JSON.parse(e.dataTransfer.getData('text/plain'));
                          if (d?.codigo === r.codigo) onMover(r, d.de, l);
                        } catch { /* payload de outro lugar — ignora */ }
                      }}
                      onClick={() => onClicarCelula(r, l)}
                      title={dicas || undefined}
                      className={`px-2 py-1.5 text-center tabular-nums cursor-pointer select-none hover:bg-violet-50 ${cor} ${
                        selecionada ? 'ring-2 ring-violet-500 ring-inset bg-violet-50' : ''
                      }`}
                    >
                      {/* Zero vira "·" só quando não houve movimento nem
                          pendência — com marcação, "0" deixa claro que zerou
                          de propósito (senão sai "·-3", que parece defeito). */}
                      {delta !== 0 || temPendencia ? valor : (valor || '·')}
                      {/* Rascunho (forte): o que VOCÊ está montando agora. */}
                      {delta !== 0 && (
                        <span className="ml-0.5 text-[9px] align-super">
                          {delta > 0 ? `+${delta}` : delta}
                        </span>
                      )}
                      {/* Já autorizado (âmbar): pedido, aguardando envio.
                          Some sozinho quando a remessa conclui ou cancela. */}
                      {pedidoSai > 0 && (
                        <span className="ml-0.5 text-[9px] align-super font-bold text-amber-600">-{pedidoSai}</span>
                      )}
                      {pedidoChega > 0 && (
                        <span className="ml-0.5 text-[9px] align-super font-bold text-amber-600">+{pedidoChega}</span>
                      )}
                      {/* Na rua (violeta): já saiu da origem, falta chegar. */}
                      {ruaChega > 0 && (
                        <span className="ml-0.5 text-[9px] align-super font-bold text-violet-600">+{ruaChega}</span>
                      )}
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-center font-bold tabular-nums">{total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-slate-400 px-2 py-1.5 border-t border-slate-100">
        {modo === 'mover' ? (
          <>
            Arraste um número de uma loja para outra para mover 1 peça (ou clique na
            origem e depois no destino). <span className="text-rose-600">Vermelho</span>/
            <span className="text-blue-600">azul</span> = rascunho (não autorizado) ·{' '}
            <span className="text-amber-600 font-bold">âmbar</span> = já pedido, aguardando
            envio · <span className="text-violet-600 font-bold">violeta</span> = a caminho.
            O número da célula já desconta o que está pedido — a marcação some quando a
            transferência conclui.
          </>
        ) : (
          <>
            Digite a quantidade certa em cada loja. A diferença vira entrada ou saída
            com motivo <b>AJUSTE</b> — mexe no estoque de verdade assim que salvar, sem
            gerar ordem de separação. Negativo não é aceito aqui (só o sistema chega
            nele, quando vende peça em trânsito).
          </>
        )}
      </p>
    </div>
  );
}

/* ─────────────── Nível 3: campos da COR ─────────────── */

function FichaDaCor({
  ref_, marca, cor, fichaCor, onSalvo,
}: {
  ref_: string;
  marca: string;
  cor: string;
  fichaCor: FichaCor | undefined;
  onSalvo: (f: Ficha) => void;
}) {
  const [titulo, setTitulo] = useState(fichaCor?.tituloComercial ?? '');
  const [youtube, setYoutube] = useState(fichaCor?.youtubeUrl ?? '');
  const [status, setStatus] = useState(
    fichaCor?.statusPublicacao === 'sem_fotos' ? 'nao_publicar' : (fichaCor?.statusPublicacao ?? 'nao_publicar'),
  );
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // A galeria vive aqui porque duas coisas dependem dela: o status
  // ("faltam fotos" some assim que a primeira sobe) e a bolinha, que é pintada
  // a conta-gotas EM CIMA da foto.
  const [fotos, setFotos] = useState<FotoCor[]>(fichaCor?.fotos ?? []);
  const [swatch, setSwatch] = useState<SwatchCor>({
    swatchTipo: fichaCor?.swatchTipo ?? 'cor',
    corHex: fichaCor?.corHex ?? null,
    swatchFocoX: fichaCor?.swatchFocoX ?? null,
    swatchFocoY: fichaCor?.swatchFocoY ?? null,
  });
  const [swatchSave, setSwatchSave] = useState<'salvando' | 'ok' | null>(null);
  const semFotos = fotos.length === 0;

  const urlCor = `/produto-ficha/${encodeURIComponent(ref_)}/cor/${encodeURIComponent(cor)}?marca=${encodeURIComponent(marca)}`;

  /** Resposta de qualquer PATCH/GET → estado local + pai, numa passada só. */
  const aplicarFicha = useCallback((f: Ficha) => {
    const c = f.cores?.find((x) => x.cor === cor);
    if (c) {
      // 'sem_fotos' é calculado e não existe no select — cai no "Fora do site".
      setStatus(c.statusPublicacao === 'sem_fotos' ? 'nao_publicar' : c.statusPublicacao);
    }
    onSalvo(f);
  }, [cor, onSalvo]);

  /**
   * BOLINHA SALVA SOZINHA (pedido do dono, 06/08): o resultado da IA, do
   * conta-gotas, do recorte e do seletor "à mão" grava sem passar pelo botão.
   * Debounce curto porque o <input type=color> dispara a cada arrasto do
   * mouse dentro do picker.
   *
   * ⚠️ O BUG DAS "5 SOLICITAÇÕES" (dono 07/08): só UMA cor fica aberta por
   * vez — clicar na próxima cor DESMONTA este painel na hora, e o cleanup
   * antigo fazia clearTimeout com o PATCH ainda pendente. Quem pintava a
   * bolinha e ia direto pra próxima cor (o fluxo natural) perdia o save em
   * silêncio; testando devagar funcionava. Por isso: o pendente agora vive
   * num ref e o desmonte DISPARA o PATCH em vez de descartá-lo.
   */
  const swatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swatchPendente = useRef<SwatchCor | null>(null);

  useEffect(() => () => {
    if (swatchTimer.current) clearTimeout(swatchTimer.current);
    const s = swatchPendente.current;
    if (s) {
      swatchPendente.current = null;
      // Componente já morreu: nada de setState — só garante a gravação.
      void api(urlCor, { method: 'PATCH', body: JSON.stringify(s) }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlCor]);

  function agendarSwatch(s: SwatchCor) {
    swatchPendente.current = s;
    if (swatchTimer.current) clearTimeout(swatchTimer.current);
    setSwatchSave('salvando');
    swatchTimer.current = setTimeout(async () => {
      const pendente = swatchPendente.current;
      swatchPendente.current = null;
      if (!pendente) return;
      try {
        const f = await api<Ficha>(urlCor, { method: 'PATCH', body: JSON.stringify(pendente) });
        aplicarFicha(f);
        setSwatchSave('ok');
      } catch (e: any) {
        setSwatchSave(null);
        setErro(e?.message || 'Não consegui salvar a bolinha');
      }
    }, 600);
  }

  /** Publicação vale no clique — era o "mudei e esqueci de salvar" clássico. */
  async function mudarStatus(novo: string) {
    const anterior = status;
    setStatus(novo);
    setErro(null);
    try {
      const f = await api<Ficha>(urlCor, {
        method: 'PATCH',
        body: JSON.stringify({ statusPublicacao: novo }),
      });
      aplicarFicha(f);
    } catch (e: any) {
      setStatus(anterior);
      setErro(e?.message || 'Não consegui mudar a publicação');
    }
  }

  /**
   * Depois que a galeria muda, o backend pode ter publicado a peça sozinho
   * (upload = publicar). Busca a ficha fresca pra tela contar essa verdade —
   * sem isso o select seguia em "Fora do site" com a peça já no ar.
   */
  async function sincronizarFicha() {
    try {
      const f = await api<Ficha>(`/produto-ficha/${encodeURIComponent(ref_)}?marca=${encodeURIComponent(marca)}`);
      if (f) aplicarFicha(f);
    } catch { /* informativo — a próxima interação sincroniza */ }
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const f = await api<Ficha>(urlCor, {
        method: 'PATCH',
        body: JSON.stringify({
          tituloComercial: titulo || null,
          youtubeUrl: youtube || null,
          statusPublicacao: status,
          ...swatch,
        }),
      });
      aplicarFicha(f);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-3 space-y-3">
      <p className="text-[10px] font-bold text-slate-500 uppercase">Só desta cor</p>

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">
            Título no site <span className="text-slate-400">(vazio = nome curto + cor)</span>
          </label>
          <input value={titulo} onChange={(e) => setTitulo(e.target.value)}
            className="w-full px-2 py-2 border rounded text-sm" />
        </div>
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">Vídeo (YouTube)</label>
          <input value={youtube} onChange={(e) => setYoutube(e.target.value)} placeholder="https://youtu.be/..."
            className="w-full px-2 py-2 border rounded text-sm font-mono" />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">Publicação</label>
          <select
            value={status}
            onChange={(e) => void mudarStatus(e.target.value)}
            disabled={semFotos}
            title={semFotos ? 'Sem foto o site não tem o que mostrar' : 'Vale na hora — sem precisar salvar'}
            className="px-2 py-2 border rounded text-sm bg-white disabled:opacity-50"
          >
            <option value="nao_publicar">Fora do site</option>
            <option value="pronto">Pronto pra publicar</option>
            <option value="publicado">No ar</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs text-slate-500">
            {semFotos
              ? 'Nenhuma foto — o status fica em "faltam fotos"'
              : `${fotos.length} foto(s)`}
          </span>
        </div>
      </div>

      <FotosDaCor
        refSku={ref_}
        cor={cor}
        fotosIniciais={fichaCor?.fotos ?? []}
        swatch={swatch}
        onSwatchChange={(s) => { setSwatch(s); agendarSwatch(s); }}
        onFotosChange={(novas) => { setFotos(novas); void sincronizarFicha(); }}
        swatchSave={swatchSave}
      />

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Salvar título e vídeo
        </button>
        <span className="text-[11px] text-slate-400">
          Fotos, bolinha e publicação já salvam sozinhas.
        </span>
      </div>
    </div>
  );
}

/* ─────────────── Importar fotos do site antigo (WooCommerce) ─────────────── */

type ResultadoImport = {
  ref: string;
  coresComFoto: string[];
  coresSemFoto: string[];
  jaTinham: string[];
  produtosWcSemCor: string[];
  produtosEncontrados?: number;
  fotos: number;
  /** Frase pronta do backend explicando por que não veio nada. */
  motivo?: string;
};

/**
 * O acervo de fotos JÁ EXISTE no site antigo: lá cada cor é um produto com o
 * mesmo SKU (a REF). Este botão puxa aquelas fotos pra cá, casando cada
 * produto do WooCommerce com a COR do catálogo pelo nome.
 *
 * Mostra o que NÃO casou em vez de esconder: cor que ficou sem foto e produto
 * do site antigo que não bateu com cor nenhuma são exatamente a lista de
 * trabalho manual que sobra.
 */
function ImportarFotosDoSite({ ref_, onImportou }: { ref_: string; onImportou: () => void }) {
  const [rodando, setRodando] = useState(false);
  const [r, setR] = useState<ResultadoImport | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function importar() {
    setRodando(true);
    setErro(null);
    try {
      const res = await api<ResultadoImport>('/product-photos/importar-wc', {
        method: 'POST',
        body: JSON.stringify({ ref: ref_ }),
      });
      setR(res);
      if (res.fotos > 0) onImportou();
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui importar');
    } finally {
      setRodando(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={() => void importar()}
        disabled={rodando}
        title="Puxa as fotos que já existem no site antigo (WooCommerce) pra cada cor desta REF"
        className="inline-flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-lg border border-violet-200 text-violet-700 hover:bg-violet-50 disabled:opacity-40"
      >
        {rodando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
        Importar fotos do site
      </button>
      {erro && <p className="text-[11px] text-rose-700 mt-1">{erro}</p>}
      {r && (
        <p className="text-[11px] text-slate-500 mt-1 max-w-xs">
          {/* O motivo vem do backend quando existe: "nao tem esta peca" era a
              mesma frase pra peca ausente, site fora do ar e fonte nao
              configurada — tres problemas com tres consertos diferentes. */}
          {r.fotos > 0
            ? `${r.fotos} foto(s) em ${r.coresComFoto.length} cor(es).`
            : r.motivo
              ? r.motivo
              : r.produtosEncontrados === 0
                ? 'O site antigo nao tem esta peca.'
                : 'Nada novo pra trazer.'}
          {r.jaTinham.length > 0 && ` ${r.jaTinham.length} cor(es) já tinham.`}
          {r.produtosWcSemCor.length > 0 && (
            <span className='text-slate-500'> {r.produtosWcSemCor.length} produto(s) do site antigo nao bateram com cor nenhuma.</span>
          )}
          {r.coresSemFoto.length > 0 && (
            <span className="text-amber-700"> Sem foto no site antigo: {r.coresSemFoto.join(', ')}.</span>
          )}
        </p>
      )}
    </div>
  );
}

/* ─────────────── Importar TUDO (lote em segundo plano) ─────────────── */

type StatusLote = {
  existe: boolean;
  status?: 'rodando' | 'concluido' | 'cancelado';
  total?: number;
  processadas?: number;
  restantes?: number;
  fotos?: number;
  bolinhas?: number;
  refsComFoto?: number;
  /** Foto no banco ≠ peça no site — foi a diferença entre os dois que passou. */
  publicadas?: number;
  semEstoque?: number;
  refAtual?: string | null;
  problemas?: { ref: string; motivo: string }[];
};

type Reparo = {
  simulado: boolean;
  ativasNoWc: number; comFoto: number; jaNoAr: number;
  publicadas: number; foraDoWc: number; falhas: number;
};

type Mutirao = { pendentesAntes: number; pintadas: number; falharam: number };

type Formatos = {
  olhadas: number; convertidas: number; jaOk: number;
  falharam: number; restantes: number; exemplosFalha: string[];
};

type LoteIa = {
  olhadas: number; enriquecidas: number; semTexto: number;
  falharam: number; restantes: number;
  foraDoCadastro: string[]; exemplosFalha: string[];
};

/**
 * Puxa o acervo INTEIRO do site antigo — foto, gravação e bolinha — sem
 * ninguém ficar clicando REF por REF.
 *
 * O trabalho roda no servidor, aos poucos: esta tela só ABRE o lote e depois
 * acompanha. Pode fechar o navegador, cair a internet, sair o deploy — o lote
 * continua de onde parou, porque o cursor está no banco e não nesta página.
 */
function ImportarTudo() {
  const [status, setStatus] = useState<StatusLote | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [abrindo, setAbrindo] = useState(false);
  const [publicando, setPublicando] = useState(false);
  const [reparo, setReparo] = useState<Reparo | null>(null);
  const [pintando, setPintando] = useState(false);
  const [mutirao, setMutirao] = useState<Mutirao | null>(null);
  const [normalizando, setNormalizando] = useState(false);
  const [formatos, setFormatos] = useState<Formatos | null>(null);
  const [extraindo, setExtraindo] = useState(false);
  const [loteIa, setLoteIa] = useState<LoteIa | null>(null);

  const consultar = useCallback(async () => {
    try {
      setStatus(await api<StatusLote>('/product-photos/importar-tudo/status'));
    } catch {
      /* silencioso: é um poll, não vale poluir a tela */
    }
  }, []);

  useEffect(() => {
    void consultar();
    // Enquanto roda, acompanha de perto; parado, quase não incomoda o servidor.
    const t = setInterval(() => void consultar(), status?.status === 'rodando' ? 5000 : 20000);
    return () => clearInterval(t);
  }, [consultar, status?.status]);

  async function comecar() {
    if (!confirm('Importar as fotos do site antigo para TODAS as REFs com estoque que ainda não têm foto?\n\nRoda em segundo plano, aos poucos, e pode ser cancelado.')) return;
    setAbrindo(true);
    setErro(null);
    try {
      setStatus(await api<StatusLote>('/product-photos/importar-tudo', {
        method: 'POST',
        body: JSON.stringify({ apenasSemFoto: true }),
      }));
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui iniciar');
    } finally {
      setAbrindo(false);
    }
  }

  async function cancelar() {
    if (!confirm('Cancelar a importação? O que já entrou continua salvo.')) return;
    try {
      setStatus(await api<StatusLote>('/product-photos/importar-tudo/cancelar', { method: 'POST' }));
    } catch (e: any) {
      setErro(e?.message || 'Não consegui cancelar');
    }
  }

  /**
   * O CONSERTO DO PASSIVO (07/08). A importação trouxe milhares de fotos e não
   * publicou NADA — peça pronta, invisível no site e na busca. O importador já
   * foi corrigido, mas ele pula quem tem foto, então o que já entrou precisa
   * deste empurrão único.
   */
  async function publicarPendentes() {
    setPublicando(true);
    setErro(null);
    setReparo(null);
    try {
      // SIMULA PRIMEIRO. Pôr peça no ar pra cliente é ação de mão única —
      // o número tem que aparecer ANTES do "confirmar", não depois.
      const previa = await api<Reparo>('/product-photos/publicar-pendentes', {
        method: 'POST',
        body: JSON.stringify({ simular: true }),
      });
      if (!previa.publicadas) {
        setReparo(previa);
        return;
      }
      const ok = confirm(
        `${previa.publicadas} peça(s) vão entrar no site agora.\n\n` +
        `Critério: está ATIVA no WooCommerce (${previa.ativasNoWc} REFs ativas lá) e já tem foto aqui.\n` +
        `${previa.jaNoAr} já estavam no ar · ${previa.foraDoWc} ficam de fora (não estão ativas no site antigo).\n\n` +
        `Confirmar? Isso fica visível pra cliente.`,
      );
      if (!ok) return;
      setReparo(await api<Reparo>('/product-photos/publicar-pendentes', { method: 'POST' }));
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui publicar');
    } finally {
      setPublicando(false);
    }
  }

  /** Mutirão de bolinha — a varredura de fundo é lenta demais pro passivo. */
  async function pintarTodas() {
    if (!confirm(
      'Pintar TODAS as bolinhas que faltam agora?\n\n' +
      'Cada bolinha é uma leitura de IA sobre a foto — pode demorar alguns minutos.',
    )) return;
    setPintando(true);
    setErro(null);
    setMutirao(null);
    try {
      setMutirao(await api<Mutirao>('/product-photos/bolinha-auto/pintar-todas', { method: 'POST' }));
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui pintar');
    } finally {
      setPintando(false);
    }
  }

  /**
   * ACERVO EM JPEG — o mutirão que destrava a bolinha (12/08).
   *
   * Parte das fotos veio do WordPress em AVIF com nome `.jpg`: a IA responde
   * "formato não suportado" (era o que segurava 129 bolinhas) e o iPhone
   * anterior ao iOS 16.4 não abre a imagem. Vai em lotes porque o R2 corta
   * download em rajada — o botão continua de onde parou a cada clique.
   */
  async function normalizarFotos() {
    if (!confirm(
      'Converter as fotos AVIF/HEIC do acervo para JPEG?\n\n' +
      'Vai em lotes; clique de novo enquanto sobrar foto por olhar.',
    )) return;
    setNormalizando(true);
    setErro(null);
    try {
      setFormatos(await api<Formatos>('/product-photos/normalizar-formatos', {
        method: 'POST',
        body: JSON.stringify({ limite: 150 }),
      }));
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui converter');
    } finally {
      setNormalizando(false);
    }
  }

  /**
   * A DESCRIÇÃO VIRA FICHA (dono, 12/08).
   *
   * A descrição da peça passa de 40 linhas e não responde o que a cliente
   * pergunta — tecido, se estica, se tem forro, se é transparente. A IA lê o
   * texto que JÁ existe e preenche os campos, sem inventar nada e sem
   * sobrescrever o que alguém digitou. Em lotes, porque cada peça é uma
   * chamada paga.
   */
  async function extrairFichas() {
    if (!confirm(
      'Ler as descrições e preencher as fichas (tecido, elasticidade, forro, decote...)?\n\n' +
      'Vai em lotes de 40 peças; clique de novo enquanto sobrar peça.\n' +
      'Nada que já esteja preenchido é sobrescrito.',
    )) return;
    setExtraindo(true);
    setErro(null);
    try {
      setLoteIa(await api<LoteIa>('/produto-ficha/ia/lote', {
        method: 'POST',
        body: JSON.stringify({ limite: 40 }),
      }));
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui extrair');
    } finally {
      setExtraindo(false);
    }
  }

  const rodando = status?.status === 'rodando';
  const pct = status?.total ? Math.round(((status.processadas ?? 0) / status.total) * 100) : 0;

  return (
    <div className="border border-violet-200 bg-violet-50/40 rounded-xl p-3 mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-slate-800">Importar fotos do site antigo — tudo de uma vez</p>
          <p className="text-[11px] text-slate-500">
            Lista o que o site antigo TEM e importa só isso (não varre o catálogo inteiro).
            Traz as fotos de cada cor, grava aqui e já pinta a bolinha. Roda em segundo plano;
            pode fechar a tela.
          </p>
        </div>
        {rodando ? (
          <button type="button" onClick={() => void cancelar()}
            className="text-xs font-bold px-3 py-2 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50">
            Cancelar
          </button>
        ) : (
          <button type="button" onClick={() => void comecar()} disabled={abrindo}
            className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
            {abrindo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
            Importar tudo
          </button>
        )}
        <button type="button" onClick={() => void publicarPendentes()} disabled={publicando}
          title="Peça com foto que ficou fora do site entra na vitrine (só quem tem estoque)"
          className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg border border-emerald-300 text-emerald-800 bg-white hover:bg-emerald-50 disabled:opacity-50">
          {publicando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Package className="w-3.5 h-3.5" />}
          Publicar quem tem foto
        </button>
        <button type="button" onClick={() => void pintarTodas()} disabled={pintando}
          title="Pinta agora todas as bolinhas que faltam (a varredura de fundo é lenta pro passivo)"
          className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg border border-violet-300 text-violet-800 bg-white hover:bg-violet-50 disabled:opacity-50">
          {pintando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
          Pintar todas as bolinhas
        </button>
        <button type="button" onClick={() => void normalizarFotos()} disabled={normalizando}
          title="Converte pra JPEG as fotos que vieram em AVIF/HEIC — a IA não lê esse formato e o iPhone antigo não abre"
          className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg border border-sky-300 text-sky-800 bg-white hover:bg-sky-50 disabled:opacity-50">
          {normalizando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
          Converter fotos pra JPEG
        </button>
        <button type="button" onClick={() => void extrairFichas()} disabled={extraindo}
          title="A varredura já preenche sozinha (240 fichas/hora). Este botão é pra adiantar 40 de uma vez — a IA lê a descrição que já existe, sem inventar e sem sobrescrever o que você digitou"
          className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg border border-amber-300 text-amber-800 bg-white hover:bg-amber-50 disabled:opacity-50">
          {extraindo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Package className="w-3.5 h-3.5" />}
          Adiantar fichas com IA
        </button>
      </div>

      {reparo && (
        <div className="mt-3 text-[11px] rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 p-2">
          {reparo.publicadas || reparo.simulado ? (
            <>
              <strong>{reparo.publicadas}</strong> peça(s){' '}
              {reparo.simulado ? 'entrariam' : 'entraram'} no site · {reparo.jaNoAr} já estavam ·{' '}
              <strong>{reparo.foraDoWc}</strong> fora (não estão ativas no site antigo)
              {reparo.falhas ? ` · ${reparo.falhas} falharam` : ''}.
            </>
          ) : (
            <>Nada pra publicar: as {reparo.comFoto} peças com foto já estão no ar ou não estão ativas no site antigo.</>
          )}
          {' '}Ativas no WooCommerce: {reparo.ativasNoWc}.
        </div>
      )}

      {mutirao && (
        <div className="mt-2 text-[11px] rounded-lg border border-violet-200 bg-violet-50 text-violet-900 p-2">
          <strong>{mutirao.pintadas}</strong> bolinha(s) pintada(s) de {mutirao.pendentesAntes} que
          faltavam{mutirao.falharam ? ` · ${mutirao.falharam} não deram certo (clique de novo pra tentar)` : ''}.
        </div>
      )}

      {formatos && (
        <div className="mt-2 text-[11px] rounded-lg border border-sky-200 bg-sky-50 text-sky-900 p-2">
          <strong>{formatos.convertidas}</strong> foto(s) convertida(s) pra JPEG ·{' '}
          {formatos.jaOk} já estavam certas
          {formatos.falharam ? ` · ${formatos.falharam} falharam` : ''} ·{' '}
          {formatos.restantes
            ? <><strong>{formatos.restantes}</strong> por olhar — clique de novo</>
            : 'acervo inteiro conferido'}
          {!!formatos.exemplosFalha?.length && (
            <details className="mt-1">
              <summary className="cursor-pointer">ver as que falharam</summary>
              <ul className="mt-1 max-h-32 overflow-auto">
                {formatos.exemplosFalha.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {loteIa && (
        <div className="mt-2 text-[11px] rounded-lg border border-amber-200 bg-amber-50 text-amber-900 p-2">
          <strong>{loteIa.enriquecidas}</strong> ficha(s) preenchida(s) de {loteIa.olhadas} lida(s)
          {loteIa.semTexto ? ` · ${loteIa.semTexto} sem descrição pra ler` : ''}
          {loteIa.falharam ? ` · ${loteIa.falharam} falharam` : ''} ·{' '}
          {loteIa.restantes
            ? <><strong>{loteIa.restantes}</strong> pendente(s) — clique de novo</>
            : 'acervo inteiro lido'}
          {!!loteIa.foraDoCadastro?.length && (
            <details className="mt-1">
              <summary className="cursor-pointer">
                {loteIa.foraDoCadastro.length} valor(es) que o cadastro não tem — vale criar
              </summary>
              <ul className="mt-1 max-h-32 overflow-auto">
                {loteIa.foraDoCadastro.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {status?.existe && (
        <div className="mt-3">
          <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-full bg-violet-600 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[11px] text-slate-600 mt-1.5">
            {rodando ? 'Rodando' : status.status === 'concluido' ? 'Concluído' : 'Cancelado'} ·{' '}
            {status.processadas}/{status.total} REFs ({pct}%) · {status.fotos} foto(s) em{' '}
            {status.refsComFoto} peça(s) · {status.bolinhas} bolinha(s)
            {status.publicadas !== undefined && (
              <>
                {' · '}
                <strong className="text-emerald-800">{status.publicadas} no site</strong>
                {status.semEstoque ? ` · ${status.semEstoque} inativas no site antigo` : ''}
              </>
            )}
            {rodando && status.refAtual ? ` · agora: ${status.refAtual}` : ''}
          </p>
          {!!status.problemas?.length && (
            <details className="mt-1">
              <summary className="text-[11px] text-amber-700 cursor-pointer">
                {status.problemas.length} peça(s) sem foto no site antigo — ver
              </summary>
              <ul className="text-[11px] text-slate-500 mt-1 max-h-32 overflow-auto">
                {status.problemas.map((p, i) => (
                  <li key={i}>{p.ref} — {p.motivo}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {erro && <p className="text-xs text-rose-700 mt-2">{erro}</p>}
    </div>
  );
}
