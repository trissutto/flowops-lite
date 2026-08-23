'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Clock, MapPin, Truck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn, formatPrice } from '@/lib/utils';
import { fetchQuotes, isValidCep, onlyDigits, type CotacaoDoSite } from '@/lib/commerce/frete';
import { useCepGuardado, useCepStore } from '@/store/cep';

/**
 * SIMULADOR DE FRETE NA PDP (item 28 da lista de lançamento).
 *
 * A pergunta "quanto custa pra chegar aqui?" é a segunda maior dúvida da
 * cliente plus size, logo depois de "tem no meu número?" — e até 06/08/2026 a
 * única resposta era um texto fixo ("frete grátis acima de R$ 399") que
 * envelheceu junto com a régua. Descobrir o frete só no checkout é descobrir
 * tarde: quem se assusta lá já preencheu nome, CPF e endereço.
 *
 * Cota UMA peça de propósito. O carrinho fechado sai mais barato por peça (a
 * caixa cresce menos que a quantidade), então o número aqui é o PIOR caso —
 * a cliente nunca é surpreendida pra cima no checkout.
 *
 * ── POR QUE ELE É `memo` (23/08/2026) ──
 *
 * Vive dentro do BuyBox, que re-renderiza a cada toque na grade de tamanhos.
 * Medido na PDP em produção: o MutationObserver flagrava o INPUT DE CEP daqui
 * entre os nós tocados a cada número escolhido — o campo e a cotação já na
 * tela sendo reconciliados por um evento que não tem relação nenhuma com eles.
 * A única prop é `preco` (number), então o memo é seguro e corta o trabalho
 * inteiro.
 */
function SimuladorFreteBase({ preco }: { preco: number }) {
  const [cep, setCep] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [cotacao, setCotacao] = useState<CotacaoDoSite | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const cepGuardado = useCepGuardado();
  const guardarCep = useCepStore((s) => s.guardar);
  /** O CEP que já foi cotado sozinho — pra não recotar a cada render. */
  const jaCotouSozinho = useRef<string | null>(null);

  const mascarar = (v: string) => {
    const d = onlyDigits(v).slice(0, 8);
    return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
  };

  const calcular = useCallback(
    async (alvo: string, guardar = true) => {
      if (!isValidCep(alvo)) {
        setErro('Digite os 8 números do CEP.');
        return;
      }
      setErro(null);
      setCarregando(true);
      try {
        const r = await fetchQuotes(alvo, preco, 1);
        setCotacao(r);
        if (!r.quotes.length) {
          setErro('Não conseguimos calcular pra esse CEP agora. Tente de novo em instantes.');
          return;
        }
        // Só guarda CEP que o cotador ACEITOU: número errado que ela corrigiu
        // em seguida não pode virar o padrão das próximas peças.
        if (guardar) guardarCep(alvo);
      } catch {
        setErro('Não conseguimos calcular agora. Tente de novo em instantes.');
      } finally {
        setCarregando(false);
      }
    },
    [guardarCep, preco],
  );

  /**
   * ABRE JÁ RESPONDIDO — o CEP que ela digitou uma vez vale pra peça toda.
   *
   * A caixa nascia vazia em toda peça e em toda visita: "quanto custa e quando
   * chega?" é a dúvida que mais adia a compra de roupa, e o site pedia uma
   * TAREFA em vez de dar a resposta que já tinha. Com o CEP guardado
   * (`store/cep`), a peça abre dizendo o prazo.
   *
   * O campo continua editável e o botão continua lá — quem quer conferir outro
   * endereço digita por cima, e aí o novo CEP passa a ser o guardado.
   */
  useEffect(() => {
    if (!cepGuardado || jaCotouSozinho.current === cepGuardado) return;
    jaCotouSozinho.current = cepGuardado;
    setCep(mascarar(cepGuardado));
    // `guardar: false` — reusar o que já está guardado não é uma escolha nova
    // dela, e renovaria a validade de 90 dias sem ela ter confirmado nada.
    void calcular(cepGuardado, false);
  }, [calcular, cepGuardado]);

  const entregas = cotacao?.quotes.filter((q) => q.kind !== 'retirada') ?? [];
  const retiradas = cotacao?.quotes.filter((q) => q.kind === 'retirada') ?? [];

  return (
    <div className="mt-7 border-t border-border pt-7">
      <p className="mb-3 flex items-center gap-2 text-small font-medium text-ink">
        <Truck className="size-4 text-primary-strong" strokeWidth={1.75} />
        Calcular frete e prazo
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void calcular(cep);
        }}
        className="flex gap-2"
      >
        <label htmlFor="pdp-cep" className="sr-only">
          Seu CEP
        </label>
        <input
          id="pdp-cep"
          value={cep}
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="00000-000"
          onChange={(e) => {
            setCep(mascarar(e.target.value));
            setErro(null);
          }}
          className="w-[140px] rounded-md border border-border bg-surface px-4 py-2.5 text-small text-ink placeholder:text-ink-muted/70 focus:border-primary focus:outline-none"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={carregando}>
          {carregando ? 'Calculando…' : 'Calcular'}
        </Button>
      </form>

      {erro && (
        <p role="alert" className="mt-2 text-small text-danger">
          {erro}
        </p>
      )}

      {cotacao && entregas.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2.5">
          {entregas.map((q) => (
            <li key={q.id} className="flex items-baseline justify-between gap-3 text-small">
              <span className="min-w-0 text-ink-soft">
                <span className="text-ink">{q.label}</span>
                {q.etaDays && (
                  <span className="text-ink-muted">
                    {' · '}
                    {q.etaDays.min === q.etaDays.max
                      ? `${q.etaDays.min} dia${q.etaDays.min > 1 ? 's' : ''} útil`
                      : `${q.etaDays.min} a ${q.etaDays.max} dias úteis`}
                  </span>
                )}
              </span>
              <span className={cn('tabular shrink-0 font-medium', q.price === 0 ? 'text-success' : 'text-ink')}>
                {q.price === 0 ? 'Grátis' : formatPrice(q.price)}
              </span>
            </li>
          ))}

          {/* Retirada: o argumento dela é a pressa, então o prazo vem junto. */}
          {retiradas.map((q) => (
            <li key={q.id} className="flex items-baseline justify-between gap-3 text-small">
              <span className="flex min-w-0 items-center gap-1.5 text-ink-soft">
                <MapPin className="size-3.5 shrink-0 text-primary-strong" />
                <span className="truncate text-ink">{q.storeLabel ?? q.label}</span>
                <span className="flex shrink-0 items-center gap-1 text-ink-muted">
                  <Clock className="size-3" /> ~{q.readyInHours ?? 3}h
                </span>
              </span>
              <span className="tabular shrink-0 font-medium text-success">Grátis</span>
            </li>
          ))}

          {/* A régua do frete grátis sai da config, nunca de texto fixo — e só
              aparece quando ainda FALTA algo (dizer "faltam R$ 0,00" é ruído). */}
          {cotacao.freteGratis.ativo && !cotacao.freteGratis.alcancado && cotacao.freteGratis.falta > 0 && (
            <li className="pt-1 text-small text-ink-muted">
              Faltam {formatPrice(cotacao.freteGratis.falta)} pra você ganhar o frete.
            </li>
          )}
          {cotacao.estimado && (
            <li className="pt-1 text-small text-ink-muted">Valores estimados — confirmamos no checkout.</li>
          )}
        </ul>
      )}
    </div>
  );
}

export const SimuladorFrete = memo(SimuladorFreteBase);
