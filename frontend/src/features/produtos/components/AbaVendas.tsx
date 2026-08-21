'use client';

/**
 * Aba VENDAS da ficha — o que ESTA peça vendeu.
 *
 * Reaproveita `GET /pdv/produtos-vendidos`, que já aceita `sku` (casa com SKU,
 * REF **ou** EAN), `from`, `to` e `storeCode`. Nenhum backend novo.
 *
 * ⚠️ A RESPOSTA VEM EM `linhas`, não em `rows`. A primeira versão desta aba
 * procurava `rows`/`itens`/`produtos`, caía no array vazio e a tela dizia "não
 * vendeu no período" pra peça que tinha vendido — erro pior que erro visível,
 * porque parece resposta. Cada linha é UM ITEM DE VENDA:
 * `{ data, hora, sku, ref, cor, tamanho, qty, precoUnit, total, storeCode,
 *    storeName, sellerName }`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import {
  Card, FiltroData, PERIODO_PADRAO, Table, TabelaVazia, Tabs, Td, Th, Tr,
  type Aba, type Periodo,
} from '@/components/ui';

interface LinhaVendida {
  data: string;
  hora: string;
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  descricao: string;
  qty: number;
  precoUnit: number;
  total: number;
  storeCode: string;
  storeName: string;
  sellerName: string | null;
}

type Corte = 'loja' | 'variacao' | 'vendedora';

function brl(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function AbaVendas({ ref_ }: { ref_: string }) {
  const [periodo, setPeriodo] = useState<Periodo>(PERIODO_PADRAO);
  const [linhas, setLinhas] = useState<LinhaVendida[] | null>(null);
  const [corte, setCorte] = useState<Corte>('loja');
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
      const r = await api<{ linhas?: LinhaVendida[] }>(`/pdv/produtos-vendidos?${qs.toString()}`);
      setLinhas(r?.linhas ?? []);
    } catch (e: any) {
      const msg = String(e?.message || e);
      setErro(
        /403/.test(msg)
          ? 'Você não tem acesso ao relatório de vendas.'
          : `Não deu pra carregar as vendas: ${msg}`,
      );
      setLinhas([]);
    } finally {
      setCarregando(false);
    }
  }, [ref_, periodo.de, periodo.ate]);

  useEffect(() => { void carregar(); }, [carregar]);

  const totalQtd = (linhas || []).reduce((s, l) => s + (l.qty || 0), 0);
  const totalValor = (linhas || []).reduce((s, l) => s + (l.total || 0), 0);

  /** Agrupa pelo corte escolhido — a mesma venda vista de três ângulos. */
  const grupos = useMemo(() => {
    const m = new Map<string, { rotulo: string; qtd: number; valor: number }>();
    for (const l of linhas || []) {
      let chave: string;
      let rotulo: string;
      if (corte === 'loja') {
        chave = l.storeCode || '—';
        rotulo = l.storeName || `Loja ${l.storeCode}`;
      } else if (corte === 'variacao') {
        chave = `${l.cor || '—'}|${l.tamanho || '—'}`;
        rotulo = [l.cor, l.tamanho].filter(Boolean).join(' · ') || l.sku;
      } else {
        chave = l.sellerName || '—';
        rotulo = l.sellerName || 'sem vendedora';
      }
      const atual = m.get(chave) || { rotulo, qtd: 0, valor: 0 };
      atual.qtd += l.qty || 0;
      atual.valor += l.total || 0;
      m.set(chave, atual);
    }
    return [...m.values()].sort((a, b) => b.qtd - a.qtd);
  }, [linhas, corte]);

  const abas: Aba<Corte>[] = [
    { id: 'loja', label: 'Por loja' },
    { id: 'variacao', label: 'Por cor e tamanho' },
    { id: 'vendedora', label: 'Por vendedora' },
  ];

  return (
    <div className="flex flex-col gap-3">
      <FiltroData valor={periodo} onChange={setPeriodo} onAplicar={carregar} carregando={carregando} />

      {erro && <Card className="border-crit bg-crit-soft px-4 py-3 text-[13px] text-crit">{erro}</Card>}

      <Card className="grid grid-cols-2 divide-x divide-line sm:grid-cols-3">
        <div className="px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-[.13em] text-ink-soft">Peças vendidas</div>
          <div className="mt-1 text-[24px] font-extrabold leading-none tabular-nums text-ink">{totalQtd}</div>
        </div>
        <div className="px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-[.13em] text-ink-soft">Faturado</div>
          {/* dinheiro é grafite — no Semáforo verde significa "em dia" */}
          <div className="mt-1 text-[24px] font-extrabold leading-none tabular-nums text-ink">{brl(totalValor)}</div>
        </div>
        <div className="px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-[.13em] text-ink-soft">Itens de venda</div>
          <div className="mt-1 text-[24px] font-extrabold leading-none tabular-nums text-ink">{linhas?.length ?? 0}</div>
        </div>
      </Card>

      <Tabs abas={abas} valor={corte} onChange={setCorte} />

      <Table>
        <thead>
          <tr>
            <Th>{corte === 'loja' ? 'Loja' : corte === 'variacao' ? 'Cor e tamanho' : 'Vendedora'}</Th>
            <Th align="right">Peças</Th>
            <Th align="right">Faturado</Th>
          </tr>
        </thead>
        <tbody>
          {carregando && <TabelaVazia colSpan={3}>Carregando as vendas…</TabelaVazia>}
          {!carregando && !grupos.length && (
            <TabelaVazia colSpan={3}>
              Esta peça não vendeu entre {periodo.de.split('-').reverse().join('/')} e{' '}
              {periodo.ate.split('-').reverse().join('/')}. Tente um intervalo maior.
            </TabelaVazia>
          )}
          {!carregando && grupos.map((g) => (
            <Tr key={g.rotulo}>
              <Td>{g.rotulo}</Td>
              <Td align="right" num className={g.qtd < 0 ? 'font-bold text-crit' : undefined}>
                {g.qtd}
              </Td>
              <Td align="right" num className="font-semibold">{brl(g.valor)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      <p className="px-1 text-[12px] text-ink-faint">
        Devolução entra com sinal negativo e aparece em vermelho.{' '}
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
