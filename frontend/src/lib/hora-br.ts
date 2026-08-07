/**
 * hora-br.ts — hora exibida na tela, sempre em Brasília, sem depender do
 * fuso/relógio do dispositivo que está olhando (dono 07/08).
 *
 * O padrão espalhado pelo front era `new Date(iso).toLocaleTimeString('pt-BR',
 * {hour:'2-digit', minute:'2-digit'})` — SEM `timeZone`. Funciona hoje porque
 * o PC da loja está configurado em Brasília, mas o resultado depende
 * inteiramente do relógio do SISTEMA de quem olha: dono conferindo de outro
 * fuso, celular com fuso errado, PC mal configurado — qualquer um desses
 * mostra hora errada sem erro nenhum na tela.
 *
 * As funções daqui fixam `timeZone: 'America/Sao_Paulo'` no `Intl`. Brasil não
 * tem horário de verão desde 2019, então o offset −03:00 vale o ano todo.
 *
 * Uso: troca direta de `new Date(iso).toLocaleTimeString('pt-BR', {...})`
 * por `horaBr(iso)`.
 */

const TZ = 'America/Sao_Paulo';

/** '2026-08-07T13:03:33.000Z' → '10:03' (hora de Brasília, sempre). */
export function horaBr(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

/** Data + hora de Brasília: '07/08/2026 10:03'. */
export function dataHoraBr(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: TZ,
  });
}

/** Só a data de Brasília: '07/08/2026'. */
export function dataBr(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: TZ });
}
