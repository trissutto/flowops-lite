'use client';

/**
 * Aba HISTÓRICO da ficha — o que aconteceu com esta peça, em qualquer loja.
 *
 * Lê `stock_movements` por SKU, sem exigir loja (o `storeCode` do endpoint
 * deixou de ser obrigatório em 21/08). Manda todos os códigos da REF de uma
 * vez, porque a peça é cor × tamanho e perguntar um por um seriam N chamadas.
 *
 * ⚠️ O QUE ESTA ABA NÃO MOSTRA, e por quê: até 21/08 o ajuste manual de
 * estoque ia só pra `productEditAudit`, e `stock_movements` recebia venda,
 * conferência e sync. A partir deste PR o ajuste entra nas duas — mas o que é
 * ANTERIOR a ele continua só na auditoria. Histórico curto numa peça velha
 * pode ser isso, não falta de movimento.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  Badge, Card, Table, TabelaVazia, Td, Th, Tr, type EstadoLinha,
} from '@/components/ui';

type Movimento = {
  id: string;
  storeCode: string;
  sku: string;
  delta: number;
  qtyBefore: number;
  qtyAfter: number;
  reason: string;
  refId: string | null;
  note: string | null;
  userId: string | null;
  createdAt: string;
};

/** Nome de gente pro motivo cru do banco. */
const MOTIVO: Record<string, string> = {
  sale: 'Venda',
  ajuste_manual: 'Ajuste manual',
  sync_giga: 'Sincronização do Giga',
  conferencia: 'Conferência',
};

function rotuloMotivo(r: string): string {
  return MOTIVO[r] || r.replace(/_/g, ' ');
}

/** Só o que TIRA peça de circulação sem venda merece destaque. */
function estadoDo(m: Movimento): EstadoLinha | undefined {
  if (m.reason === 'ajuste_manual') return 'warn';
  return undefined;
}

function quando(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function AbaHistorico({
  codigos,
  lojaNomes,
  rotuloDoSku,
}: {
  codigos: string[];
  lojaNomes: Map<string, string>;
  /** `123456` → "PRETO · 46", pra a linha dizer qual variação mexeu */
  rotuloDoSku: (sku: string) => string;
}) {
  const [movs, setMovs] = useState<Movimento[] | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    if (!codigos.length) { setMovs([]); setCarregando(false); return; }
    setCarregando(true);
    setErro(null);
    try {
      const qs = new URLSearchParams({ skus: codigos.join(','), limit: '300' });
      const r = await api<Movimento[] | { error?: string }>(
        `/admin/stock-mirror/movements?${qs.toString()}`,
      );
      if (Array.isArray(r)) setMovs(r);
      else { setErro((r as any)?.error || 'Resposta inesperada.'); setMovs([]); }
    } catch (e: any) {
      const msg = String(e?.message || e);
      setErro(
        /403|admin/i.test(msg)
          ? 'O histórico de movimentação é restrito à matriz.'
          : `Não deu pra carregar o histórico: ${msg}`,
      );
      setMovs([]);
    } finally {
      setCarregando(false);
    }
  }, [codigos]);

  useEffect(() => { void carregar(); }, [carregar]);

  return (
    <div className="flex flex-col gap-3">
      {erro && (
        <Card className="border-crit bg-crit-soft px-4 py-3 text-[13px] text-crit">{erro}</Card>
      )}

      <Table>
        <thead>
          <tr>
            <Th>Quando</Th>
            <Th>Loja</Th>
            <Th>Variação</Th>
            <Th>Motivo</Th>
            <Th align="right">Mudança</Th>
            <Th align="right">Ficou</Th>
            <Th>Quem</Th>
          </tr>
        </thead>
        <tbody>
          {carregando && <TabelaVazia colSpan={7}>Carregando o histórico…</TabelaVazia>}
          {!carregando && !movs?.length && (
            <TabelaVazia colSpan={7}>
              Nenhum movimento registrado pra esta peça.
            </TabelaVazia>
          )}
          {!carregando && movs?.map((m) => (
            <Tr key={m.id} estado={estadoDo(m)}>
              <Td num className="text-ink-soft">{quando(m.createdAt)}</Td>
              <Td>{lojaNomes.get(m.storeCode) || `Loja ${m.storeCode}`}</Td>
              <Td className="text-ink-soft">{rotuloDoSku(m.sku)}</Td>
              <Td>
                {rotuloMotivo(m.reason)}
                {m.note && <span className="ml-2 text-ink-faint">· {m.note}</span>}
              </Td>
              <Td align="right" num className="font-semibold">
                {m.delta > 0 ? `+${m.delta}` : m.delta}
              </Td>
              <Td align="right" num className="text-ink-soft">
                {m.qtyBefore} → {m.qtyAfter}
              </Td>
              <Td className="text-ink-soft">
                {m.userId || <span className="text-ink-faint">sistema</span>}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      <p className="px-1 text-[12px] leading-relaxed text-ink-faint">
        Ajuste manual anterior a 21/08/2026 não aparece aqui — até então ele era gravado só na
        auditoria do editor. <Badge tom="warn">Ajuste manual</Badge> ganha faixa porque é a única
        linha em que alguém mudou o estoque na mão.
      </p>
    </div>
  );
}
