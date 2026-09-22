'use client';

/**
 * ESTORNOS DESTE PEDIDO — o bloco dentro da ficha (22/09/2026).
 *
 * Só leitura, e some quando não há estorno nenhum (que é o caso de quase todo
 * pedido). Ele existe por um motivo bem específico: quem atende a cliente abre
 * o PEDIDO, não a tela de estornos — sem este bloco, a pessoa não enxerga que
 * o dinheiro já voltou e pede de novo.
 *
 * Estornar continua sendo em /site/estornos, com senha Master/Suprema.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Undo2 } from 'lucide-react';
import { api } from '@/lib/api';

type Linha = {
  id: string;
  status: string;
  tipo: string;
  valorCents: number;
  metodo: string;
  motivoLabel: string;
  criadoEm: string | null;
  processadoEm: string | null;
  usuarioNome: string | null;
};

const ROTULO: Record<string, { texto: string; cor: string }> = {
  iniciado: { texto: 'iniciado', cor: 'bg-slate-100 text-slate-700' },
  enviado: { texto: 'enviado ao gateway', cor: 'bg-amber-100 text-amber-800' },
  processando: { texto: 'em processamento', cor: 'bg-amber-100 text-amber-800' },
  processado: { texto: 'processado', cor: 'bg-emerald-100 text-emerald-800' },
  recusado: { texto: 'recusado', cor: 'bg-rose-100 text-rose-800' },
  erro: { texto: 'erro', cor: 'bg-rose-100 text-rose-800' },
};

const brl = (c: number) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const quando = (v: string | null) =>
  v
    ? new Date(v).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '—';

export default function BlocoEstornos({ pedidoRef }: { pedidoRef: string | number }) {
  const [linhas, setLinhas] = useState<Linha[]>([]);

  useEffect(() => {
    let vivo = true;
    api<{ estornos: Linha[] }>(`/admin/estornos/pedido/${encodeURIComponent(String(pedidoRef))}`)
      .then((r) => { if (vivo) setLinhas(r?.estornos || []); })
      // Sem permissão (loja) ou sem estorno: o bloco simplesmente não aparece.
      .catch(() => {});
    return () => { vivo = false; };
  }, [pedidoRef]);

  if (!linhas.length) return null;

  const devolvido = linhas
    .filter((l) => l.status === 'processado' || l.status === 'processando')
    .reduce((s, l) => s + l.valorCents, 0);

  return (
    <div className="bg-white rounded-lg shadow border border-rose-200 p-4 mb-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-black text-slate-800 uppercase tracking-wide flex items-center gap-2">
          <Undo2 className="w-4 h-4 text-rose-600" /> Estornos deste pedido
        </h3>
        <span className="text-sm">
          <span className="text-slate-500 text-xs">devolvido: </span>
          <b className="text-rose-700">{brl(devolvido)}</b>
        </span>
      </div>
      <div className="divide-y mt-2">
        {linhas.map((l) => {
          const r = ROTULO[l.status] || { texto: l.status, cor: 'bg-slate-100 text-slate-700' };
          return (
            <div key={l.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-xs text-slate-500 w-24">{quando(l.criadoEm)}</span>
              <b className="text-slate-800">{brl(l.valorCents)}</b>
              <span className="text-xs text-slate-500">
                {l.tipo === 'integral' ? 'integral' : 'parcial'} · {String(l.metodo).includes('pix') ? 'PIX' : 'cartão'}
              </span>
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${r.cor}`}>{r.texto}</span>
              <span className="text-xs text-slate-500">{l.motivoLabel}</span>
              {l.usuarioNome && <span className="text-[11px] text-slate-400">por {l.usuarioNome}</span>}
            </div>
          );
        })}
      </div>
      <Link href="/site/estornos" className="inline-block mt-2 text-xs text-rose-700 font-semibold hover:underline">
        Abrir Estornos e Devoluções →
      </Link>
    </div>
  );
}
