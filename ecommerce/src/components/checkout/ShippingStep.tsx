'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Clock, MapPin, Truck } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { fetchQuotes, isValidCep } from '@/lib/commerce/frete';
import { stores } from '@/data/stores';
import { trackAddShippingInfo, trackCheckoutValidationError, type TrackedItem } from '@/lib/tracking';
import type { Address, ShippingQuote } from '@/types/checkout';
import { maskCep, onlyDigits } from './masks';

/**
 * § 2 — ENTREGA. A ordem da seção é a ordem da decisão da cliente:
 * CEP → "quanto custa e quando chega?" (cotações) → endereço completo.
 *
 * ViaCEP preenche rua/bairro/cidade/UF sozinho e o foco pula pro NÚMERO —
 * o único campo que só a cliente sabe. Erro do ViaCEP é SILENCIOSO de
 * propósito: o serviço é cortesia, e se ele cair a cliente simplesmente
 * digita o endereço (os campos continuam editáveis).
 *
 * Retirada na loja dispensa endereço: a peça não viaja até ela.
 */

/** Resultado consolidado da etapa — o que a página guarda. */
export interface ShippingSelection {
  /** Só dígitos. */
  cep: string;
  /** undefined quando retirada na loja. */
  address?: Address;
  quote: ShippingQuote;
}

/**
 * Os TETOS são os mesmos do servidor (`/api/checkout`), de propósito.
 *
 * Estavam só lá: quem escrevia "123 - fundos, perto do mercado" no NÚMERO
 * passava por esta tela, e o pedido morria depois, na hora de pagar, com um
 * "alguns dados não conferem" que não dizia onde. Erro de campo tem que
 * aparecer no campo, enquanto ela ainda está digitando nele.
 */
const addressSchema = z.object({
  street: z.string().trim().min(2, 'Informe a rua.').max(160, 'Encurte a rua (máx. 160 caracteres).'),
  number: z
    .string()
    .trim()
    .min(1, 'Informe o número.')
    .max(20, 'Só o número aqui (máx. 20 caracteres) — o resto vai no complemento.'),
  complement: z.string().trim().max(80, 'Encurte o complemento (máx. 80 caracteres).').optional(),
  neighborhood: z.string().trim().min(2, 'Informe o bairro.').max(80, 'Encurte o bairro (máx. 80 caracteres).'),
  city: z.string().trim().min(2, 'Informe a cidade.').max(80, 'Encurte a cidade (máx. 80 caracteres).'),
  uf: z.string().trim().length(2, 'UF.'),
});

type AddressValues = z.infer<typeof addressSchema>;

interface ShippingStepProps {
  subtotal: number;
  /** Peças na sacola — muda a caixa e, com ela, o preço da cotação. */
  pecas?: number;
  /** Itens no formato de tracking — pro add_shipping_info. */
  itemsTracked: TrackedItem[];
  defaults?: ShippingSelection | null;
  onDone: (selection: ShippingSelection) => void;
}

