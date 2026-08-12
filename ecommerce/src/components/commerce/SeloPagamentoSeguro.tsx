import { Lock } from 'lucide-react';

/**
 * O CADEADO — onde a cliente hesita antes de digitar o cartão.
 *
 * Vive no rodapé desde 12/08 (`SelosDeConfianca`), mas rodapé é onde ninguém
 * olha na hora de pagar. Este é o mesmo sinal, colado nos três momentos em que
 * a dúvida aparece: a peça (buy box), a sacola e o botão de finalizar.
 *
 * ── O QUE ELE PODE DIZER ──
 *
 * Só o que é verdade e verificável: a conexão é HTTPS e o pagamento é
 * processado por PagBank e Pagar.me — a loja nunca vê nem guarda o número do
 * cartão. Nada de logo de terceiro ("site seguro", "compra garantida") sem o
 * selo emitido por eles: marca de terceiro no rodapé afirma que alguém
 * auditou a loja, e quem responde por isso é a loja.
 *
 * Duas medidas porque os lugares são diferentes: `compacto` é uma linha pra
 * caber embaixo de um botão; o normal tem a explicação inteira.
 */
export function SeloPagamentoSeguro({
  compacto = false,
  className = '',
}: {
  compacto?: boolean;
  className?: string;
}) {
  return (
    <p
      className={`flex items-center justify-center gap-2 text-center text-small font-light text-ink-soft ${className}`}
    >
      <Lock className="size-3.5 shrink-0 text-primary-strong" strokeWidth={1.75} aria-hidden />
      {compacto ? (
        <>Pagamento criptografado · PagBank e Pagar.me</>
      ) : (
        <>
          Pagamento criptografado. Processado por PagBank e Pagar.me — a loja não guarda o
          número do seu cartão.
        </>
      )}
    </p>
  );
}
