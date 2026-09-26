/**
 * ATESTADO DE HORAS — o que a caixa diz enquanto a supervisão digita
 * "até tal hora". Fora do componente pra ter teste (`npm run test:atestado-horas`).
 *
 * O pedido (dono, 26/09/2026): "o atestado de justificativa de horas tem que
 * ser fácil de colocar — um campo pro horário de ATÉ tal hora; essa jornada
 * não desconta da funcionária".
 *
 * A régua do backend já abatia só a janela desde 28/08 (`diaInteiro=false` +
 * hora). O que não existia era a PORTA: a caixa "Ajustar dia" do espelho
 * mandava sempre dia inteiro, e o formulário de Eventos escondia as horas num
 * checkbox com 08:00–12:00 chumbado. Consulta de 2h virava atestado de 8h, ou
 * não era lançada.
 *
 * O que fica aqui, e por quê:
 *
 * 1. `validarHoras` — "só algumas horas" com o até em branco NÃO pode gravar.
 *    O backend também recusa (400), mas a tela tem que travar o botão antes,
 *    senão o erro chega depois de subir o anexo.
 * 2. `horasAoLigarParcial` — ao escolher "só algumas horas", o DAS nasce com a
 *    entrada cadastrada dela. É o que faz o pedido valer: quem lança digita UM
 *    campo, o até.
 * 3. `fraseDaPrevia` — o número que o backend devolve vira uma frase que diz o
 *    que vai acontecer com o dia ("abona 2h — ela deve só 6h"), inclusive o
 *    aviso de hora que não cai na jornada. Erro de hora é MUDO: sem a frase o
 *    atestado das 07:00 às 08:30 numa jornada que começa 09:00 abona zero e
 *    ninguém vê.
 *
 * A CONTA não mora aqui — só a frase. Quem calcula é o backend
 * (`GET /rh/eventos/previa`, mesma régua do espelho). Uma conta na tela e
 * outra no servidor foi o que fez o site prometer peça que a loja não tinha.
 */

export interface JanelaCadastrada {
  inicio: string | null;
  fim: string | null;
  almocoInicio?: string | null;
  almocoFim?: string | null;
}

/** O que a caixa guarda: dia inteiro, ou uma janela "das/até". */
export interface HorasDoEvento {
  diaInteiro: boolean;
  horaInicio: string;
  horaFim: string;
}

export const DIA_INTEIRO: HorasDoEvento = { diaInteiro: true, horaInicio: '', horaFim: '' };

/** Resposta de `GET /rh/eventos/previa`. */
export interface PreviaEventoDia {
  data: string;
  diaSemana: string;
  janela: JanelaCadastrada | null;
  folga: boolean;
  semCadastro: boolean;
  minPrevisto: number;
  minAfetados: number;
  minRestantes: number;
  efeito: 'abona' | 'credita' | 'debita' | 'nenhum';
  parcial: boolean;
  foraDaJornada: boolean;
}

export interface FraseDaPrevia {
  texto: string;
  /** ok = faz o que a supervisão espera · alerta = vai gravar algo que não abona · neutro = informação */
  tom: 'ok' | 'alerta' | 'neutro';
}

const DIA_NOME: Record<string, string> = {
  SEG: 'segunda', TER: 'terça', QUA: 'quarta', QUI: 'quinta', SEX: 'sexta', SAB: 'sábado', DOM: 'domingo',
};

/** 90 → "1h30", 120 → "2h", 0 → "0h". */
export function fmtMin(min: number): string {
  const abs = Math.abs(Math.round(min));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const sinal = min < 0 ? '-' : '';
  return m === 0 ? `${sinal}${h}h` : `${sinal}${h}h${String(m).padStart(2, '0')}`;
}

