/**
 * HORAS DA JORNADA — pré-preenche a caixa "Ajustar" do espelho de ponto num
 * dia SEM batida.
 *
 * Pedido do dono (14/11/2026): "permitir inserir os horários manualmente nos
 * dias em que não ocorreram batidas de ponto". A caixa já criava batida em
 * campo vazio preenchido, mas num dia vazio a supervisão digitava quatro
 * horas que o cadastro da funcionária já sabia. Um clique preenche pela
 * jornada cadastrada; ela corrige só o que foi diferente. Salvar segue o
 * caminho de sempre (campo preenchido → `POST /ponto/manual`), nada aqui
 * grava.
 *
 * Dia SEM intervalo (sábado de meio período) tem DUAS batidas — quem decide é
 * a régua `backend/src/common/jornada-do-dia.ts`, e o espelho manda
 * `semIntervalo` por dia. Sem o campo (API velha durante o deploy), almoço
 * ausente, de duração zero ou fora do turno vale como "sem almoço": senão
 * nasceriam duas batidas no mesmo minuto, o bipe em sequência que a própria
 * caixa lista como "repetida".
 */

export interface JanelaDoDia {
  inicio: string | null;
  fim: string | null;
  almocoInicio?: string | null;
  almocoFim?: string | null;
}

export type HorasDoDia = Record<'entrada' | 'saida_almoco' | 'volta_almoco' | 'saida', string>;

/** "HH:MM" válido. Comparação lexicográfica funciona porque é zero-padded. */
const HHMM = /^\d{2}:\d{2}$/;
const hora = (v?: string | null): string | null => (v && HHMM.test(v) ? v : null);

/** Só dá pra preencher quando a jornada diz onde o dia começa e termina. */
export function podePreencherPelaJornada(janela: JanelaDoDia | null | undefined): boolean {
  if (!janela) return false;
  const ini = hora(janela.inicio);
  const fim = hora(janela.fim);
  return !!ini && !!fim && ini < fim;
}

/**
 * O almoço entra quando o backend diz que o dia TEM intervalo. Sem a
 * resposta dele, a conta local: almoço presente, com duração, dentro do turno.
 */
function temAlmoco(janela: JanelaDoDia, semIntervalo?: boolean): boolean {
  if (semIntervalo === true) return false;
  const ini = hora(janela.inicio);
  const fim = hora(janela.fim);
  const aIni = hora(janela.almocoInicio);
  const aFim = hora(janela.almocoFim);
  if (!aIni || !aFim || aIni >= aFim) return false;
  if (semIntervalo === false) return true;
  return !!ini && !!fim && aIni >= ini && aFim <= fim;
}

/** As horas que a caixa "Ajustar" recebe — vazio onde a jornada não tem batida. */
export function horasDaJornada(janela: JanelaDoDia, semIntervalo?: boolean): HorasDoDia {
  const almoco = temAlmoco(janela, semIntervalo);
  return {
    entrada: hora(janela.inicio) ?? '',
    saida_almoco: almoco ? (janela.almocoInicio as string) : '',
    volta_almoco: almoco ? (janela.almocoFim as string) : '',
    saida: hora(janela.fim) ?? '',
  };
}

/** Rótulo do botão: "09:00–18:00 · almoço 12:00–13:00" ou "09:00–13:00 · sem intervalo". */
export function resumoDaJornada(janela: JanelaDoDia, semIntervalo?: boolean): string {
  const turno = `${hora(janela.inicio) ?? '?'}–${hora(janela.fim) ?? '?'}`;
  return temAlmoco(janela, semIntervalo)
    ? `${turno} · almoço ${janela.almocoInicio}–${janela.almocoFim}`
    : `${turno} · sem intervalo`;
}
