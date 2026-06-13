import PixPaidListener from './PixPaidListener';
import ImpersonateBanner from '@/components/ImpersonateBanner';

/**
 * Layout de /minha-loja/* — engloba todas as telas da vendedora.
 * Inclui:
 *  - PixPaidListener global pra detectar pagamento via webhook
 *    em qualquer tela (PDV, Caixa, Recebimentos, etc).
 *  - ImpersonateBanner: barra vermelha quando admin esta usando o PDV
 *    de uma loja em modo master (token temporario via /retaguarda/lojas).
 */
export default function MinhaLojaLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ImpersonateBanner />
      <PixPaidListener />
      {children}
    </>
  );
}
