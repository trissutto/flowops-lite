'use client';

/**
 * QUANTO DO DIA O EVENTO COBRE — "Dia inteiro" ou "Só algumas horas: das … até …".
 *
 * Pedido do dono (26/09/2026): o atestado de HORAS tem que ser fácil de
 * lançar — um campo pro "até tal hora", e essa jornada não desconta. A régua
 * do backend já abatia só a janela desde 28/08; faltava a porta. Este bloco é
 * a porta, e é UM só pras duas telas que lançam evento (a caixa "Ajustar dia"
 * do espelho e o formulário de Eventos de RH): duas caixas diferentes pra
 * mesma pergunta seria o jeito de uma delas voltar a mandar dia inteiro.
 *
 * O que ele faz:
 *   · ao escolher "Só algumas horas", o DAS nasce com a entrada cadastrada
 *     dela — quem lança digita só o ATÉ (é o gesto do pedido);
 *   · pede a prévia ao backend (`GET /rh/eventos/previa`, mesma conta do
 *     espelho) e mostra o que vai acontecer com o dia: "abona 2h — ela deve
 *     só 6h", ou o ALERTA de hora que não cai na jornada. Erro de hora é mudo:
 *     sem a frase, 07:00–08:30 numa jornada que começa 09:00 abona zero e
 *     ninguém vê;
 *   · a conta NÃO mora aqui. A tela só mostra o número que o servidor devolve.
 *
 * Quem usa o bloco valida com `validarHoras` antes de salvar — o backend
 * também recusa parcial sem hora (400), mas o botão tem que travar antes,
 * senão o erro só aparece depois de subir o anexo.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import {
  fraseDaPrevia,
  horasAoLigarParcial,
  janelaTexto,
  validarHoras,
  type HorasDoEvento as Horas,
  type JanelaCadastrada,
  type PreviaEventoDia,
} from '@/lib/atestado-horas';

export type TipoComParcial = { codigo: string; label: string; admiteParcial: boolean } | null;

const TOM: Record<'ok' | 'alerta' | 'neutro', string> = {
  ok: 'text-emerald-800 bg-emerald-50 border-emerald-200',
  alerta: 'text-amber-900 bg-amber-50 border-amber-300',
  neutro: 'text-slate-700 bg-white border-slate-200',
};

export function HorasDoEvento({
  tipo, sellerId, data, dias = 1, valor, onChange, janela: janelaDaTela,
}: {
  tipo: TipoComParcial;
  sellerId: string;
  /** Dia do evento (AAAA-MM-DD). Com período, o primeiro dia. */
  data: string;
  /** Quantos dias o lançamento cobre — muda só a frase. */
  dias?: number;
  valor: Horas;
  onChange: (h: Horas) => void;
  /** Jornada do dia quando a tela já a tem (espelho). A prévia confirma. */
  janela?: JanelaCadastrada | null;
}) {
  const [previa, setPrevia] = useState<PreviaEventoDia | null>(null);
  const [previaFalhou, setPreviaFalhou] = useState(false);
  // A pessoa já mexeu no "das": a entrada cadastrada que chegar depois não
  // pode sobrescrever o que ela está digitando.
  const [tocouDas, setTocouDas] = useState(false);

  const codigo = tipo?.codigo ?? '';
  const admiteParcial = !!tipo?.admiteParcial;
  const erro = admiteParcial ? validarHoras(valor) : null;
  const completo = valor.diaInteiro || !erro;
  const janela = previa?.janela ?? janelaDaTela ?? null;

  // Prévia server-side, com folga de 300ms entre teclas. Janela incompleta
  // pede a prévia de DIA INTEIRO: serve pra descobrir a jornada (e a frase
  // dela não é mostrada, porque não corresponde ao que está na tela).
  useEffect(() => {
    if (!codigo || !admiteParcial || !sellerId || !data) {
      setPrevia(null);
      return;
    }
    const qs = new URLSearchParams({ sellerId, data, tipo: codigo });
    if (!valor.diaInteiro && completo) {
      qs.set('diaInteiro', '0');
      qs.set('horaInicio', valor.horaInicio);
      qs.set('horaFim', valor.horaFim);
    }
    let vivo = true;
    const t = setTimeout(() => {
      api<PreviaEventoDia>(`/rh/eventos/previa?${qs}`)
        .then((p) => {
          if (!vivo) return;
          setPrevia(p);
          setPreviaFalhou(false);
        })
        .catch(() => {
          if (!vivo) return;
          setPrevia(null);
          setPreviaFalhou(true);
        });
    }, 300);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [codigo, admiteParcial, sellerId, data, valor.diaInteiro, valor.horaInicio, valor.horaFim, completo]);

  // A entrada cadastrada chega DEPOIS (a prévia é assíncrona): se "só algumas
  // horas" já está escolhido e o das continua vazio, preenche agora. Prop que
  // chega depois não pode virar estado inicial e parar aí.
  useEffect(() => {
    if (valor.diaInteiro || tocouDas || valor.horaInicio || !janela?.inicio) return;
    onChange({ ...valor, horaInicio: janela.inicio });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [janela?.inicio, valor.diaInteiro, valor.horaInicio, tocouDas]);

  if (!admiteParcial) return null;

  const frase = completo ? fraseDaPrevia(previa, { dias, horas: valor }) : null;
  const botao = (ativo: boolean) =>
    `px-3 py-2 rounded-lg border text-sm font-bold transition ${
      ativo
        ? 'bg-slate-800 border-slate-800 text-white'
        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
    }`;
  const chip =
    'text-[11px] font-semibold px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100';

  return (
    <div className="mt-2 border rounded-lg p-3 bg-slate-50 space-y-2">
      <p className="text-[11px] font-bold uppercase text-slate-500">Quanto do dia</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => {
            setTocouDas(false);
            onChange({ ...valor, diaInteiro: true });
          }}
          className={botao(valor.diaInteiro)}
        >
          Dia inteiro
        </button>
        <button
          type="button"
          onClick={() => onChange(horasAoLigarParcial(valor, janela))}
          className={botao(!valor.diaInteiro)}
        >
          Só algumas horas
        </button>
      </div>

      {!valor.diaInteiro && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Das</label>
              <input
                type="time"
                value={valor.horaInicio}
                onChange={(e) => {
                  setTocouDas(true);
                  onChange({ ...valor, horaInicio: e.target.value });
                }}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono bg-white"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Até</label>
              <input
                type="time"
                autoFocus
                value={valor.horaFim}
                onChange={(e) => onChange({ ...valor, horaFim: e.target.value })}
                className={`w-full border rounded-lg px-3 py-2 text-sm font-mono bg-white ${
                  !valor.horaFim ? 'border-amber-400' : ''
                }`}
              />
            </div>
          </div>
          {janela?.inicio && janela?.fim && (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className={chip}
                onClick={() => {
                  setTocouDas(true);
                  onChange({ ...valor, horaInicio: janela.inicio! });
                }}
              >
                desde a entrada ({janela.inicio})
              </button>
              <button
                type="button"
                className={chip}
                onClick={() => onChange({ ...valor, horaFim: janela.fim! })}
              >
                até a saída ({janela.fim})
              </button>
            </div>
          )}
          {erro && <p className="text-[11px] text-amber-800 font-semibold">{erro}</p>}
        </>
      )}

      {janela?.inicio && janela?.fim && (
        <p className="text-[11px] text-slate-500 flex items-center gap-1">
          <Clock className="w-3 h-3" /> Jornada cadastrada
          {previa?.diaSemana ? ` (${previa.diaSemana})` : ''}: {janelaTexto(janela)}
        </p>
      )}

      {frase && (
        <div className={`text-xs border rounded-md px-2.5 py-1.5 flex gap-1.5 ${TOM[frase.tom]}`}>
          {frase.tom === 'alerta' && <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
          <span>{frase.texto}</span>
        </div>
      )}
      {previaFalhou && (
        <p className="text-[11px] text-slate-400">
          Prévia indisponível agora — o evento vale do mesmo jeito; o espelho mostra o resultado.
        </p>
      )}
    </div>
  );
}
