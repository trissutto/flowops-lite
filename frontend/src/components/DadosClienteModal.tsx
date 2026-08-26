'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import {
  cpfValidoBr,
  maskCpfBr,
  maskTelefoneBr,
  telefoneProblema,
} from '@/lib/telefone-br';

/**
 * CORRIGIR OS DADOS DA CLIENTE de um pedido — CPF, e-mail e WhatsApp.
 *
 * Irmã da `EnderecoEntregaModal`, pela mesma razão de existir: esses campos
 * são SNAPSHOT do checkout e eram imutáveis. O caso que doeu: telefone
 * gravado "55119595822" (a cliente colou "+55 11 …" e a máscara antiga do
 * site engolia o fim do número) — o aviso de WhatsApp ia pro nada e não
 * havia o que clicar pra consertar.
 *
 * A máscara daqui já remove o DDI: colar o número inteiro com +55 conserta
 * em vez de repetir o defeito. Campo apagado LIMPA o dado no pedido.
 */

export interface DadosClienteEdicao {
  cpf?: string | null;
  email?: string | null;
  telefone?: string | null;
}

export default function DadosClienteModal({
  wcOrderId, inicial, onFechar, onSalvo,
}: {
  wcOrderId: number;
  inicial: DadosClienteEdicao;
  onFechar: () => void;
  /** A tela recarrega o pedido com os dados já certos. */
  onSalvo: () => void;
}) {
  const [cpf, setCpf] = useState(maskCpfBr(String(inicial.cpf ?? '')));
  const [email, setEmail] = useState(String(inicial.email ?? ''));
  const [telefone, setTelefone] = useState(maskTelefoneBr(String(inicial.telefone ?? '')));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const cpfDigits = cpf.replace(/\D/g, '');
  const avisoCpf = cpfDigits && !cpfValidoBr(cpfDigits)
    ? (cpfDigits.length < 11 ? 'CPF incompleto (11 dígitos).' : 'Dígito verificador não bate — confira.')
    : null;
  // A máscara já tirou o DDI; o que sobrar de errado é dígito faltando/sobrando.
  const avisoTelefone = telefone ? telefoneProblema(telefone) : null;

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      await api<any>(`/orders/wc/${wcOrderId}/dados-cliente`, {
        method: 'PATCH',
        body: JSON.stringify({
          cpf: cpfDigits,
          email: email.trim(),
          telefone: telefone.replace(/\D/g, ''),
        }),
      });
      onSalvo();
      onFechar();
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui salvar');
      setSalvando(false);
    }
  }

  const campo = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-800">Corrigir dados da cliente</h3>
          <button onClick={onFechar} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Vale pra ESTE pedido: aviso de WhatsApp, e-mail de status, NF-e e crédito de peça
          faltante leem daqui. Campo apagado limpa o dado.
        </p>

        {erro && <div className="mb-3 rounded bg-rose-50 px-3 py-2 text-xs text-rose-800">{erro}</div>}

        <div className="space-y-2.5">
          <div>
            <label className="text-[11px] uppercase tracking-wide text-slate-400">CPF</label>
            <input
              value={cpf}
              onChange={(e) => setCpf(maskCpfBr(e.target.value))}
              inputMode="numeric"
              placeholder="000.000.000-00"
              className={campo}
            />
            {avisoCpf && <p className="mt-1 text-[11px] text-rose-700">{avisoCpf}</p>}
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-slate-400">E-mail</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="cliente@exemplo.com"
              className={campo}
            />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-slate-400">WhatsApp</label>
            <input
              value={telefone}
              onChange={(e) => setTelefone(maskTelefoneBr(e.target.value))}
              inputMode="tel"
              placeholder="(11) 99999-9999"
              className={campo}
            />
            {avisoTelefone ? (
              <p className="mt-1 text-[11px] text-rose-700">⚠ {avisoTelefone}</p>
            ) : (
              <p className="mt-1 text-[11px] text-slate-400">
                Pode colar com +55 — o DDI sai sozinho e ficam só DDD + número.
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button onClick={onFechar} className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">
            Cancelar
          </button>
          <button
            onClick={() => void salvar()}
            disabled={salvando}
            className="flex-1 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-black text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {salvando ? 'Salvando…' : 'Salvar dados'}
          </button>
        </div>

        <p className="mt-3 text-[11px] leading-snug text-amber-800">
          NF-e já emitida não muda sozinha — corrija ANTES de faturar. O cadastro da cliente
          no CRM não é alterado por aqui, só o pedido.
        </p>
      </div>
    </div>
  );
}