/** "HH:MM" → minutos. Null no que não for hora. */
export function paraMinutos(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * O que impede de gravar. Null = pode.
 *
 * Só a JANELA é conferida: dia inteiro nunca tem erro. O texto é o que a
 * pessoa precisa fazer, não o nome do campo que falhou.
 */
export function validarHoras(h: HorasDoEvento): string | null {
  if (h.diaInteiro) return null;
  const ini = paraMinutos(h.horaInicio);
  const fim = paraMinutos(h.horaFim);
  if (ini === null && fim === null) return 'Preencha das/até que horas.';
  if (ini === null) return 'Preencha a partir de que horas.';
  if (fim === null) return 'Preencha até que horas.';
  if (fim <= ini) return 'O "até" precisa ser depois do "das".';
  return null;
}

/** "09:00–18:00 · almoço 12:00–13:00". Vazio sem janela. */
export function janelaTexto(j: JanelaCadastrada | null | undefined): string {
  if (!j?.inicio || !j?.fim) return '';
  const base = `${j.inicio}–${j.fim}`;
  const aIni = paraMinutos(j.almocoInicio);
  const aFim = paraMinutos(j.almocoFim);
  if (aIni !== null && aFim !== null && aFim > aIni) {
    return `${base} · almoço ${j.almocoInicio}–${j.almocoFim}`;
  }
  return base;
}

/**
 * AO ESCOLHER "SÓ ALGUMAS HORAS": o das nasce com a ENTRADA cadastrada.
 *
 * É o gesto que o dono pediu — a supervisão digita só o até. Hora que a pessoa
 * já tinha digitado não é sobrescrita (ela pode ter começado pelo das).
 */
export function horasAoLigarParcial(
  atual: HorasDoEvento,
  janela: JanelaCadastrada | null | undefined,
): HorasDoEvento {
  return {
    diaInteiro: false,
    horaInicio: atual.horaInicio || janela?.inicio || '',
    horaFim: atual.horaFim || '',
  };
}

/**
 * A FRASE. Recebe a prévia do backend e quantos dias o lançamento cobre.
 *
 * `horas` é o que está digitado: serve só pra dizer "só o que cai na jornada"
 * quando o papel cobre mais do que a jornada (atestado 08:00–11:00 numa
 * entrada 09:00 abona 2h, não 3h — e a pessoa precisa entender por quê).
 */
export function fraseDaPrevia(
  p: PreviaEventoDia | null | undefined,
  opts: { dias?: number; horas?: HorasDoEvento } = {},
): FraseDaPrevia | null {
  if (!p) return null;
  const dias = Math.max(1, opts.dias ?? 1);
  const diaNome = DIA_NOME[p.diaSemana] ?? p.diaSemana.toLowerCase();
  const porDia = dias > 1 ? ' por dia' : '';
  const emCada = dias > 1 ? ` em cada um dos ${dias} dias` : '';

  if (p.semCadastro) {
    return {
      tom: 'alerta',
      texto: `Sem horário cadastrado pra ${diaNome} — não há jornada pra abonar. Confira a ficha dela.`,
    };
  }
  if (p.folga) {
    return {
      tom: 'alerta',
      texto: `${diaNome[0].toUpperCase()}${diaNome.slice(1)} é folga no cadastro — não há jornada pra abonar.`,
    };
  }
  if (p.minPrevisto <= 0) {
    return { tom: 'alerta', texto: 'Jornada zerada neste dia — nada a abonar.' };
  }
  if (p.foraDaJornada) {
    return {
      tom: 'alerta',
      texto: `Essas horas não caem na jornada (${janelaTexto(p.janela)}) — nada seria abonado.`,
    };
  }

  const afetados = fmtMin(p.minAfetados);
  const previsto = fmtMin(p.minPrevisto);
  const restantes = fmtMin(p.minRestantes);

  // O papel cobre mais do que a jornada: diz que só a parte de dentro conta.
  let recorte = '';
  if (p.parcial && opts.horas && !opts.horas.diaInteiro) {
    const ini = paraMinutos(opts.horas.horaInicio);
    const fim = paraMinutos(opts.horas.horaFim);
    if (ini !== null && fim !== null && fim - ini > p.minAfetados) {
      recorte = ` (só o que cai na jornada ${janelaTexto(p.janela)})`;
    }
  }

  switch (p.efeito) {
    case 'abona':
      if (p.parcial) {
        return {
          tom: 'ok',
          texto: `Abona ${afetados}${emCada} das ${previsto} do dia${recorte} — ela deve só ${restantes}${porDia}.`,
        };
      }
      return {
        tom: 'ok',
        texto: dias > 1
          ? `Abona os ${dias} dias inteiros (${previsto}${porDia}) — o saldo desses dias fica zerado.`
          : `Abona o dia inteiro (${previsto}) — o saldo do dia fica zerado.`,
      };
    case 'credita':
      return {
        tom: 'ok',
        texto: `Conta ${afetados}${emCada} como trabalhadas${recorte} — ela estava em jornada, só que fora da loja.`,
      };
    case 'debita':
      return {
        tom: 'neutro',
        texto: `Consome ${afetados}${emCada} do banco de horas${recorte} — o dia entra devendo essas horas.`,
      };
    default:
      return {
        tom: 'neutro',
        texto: `Não abona — o dia continua devendo as ${previsto}${porDia}.`,
      };
  }
}
