'use client';

import { useEffect, useState } from 'react';
import { KeyRound, PackageSearch } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * "GUARDE ESTA COMPRA NA SUA CONTA" — o convite que faltava.
 *
 * O checkout é sem cadastro, e isso está certo: exigir conta antes de pagar é
 * a barreira mais cara que existe. Mas depois de pagar ninguém oferecia nada,
 * então quem comprou como visitante NUNCA virava conta — e sem conta ela não
 * acompanha o pedido, não vê o cashback que já está sendo creditado e não abre
 * troca sozinha. Toda vez ela volta pro WhatsApp da loja.
 *
 * ⚠️ POR QUE O CADASTRO NÃO ACONTECE AQUI DENTRO. A primeira versão criava a
 * conta na própria tela, reaproveitando o CPF do pedido. Não dá: esta página
 * é a URL COMPARTILHÁVEL do pedido (`/pedido/<uuid>`) e por isso o backend
 * devolve o CPF MASCARADO de propósito. Além de o dado não estar aqui, criar
 * conta a partir de um link que a cliente cola no grupo da família seria abrir
 * cadastro no CPF dela pra quem recebesse o link. O convite leva pra
 * `/conta`, onde ela digita o próprio CPF e escolhe a senha.
 *
 * Some pra quem já está logada (a conta existe) e pra quem dispensar —
 * insistir depois de um "agora não" é o que transforma convite em ruído.
 */

const CHAVE_DISPENSA = 'lurds-conta-convite-dispensado';

export function CriarContaDepoisDaCompra() {
  const [visivel, setVisivel] = useState(false);

  useEffect(() => {
    let vivo = true;

    void (async () => {
      try {
        if (window.localStorage.getItem(CHAVE_DISPENSA) === '1') return;
      } catch {
        /* localStorage bloqueado — segue e oferece */
      }
      try {
        const r = await fetch('/api/conta/sessao');
        if (!r.ok) return;
        const { cliente } = await r.json();
        // Já logada: a conta existe, não há o que convidar.
        if (cliente) return;
      } catch {
        // Backend fora: melhor não convidar do que convidar pra uma tela que
        // vai falhar logo depois de ela clicar.
        return;
      }
      if (vivo) setVisivel(true);
    })();

    return () => {
      vivo = false;
    };
  }, []);

  if (!visivel) return null;

  return (
    <section className="mx-auto mt-6 max-w-text rounded-md border border-border bg-surface-alt p-6">
      <h2 className="flex items-center gap-2 font-display text-h4 text-ink">
        <KeyRound className="size-4 text-primary-strong" strokeWidth={1.75} /> Guarde esta compra na
        sua conta
      </h2>
      <p className="mt-2 text-small text-ink-soft">
        Com a conta você acompanha a entrega, abre troca sozinha e vê o cashback que já está sendo
        creditado. É a mesma conta das lojas físicas — se você já comprou em alguma delas, seus
        pedidos antigos aparecem lá também. Leva um minuto: CPF e uma senha.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button href="/conta" size="md">
          <PackageSearch className="size-4" strokeWidth={1.75} /> Criar minha conta
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={() => {
            try {
              window.localStorage.setItem(CHAVE_DISPENSA, '1');
            } catch {
              /* sem localStorage o convite volta na próxima — aceitável */
            }
            setVisivel(false);
          }}
        >
          Agora não
        </Button>
      </div>
    </section>
  );
}
