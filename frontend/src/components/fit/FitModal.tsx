'use client';

/**
 * LURDS FIT AI — modal "Descubra seu tamanho ideal".
 *
 * Sistema PRÓPRIO da Lurd's (nada de terceiro): 6 passos curtos, um por tela,
 * com barra de progresso — o padrão que menos cansa em mobile. Cada resposta
 * avança sozinha (sem botão "próximo"), que é o que sustenta a taxa de
 * conclusão alta em formulário de conversão.
 *
 * Visual: fundo claro, tipografia grande, ouro da marca como acento,
 * transições curtas (180–260ms). Mobile-first — no celular vira bottom sheet.
 *
 * Sem dependência de animação externa: as transições são CSS puro, então o
 * widget carrega leve e pode ser embutido em qualquer página (inclusive fora
 * do app, via iframe/script).
 */

import { useEffect, useMemo, useRef, useState } from 'react';

const OURO = '#B8912B';
const OURO_CLARO = '#FBF6E6';

export type FitResultado = {
  recomendacaoId: string;
  tamanho: string;
  tamanhoAlt: string | null;
  confianca: number;
  estrelas: number;
  falarComConsultora: boolean;
  titulo: string;
  frases: string[];
};

type Props = {
  aberto: boolean;
  onClose: () => void;
  /** REF da peça (o motor usa pra ler a ficha de caimento + o aprendizado) */
  ref_?: string | null;
  categoria?: string | null;
  marca?: string | null;
  nomeProduto?: string | null;
  /** Tamanhos com estoque — a recomendação nunca sai fora deles */
  tamanhosDisponiveis?: string[] | null;
  apiBase: string;
  whatsapp?: string | null;
  /** Chamado quando a cliente aceita o tamanho (pra pré-selecionar na PDP) */
  onEscolherTamanho?: (tamanho: string) => void;
};

const TAMANHOS = ['46', '48', '50', '52', '54', '56', '58', '60'];

const PASSOS = [
  { id: 'medidas', titulo: 'Vamos começar', sub: 'Só o básico — leva 20 segundos.' },
  { id: 'preferencia', titulo: 'Como você gosta da roupa?', sub: 'Não existe certo ou errado.' },
  { id: 'formato', titulo: 'Formato do corpo', sub: 'Se não souber, tudo bem.' },
  { id: 'busto', titulo: 'Seu busto costuma ser', sub: 'Comparado ao seu corpo.' },
  { id: 'quadril', titulo: 'Seu quadril costuma ser', sub: 'Comparado ao seu corpo.' },
  { id: 'habitual', titulo: 'Qual tamanho normalmente compra?', sub: 'Isso deixa a recomendação bem mais precisa.' },
];

/** Identidade anônima do navegador — vira Body Profile no CRM. */
function anonId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = localStorage.getItem('lurds_fit_anon');
    if (!id) {
      id = 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('lurds_fit_anon', id);
    }
    return id;
  } catch { return ''; }
}

function perfilSalvo(): any | null {
  if (typeof window === 'undefined') return null;
  try { return JSON.parse(localStorage.getItem('lurds_fit_perfil') || 'null'); } catch { return null; }
}

