'use client';

/**
 * /retaguarda/modulo-produtos — A MESA DE TRIAGEM do segmento Produtos & Estoque.
 *
 * Pedido do dono (11/08/2026), como primeiro passo da reorganização dos
 * módulos: TODAS as telas do segmento numa tela só, NUMERADAS, com descrição
 * e uso real — ele testa uma a uma e devolve "o 12 exclui, mescla o 7 com o
 * 15". O número é o vocabulário da conversa; por isso ele é fixo no array e
 * NUNCA deve ser renumerado enquanto a triagem estiver viva (excluir tela =
 * riscar o número, não reaproveitar).
 *
 * O uso vem de GET /telemetria/paginas (ligada em 11/08): quantas visitas,
 * quando foi a última e quem (papel/loja). Tela sem visita mostra "nunca
 * visto" — com a data de início da medição, senão "nunca" parece eterno e a
 * medição tem só dias.
 *
 * Achados do inventário que esta tela expõe de propósito:
 * · `/retaguarda/produto-estoque` é uma tentativa ANTERIOR de módulo
 *   unificado, com 9 subtelas — quase todas órfãs. A triagem decide se ela
 *   vira o destino final ou morre.
 * · Telas de detalhe (com [id]) não têm botão: abrem a partir da lista-mãe.
 *   Estão aqui pra contagem ficar honesta, marcadas como "detalhe".
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Boxes, ExternalLink } from 'lucide-react';

interface Uso {
  path: string;
  hits: number;
  lastAt: string;
  lastRole: string | null;
  lastStore: string | null;
}

interface Item {
  n: number;
  href: string;
  titulo: string;
  desc: string;
  area: string;
  /** Tela de detalhe — precisa de um id, não tem botão direto. */
  detalhe?: boolean;
  /** Sem link em lugar nenhum antes desta tela. */
  orfa?: boolean;
}

