'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, ArrowLeft, MessageCircle, Check } from 'lucide-react';
import { Overlay } from '@/components/ui/Overlay';
import { Button } from '@/components/ui/Button';
import { transition } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * LURDS FIT AI — assistente proprietário de tamanho.
 *
 * Sistema da casa: o motor mora no backend (cruza o corpo da cliente com a
 * ficha de caimento da peça e com o que as TROCAS REAIS da rede ensinaram).
 * Aqui é só a conversa — 6 perguntas curtas, uma por tela.
 *
 * Decisões de UX que sustentam a taxa de conclusão:
 *  - uma pergunta por vez, com avanço automático ao tocar (sem "próximo")
 *  - bottom sheet no mobile (polegar alcança), diálogo centrado no desktop
 *  - o que ela responde fica salvo no aparelho: na 2ª peça o assistente já
 *    conhece o corpo dela e a resposta é quase instantânea
 *  - confiança é mostrada com honestidade; abaixo de 80% oferece consultora
 *    em vez de fingir certeza
 */

type Preferencia = 'justa' | 'normal' | 'soltinha';

export interface FitResultado {
  recomendacaoId: string;
  tamanho: string;
  tamanhoAlt: string | null;
  confianca: number;
  estrelas: number;
  falarComConsultora: boolean;
  frases: string[];
}

interface FitAssistantProps {
  open: boolean;
  onClose: () => void;
  /** REF/SKU da peça — chave da ficha de caimento e do aprendizado. */
  productRef?: string | null;
  productName: string;
  categoria?: string | null;
  /** Só os tamanhos com estoque: o assistente nunca sugere o que não tem. */
  tamanhosDisponiveis: string[];
  onEscolherTamanho: (tamanho: string) => void;
  whatsapp?: string;
}

const PERGUNTAS = [
  { titulo: 'Vamos começar', legenda: 'Só o básico — leva 20 segundos.' },
  { titulo: 'Como você gosta da roupa?', legenda: 'Não existe certo ou errado.' },
  { titulo: 'Formato do corpo', legenda: 'Se não souber, tudo bem — a gente calcula igual.' },
  { titulo: 'Seu busto costuma ser', legenda: 'Comparado ao restante do seu corpo.' },
  { titulo: 'Seu quadril costuma ser', legenda: 'Comparado ao restante do seu corpo.' },
  { titulo: 'Qual tamanho você costuma comprar?', legenda: 'É o que deixa a recomendação mais precisa.' },
] as const;

const GRADE = ['46', '48', '50', '52', '54', '56', '58', '60'];

/**
 * Painel do assistente.
 *
 * NÃO brigar com o posicionamento do Overlay: ele já aplica
 * `inset-x-0 bottom-0 w-full` para side="bottom". Sobrescrever isso com
 * `sm:inset-0 sm:m-auto` gerava conflito de utilitário no Tailwind e o painel
 * abria achatado no desktop — só o cabeçalho aparecia. Aqui limitamos apenas
 * LARGURA e altura; a âncora continua sendo do Overlay.
 */
const PAINEL =
  'max-h-[88vh] min-h-[420px] overflow-y-auto rounded-t-lg bg-surface ' +
  'sm:mx-auto sm:mb-8 sm:max-w-[460px] sm:rounded-lg';

const STORAGE_PERFIL = 'lurds_fit_perfil';
const STORAGE_ANON = 'lurds_fit_anon';

function lerPerfil(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_PERFIL) ?? 'null');
  } catch {
    return null;
  }
}