export default function FitModal({
  aberto, onClose, ref_, categoria, marca, nomeProduto,
  tamanhosDisponiveis, apiBase, whatsapp, onEscolherTamanho,
}: Props) {
  const salvo = useMemo(() => perfilSalvo(), []);
  const [passo, setPasso] = useState(0);
  const [altura, setAltura] = useState<string>(salvo?.alturaCm ? String(salvo.alturaCm) : '');
  const [peso, setPeso] = useState<string>(salvo?.pesoKg ? String(salvo.pesoKg) : '');
  const [idade, setIdade] = useState<string>(salvo?.idade ? String(salvo.idade) : '');
  const [preferencia, setPreferencia] = useState<string>(salvo?.preferencia || '');
  const [formato, setFormato] = useState<string>(salvo?.formatoCorpo || '');
  const [busto, setBusto] = useState<string>(salvo?.busto || '');
  const [quadril, setQuadril] = useState<string>(salvo?.quadril || '');
  const [habitual, setHabitual] = useState<string>(salvo?.tamanhoHabitual || '');
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<FitResultado | null>(null);
  const alturaRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!aberto) return;
    setPasso(0); setResultado(null); setErro(null);
    const t = setTimeout(() => alturaRef.current?.focus(), 260);
    return () => clearTimeout(t);
  }, [aberto]);

  // ESC fecha
  useEffect(() => {
    if (!aberto) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', h); document.body.style.overflow = ''; };
  }, [aberto, onClose]);

  const medidasOk = Number(altura) >= 120 && Number(altura) <= 220 && Number(peso) >= 35 && Number(peso) <= 250;
  const progresso = resultado ? 100 : Math.round((passo / PASSOS.length) * 100);

  const avancar = (delay = 180) => setTimeout(() => setPasso((p) => p + 1), delay);

  async function calcular(tamanhoHabitual: string) {
    setCarregando(true); setErro(null);
    const corpo = {
      alturaCm: Number(altura), pesoKg: Number(peso),
      idade: idade ? Number(idade) : null,
      preferencia: preferencia || 'normal',
      formatoCorpo: formato || null, busto: busto || null, quadril: quadril || null,
      tamanhoHabitual: tamanhoHabitual === 'naosei' ? null : tamanhoHabitual,
    };
    try {
      localStorage.setItem('lurds_fit_perfil', JSON.stringify(corpo));
    } catch { /* modo anônimo */ }
    try {
      const r = await fetch(`${apiBase}/public/fit/recomendar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...corpo,
          ref: ref_ || null, categoria: categoria || null, marca: marca || null,
          tamanhosDisponiveis: tamanhosDisponiveis || null,
          anonId: anonId(), origem: 'pdp',
        }),
      });
      if (!r.ok) throw new Error(`Falha ${r.status}`);
      setResultado(await r.json());
    } catch (e: any) {
      setErro('Não consegui calcular agora. Tente de novo em instantes.');
    } finally {
      setCarregando(false);
    }
  }

  function escolher(tamanho: string) {
    if (resultado?.recomendacaoId) {
      fetch(`${apiBase}/public/fit/desfecho`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recomendacaoId: resultado.recomendacaoId,
          desfecho: 'comprou',
          tamanhoComprado: tamanho,
        }),
      }).catch(() => {});
    }
    onEscolherTamanho?.(tamanho);
    onClose();
  }

  if (!aberto) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-[fitFade_.2s_ease-out]" />

      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-md bg-white sm:rounded-3xl rounded-t-3xl shadow-2xl overflow-hidden
                   animate-[fitUp_.26s_cubic-bezier(.22,1,.36,1)] max-h-[92vh] flex flex-col"
      >
        {/* Cabeçalho */}
        <div className="px-6 pt-5 pb-3 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-black tracking-[0.18em] uppercase" style={{ color: OURO }}>
                Lurd&apos;s Fit AI
              </div>
              {nomeProduto && (
                <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{nomeProduto}</div>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Fechar"
              className="w-8 h-8 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 text-xl leading-none transition"
            >
              ×
            </button>
          </div>
          <div className="mt-3 h-[3px] bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progresso}%`, background: `linear-gradient(90deg, ${OURO}, #D4AF37)` }}
            />
          </div>
        </div>

        <div className="px-6 pb-6 overflow-y-auto">
          {/* ── RESULTADO ── */}
          {resultado ? (
            <div className="animate-[fitIn_.3s_ease-out] text-center pt-2">
              <p className="text-sm text-slate-500">Seu tamanho ideal é</p>
              <div className="my-1 text-[64px] leading-none font-black tracking-tight" style={{ color: OURO }}>
                {resultado.tamanho}
              </div>
              <div className="text-lg tracking-[0.2em]" aria-label={`${resultado.estrelas} de 5`}>
                {'★'.repeat(resultado.estrelas)}<span className="text-slate-200">{'★'.repeat(5 - resultado.estrelas)}</span>
              </div>

              <div className="mt-4 rounded-2xl p-4 text-left space-y-1.5" style={{ background: OURO_CLARO }}>
                {resultado.frases.map((f, i) => (
                  <p key={i} className="text-[13px] text-slate-700 leading-relaxed">{f}</p>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-center gap-2 text-[13px]">
                <span className="text-slate-500">Confiança da recomendação</span>
                <span className="font-black" style={{ color: resultado.confianca >= 80 ? '#2E7D46' : OURO }}>
                  {resultado.confianca}%
                </span>
              </div>

              {resultado.falarComConsultora ? (
                <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-[13px] text-amber-900 font-semibold">Ainda temos dúvidas.</p>
                  <p className="text-[12px] text-amber-800 mt-0.5">
                    Fale com uma consultora — a gente confere as medidas dessa peça pra você.
                  </p>
                  <a
                    href={`https://wa.me/${(whatsapp || '5513996218277').replace(/\D/g, '')}?text=${encodeURIComponent(
                      `Oi! Usei o Lurd's Fit AI${nomeProduto ? ` na peça ${nomeProduto}` : ''} e queria confirmar meu tamanho (sugeriu ${resultado.tamanho}).`,
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[#25D366] text-white font-bold py-3 text-sm hover:brightness-95 transition"
                  >
                    Falar com uma consultora
                  </a>
                </div>
              ) : null}

              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => escolher(resultado.tamanho)}
                  className="flex-1 rounded-xl text-white font-bold py-3.5 text-sm shadow-lg hover:brightness-105 active:scale-[.99] transition"
                  style={{ background: `linear-gradient(135deg, ${OURO}, #8C7325)` }}
                >
                  Quero o {resultado.tamanho}
                </button>
                {resultado.tamanhoAlt && (
                  <button
                    onClick={() => escolher(resultado.tamanhoAlt!)}
                    className="px-4 rounded-xl border-2 font-bold py-3.5 text-sm transition hover:bg-[#FBF6E6]"
                    style={{ borderColor: OURO, color: OURO }}
                  >
                    {resultado.tamanhoAlt}
                  </button>
                )}
              </div>
              <button
                onClick={() => { setResultado(null); setPasso(0); }}
                className="mt-2 w-full text-[12px] text-slate-400 hover:text-slate-600 py-2 transition"
              >
                Refazer
              </button>
            </div>
          ) : carregando ? (
            <div className="py-16 text-center animate-[fitIn_.2s_ease-out]">
              <div
                className="w-12 h-12 mx-auto rounded-full border-[3px] border-slate-100 animate-spin"
                style={{ borderTopColor: OURO }}
              />
              <p className="mt-4 text-sm text-slate-500">Analisando o caimento dessa peça…</p>
              <p className="mt-1 text-[11px] text-slate-400">
                Cruzando seu corpo com as medidas reais e o histórico de quem já comprou.
              </p>
            </div>
          ) : (
            <div key={passo} className="animate-[fitIn_.24s_ease-out]">
              <h2 className="text-[22px] font-black text-slate-900 leading-tight">{PASSOS[passo].titulo}</h2>
              <p className="text-[13px] text-slate-500 mt-1 mb-5">{PASSOS[passo].sub}</p>

              {/* 1 — medidas */}
              {passo === 0 && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Campo label="Altura (cm)">
                      <input
                        ref={alturaRef}
                        inputMode="numeric" value={altura}
                        onChange={(e) => setAltura(e.target.value.replace(/\D/g, '').slice(0, 3))}
                        placeholder="165" className={inputCls}
                      />
                    </Campo>
                    <Campo label="Peso (kg)">
                      <input
                        inputMode="numeric" value={peso}
                        onChange={(e) => setPeso(e.target.value.replace(/\D/g, '').slice(0, 3))}
                        placeholder="82" className={inputCls}
                      />
                    </Campo>
                  </div>
                  <Campo label="Idade (opcional)">
                    <input
                      inputMode="numeric" value={idade}
                      onChange={(e) => setIdade(e.target.value.replace(/\D/g, '').slice(0, 2))}
                      placeholder="35" className={inputCls}
                    />
                  </Campo>
                  <button
                    disabled={!medidasOk}
                    onClick={() => setPasso(1)}
                    className="w-full mt-1 rounded-xl text-white font-bold py-3.5 text-sm disabled:opacity-30 disabled:cursor-not-allowed hover:brightness-105 active:scale-[.99] transition shadow-lg"
                    style={{ background: `linear-gradient(135deg, ${OURO}, #8C7325)` }}
                  >
                    Continuar
                  </button>
                  <p className="text-[11px] text-center text-slate-400 pt-1">
                    Seus dados ficam só com a Lurd&apos;s. Nada é compartilhado.
                  </p>
                </div>
              )}

              {/* 2 — preferência */}
              {passo === 1 && (
                <Opcoes
                  valor={preferencia}
                  onEscolher={(v) => { setPreferencia(v); avancar(); }}
                  itens={[
                    { v: 'justa', t: 'Mais justa', d: 'Marca o corpo' },
                    { v: 'normal', t: 'Normal', d: 'Do jeito que veio' },
                    { v: 'soltinha', t: 'Mais soltinha', d: 'Folgadinha, confortável' },
                  ]}
                />
              )}

              {/* 3 — formato */}
              {passo === 2 && (
                <Opcoes
                  valor={formato}
                  onEscolher={(v) => { setFormato(v); avancar(); }}
                  itens={[
                    { v: 'ampulheta', t: 'Ampulheta', d: 'Busto e quadril parecidos, cintura marcada' },
                    { v: 'pera', t: 'Pera', d: 'Quadril maior que o busto' },
                    { v: 'maca', t: 'Maçã', d: 'Volume mais na barriga e no busto' },
                    { v: 'retangulo', t: 'Retângulo', d: 'Corpo mais reto, sem muita cintura' },
                    { v: 'naosei', t: 'Não sei', d: 'Sem problema — a gente calcula do mesmo jeito' },
                  ]}
                />
              )}

              {/* 4 — busto */}
              {passo === 3 && (
                <Opcoes
                  valor={busto}
                  onEscolher={(v) => { setBusto(v); avancar(); }}
                  itens={[{ v: 'P', t: 'Pequeno' }, { v: 'M', t: 'Médio' }, { v: 'G', t: 'Grande' }]}
                />
              )}

              {/* 5 — quadril */}
              {passo === 4 && (
                <Opcoes
                  valor={quadril}
                  onEscolher={(v) => { setQuadril(v); avancar(); }}
                  itens={[{ v: 'P', t: 'Pequeno' }, { v: 'M', t: 'Médio' }, { v: 'G', t: 'Grande' }]}
                />
              )}

              {/* 6 — tamanho habitual */}
              {passo === 5 && (
                <div>
                  <div className="grid grid-cols-4 gap-2">
                    {TAMANHOS.map((t) => (
                      <button
                        key={t}
                        onClick={() => { setHabitual(t); calcular(t); }}
                        className="aspect-square rounded-2xl border-2 font-black text-lg transition hover:scale-[1.04] active:scale-95"
                        style={{
                          borderColor: habitual === t ? OURO : '#E7E2D8',
                          background: habitual === t ? OURO_CLARO : '#fff',
                          color: habitual === t ? OURO : '#334155',
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => { setHabitual('naosei'); calcular('naosei'); }}
                    className="w-full mt-3 rounded-xl border-2 border-slate-200 text-slate-500 font-semibold py-3 text-sm hover:bg-slate-50 transition"
                  >
                    Não sei meu tamanho
                  </button>
                </div>
              )}

              {erro && <p className="mt-3 text-[13px] text-rose-600 text-center">{erro}</p>}

              {passo > 0 && (
                <button
                  onClick={() => setPasso((p) => Math.max(0, p - 1))}
                  className="mt-4 w-full text-[12px] text-slate-400 hover:text-slate-600 py-2 transition"
                >
                  ← Voltar
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <style jsx global>{`
        @keyframes fitFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes fitUp {
          from { opacity: 0; transform: translateY(28px) scale(.98) }
          to   { opacity: 1; transform: translateY(0) scale(1) }
        }
        @keyframes fitIn {
          from { opacity: 0; transform: translateY(8px) }
          to   { opacity: 1; transform: translateY(0) }
        }
      `}</style>
    </div>
  );
}

const inputCls =
  'w-full px-4 py-3.5 rounded-xl border-2 border-[#E7E2D8] text-lg font-bold text-slate-800 ' +
  'focus:outline-none focus:border-[#B8912B] transition text-center';

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function Opcoes({
  itens, valor, onEscolher,
}: {
  itens: Array<{ v: string; t: string; d?: string }>;
  valor: string;
  onEscolher: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      {itens.map((i) => {
        const ativo = valor === i.v;
        return (
          <button
            key={i.v}
            onClick={() => onEscolher(i.v)}
            className="w-full text-left rounded-2xl border-2 px-4 py-3.5 transition hover:border-[#B8912B] hover:bg-[#FBF6E6] active:scale-[.99]"
            style={{ borderColor: ativo ? OURO : '#E7E2D8', background: ativo ? OURO_CLARO : '#fff' }}
          >
            <div className="font-bold text-slate-800 text-[15px]">{i.t}</div>
            {i.d && <div className="text-[12px] text-slate-500 mt-0.5">{i.d}</div>}
          </button>
        );
      })}
    </div>
  );
}