export function ShippingStep({ subtotal, pecas = 1, itemsTracked, defaults, onDone }: ShippingStepProps) {
  const [cep, setCep] = useState(defaults ? maskCep(defaults.cep) : '');
  const [cepBuscando, setCepBuscando] = useState(false);
  const [quoteId, setQuoteId] = useState<string | undefined>(defaults?.quote.id);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Evita refetch do ViaCEP pro mesmo CEP (inclusive na volta da edição).
  const ultimoCepBuscado = useRef<string | null>(defaults ? onlyDigits(defaults.cep) : null);

  /**
   * O ENDEREÇO DO ViaCEP FICA GUARDADO AQUI ANTES DE IR PRA TELA.
   *
   * Ele era escrito direto nos campos com `setValue` assim que a resposta
   * chegava — e os campos ainda não existiam. O bloco de endereço só
   * renderiza depois que a cotação chega (`precisaEndereco`), e a cotação
   * demora segundos enquanto o ViaCEP volta em ~400ms. Escrever num campo
   * desmontado não dá erro: o React Hook Form guarda o valor e, quando o
   * input finalmente monta, ele restaura do `defaultValues` — não do que foi
   * gravado no meio do caminho. Resultado: rua, bairro, cidade e UF em
   * branco, e a cliente digitando na mão o que o sistema já sabia.
   *
   * Guardando em estado, quem aplica é o efeito abaixo, que só roda com os
   * campos na tela. Quanto mais lenta a cotação, mais o bug antigo
   * acontecia — era garantido nos 5s medidos em 17/08.
   */
  const [cepAuto, setCepAuto] = useState<{
    digits: string; street: string; neighborhood: string; city: string; uf: string;
  } | null>(null);
  /** Já despejado nos campos — não reescreve por cima do que ela digitou. */
  const cepAplicado = useRef<string | null>(defaults ? onlyDigits(defaults.cep) : null);

  const {
    register,
    handleSubmit,
    setValue,
    setFocus,
    formState: { errors },
  } = useForm<AddressValues>({
    resolver: zodResolver(addressSchema),
    defaultValues: defaults?.address
      ? {
          street: defaults.address.street,
          number: defaults.address.number,
          complement: defaults.address.complement ?? '',
          neighborhood: defaults.address.neighborhood,
          city: defaults.address.city,
          uf: defaults.address.uf,
        }
      : undefined,
    mode: 'onTouched',
  });

  const cepValido = isValidCep(cep);

  /**
   * COTAÇÃO DE VERDADE (bloco B). Era síncrona porque saía de uma tabela local
   * declarada como estimativa; agora vem do backend, que aplica a tabela
   * promocional cadastrada e a cotação do contrato. Se ele não responder,
   * `fetchQuotes` devolve a tabela local — a etapa nunca fica sem opção.
   *
   * O `subtotal` entra na chamada porque é ele que decide o frete grátis, e o
   * número de peças porque a caixa (e o preço) mudam com a quantidade.
   */
  const [quotes, setQuotes] = useState<ShippingQuote[]>([]);
  const [cotando, setCotando] = useState(false);
  const [retirada, setRetirada] = useState<{ prazoHoras: number; instrucoes: string | null } | null>(null);
  const [estimado, setEstimado] = useState(false);

  useEffect(() => {
    if (!cepValido) {
      setQuotes([]);
      return;
    }
    const controller = new AbortController();
    setCotando(true);
    fetchQuotes(cep, subtotal, pecas, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setQuotes(r.quotes);
        setEstimado(r.estimado);
        setRetirada(r.retirada ?? null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCotando(false);
      });
    return () => controller.abort();
  }, [cep, cepValido, subtotal, pecas]);

  const selectedQuote = quotes.find((q) => q.id === quoteId);
  /**
   * O ENDEREÇO APARECE DURANTE A COTAÇÃO, NÃO DEPOIS DELA.
   *
   * A cotação leva ~5 segundos (medido 17/08) e nesse tempo a tela ficava
   * parada: CEP preenchido, nada pra fazer, nenhum campo na frente dela.
   * Segundos de espera com a tela morta é onde a cliente vai embora.
   *
   * Mostrando o bloco já com "calculando…", ela preenche o número enquanto
   * o frete calcula — e os campos existem quando o ViaCEP responde, que é
   * o que conserta o preenchimento automático.
   *
   * A regra é por AUSÊNCIA: com CEP válido o endereço fica, e só some se
   * ela escolher retirada. Amarrar em `cotando` faria o bloco piscar —
   * apareceria durante o cálculo e sumiria quando as opções chegassem, até
   * ela clicar numa.
   */
  const mostraEndereco = cepValido && (selectedQuote ? selectedQuote.kind !== 'retirada' : true);

  /* ViaCEP — dispara quando o CEP fica completo. */
  useEffect(() => {
    const digits = onlyDigits(cep);
    if (digits.length !== 8 || ultimoCepBuscado.current === digits) return;
    setCepBuscando(true);

    const controller = new AbortController();
    fetch(`https://viacep.com.br/ws/${digits}/json/`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (controller.signal.aborted) return;
        // Só agora marca como buscado. Antes marcava ANTES de pedir, e uma
        // busca cancelada (ela corrigiu um dígito e voltou atrás) deixava o
        // CEP marcado pra sempre — nunca mais tentava, campos em branco.
        ultimoCepBuscado.current = digits;
        // ViaCEP devolve { erro: true } pra CEP inexistente — silencioso.
        if (data && !data.erro) {
          setCepAuto({
            digits,
            street: data.logradouro ?? '',
            neighborhood: data.bairro ?? '',
            city: data.localidade ?? '',
            uf: (data.uf ?? '').toUpperCase(),
          });
        }
      })
      .catch(() => {
        /* silêncio combinado: a cliente digita na mão */
      })
      .finally(() => {
        if (!controller.signal.aborted) setCepBuscando(false);
      });

    return () => controller.abort();
  }, [cep]);

  /**
   * DESPEJA NOS CAMPOS — e só roda com eles na tela.
   *
   * `mostraEndereco` na dependência é o ponto todo: o efeito espera os
   * inputs existirem. Efeito roda depois do commit do DOM, então quando
   * `mostraEndereco` vira true nesta mesma renderização os campos já estão
   * montados e o `setValue` acha a referência deles.
   *
   * Uma vez por CEP: se ela corrigir a rua na mão, nada reescreve por cima.
   */
  useEffect(() => {
    if (!cepAuto || !mostraEndereco || cepAplicado.current === cepAuto.digits) return;
    cepAplicado.current = cepAuto.digits;
    setValue('street', cepAuto.street, { shouldValidate: false });
    setValue('neighborhood', cepAuto.neighborhood, { shouldValidate: false });
    setValue('city', cepAuto.city, { shouldValidate: false });
    setValue('uf', cepAuto.uf, { shouldValidate: false });
  }, [cepAuto, mostraEndereco, setValue]);

  /* Foco automático no número — o único campo que o ViaCEP não sabe. */
  useEffect(() => {
    if (mostraEndereco && !cepBuscando) setFocus('number');
  }, [mostraEndereco, cepBuscando, setFocus]);

  function confirmar(address?: AddressValues) {
    if (!selectedQuote) {
      trackCheckoutValidationError('shipping', 'shipping_method');
      setQuoteError('Escolha como você quer receber.');
      return;
    }
    const selection: ShippingSelection = {
      cep: onlyDigits(cep),
      quote: selectedQuote,
      address:
        address && selectedQuote.kind !== 'retirada'
          ? {
              cep: onlyDigits(cep),
              street: address.street.trim(),
              number: address.number.trim(),
              complement: address.complement?.trim() || undefined,
              neighborhood: address.neighborhood.trim(),
              city: address.city.trim(),
              uf: address.uf.trim().toUpperCase(),
            }
          : undefined,
    };
    // Evento do funil só quando a etapa é CONFIRMADA (não a cada clique no rádio).
    trackAddShippingInfo(itemsTracked, selectedQuote.label, selectedQuote.price);
    onDone(selection);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedQuote) {
      trackCheckoutValidationError('shipping', 'shipping_method');
      setQuoteError('Escolha como você quer receber.');
      return;
    }
    if (selectedQuote.kind === 'retirada') {
      // Retirada não valida endereço — a peça espera na loja.
      confirmar();
      return;
    }
    void handleSubmit(
      (values) => confirmar(values),
      (invalid) => trackCheckoutValidationError('shipping', Object.keys(invalid)[0] ?? 'unknown'),
    )();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {/* CEP primeiro: é ele que define preço, prazo e lojas de retirada. */}
      <div className="max-w-[220px]">
        <Input
          label="CEP"
          inputMode="numeric"
          autoComplete="postal-code"
          enterKeyHint="next"
          placeholder="00000-000"
          value={cep}
          onChange={(e) => {
            setCep(maskCep(e.target.value));
            setQuoteError(null);
          }}
          // Altura reservada pro hint: o "Buscando…" não empurra o layout.
          hint={cepBuscando ? 'Buscando endereço…' : ' '}
        />
      </div>

      {/* Cotações — rádios elegantes, uma linha por opção. */}
      {cepValido && (quotes.length > 0 || cotando) && (
        <fieldset>
          <legend className="eyebrow mb-3 text-ink-soft">
            Como você quer receber {cotando && <span className="text-ink-muted">· calculando…</span>}
          </legend>
          <div className="flex flex-col gap-3" role="radiogroup">
            {quotes.map((quote) => (
              <QuoteOption
                key={quote.id}
                quote={quote}
                estimado={estimado}
                instrucoesRetirada={retirada?.instrucoes ?? null}
                checked={quoteId === quote.id}
                onSelect={() => {
                  setQuoteId(quote.id);
                  setQuoteError(null);
                }}
              />
            ))}
          </div>
          {quoteError && (
            <p role="alert" className="mt-3 text-small text-danger">
              {quoteError}
            </p>
          )}
        </fieldset>
      )}

      {/* Endereço completo — enquanto cotamos e depois, se for entrega. */}
      {mostraEndereco && (
        <div className="grid gap-5 sm:grid-cols-6">
          <Input
            label="Rua"
            autoComplete="address-line1"
            enterKeyHint="next"
            maxLength={160}
            className="sm:col-span-4"
            error={errors.street?.message}
            {...register('street')}
          />
          <Input
            label="Número"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="next"
            maxLength={20}
            className="sm:col-span-2"
            error={errors.number?.message}
            {...register('number')}
          />
          <Input
            label="Complemento"
            hint="Apartamento, bloco… (opcional)"
            autoComplete="address-line2"
            enterKeyHint="next"
            maxLength={80}
            className="sm:col-span-3"
            error={errors.complement?.message}
            {...register('complement')}
          />
          <Input
            label="Bairro"
            autoComplete="address-level3"
            enterKeyHint="next"
            maxLength={80}
            className="sm:col-span-3"
            error={errors.neighborhood?.message}
            {...register('neighborhood')}
          />
          <Input
            label="Cidade"
            autoComplete="address-level2"
            enterKeyHint="next"
            maxLength={80}
            className="sm:col-span-4"
            error={errors.city?.message}
            {...register('city')}
          />
          <Input
            label="UF"
            autoComplete="address-level1"
            enterKeyHint="done"
            maxLength={2}
            className="sm:col-span-2"
            error={errors.uf?.message}
            {...register('uf', {
              onChange: (e) => setValue('uf', e.target.value.toUpperCase().slice(0, 2)),
            })}
          />
        </div>
      )}

      {cepValido && (
        <div className="pt-1">
          <Button type="submit" block className="sm:w-auto">
            Continuar para o pagamento
          </Button>
        </div>
      )}
    </form>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Uma opção de frete. Retirada mostra o endereço da loja (a cliente decide
 * pelo bairro, não pelo slug) e o "pronto em ~3h" — o argumento da retirada
 * é a pressa.
 */
