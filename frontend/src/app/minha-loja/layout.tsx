import PixPaidListener from './PixPaidListener';

/**
 * Layout de /minha-loja/* — engloba todas as telas da vendedora.
 * Inclui o PixPaidListener global pra detectar pagamento via webhook
 * em qualquer tela (PDV, Caixa, Recebimentos, etc).
 */
export default function MinhaLojaLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PixPaidListener />
      {children}
    </>
  );
}
