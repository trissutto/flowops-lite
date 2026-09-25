'use client';

import { useState } from 'react';
import { TicketPercent, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { CouponResult } from '@/types/checkout';

/**
 * CAMPO DE CUPOM — UMA implementação, dois lugares (22/09).
 *
 * O checkout mostra cupom em dois pontos, e o dono foi explícito: nada de
 * "duplicar o campo em vários lugares". Duplicar o COMPONENTE é que seria o
 * problema — dois campos com estado próprio, um sem saber do outro, é como o
 * cupom sumia. Aqui o campo é um só, e os dois pontos recebem o MESMO
 * `coupon` e os MESMOS handlers da página: aplicar num reflete no outro na
 * hora, porque não existe estado local de cupom em lugar nenhum.
 *
 *   variant="resumo" — dentro do "Resumo do pedido". O campo genérico, onde
 *                      entra cupom de campanha (PRIMEIRA10 e afins).
 *   variant="troca"  — colado no CPF, na etapa de pagamento. É a pergunta que
 *                      o dono pediu ("Você possui um cupom de troca?"), e ela
 *                      mora ali porque o vale é NOMINAL: só o CPF diz se ele
 *                      é dela. Perguntar antes do CPF é perguntar cedo demais.
 */

interface CouponFieldProps {
  coupon: CouponResult | null;
  onApply: (code: string) => void | Promise<void>;
  onRemove: () => void;
  variant?: 'resumo' | 'troca';
  /** CPF válido na tela — só `troca` usa, pra saber o que dizer enquanto falta. */
  temCpf?: boolean;
  /**
   * A página está conferindo o cupom no backend AGORA (o CPF acabou de
   * entrar e o vale nominal está sendo validado sozinho). Enquanto dura, o
   * campo diz "conferindo" em vez de repetir "informe o CPF" pra um CPF que
   * já está na tela.
   */
  conferindo?: boolean;
}

export function CouponField({ coupon, onApply, onRemove, variant = 'resumo', temCpf, conferindo }: CouponFieldProps) {
  const [code, setCode] = useState('');
  /** Clique em "Aplicar" em voo — o botão avisa e não aceita o segundo clique. */
  const [aplicando, setAplicando] = useState(false);
  /**
   * Enquanto ela não encostar no campo, ele MOSTRA o código pendente (o vale
   * que veio da sacola) — é o "não digite duas vezes" ficando visível. Depois
   * do primeiro toque quem manda é o que ela digitou, inclusive apagar tudo:
   * sem esta flag, limpar o campo o repreenchia sozinho.
   */
  const [editou, setEditou] = useState(false);
  const troca = variant === 'troca';
  const inputId = troca ? 'checkout-cupom-troca' : 'checkout-cupom';

  /**
   * O cupom APLICADO aparece igual nos dois lugares — inclusive o de troca,
   * pra ela ver de onde veio o abatimento sem abrir o resumo.
   */
  if (coupon?.ok) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-sm bg-primary-wash px-4 py-3">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 text-small font-medium text-primary-strong">
            <TicketPercent className="size-4" /> {coupon.code}
          </span>
          {coupon.nominal && (
            <span className="text-caption text-ink-soft">Cupom de troca aplicado com sucesso!</span>
          )}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remover cupom ${coupon.code}`}
          className="shrink-0 text-ink-muted transition-colors hover:text-danger"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

  /**
   * PENDENTE ≠ INVÁLIDO. Vale nominal aguardando CPF não é erro vermelho: o
   * código está guardado e entra sozinho quando o CPF for preenchido. Pintar
   * de vermelho aqui é o que fazia a cliente apagar um cupom que ia funcionar.
   */
  const pendentePorCpf = coupon?.reason === 'nominal_sem_cpf';
  const codigoGuardado = coupon && !coupon.ok && coupon.reason ? coupon.code : null;
  const valorDoCampo = editou ? code : codigoGuardado ?? code;
  const ocupado = aplicando || conferindo === true;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const digitado = valorDoCampo.trim();
        if (!digitado || ocupado) return;
        setAplicando(true);
        void Promise.resolve(onApply(digitado)).finally(() => setAplicando(false));
      }}
      className="flex flex-col gap-2"
    >
      {troca && (
        <label htmlFor={inputId} className="text-small font-medium text-ink">
          Você possui um cupom de troca?
        </label>
      )}
      <div className="flex gap-2">
        {!troca && (
          <label htmlFor={inputId} className="sr-only">
            Cupom de desconto
          </label>
        )}
        <input
          id={inputId}
          value={valorDoCampo}
          onChange={(e) => {
            setEditou(true);
            setCode(e.target.value.toUpperCase());
          }}
          placeholder={troca ? 'TROCA-XXXXXXXX' : 'Cupom de desconto'}
          autoComplete="off"
          className="w-full min-w-0 flex-1 rounded-md border border-border bg-surface px-4 py-2.5 text-small text-ink placeholder:text-ink-muted/70 focus:border-primary focus:outline-none"
        />
        <Button type="submit" variant="secondary" size="sm" className="shrink-0" disabled={ocupado}>
          {ocupado ? 'Conferindo…' : 'Aplicar'}
        </Button>
      </div>
      {troca && !coupon && (
        <p className="text-caption text-ink-soft">
          {temCpf
            ? 'O desconto entra no resumo assim que o cupom for aplicado.'
            : 'Preencha o CPF acima — é ele que confirma que o cupom é seu.'}
        </p>
      )}
      {/* Mensagem do backend — elegante por contrato, nunca técnica.
          Enquanto a página confere o vale com o CPF recém-digitado, a frase
          "informe o CPF" seria mentira — ela acabou de informar. */}
      {coupon && !coupon.ok && (() => {
        // Vale nominal com o veredito em voo: nem "informe o CPF" (ela
        // acabou de informar) nem "outro CPF" (o recálculo local ainda não
        // sabe deste CPF — quem sabe é o backend, que está respondendo).
        const emVoo = coupon.nominal === true && (conferindo || (pendentePorCpf && temCpf));
        const suave = emVoo || pendentePorCpf;
        return (
          <p
            role={suave ? undefined : 'alert'}
            aria-live={suave ? 'polite' : undefined}
            className={suave ? 'text-small text-ink-soft' : 'text-small text-danger'}
          >
            {emVoo ? 'Conferindo o cupom de troca com o CPF informado…' : coupon.message}
          </p>
        );
      })()}
    </form>
  );
}