/** Identidade anônima do navegador — vira Body Profile no CRM da Lurd's. */
function anonId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = window.localStorage.getItem(STORAGE_ANON);
    if (!id) {
      id = `a${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      window.localStorage.setItem(STORAGE_ANON, id);
    }
    return id;
  } catch {
    return '';
  }
}

export function FitAssistant({
  open,
  onClose,
  productRef,
  productName,
  categoria,
  tamanhosDisponiveis,
  onEscolherTamanho,
  whatsapp = '5513996050174',
}: FitAssistantProps) {
  const salvo = useMemo(lerPerfil, []);
  const [passo, setPasso] = useState(0);
  const [altura, setAltura] = useState(salvo?.alturaCm ? String(salvo.alturaCm) : '');
  const [peso, setPeso] = useState(salvo?.pesoKg ? String(salvo.pesoKg) : '');
  const [idade, setIdade] = useState(salvo?.idade ? String(salvo.idade) : '');
  const [preferencia, setPreferencia] = useState<string>((salvo?.preferencia as string) ?? '');
  const [formato, setFormato] = useState<string>((salvo?.formatoCorpo as string) ?? '');
  const [busto, setBusto] = useState<string>((salvo?.busto as string) ?? '');
  const [quadril, setQuadril] = useState<string>((salvo?.quadril as string) ?? '');
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<FitResultado | null>(null);
  const alturaRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setPasso(0);
    setResultado(null);
    setErro(null);
    const t = window.setTimeout(() => alturaRef.current?.focus(), 320);
    return () => window.clearTimeout(t);
  }, [open]);

  const medidasOk =
    Number(altura) >= 120 && Number(altura) <= 220 && Number(peso) >= 35 && Number(peso) <= 250;
  const progresso = resultado ? 100 : Math.round((passo / PERGUNTAS.length) * 100);

  async function calcular(tamanhoHabitual: string | null) {
    setCarregando(true);
    setErro(null);
    const corpo = {
      alturaCm: Number(altura),
      pesoKg: Number(peso),
      idade: idade ? Number(idade) : null,
      preferencia: (preferencia || 'normal') as Preferencia,
      formatoCorpo: formato || null,
      busto: busto || null,
      quadril: quadril || null,
      tamanhoHabitual,
    };
    try {
      window.localStorage.setItem(STORAGE_PERFIL, JSON.stringify(corpo));
    } catch {
      /* navegação anônima — segue sem lembrar */
    }
    try {
      const resposta = await fetch('/api/fit/recomendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...corpo,
          ref: productRef ?? null,
          categoria: categoria ?? null,
          tamanhosDisponiveis,
          anonId: anonId(),
        }),
      });
      if (!resposta.ok) throw new Error(String(resposta.status));
      setResultado(await resposta.json());
    } catch {
      setErro('Não consegui calcular agora. Tente de novo em instantes.');
    } finally {
      setCarregando(false);
    }
  }

  function aceitar(tamanho: string) {
    if (resultado?.recomendacaoId) {
      // Fecha o ciclo de aprendizado — nunca bloqueia a compra.
      void fetch('/api/fit/desfecho', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recomendacaoId: resultado.recomendacaoId,
          desfecho: 'comprou',
          tamanhoComprado: tamanho,
        }),
      }).catch(() => {});
    }
    onEscolherTamanho(tamanho);
    onClose();
  }

  const linkConsultora = `https://api.whatsapp.com/send?phone=${whatsapp}&text=${encodeURIComponent(
    `Olá! Usei o Lurd's Fit AI na peça "${productName}" e queria confirmar meu tamanho${
      resultado ? ` (sugeriu ${resultado.tamanho})` : ''
    }.`,
  )}`;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      side="bottom"
      label="Descubra seu tamanho ideal"
      layer="modal"
      showClose
      className={PAINEL}
    >
      <div className="px-6 pb-8 pt-7 sm:px-8">
        <p className="eyebrow flex items-center gap-1.5 text-primary-strong">
          <Sparkles className="size-3" strokeWidth={1.75} />
          Lurd&apos;s Fit AI
        </p>
        <p className="mt-1 truncate text-small font-light text-ink-muted">{productName}</p>

        <div className="mt-4 h-px w-full bg-border">
          <motion.div
            className="h-px bg-primary"
            initial={false}
            animate={{ width: `${progresso}%` }}
            transition={transition.base}
          />
        </div>

        <div className="mt-7">
          {resultado ? (
            <Resultado
              resultado={resultado}
              onAceitar={aceitar}
              onRefazer={() => {
                setResultado(null);
                setPasso(0);
              }}
              linkConsultora={linkConsultora}
            />
          ) : carregando ? (
            <Calculando />
          ) : (
            <motion.div
              key={passo}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={transition.base}
            >
              <h2 className="font-display text-h4 text-ink">{PERGUNTAS[passo].titulo}</h2>
              <p className="mt-1.5 text-small font-light text-ink-soft">{PERGUNTAS[passo].legenda}</p>

              <div className="mt-6">
                {passo === 0 && (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 gap-3">
                      <Campo label="Altura (cm)">
                        <input
                          ref={alturaRef}
                          inputMode="numeric"
                          value={altura}
                          onChange={(e) => setAltura(e.target.value.replace(/\D/g, '').slice(0, 3))}
                          placeholder="165"
                          className={INPUT}
                        />
                      </Campo>
                      <Campo label="Peso (kg)">
                        <input
                          inputMode="numeric"
                          value={peso}
                          onChange={(e) => setPeso(e.target.value.replace(/\D/g, '').slice(0, 3))}
                          placeholder="82"
                          className={INPUT}
                        />
                      </Campo>
                    </div>
                    <Campo label="Idade (opcional)">
                      <input
                        inputMode="numeric"
                        value={idade}
                        onChange={(e) => setIdade(e.target.value.replace(/\D/g, '').slice(0, 2))}
                        placeholder="35"
                        className={INPUT}
                      />
                    </Campo>
                    <Button block disabled={!medidasOk} onClick={() => setPasso(1)}>
                      Continuar
                    </Button>
                    <p className="text-center text-caption font-light text-ink-muted">
                      Seus dados ficam só com a Lurd&apos;s.
                    </p>
                  </div>
                )}

                {passo === 1 && (
                  <Escolhas
                    selecionado={preferencia}
                    onEscolher={(v) => {
                      setPreferencia(v);
                      setPasso(2);
                    }}
                    opcoes={[
                      { valor: 'justa', titulo: 'Mais justa', nota: 'Marcando o corpo' },
                      { valor: 'normal', titulo: 'Normal', nota: 'Do jeito que a peça foi feita' },
                      { valor: 'soltinha', titulo: 'Mais soltinha', nota: 'Com folga, confortável' },
                    ]}
                  />
                )}

                {passo === 2 && (
                  <Escolhas
                    selecionado={formato}
                    onEscolher={(v) => {
                      setFormato(v);
                      setPasso(3);
                    }}
                    opcoes={[
                      { valor: 'ampulheta', titulo: 'Ampulheta', nota: 'Busto e quadril parecidos, cintura marcada' },
                      { valor: 'pera', titulo: 'Pera', nota: 'Quadril mais largo que o busto' },
                      { valor: 'maca', titulo: 'Maçã', nota: 'Volume no busto e na barriga' },
                      { valor: 'retangulo', titulo: 'Retângulo', nota: 'Corpo mais reto, cintura pouco marcada' },
                      { valor: 'naosei', titulo: 'Não sei', nota: 'Seguimos com o resto das respostas' },
                    ]}
                  />
                )}

                {passo === 3 && (
                  <Escolhas
                    selecionado={busto}
                    onEscolher={(v) => {
                      setBusto(v);
                      setPasso(4);
                    }}
                    opcoes={[
                      { valor: 'P', titulo: 'Pequeno' },
                      { valor: 'M', titulo: 'Médio' },
                      { valor: 'G', titulo: 'Grande' },
                    ]}
                  />
                )}

                {passo === 4 && (
                  <Escolhas
                    selecionado={quadril}
                    onEscolher={(v) => {
                      setQuadril(v);
                      setPasso(5);
                    }}
                    opcoes={[
                      { valor: 'P', titulo: 'Pequeno' },
                      { valor: 'M', titulo: 'Médio' },
                      { valor: 'G', titulo: 'Grande' },
                    ]}
                  />
                )}

                {passo === 5 && (
                  <div>
                    <div className="grid grid-cols-4 gap-2">
                      {GRADE.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => calcular(t)}
                          className="tabular rounded-sm border border-border py-4 text-body font-medium text-ink-soft transition-all duration-[180ms] hover:border-primary hover:bg-primary-wash hover:text-primary-strong"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => calcular(null)}
                      className="mt-3 w-full rounded-sm border border-border py-3.5 text-small font-light text-ink-soft transition-colors hover:border-border-strong hover:text-ink"
                    >
                      Não sei meu tamanho
                    </button>
                  </div>
                )}
              </div>

              {erro && (
                <p role="alert" className="mt-4 text-center text-small text-danger">
                  {erro}
                </p>
              )}

              {passo > 0 && (
                <button
                  type="button"
                  onClick={() => setPasso((p) => Math.max(0, p - 1))}
                  className="mt-6 inline-flex items-center gap-1.5 text-small font-light text-ink-muted transition-colors hover:text-ink"
                >
                  <ArrowLeft className="size-3.5" strokeWidth={1.5} />
                  Voltar
                </button>
              )}
            </motion.div>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/* ------------------------------------------------------------------ partes */

function Calculando() {
  return (
    <div className="py-16 text-center">
      <motion.div
        className="mx-auto size-9 rounded-full border border-border border-t-primary"
        animate={{ rotate: 360 }}
        transition={{ duration: 0.9, ease: 'linear', repeat: Infinity }}
      />
      <p className="mt-5 text-body font-light text-ink-soft">Analisando o caimento dessa peça…</p>
      <p className="mt-1.5 text-caption font-light text-ink-muted">
        Cruzando seu corpo com as medidas reais e o histórico de quem já comprou.
      </p>
    </div>
  );
}

function Resultado({
  resultado,
  onAceitar,
  onRefazer,
  linkConsultora,
}: {
  resultado: FitResultado;
  onAceitar: (t: string) => void;
  onRefazer: () => void;
  linkConsultora: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition.base}
      className="text-center"
    >
      <p className="text-small font-light text-ink-soft">Seu tamanho ideal é</p>
      <p className="tabular mt-1 font-display text-[4rem] leading-none font-medium text-primary-strong">
        {resultado.tamanho}
      </p>

      <span
        className="mt-3 inline-flex gap-1"
        role="img"
        aria-label={`Confiança ${resultado.estrelas} de 5`}
      >
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className={cn('text-body', i < resultado.estrelas ? 'text-primary' : 'text-border-strong')}
          >
            ★
          </span>
        ))}
      </span>

      <div className="mt-6 rounded-sm bg-surface-alt px-5 py-4 text-left">
        {resultado.frases.map((frase) => (
          <p key={frase} className="text-small font-light leading-relaxed text-ink-soft">
            {frase}
          </p>
        ))}
      </div>

      <p className="mt-4 text-small font-light text-ink-soft">
        Confiança da recomendação{' '}
        <span className={cn('tabular font-medium', resultado.confianca >= 80 ? 'text-success' : 'text-primary-strong')}>
          {resultado.confianca}%
        </span>
      </p>

      {resultado.falarComConsultora && (
        <div className="mt-5 rounded-sm border border-border-strong bg-primary-wash px-5 py-4 text-left">
          <p className="text-small font-medium text-ink">Ainda temos dúvidas.</p>
          <p className="mt-1 text-small font-light text-ink-soft">
            Essa peça tem pouca informação de caimento. Uma consultora confere as medidas com você
            em um minuto.
          </p>
          <Button href={linkConsultora} external variant="whatsapp" size="sm" block className="mt-4">
            <MessageCircle /> Falar com uma consultora
          </Button>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-2.5">
        <Button block onClick={() => onAceitar(resultado.tamanho)}>
          <Check /> Quero o {resultado.tamanho}
        </Button>
        {resultado.tamanhoAlt && (
          <Button variant="secondary" block onClick={() => onAceitar(resultado.tamanhoAlt!)}>
            Prefiro o {resultado.tamanhoAlt}
          </Button>
        )}
        <button
          type="button"
          onClick={onRefazer}
          className="pt-1 text-small font-light text-ink-muted transition-colors hover:text-ink"
        >
          Refazer
        </button>
      </div>
    </motion.div>
  );
}

const INPUT =
  'tabular w-full rounded-sm border border-border bg-surface px-4 py-3.5 text-center text-body ' +
  'font-medium text-ink transition-colors placeholder:font-light placeholder:text-ink-muted ' +
  'focus:border-primary focus:outline-none';

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-2 block text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

function Escolhas({
  opcoes,
  selecionado,
  onEscolher,
}: {
  opcoes: Array<{ valor: string; titulo: string; nota?: string }>;
  selecionado: string;
  onEscolher: (valor: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {opcoes.map((opcao) => (
        <button
          key={opcao.valor}
          type="button"
          onClick={() => onEscolher(opcao.valor)}
          aria-pressed={selecionado === opcao.valor}
          className={cn(
            'rounded-sm border px-5 py-3.5 text-left transition-all duration-[180ms]',
            selecionado === opcao.valor
              ? 'border-primary bg-primary-wash'
              : 'border-border hover:border-primary hover:bg-primary-wash',
          )}
        >
          <span className="block text-body font-medium text-ink">{opcao.titulo}</span>
          {opcao.nota && (
            <span className="mt-0.5 block text-small font-light text-ink-soft">{opcao.nota}</span>
          )}
        </button>
      ))}
    </div>
  );
}
