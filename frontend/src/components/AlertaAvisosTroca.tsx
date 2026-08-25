'use client';

/**
 * ALARME: código de postagem que a cliente NÃO recebeu.
 *
 * Em 25/08/2026 a medição em produção mostrou 19 trocas com código VÁLIDO nos
 * Correios e ZERO clientes avisadas — a mais antiga esperando desde 28/07. A
 * sessão do WhatsApp tinha caído em ~14/08 e o único sinal disso era um WARN
 * no log do backend, que ninguém lê.
 *
 * É sempre o mesmo padrão: a etapa que trava é a única invisível. Esta barra
 * existe pra que ela pare de ser — vermelha, em cima, na tela de quem trabalha
 * a fila, com o caminho do conserto do lado (só um humano com o celular na mão
 * reconecta o WhatsApp).
 *
 * Some sozinha quando não há nada preso: alarme que fica aceso à toa mata a
 * confiança em todos os outros.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';

type Alerta = {
  whatsappConectado?: boolean;
  presos?: number;
  vencidos?: number;
  maisAntigoDias?: number;
  trocas?: string[];
};

export default function AlertaAvisosTroca({ className = '' }: { className?: string }) {
  const [a, setA] = useState<Alerta | null>(null);

  const carregar = useCallback(async () => {
    try {
      setA(await api<Alerta>('/trocas/alerta-avisos'));
    } catch {
      // Sem permissão ou backend fora: a barra some. Ela é aviso, não trava.
      setA(null);
    }
  }, []);

  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 60_000);
    return () => clearInterval(t);
  }, [carregar]);

  if (!a) return null;
  const presos = Number(a.presos || 0);
  const desconectado = a.whatsappConectado === false;
  if (presos === 0 && !desconectado) return null;

  // Cliente esperando é VERMELHO. Canal caído sem ninguém esperando ainda é
  // amarelo — problema real, mas não é a cliente no telefone cobrando.
  const vermelho = presos > 0;

  return (
    <div
      className={`mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-2 px-3 py-2 text-sm ${
        vermelho
          ? 'border-rose-300 bg-rose-50 text-rose-900'
          : 'border-amber-300 bg-amber-50 text-amber-900'
      } ${className}`}
    >
      <AlertTriangle className={`w-4 h-4 shrink-0 ${vermelho ? 'text-rose-600' : 'text-amber-600'}`} />
      {vermelho ? (
        <span>
          <b>{presos} código(s) de postagem preso(s)</b> — a cliente não recebeu.
          {a.maisAntigoDias ? <> A mais antiga espera há <b>{a.maisAntigoDias} dias</b>.</> : null}
          {a.vencidos ? <> {a.vencidos} já venceu(ram) e precisa(m) de etiqueta nova.</> : null}
          {a.trocas?.length ? (
            <span className="text-rose-700"> ({a.trocas.join(', ')}{presos > a.trocas.length ? '…' : ''})</span>
          ) : null}
        </span>
      ) : (
        <span>
          <b>WhatsApp desconectado</b> — nenhum aviso está saindo pra cliente por esse canal.
        </span>
      )}
      {desconectado && (
        <Link
          href="/retaguarda/whatsapp"
          className={`ml-auto shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold text-white ${
            vermelho ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-600 hover:bg-amber-700'
          }`}
        >
          Conectar WhatsApp
        </Link>
      )}
    </div>
  );
}