function QuoteOption({
  quote,
  checked,
  estimado,
  instrucoesRetirada,
  onSelect,
}: {
  quote: ShippingQuote;
  checked: boolean;
  /** true = preço veio da estimativa (transportador fora do ar). */
  estimado?: boolean;
  /** O que levar / quanto tempo a peça fica reservada — cadastrado na retaguarda. */
  instrucoesRetirada?: string | null;
  onSelect: () => void;
}) {
  const retirada = quote.kind === 'retirada';
  const store = retirada ? stores.find((s) => s.slug === quote.storeSlug) : undefined;

  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-4 rounded-md border px-4 py-3.5 transition-colors duration-[180ms]',
        checked ? 'border-primary bg-primary-wash' : 'border-border bg-surface hover:border-border-strong',
      )}
    >
      <input
        type="radio"
        name="frete"
        checked={checked}
        onChange={onSelect}
        className="peer sr-only"
      />
      {/* Bolinha do rádio desenhada (o input nativo fica sr-only pro teclado). */}
      <span
        aria-hidden
        className={cn(
          'mt-1 flex size-[18px] shrink-0 items-center justify-center rounded-pill border transition-colors duration-[180ms]',
          checked ? 'border-primary' : 'border-border-strong',
          'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary',
        )}
      >
        <span
          className={cn(
            'size-2 rounded-pill bg-primary transition-transform duration-[180ms]',
            checked ? 'scale-100' : 'scale-0',
          )}
        />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-body font-normal text-ink">
          {retirada ? <MapPin className="size-4 text-primary-strong" /> : <Truck className="size-4 text-primary-strong" />}
          {quote.label}
        </span>
        {retirada ? (
          <>
            {store && (
              <span className="truncate text-small text-ink-soft">
                {store.address.street} · {store.address.neighborhood}, {store.city}/{store.uf}
              </span>
            )}
            <span className="flex items-center gap-1.5 text-small text-ink-muted">
              <Clock className="size-3.5" /> Pronto em ~{quote.readyInHours ?? 3}h
            </span>
            {/* Item 27: o que levar e por quanto tempo a peça espera. Vai AQUI,
                na hora da escolha — não numa página de ajuda que ninguém abre. */}
            {instrucoesRetirada && checked && (
              <span className="text-small text-ink-muted">{instrucoesRetirada}</span>
            )}
          </>
        ) : (
          quote.etaDays && (
            <span className="text-small text-ink-soft">
              {quote.etaDays.min === quote.etaDays.max
                ? `${quote.etaDays.min} dia${quote.etaDays.min > 1 ? 's' : ''} útil`
                : `${quote.etaDays.min} a ${quote.etaDays.max} dias úteis`}
              {/* "estimado" só quando É estimado. O prazo do contrato é oficial,
                  e chamar tudo de estimativa treina a cliente a não confiar. */}
              {estimado ? ' · frete estimado' : ''}
            </span>
          )
        )}
      </span>

      {/* Preço: 0 = "Grátis" (verde de dinheiro), nunca "R$ 0,00". */}
      <span className={cn('tabular shrink-0 text-body font-medium', quote.price === 0 ? 'text-success' : 'text-ink')}>
        {quote.price === 0 ? 'Grátis' : formatPrice(quote.price)}
      </span>
    </label>
  );
}
