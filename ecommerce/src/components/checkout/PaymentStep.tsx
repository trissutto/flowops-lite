'use client';

import { useEffect, useId, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { isValidCpf, maskCpf, onlyDigits } from './masks';
import { CreditCard, QrCode } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import { PIX_DESCONTO_PCT } from '@/lib/commerce/pix';
import { Badge } from '@/components/ui/Badge';
import { trackAddPaymentInfo, trackPaymentMethodSelected, type TrackedItem } from '@/lib/tracking';
import type { PaymentMethod } from '@/types/checkout';
import { CardForm } from './CardForm';

/**
 * § 3 — PAGAMENTO. Duas abas: PIX (recomendado e primeiro — é o meio com
 * melhor conversão E menor custo pra loja) e Cartão. A loja não trabalha com
 * boleto (dono, 10/08/2026) — ver o comentário do `PaymentMethod`.
 *
 * O desconto do PIX aparece como badge informativa; o VALOR real com desconto
 * quem calcula é o SERVER na criação do pedido (o client nunca inventa total
 * — mesma filosofia do cupom em lib/commerce/cupom.ts). Desde a sprint 011 o
 * "server" que fecha a conta é o backend FlowOps, dono do pedido.
 *
 * `add_payment_info` dispara na ESCOLHA da aba (é aí que a decisão acontece),
 * uma vez por método — trocar de aba de novo pro mesmo método não re-dispara.
 */

export interface PaymentSelection {
  method: PaymentMethod;
  installments?: number;
  /**
   * Token do cartão, gerado pelo `CardForm` direto na Pagar.me. Único dado de
   * cartão que sai do navegador — ver o cabeçalho do CardForm.
   */
  cardToken?: string;
}

const TABS: Array<{ method: PaymentMethod; label: string; icon: React.ElementType }> = [
  { method: 'pix', label: 'PIX', icon: QrCode },
  { method: 'card', label: 'Cartão', icon: CreditCard },
];

/** Dados da nota, coletados AQUI antes de escolher como pagar. */
export interface DadosDaNota { email: string; cpf: string }

interface PaymentStepProps {
  /** Total estimado (subtotal − desconto + frete) — só pra exibir parcelas. */
  total: number;
  /** Total de exibição com o desconto PIX já aplicado. */
  pixTotal: number;
  itemsTracked: TrackedItem[];
  // `defaults` saiu em 17/08: com o clique valendo compra, deixar um método
  // pré-selecionado seria mostrar como escolhido algo que não foi enviado.
  defaultsNota?: DadosDaNota | null;
  /** Pedido em voo — trava os dois métodos e avisa que o PIX está saindo. */
  enviando?: boolean;
  /** Chamado com TUDO pronto: o pedido já pode ser criado e o PIX gerado. */
  onDone: (payment: PaymentSelection, nota: DadosDaNota) => void;
  /**
   * CPF/e-mail VÁLIDOS mudaram. Existe pra recuperação: depois de uma
   * recusa, o botão do painel de erro reenvia lendo o estado da página — e
   * o estado precisa ter o valor que ela acabou de corrigir aqui.
   */
  onNotaChange?: (nota: DadosDaNota) => void;
}

/**
 * ORDEM NOVA (dono, 17/08): CPF → e-mail → escolha do pagamento.
 *
 * "Ao entrar na etapa 3 a cliente preenche o CPF e o email. Após isso,
 * habilita a escolha do modo de pagamento. Se ela clicar no logotipo PIX,
 * ele abre o QR Code."
 *
 * O clique no método apenas revela a confirmação correspondente; não existe
 * etapa de revisão separada. Por isso os dados da nota vêm ANTES: quando o
 * CTA final é acionado, não pode faltar nada.
 *
 * As abas ficam desabilitadas até CPF e e-mail válidos. Desabilitar em vez
 * de esconder é deliberado: ela VÊ que PIX e Cartão existem e entende que
 * faltam dois campos — esconder faria a etapa parecer quebrada.
 */
export function PaymentStep({ total, pixTotal, itemsTracked, defaultsNota, enviando, onDone, onNotaChange }: PaymentStepProps) {
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [tracked, setTracked] = useState<Set<PaymentMethod>>(new Set());
  const [email, setEmail] = useState(defaultsNota?.email ?? '');
  const [cpf, setCpf] = useState(defaultsNota?.cpf ? maskCpf(defaultsNota.cpf) : '');
  const [tocou, setTocou] = useState({ cpf: false, email: false });
  const groupId = useId();

  const cpfOk = isValidCpf(cpf);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const liberado = cpfOk && emailOk && !enviando;

  // Avisa a página só quando os dois estão válidos — meio-CPF não interessa.
  const notaValida = cpfOk && emailOk ? `${onlyDigits(cpf)}|${email.trim().toLowerCase()}` : null;
  useEffect(() => {
    if (!notaValida || !onNotaChange) return;
    const [c, e] = notaValida.split('|');
    onNotaChange({ cpf: c, email: e });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notaValida]);

  /** Uma vez por método por visita à seção — evita inflar o funil. */
  function ensureTracked(m: PaymentMethod) {
    if (!tracked.has(m)) {
      trackAddPaymentInfo(itemsTracked, m);
      trackPaymentMethodSelected(m);
      setTracked((prev) => new Set(prev).add(m));
    }
  }

  /**
   * Os dois métodos apenas abrem seus detalhes. O pedido só é criado no CTA
   * explícito do PIX ou após o envio válido do formulário de cartão.
   */
  function pick(next: PaymentMethod) {
    if (!liberado) { setTocou({ cpf: true, email: true }); return; }
    setMethod(next);
    ensureTracked(next);
  }

  /** Entrega tudo após a confirmação explícita da cliente. */
  function confirm(selection: PaymentSelection) {
    ensureTracked(selection.method);
    onDone(selection, { email: email.trim().toLowerCase(), cpf: onlyDigits(cpf) });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* OS DADOS DA NOTA VÊM PRIMEIRO. CPF antes do e-mail, na ordem que o
          dono pediu. Sem eles, as abas abaixo não respondem. */}
      <div className="flex flex-col gap-5">
        <Input
          label="CPF" inputMode="numeric" autoComplete="off" enterKeyHint="next"
          placeholder="000.000.000-00" hint="Usado somente no pedido e na nota fiscal."
          value={cpf}
          onChange={(e) => setCpf(maskCpf(e.target.value))}
          onBlur={() => setTocou((t) => ({ ...t, cpf: true }))}
          error={tocou.cpf && !cpfOk ? 'Confira o CPF — esse número não confere.' : undefined}
        />
        <Input
          label="E-mail" type="email" inputMode="email" autoComplete="email" enterKeyHint="done"
          placeholder="voce@email.com" hint="A confirmação e o rastreio chegam por aqui."
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTocou((t) => ({ ...t, email: true }))}
          error={tocou.email && !emailOk ? 'Digite um e-mail válido.' : undefined}
        />
      </div>

      {enviando ? (
        <p id={`${groupId}-status`} className="text-small text-ink-soft" aria-live="polite">
          {method === 'pix' ? 'Gerando seu código PIX…' : 'Enviando seu pedido…'}
        </p>
      ) : !liberado ? (
        <p id={`${groupId}-status`} className="text-small text-ink-muted">
          Preencha o CPF e o e-mail para escolher como pagar.
        </p>
      ) : null}

      {/* NÃO É MAIS UM TABLIST (17/08).

          Eram abas ARIA, com seta ←/→ trocando a aba selecionada. Agora o
          os métodos são ações, não navegação entre abas. Dois botões comuns
          mantêm Tab e Enter previsíveis e evitam troca acidental por setas. */}
      <div role="group" aria-label="Forma de pagamento" className="grid grid-cols-2 gap-2">
        {TABS.map(({ method: m, label, icon: Icon }) => {
          const selected = m === method;
          return (
            <button
              key={m}
              type="button"
              id={`${groupId}-tab-${m}`}
              aria-describedby={`${groupId}-status`}
              disabled={!liberado}
              onClick={() => pick(m)}
              className={cn(
                'relative flex flex-col items-center gap-1.5 rounded-md border px-3 py-3.5 text-small font-medium transition-colors duration-[180ms]',
                !liberado && 'cursor-not-allowed opacity-45',
                selected
                  ? 'border-primary bg-primary-wash text-ink'
                  : 'border-border text-ink-soft hover:border-border-strong hover:text-ink',
              )}
            >
              <Icon className="size-5 text-primary-strong" strokeWidth={1.5} />
              {label}
              {/* O desconto subiu pra cá: ele é o argumento pra escolher PIX,
                  e ficava escondido num painel que só abria DEPOIS da
                  escolha — quando já não servia pra decidir nada. */}
              {m === 'pix' && (
                <span className="eyebrow text-[0.5625rem] text-primary-strong">
                  {PIX_DESCONTO_PCT}% off
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* O QUE ERA O PAINEL DO PIX.

          Tinha três linhas explicando o PIX e uma badge de desconto — tudo
          visível só DEPOIS de escolher PIX, ou seja, tarde demais pra
          ajudar na escolha. O desconto subiu pro botão; o resto vira o que
          é útil neste segundo: o aviso de que o código está saindo. */}
      {method === 'pix' && (
        <div className="flex flex-col gap-3">
          <Badge tone="success" className="self-start">
            {PIX_DESCONTO_PCT}% off já aplicado
          </Badge>
          <p className="text-body text-ink-soft">
            {/* 24h é a validade que o backend gera (PIX_EXPIRA_MIN=1440). */}
            O QR Code e o copia-e-cola aparecem aqui em instantes. O código vale
            por 24 horas.
          </p>
          <div className="rounded-sm border border-border bg-surface px-4 py-3">
            <p className="text-small text-ink-soft">Total com desconto no PIX</p>
            <p className="tabular text-h3 font-medium text-success">{formatPrice(pixTotal)}</p>
          </div>
          <Button
            type="button"
            block
            size="lg"
            disabled={enviando}
            onClick={() => confirm({ method: 'pix' })}
          >
            {enviando ? 'Gerando seu código PIX…' : 'Gerar PIX e concluir pedido'}
          </Button>
        </div>
      )}

      {method === 'card' && <CardForm total={total} onDone={confirm} />}
    </div>
  );
}