/** ⚠️ NÚMEROS FIXOS — são o vocabulário da triagem. Nunca renumerar. */
const ITENS: Item[] = [
  // ── Cadastro & Ficha ──
  { n: 1, area: 'Cadastro & Ficha', href: '/retaguarda/produto-master', titulo: 'Ficha Master do Produto', desc: 'A ficha completa de uma peça num lugar só: fotos por cor, ficha técnica, publicação no site.' },
  { n: 2, area: 'Cadastro & Ficha', href: '/retaguarda/cadastro-produtos', titulo: 'Cadastro de Produtos', desc: 'Cadastro dinâmico de produto novo (gera REF/EAN pela sequência do Flow).' },
  { n: 3, area: 'Cadastro & Ficha', href: '/retaguarda/editor-produtos', titulo: 'Editor de Produtos', desc: 'Edição em massa de nome/preço/atributos (só admin).' },
  { n: 4, area: 'Cadastro & Ficha', href: '/produtos', titulo: 'Consultar Catálogo (Woo)', desc: 'Listagem ao vivo do catálogo WooCommerce — a "Consultar" antiga.' },
  { n: 5, area: 'Cadastro & Ficha', href: '/retaguarda/produtos-agrupados', titulo: 'Produtos Agrupados', desc: 'Revisão das REFs juntadas como uma peça só (900887 + 900887B). Separar aqui trava contra o sync.' },

  // ── Classificação ──
  { n: 6, area: 'Classificação', href: '/retaguarda/classificar-produtos', titulo: 'Classificar Produtos (site)', desc: 'Mutirão de categoria/subcategoria da vitrine, em lote, com atalhos por manga.' },
  { n: 7, area: 'Classificação', href: '/cadastros/classificacao-produtos', titulo: 'Classificação BÁSICO/MODA', desc: 'Marca cada REF como BÁSICO ou MODA (relatórios de compra).' },
  { n: 8, area: 'Classificação', href: '/cadastros/classificacao-peca', titulo: 'Classificação da Peça', desc: 'Ocasião · Tecido · Modelagem · Coleção — os eixos da ficha que o site filtra.' },

  // ── Estoque ──
  { n: 9, area: 'Estoque', href: '/retaguarda/estoque', titulo: 'Estoque (consulta)', desc: 'Consulta de estoque por REF/loja.' },
  { n: 10, area: 'Estoque', href: '/retaguarda/baixa-estoque', titulo: 'Baixa de Estoque', desc: 'Baixa manual de peças (perda, defeito, uso interno).' },
  { n: 11, area: 'Estoque', href: '/retaguarda/baixa-origem', titulo: 'Baixa na Origem', desc: 'Baixa de estoque na loja de origem (fluxo site/live).' },
  { n: 12, area: 'Estoque', href: '/retaguarda/baixas-log', titulo: 'Log de Baixas', desc: 'Auditoria de todas as baixas feitas.' },
  // n:13 (Conferidor Flow × Giga) saiu da lista em 09/26: o MySQL do Giga foi desligado.
  { n: 14, area: 'Estoque', href: '/retaguarda/reconciliar-estoque', titulo: 'Reconciliar Estoque', desc: 'Acerta divergências encontradas na conferência.' },
  { n: 15, area: 'Estoque', href: '/retaguarda/reprocessar-estoque', titulo: 'Reprocessar Estoque', desc: 'Reprocessa movimentos de estoque (ferramenta de correção).' },
  { n: 16, area: 'Estoque', href: '/retaguarda/inteligencia-estoque', titulo: 'Inteligência de Estoque', desc: 'Sugestões de compra/redistribuição a partir do giro.' },
  { n: 17, area: 'Estoque', href: '/retaguarda/distribuicao-estoque', titulo: 'Distribuição de Estoque', desc: 'Distribui peças recém-chegadas entre as lojas.' },
  { n: 18, area: 'Estoque', href: '/franquias/estoque', titulo: 'Estoque de Franquias', desc: 'Visão de estoque do portal de franquias.' },

  // ── Entradas & Pedidos de compra ──
  { n: 19, area: 'Entradas & Compras', href: '/loja/pedidos-compra', titulo: 'Pedidos de Compra', desc: 'Lista de pedidos de compra de fornecedor.' },
  { n: 20, area: 'Entradas & Compras', href: '/loja/pedidos-compra/novo', titulo: 'Novo Pedido de Compra', desc: 'Criação de pedido (grade cor×tamanho, NCM por IA).' },
  { n: 21, area: 'Entradas & Compras', href: '/loja/pedidos-compra/[id]', titulo: 'Detalhe do Pedido', desc: 'Conferência e recebimento de um pedido.', detalhe: true },
  { n: 22, area: 'Entradas & Compras', href: '/loja/pedidos-compra/[id]/etiquetas', titulo: 'Etiquetas do Pedido', desc: 'Etiquetas das peças recebidas num pedido.', detalhe: true },
  { n: 23, area: 'Entradas & Compras', href: '/loja/pedidos-compra/[id]/imprimir', titulo: 'Imprimir Pedido', desc: 'Versão de impressão do pedido.', detalhe: true },
  { n: 24, area: 'Entradas & Compras', href: '/loja/reposicao', titulo: 'Reposição', desc: 'Reposição de produtos vendidos.' },
  { n: 25, area: 'Entradas & Compras', href: '/retaguarda/almoxarifado', titulo: 'Almoxarifado', desc: 'Materiais de consumo interno (sacolas, bobinas...).' },

  // ── Realinhamento (transferência entre lojas) ──
  { n: 26, area: 'Realinhamento', href: '/retaguarda/realinhamento', titulo: 'Realinhamento (matriz)', desc: 'Rebalanceia estoque entre lojas — gera as ordens.' },
  { n: 27, area: 'Realinhamento', href: '/minha-loja/realinhamento', titulo: 'Realinhamento (filial)', desc: 'A filial separa as ordens recebidas.' },
  { n: 28, area: 'Realinhamento', href: '/retaguarda/realinhamento/nao-encontrados', titulo: 'Não Encontrados', desc: 'Peças que a filial não achou na separação.' },
  { n: 29, area: 'Realinhamento', href: '/retaguarda/realinhamento/imprimir', titulo: 'Imprimir Realinhamento', desc: 'Romaneio de impressão das ordens.', orfa: true },

  // ── Etiquetas ──
  { n: 30, area: 'Etiquetas', href: '/loja/etiquetas-avulsas', titulo: 'Etiquetas Avulsas', desc: 'Imprime etiquetas a partir de SKUs/REFs/EANs soltos.' },

  // ── Auditoria & Diagnóstico ──
  { n: 31, area: 'Auditoria', href: '/auditoria-sku', titulo: 'Auditoria de SKU', desc: 'Confere SKUs divergentes entre sistemas.' },
  // n:32 (Auditoria de NCM) saiu da lista em 09/26: a tela lia o MySQL do Giga, que foi desligado.

  // ── Relatórios de venda de peça ──
  { n: 33, area: 'Vendidos', href: '/retaguarda/produtos-vendidos', titulo: 'Produtos Vendidos (matriz)', desc: 'O que vendeu, por peça, na rede.' },
  { n: 34, area: 'Vendidos', href: '/minha-loja/pdv/produtos-vendidos', titulo: 'Produtos Vendidos (loja)', desc: 'O que a própria loja vendeu.' },

  // ── Módulo unificado (tentativa anterior — decidir o destino) ──
  { n: 35, area: 'Módulo unificado (antigo)', href: '/retaguarda/produto-estoque', titulo: 'Produto & Estoque (hub)', desc: 'Tentativa anterior de juntar tudo. Hub com abas internas.' },
  { n: 36, area: 'Módulo unificado (antigo)', href: '/retaguarda/produto-estoque/produtos', titulo: '↳ Produtos', desc: 'Aba de produtos do módulo unificado.' },
  { n: 37, area: 'Módulo unificado (antigo)', href: '/retaguarda/produto-estoque/produtos/classificacao', titulo: '↳ Classificação', desc: 'Aba de classificação do módulo unificado.' },
  { n: 38, area: 'Módulo unificado (antigo)', href: '/retaguarda/produto-estoque/produtos/grade-geral', titulo: '↳ Grade Geral', desc: 'Grade cor×tamanho geral.', orfa: true },
  { n: 39, area: 'Módulo unificado (antigo)', href: '/retaguarda/produto-estoque/produtos/pendencias', titulo: '↳ Pendências', desc: 'Pendências de cadastro.', orfa: true },
  { n: 40, area: 'Módulo unificado (antigo)', href: '/retaguarda/produto-estoque/cadastros', titulo: '↳ Cadastros', desc: 'Aba de cadastros.', orfa: true },
  { n: 41, area: 'Módulo unificado (antigo)', href: '/retaguarda/produto-estoque/entradas', titulo: '↳ Entradas', desc: 'Aba de entradas.', orfa: true },
  { n: 42, area: 'Módulo unificado (antigo)', href: '/retaguarda/produto-estoque/estoque', titulo: '↳ Estoque', desc: 'Aba de estoque.', orfa: true },
  { n: 43, area: 'Módulo unificado (antigo)', href: '/retaguarda/produto-estoque/inteligencia', titulo: '↳ Inteligência', desc: 'Aba de inteligência.', orfa: true },
];

