'use client';

/**
 * Aba VENDAS da ficha — o que ESTA peça vendeu.
 *
 * Reaproveita `GET /pdv/produtos-vendidos`, que já aceita `sku` (casa com SKU
 * **ou** REF), `from`, `to` e `storeCode`. Nenhum backend novo: o relatório da
 * rede continua existindo em `/retaguarda/produtos-vendidos`, porque responde
 * outra pergunta — o que mais vendeu no período, sem escolher peça antes.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import {
  Badge, Card, FiltroData, PERIODO_PADRAO, Table, TabelaVazia, Td, Th, Tr,
  type Periodo,
} from '@/components/ui';

type LinhaVenda = {
  sku?: string;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  storeCode?: string | null;
  qtd?: number;
  quantidade?: number;
  total?: number;
  valor?: number;
  data?: string;
  createdAt?: string;
};

function brl(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function AbaVendas({
  ref_,
  lojaNomes,
}: {
  ref_: string;
  lojaNomes: Map<string, string>;
}) {
  const [periodo, setPeriodo] = useState<Periodo>(PERIODO_PADRAO);
  const [linhas, setLinhas] = useState<LinhaVenda[] | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const qs = new URLSearchParams({
        sku: ref_,
        from: periodo.de,
        to: periodo.ate,
        includeReturns: '1',
      });
      const r = await api<any>(`/pdv/produtos-vendidos?${qs.toString()}`);
      /* a resposta pode vir como array puro ou embrulhada — normaliza aqui */
      const lista: LinhaVenda[] = Array.isArray(r) ? r : (r?.rows ?? r?.itens ?? r?.produtos ?? []);
      setLinhas(lista);
    } catch (e: any) {
      setErro(e?.message || 'Não deu pra carregar as vendas.');
      setLinhas([]);
    } finally {
      setCarregando(false);
    }
  }, [ref_, periodo.de, periodo.ate]);

  useEffect(() => { void carregar(); }, [carregar]);

  const qtdDe = (l: LinhaVenda) => l.qtd ?? l.quantidade ?? 0;
  const valorDe = (l: LinhaVenda) => l.total ?? l.valor ?? null;

  const totalQtd = (linhas || []).reduce((s, l) => s + qtdDe(l), 0);
  const totalValor = (linhas || []).reduce((s, l) => s + (valorDe(l) ?? 0), 0);

  /* quebra por loja — a pergunta que a matriz faz primeiro */
  const porLoja = new Map<string, { qtd: number; valor: number }>();
  for (const l of linhas || []) {
    const loja = String(l.storeCode || '—');
    const atual = porLoja.get(loja) || { qtd: 0, valor: 0 };
    atual.qtd += qtdDe(l);
    atual.valor += valorDe(l) ?? 0;
    porLoja.set(loja, atual);
  }
  const lojas = [...porLoja.entries()].sort((a, b) => b[1].qtd - a[1].qtd);

  return (
    <div className="flex flex-col gap-3">
      <FiltroData valor={periodo} onChange={setPeriodo} onAplicar={carregar} carregando={carregando} />

      {erro && (
        <Card className="border-crit bg-crit-soft px-4 py-3 text-[13px] text-crit">{erro}</Card>
      )}

      <Card className="grid grid-cols-2 divide-x divide-line sm:grid-cols-3">
        <div className="px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-[.13em] text-ink-soft">Peças vendidas</div>
          <div className="mt-1 text-[24px] font-extrabold leading-none tabular-nums text-ink">{totalQtd}</div>
        </div>
        <div className="px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-[.13em] text-ink-soft">Faturado</div>
          {/* dinheiro é grafite, não verde — verde agora significa "em dia" */}
          <div className="mt-1 text-[24px] font-extrabold leading-none tabular-nums text-ink">{brl(totalValor)}</div>
        </div>
        <div className="px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-[.13em] text-ink-soft">Lojas que venderam</div>
          <div className="mt-1 text-[24px] font-extrabold leading-none tabular-nums text-ink">{lojas.length}</div>
        </div>
      </Card>

      <Table>
        <thead>
          <tr>
            <Th>Loja</Th>
            <Th align="right">Peças</Th>
            <Th align="right">Faturado</Th>
          </tr>
        </thead>
        <tbody>
          {carregando && <TabelaVazia colSpan={3}>Carregando as vendas…</TabelaVazia>}
          {!carregando && !lojas.length && (
            <TabelaVazia colSpan={3}>
              Esta peça não vendeu no período. Tente um intervalo maior.
            </TabelaVazia>
          )}
          {!carregando && lojas.map(([loja, v]) => (
            <Tr key={loja}>
              <Td>
                {lojaNomes.get(loja) || `Loja ${loja}`}
                {v.qtd < 0 && <Badge tom="warn" className="ml-2">devolução</Badge>}
              </Td>
              <Td align="right" num>{v.qtd}</Td>
              <Td align="right" num className="font-semibold">{brl(v.valor)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      <p className="px-1 text-[12px] text-ink-faint">
        Devolução entra com sinal negativo.{' '}
        <Link
          href="/retaguarda/produtos-vendidos"
          className="inline-flex items-center gap-1 text-ink-soft underline-offset-2 hover:text-ink hover:underline"
        >
          Ver o relatório da rede inteira <ExternalLink className="h-3 w-3" />
        </Link>
      </p>
    </div>
  );
}
