'use client';

import { useEffect, useRef, useState } from 'react';
import { PiggyBank } from 'lucide-react';
import { formatPrice } from '@/lib/utils';

/**
 * USAR O CASHBACK NO CHECKOUT — a razão de o programa existir (22/09).
 *
 * Fica colado no CPF, junto do campo de cupom de troca, e pelo mesmo motivo:
 * o cashback é NOMINAL. Só depois do CPF dá pra saber se existe saldo, e
 * perguntar antes seria perguntar cedo demais.
 *
 * ── POR QUE NÃO TEM CAMPO DE VALOR ──
 *
 * Porque a cliente não deveria precisar calcular nada. O servidor já devolve
 * o MÁXIMO permitido pra esta sacola (saldo liberado, mínimo, teto de % da
 * compra) e o botão aplica isso. Campo de valor livre só criaria a chance de
 * digitar um número que o backend vai recusar.
 *
 * ── POR QUE MANDA O WHATSAPP JUNTO ──
 *
 * O cashback é preso ao CPF e não tem código — sem uma segunda chave, digitar
 * um CPF qualquer viraria consulta ao saldo alheio. O checkout já pediu o
 * WhatsApp na primeira etapa, então a guarda não custa um campo a mais.
 * Quando os dois não batem com nenhum cadastro, o servidor devolve saldo zero
 * e uma `dica` — que é mostrada, porque sumir em silêncio com o dinheiro de
 * quem tem direito é o defeito que este trabalho inteiro veio consertar.
 *
 * ── O SALDO É RECONSULTADO QUANDO A SACOLA MUDA ──
 *
 * `permitido` depende do valor da compra (teto de %), então mudar o carrinho
 * muda o que dá pra abater. O efeito reconsulta por (cpf, telefone, base).
 */

interface SaldoResposta {
  saldo: number;
  permitido: number;
  motivo: string | null;
  ativo: boolean;
  dica: string | null;
}

interface CashbackFieldProps {
  /** Só dígitos; vazio enquanto o CPF não estiver válido. */
  cpf: string;
  /** Só dígitos, com DDD (vem da primeira etapa). */
  phone: string;
  /** Base do teto: peças já sem cupom/promoção, SEM frete. */
  base: number;
  /** Quanto está aplicado agora (reais). */
  value: number;
  onChange: (valor: number) => void;
}

export function CashbackField({ cpf, phone, base, value, onChange }: CashbackFieldProps) {
  const [saldo, setSaldo] = useState<SaldoResposta | null>(null);
  const [carregando, setCarregando] = useState(false);
  /** Guarda o último onChange sem entrar nas dependências do efeito. */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const podeConsultar = cpf.length === 11 && phone.length >= 10 && base > 0;

  useEffect(() => {
    if (!podeConsultar) {
      setSaldo(null);
      return;
    }
    let cancelado = false;
    setCarregando(true);
    fetch('/api/loja/cashback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpf, phone, subtotal: base }),
    })
      .then((r) => r.json())
      .then((r: SaldoResposta) => {
        if (cancelado) return;
        setSaldo(r);
        /**
         * Se o permitido encolheu (ela tirou peça da sacola e o teto de %
         * caiu), o aplicado tem que encolher junto — senão a tela mostraria
         * um abatimento que o backend vai recusar, e a cliente descobriria
         * isso só no clique de pagar.
         */
        if (value > 0 && r.permitido < value) onChangeRef.current(r.permitido);
      })
      .catch(() => {
        // Consulta que não respondeu não trava o checkout: ela compra sem o
        // abatimento. Fingir saldo zero aqui seria o mesmo que mentir.
        if (!cancelado) setSaldo(null);
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });
    return () => {
      cancelado = true;
    };
    // `value` de propósito FORA: ele muda a cada clique e reconsultaria em loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpf, phone, base, podeConsultar]);

  if (!podeConsultar) {
    return (
      <p className="text-small text-ink-muted">
        <PiggyBank className="mr-1.5 inline size-4" aria-hidden />
        Tem cashback? Preencha o CPF acima que a gente confere.
      </p>
    );
  }

  if (carregando && !saldo) {
    return <p className="text-small text-ink-muted">Conferindo seu cashback…</p>;
  }

  // Sem saldo, ou com a dica de "confirme os dados" — as duas respostas
  // honestas do servidor.
  if (!saldo || saldo.saldo <= 0) {
    if (saldo?.dica) {
      return (
        <p className="text-small text-ink-muted">
          <PiggyBank className="mr-1.5 inline size-4" aria-hidden />
          {saldo.dica}
        </p>
      );
    }
    return null;
  }

  const aplicado = value > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 text-small font-medium text-ink">
            <PiggyBank className="size-4 text-success" aria-hidden />
            Você tem {formatPrice(saldo.saldo)} de cashback
          </span>
          {saldo.permitido > 0 ? (
            <span className="text-caption text-ink-soft">
              {aplicado
                ? `${formatPrice(value)} abatido nesta compra.`
                : `Dá pra abater ${formatPrice(saldo.permitido)} agora.`}
            </span>
          ) : (
            <span className="text-caption text-ink-soft">
              {saldo.motivo ?? 'Não dá pra usar nesta compra.'}
            </span>
          )}
        </span>

        {saldo.permitido > 0 && (
          <button
            type="button"
            onClick={() => onChange(aplicado ? 0 : saldo.permitido)}
            className={
              aplicado
                ? 'shrink-0 text-small font-medium text-ink-muted underline underline-offset-4 transition-colors hover:text-danger'
                : 'shrink-0 rounded-sm bg-success px-4 py-2 text-small font-medium text-white transition-opacity hover:opacity-90'
            }
          >
            {aplicado ? 'Tirar' : `Usar ${formatPrice(saldo.permitido)}`}
          </button>
        )}
      </div>

      {aplicado && (
        <p className="text-caption text-ink-muted">
          O saldo só sai quando o pedido for criado. Se você não pagar, ele volta pra você.
        </p>
      )}
    </div>
  );
}
