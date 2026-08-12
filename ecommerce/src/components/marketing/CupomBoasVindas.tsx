'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy, X } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

/**
 * POPUP DO CUPOM DE BOAS-VINDAS — nome, celular e e-mail por 10% na primeira
 * compra (pedido do dono, 12/08/2026).
 *
 * ── O ACORDO COM A NAVEGAÇÃO ──
 *
 * O pedido foi explícito: "não muito agressivo". Isto NÃO é um modal: não
 * escurece a tela, não trava o scroll, não rouba o foco. É um cartão no canto
 * (barra rente ao rodapé no celular) que a cliente pode ignorar a vida
 * inteira. As regras que o mantêm educado:
 *
 *   · só aparece pra quem ROLOU meia tela — sinal de interesse — e depois de
 *     15s. Quem chegou, olhou e saiu nunca é interrompido;
 *   · UMA vez por pessoa. Fechou, some por 60 dias; cadastrou, some por um
 *     ano. Sem "aparece de novo a cada página";
 *   · NUNCA no carrinho, no checkout nem na conta: quem está comprando não
 *     pode ser distraído — é onde o site ganha dinheiro;
 *   · Esc fecha, o X é grande o bastante pro dedo, e o foco não é sequestrado.
 *
 * ⚠️ Isto contraria a regra que estava escrita em `NewsletterBlock`
 * ("newsletter é bloco de seção, NUNCA popup"). A regra era minha, a decisão é
 * do dono, e ele decidiu depois de ver a base de contatos parada. O bloco da
 * newsletter continua existindo pra quem rola até o rodapé.
 */

/** Uma chave só guarda os dois estados — ver `deveAparecer`. */
const CHAVE = 'lurds:cupom-boas-vindas';
const DIA = 24 * 60 * 60 * 1000;
/** Fechou sem se cadastrar: volta a perguntar depois de 60 dias. */
const ESPERA_FECHADO = 60 * DIA;
/** Já pegou o cupom: um ano sem incomodar. */
const ESPERA_CADASTRADO = 365 * DIA;

const SEGUNDOS_ATE_APARECER = 15_000;
/**
 * Rolou meia tela = está lendo, não passou por acaso.
 *
 * O piso de 400px não é enfeite: em aba de fundo (e em webview embutida)
 * `innerHeight` vem 0, e a conta viraria `scrollY >= 0` — verdadeira desde o
 * primeiro instante. O popup apareceria pra quem nunca rolou nada, que é
 * exatamente o comportamento agressivo que a regra existe pra impedir.
 */
const ROLAGEM_MINIMA = () => Math.max(400, window.innerHeight * 0.5);

/** Onde o popup não entra: quem está comprando não é interrompido. */
const ROTAS_PROIBIDAS = ['/carrinho', '/checkout', '/conta', '/pedido', '/trocas'];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type Estado = { estado: 'fechado' | 'cadastrado'; em: number };

function jaResolvido(): boolean {
  try {
    const cru = window.localStorage.getItem(CHAVE);
    if (!cru) return false;
    const { estado, em } = JSON.parse(cru) as Estado;
    const espera = estado === 'cadastrado' ? ESPERA_CADASTRADO : ESPERA_FECHADO;
    return Date.now() - em < espera;
  } catch {
    // localStorage bloqueado (aba anônima em alguns navegadores): melhor não
    // mostrar do que mostrar em toda página sem conseguir lembrar do "não".
    return true;
  }
}

function lembrar(estado: Estado['estado']) {
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify({ estado, em: Date.now() } satisfies Estado));
  } catch {
    /* sem localStorage o popup reaparece na próxima visita — aceitável. */
  }
}

