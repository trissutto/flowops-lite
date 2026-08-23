'use client';

import { useEffect, useState } from 'react';
import type { Address } from '@/types/checkout';

/**
 * QUEM ESTÁ LOGADA — pro checkout parar de perguntar o que já sabe.
 *
 * Medido em 22/08/2026: o checkout NUNCA consultava `/api/conta/*`. Ele
 * guardava rascunho na sessão do navegador (bom pra um F5), mas quem já tinha
 * conta — com nome, WhatsApp, CPF, e-mail e endereço salvos no CRM desde a
 * loja física — digitava tudo outra vez, no celular, com a compra decidida.
 * É o abandono mais caro que existe, porque acontece depois do "sim".
 *
 * Best-effort por princípio: sem sessão, backend fora ou resposta estranha, o
 * hook devolve `null` e o checkout segue exatamente como sempre foi — visitante
 * digitando. Nada aqui pode BLOQUEAR o caminho de pagar.
 */

export interface ClienteDoCheckout {
  nome: string;
  email: string;
  cpf: string;
  telefone: string;
}

/** Endereço salvo, já no formato que a etapa de entrega usa. */
export interface EnderecoSalvo extends Address {
  id: string;
  cep: string;
  /** "Casa", "Trabalho" — o apelido que ela deu, quando deu. */
  apelido?: string | null;
}

interface Resultado {
  cliente: ClienteDoCheckout | null;
  enderecos: EnderecoSalvo[];
  /** `false` enquanto a consulta não voltou — evita piscar o campo vazio. */
  pronto: boolean;
}

const so = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const texto = (v: unknown) => String(v ?? '').trim();

export function useClienteLogada(): Resultado {
  const [cliente, setCliente] = useState<ClienteDoCheckout | null>(null);
  const [enderecos, setEnderecos] = useState<EnderecoSalvo[]>([]);
  const [pronto, setPronto] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const r = await fetch('/api/conta/sessao', { signal: controller.signal });
        if (!r.ok) return;
        const { cliente: c } = await r.json();
        if (!c || controller.signal.aborted) return;

        setCliente({
          nome: texto(c.name),
          email: texto(c.email),
          cpf: so(c.cpf),
          telefone: so(c.phone),
        });

        // Endereços só fazem sentido com sessão — e a falha deles não pode
        // derrubar o preenchimento do nome, que é o que mais economiza toque.
        try {
          const re = await fetch('/api/conta/enderecos', { signal: controller.signal });
          if (!re.ok) return;
          const lista = await re.json();
          if (!Array.isArray(lista) || controller.signal.aborted) return;
          setEnderecos(
            lista
              .map((e: Record<string, unknown>) => ({
                id: texto(e.id),
                cep: so(e.zip ?? e.cep ?? e.postalCode),
                street: texto(e.street),
                number: texto(e.number),
                complement: texto(e.complement) || undefined,
                neighborhood: texto(e.neighborhood ?? e.district),
                city: texto(e.city),
                uf: texto(e.uf ?? e.state).toUpperCase().slice(0, 2),
                apelido: texto(e.label ?? e.nickname) || null,
              }))
              // Endereço pela metade não é atalho: ela escolheria e teria que
              // corrigir campo por campo, que é pior que digitar do zero.
              .filter((e) => e.cep.length === 8 && e.street && e.city && e.uf.length === 2),
          );
        } catch {
          /* endereço é bônus */
        }
      } catch {
        /* visitante ou backend fora — segue como sempre */
      } finally {
        if (!controller.signal.aborted) setPronto(true);
      }
    })();

    return () => controller.abort();
  }, []);

  return { cliente, enderecos, pronto };
}
