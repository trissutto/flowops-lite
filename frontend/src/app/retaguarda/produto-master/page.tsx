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
/**
 * Tipos e componentes da cascata saíram deste arquivo em 21/08/2026 pra
 * `@/features/produtos`, porque a tela nova `/retaguarda/produtos` usa os
 * MESMOS. Nada mudou de comportamento — só o endereço.
 */
import {
  ELASTICIDADE_LABEL,
  STATUS_LABEL,
  type ArvoreSite,
  type Ficha,
  type FichaCor,
  type Grade,
  type Movimento,
  type Pendencia,
  type Produto,
  type SkuRow,
  type VitrinesPeca,
} from '@/features/produtos/types';
import {
  FichaComum,
  FichaDaCor,
  GradeEstoque,
  VitrinesDoSite,
} from '@/features/produtos/components/FichaProduto';
import MatrizReposicao from '@/features/produtos/components/MatrizReposicao';

/** Os três modos do nível 3. Rótulo aqui pra não virar `if` dentro do JSX. */
const MODO_LABEL = {
  mover: 'Mover entre lojas',
  ajustar: 'Ajustar estoque',
  comprar: 'Comprar de novo',
} as const;


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
  /**
   * 'comprar' (24/08) é a terceira pergunta da mesma cor: as duas de cima
   * mexem no que JÁ existe (onde a peça está, quanto tem), essa olha o que
   * FALTA. Entrou como modo, e não como painel embaixo da grade, porque a
   * matriz tem a sua própria linha de estoque — as duas visíveis ao mesmo
   * tempo dariam dois totais na mesma tela.
   */
  const [modo, setModo] = useState<'mover' | 'ajustar' | 'comprar'>('mover');
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

      <MutiroesDoAcervo />

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
                              de digitação ao mesmo tempo. "Comprar de novo"
                              nem mexe no estoque: olha o que falta. */}
                          <div className="flex gap-1">
                            {(['mover', 'ajustar', 'comprar'] as const).map((m) => (
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
                                {MODO_LABEL[m]}
                              </button>
                            ))}
                          </div>
                          {modo === 'comprar' ? (
                            <MatrizReposicao
                              ref_={prod.ref}
                              marca={prod.marca}
                              cor={prod.cor}
                              skus={prod.skus}
                              lojaNomes={lojaNomes}
                            />
                          ) : (
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
                          )}
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



/* ─────────────── Mutirões do acervo de fotos e fichas ─────────────── */

/*
 * A importação de fotos do site antigo (WooCommerce) saiu em 09/26 — o botão
 * por REF e o "Importar tudo" em lote. O host do WordPress foi apagado em
 * 27/08/2026: não existe mais acervo pra puxar. Foto nova entra pelo upload da
 * própria peça.
 */

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
 * Os mutirões do acervo: publicar quem já tem foto, pintar bolinha, converter
 * formato e adiantar ficha com IA. Cada um roda no servidor e volta com o
 * número do que fez — nada aqui depende do navegador ficar aberto.
 */
function MutiroesDoAcervo() {
  const [erro, setErro] = useState<string | null>(null);
  const [publicando, setPublicando] = useState(false);
  const [reparo, setReparo] = useState<Reparo | null>(null);
  const [pintando, setPintando] = useState(false);
  const [mutirao, setMutirao] = useState<Mutirao | null>(null);
  const [normalizando, setNormalizando] = useState(false);
  const [formatos, setFormatos] = useState<Formatos | null>(null);
  const [extraindo, setExtraindo] = useState(false);
  const [loteIa, setLoteIa] = useState<LoteIa | null>(null);

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

  return (
    <div className="border border-violet-200 bg-violet-50/40 rounded-xl p-3 mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-slate-800">Mutirões do acervo</p>
          <p className="text-[11px] text-slate-500">
            Trabalho em massa sobre o que já está aqui: põe no ar quem tem foto, pinta as
            bolinhas que faltam, acerta o formato das imagens e adianta as fichas.
          </p>
        </div>
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

      {erro && <p className="text-xs text-rose-700 mt-2">{erro}</p>}
    </div>
  );
}