/** Máscara de celular: (13) 99999-9999. */
function mascaraCelular(valor: string): string {
  const d = valor.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function CupomBoasVindas() {
  const pathname = usePathname();
  const [aberto, setAberto] = useState(false);
  const [cupom, setCupom] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  const [nome, setNome] = useState('');
  const [celular, setCelular] = useState('');
  const [email, setEmail] = useState('');
  const [sobrenome, setSobrenome] = useState(''); // armadilha de robô
  const [erro, setErro] = useState<string>();
  const [enviando, setEnviando] = useState(false);

  const proibida = ROTAS_PROIBIDAS.some((r) => pathname?.startsWith(r));
  const jaApareceu = useRef(false);

  /* --------------------------------------------------------------- gatilho */
  useEffect(() => {
    if (proibida || jaApareceu.current || jaResolvido()) return;

    let tempoCumprido = false;
    let rolagemCumprida = window.scrollY >= ROLAGEM_MINIMA();

    const tentar = () => {
      if (!tempoCumprido || !rolagemCumprida || jaApareceu.current) return;
      jaApareceu.current = true;
      setAberto(true);
      window.removeEventListener('scroll', aoRolar);
    };
    const aoRolar = () => {
      if (window.scrollY >= ROLAGEM_MINIMA()) {
        rolagemCumprida = true;
        tentar();
      }
    };

    const timer = setTimeout(() => {
      tempoCumprido = true;
      tentar();
    }, SEGUNDOS_ATE_APARECER);
    window.addEventListener('scroll', aoRolar, { passive: true });

    return () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', aoRolar);
    };
  }, [proibida]);

  const fechar = useCallback(() => {
    setAberto(false);
    // Fechar DEPOIS de pegar o cupom não vale como recusa — o estado
    // 'cadastrado' já foi gravado no envio e vale por um ano.
    if (!cupom) lembrar('fechado');
  }, [cupom]);

  useEffect(() => {
    if (!aberto) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') fechar();
    };
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [aberto, fechar]);

  /* ---------------------------------------------------------------- envio */
  async function enviar(evento: React.FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const digitos = celular.replace(/\D/g, '');
    const problema =
      nome.trim().length < 2
        ? 'Como podemos te chamar?'
        : digitos.length < 10
          ? 'Confira o celular com DDD'
          : !EMAIL.test(email.trim())
            ? 'Confira o e-mail digitado'
            : undefined;
    setErro(problema);
    if (problema) return;

    setEnviando(true);
    try {
      const resposta = await fetch('/api/loja/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nome: nome.trim(),
          telefone: digitos,
          email: email.trim(),
          origem: pathname,
          sobrenome,
        }),
      });
      const dados = await resposta.json().catch(() => ({}));
      if (!resposta.ok) {
        setErro(dados?.message || 'Não deu pra cadastrar agora. Tente de novo em instantes.');
        return;
      }
      lembrar('cadastrado');
      setCupom(dados?.cupom ?? null);
    } catch {
      setErro('Não deu pra cadastrar agora. Tente de novo em instantes.');
    } finally {
      setEnviando(false);
    }
  }

  async function copiar() {
    if (!cupom) return;
    try {
      await navigator.clipboard.writeText(cupom);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      /* sem permissão de área de transferência: o código está na tela. */
    }
  }

  if (proibida) return null;

  return (
    <AnimatePresence>
      {aberto && (
        <motion.aside
          role="dialog"
          aria-labelledby="cupom-boas-vindas-titulo"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            'fixed z-40 rounded-md border border-primary/25 bg-champagne shadow-[0_18px_50px_-24px_rgba(26,22,20,0.45)]',
            // Celular: barra rente ao rodapé, larga mas baixa. Desktop: cartão
            // no canto, longe do conteúdo e do botão do atendimento (bottom-6
            // right-6 é da bolha do chat, por isso este sobe pra 28).
            'inset-x-3 bottom-3 p-5 sm:inset-x-auto sm:right-6 sm:bottom-28 sm:w-[22rem] sm:p-6',
          )}
        >
          <button
            type="button"
            onClick={fechar}
            aria-label="Fechar"
            className="absolute top-2.5 right-2.5 flex size-9 items-center justify-center rounded-pill text-ink-soft transition-colors hover:bg-surface/60 hover:text-ink"
          >
            <X className="size-4" strokeWidth={1.5} />
          </button>

          {cupom ? (
            /* ------------------------------------------------- deu certo */
            <div>
              <p className="eyebrow text-primary-strong">Cupom liberado</p>
              <h2 id="cupom-boas-vindas-titulo" className="mt-3 font-display text-h4 text-ink">
                Bem-vinda, {nome.trim().split(' ')[0]}
              </h2>
              <p className="mt-2 text-small font-light text-ink-soft">
                Use o código abaixo na sacola e ganhe 10% na sua primeira compra — sem valor
                mínimo.
              </p>

              <button
                type="button"
                onClick={copiar}
                className="mt-4 flex w-full items-center justify-between gap-3 rounded-sm border border-dashed border-primary bg-surface px-4 py-3 text-left transition-colors hover:bg-primary-wash"
              >
                <span className="tabular text-body font-medium tracking-[0.12em] text-ink">
                  {cupom}
                </span>
                <span className="flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-[0.14em] text-primary-strong uppercase">
                  {copiado ? (
                    <>
                      <Check className="size-3.5" strokeWidth={2} /> Copiado
                    </>
                  ) : (
                    <>
                      <Copy className="size-3.5" strokeWidth={1.75} /> Copiar
                    </>
                  )}
                </span>
              </button>

              <Button block className="mt-4" onClick={fechar}>
                Continuar comprando
              </Button>
            </div>
          ) : (
            /* ------------------------------------------------- formulário */
            <form onSubmit={enviar} noValidate>
              <p className="eyebrow text-primary-strong">Primeira compra</p>
              <h2 id="cupom-boas-vindas-titulo" className="mt-3 pr-8 font-display text-h4 text-ink">
                10% de desconto <span className="italic">pra estrear</span>
              </h2>
              <p className="mt-2 text-small font-light text-ink-soft">
                Deixe seus dados e o cupom aparece aqui na hora.
              </p>

              <div className="mt-4 flex flex-col gap-3">
                <Input
                  label="Nome"
                  id="cupom-nome"
                  value={nome}
                  onChange={(e) => {
                    setNome(e.target.value);
                    setErro(undefined);
                  }}
                  placeholder="Como podemos te chamar"
                  autoComplete="given-name"
                />
                <Input
                  label="Celular"
                  id="cupom-celular"
                  value={celular}
                  onChange={(e) => {
                    setCelular(mascaraCelular(e.target.value));
                    setErro(undefined);
                  }}
                  placeholder="(13) 99999-9999"
                  inputMode="numeric"
                  autoComplete="tel-national"
                />
                <Input
                  label="E-mail"
                  id="cupom-email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setErro(undefined);
                  }}
                  placeholder="voce@email.com"
                  type="email"
                  autoComplete="email"
                  error={erro}
                />

                {/* Armadilha de robô: escondida de gente, visível pra script.
                    `sr-only` não serve — leitor de tela leria o campo. */}
                <div aria-hidden className="pointer-events-none absolute -left-[9999px] opacity-0">
                  <label htmlFor="cupom-sobrenome">Sobrenome</label>
                  <input
                    id="cupom-sobrenome"
                    name="sobrenome"
                    tabIndex={-1}
                    autoComplete="off"
                    value={sobrenome}
                    onChange={(e) => setSobrenome(e.target.value)}
                  />
                </div>
              </div>

              <Button type="submit" block className="mt-4" disabled={enviando}>
                {enviando ? 'Enviando…' : 'Quero meu cupom'}
              </Button>
              <p className="mt-3 text-[0.6875rem] leading-relaxed font-light text-ink-muted">
                Usamos seus dados só pra falar de novidades da Lurd&apos;s. Você pode pedir pra
                sair quando quiser.
              </p>
            </form>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