const INICIO_MEDICAO = '11/08/2026';

export default function ModuloProdutosPage() {
  const [uso, setUso] = useState<Map<string, Uso>>(new Map());
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api<Uso[]>('/telemetria/paginas')
      .then((r) => setUso(new Map(r.map((u) => [u.path, u]))))
      .catch((e) => setErro(e?.message ?? 'telemetria indisponível'));
  }, []);

  const areas = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of ITENS) (m.get(i.area) ?? m.set(i.area, []).get(i.area)!).push(i);
    return [...m.entries()];
  }, []);

  const fmtUso = (i: Item) => {
    const u = uso.get(i.href);
    if (!u) return { texto: `nunca visto (medição desde ${INICIO_MEDICAO})`, tom: 'text-slate-400' };
    const d = new Date(u.lastAt);
    const quando = d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
    const quem = u.lastRole === 'store' ? `loja ${u.lastStore}` : u.lastRole || '?';
    return { texto: `${u.hits} acesso(s) · último ${quando} (${quem})`, tom: 'text-emerald-700' };
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Boxes className="w-6 h-6" /> Módulo Produtos — triagem
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          As {ITENS.length} telas do segmento, numeradas. Teste cada uma e responda pelo número:
          <b> &quot;o 12 exclui, mescla o 7 com o 15&quot;</b>. Os números nunca mudam.
        </p>
        {erro && <p className="text-xs text-amber-700 mt-1">uso indisponível agora: {erro}</p>}
      </div>

      {areas.map(([area, itens]) => (
        <section key={area} className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-3">{area}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {itens.map((i) => {
              const u = fmtUso(i);
              const card = (
                <div
                  className={`h-full rounded-lg border bg-white p-4 shadow-sm transition ${
                    i.detalhe ? 'opacity-70' : 'hover:border-brand/50 hover:shadow'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-white">
                      {i.n}
                    </span>
                    {i.orfa && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                        SEM LINK
                      </span>
                    )}
                    {i.detalhe && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                        DETALHE
                      </span>
                    )}
                    {!i.detalhe && <ExternalLink className="w-3.5 h-3.5 text-slate-300" />}
                  </div>
                  <div className="mt-2 text-sm font-semibold text-slate-800">{i.titulo}</div>
                  <div className="mt-0.5 text-xs text-slate-500 leading-snug">{i.desc}</div>
                  <div className="mt-2 font-mono text-[10px] text-slate-400">{i.href}</div>
                  <div className={`mt-1 text-[11px] ${u.tom}`}>{u.texto}</div>
                </div>
              );
              return i.detalhe ? (
                <div key={i.n}>{card}</div>
              ) : (
                <Link key={i.n} href={i.href} target="_blank" className="block">
                  {card}
                </Link>
              );
            })}
          </div>
        </section>
      ))}

      <p className="mt-4 text-xs text-slate-400">
        Telas marcadas <b>DETALHE</b> abrem a partir da lista-mãe (precisam de um id) — estão aqui só
        pra contagem. <b>SEM LINK</b> = nenhum botão do sistema leva até ela hoje.
      </p>
    </div>
  );
}
