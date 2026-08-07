/**
 * hora-br.ts — hora exibida na tela, sempre em Brasília, sem depender do
 * fuso/relógio do dispositivo que está olhando (dono 07/08).
 *
 * O padrão espalhado pelo front era `new Date(iso).toLocaleTimeString('pt-BR',
 * {hour:'2-digit', minute:'2-digit'})` — SEM `timeZone` explícito. Isso
 * funciona hoje porque o PC da loja já está configurado em Brasília, mas o
 * resultado depende inteiramente do relógio do SISTEMA de quem está olhando:
 * dono checando de outro fuso, celular com fuso errado, PC mal configurado —
 * qualquer um desses mostra a hora errada sem erro nenhum na tela.
 *
 * As funções daqui fixam `timeZone: 'America/Sao_Paulo'` no `Intl` — a hora
 * exibida é sempre a de Brasília, não importa de onde o navegador está lendo.
 * Brasil não tem mais horário de verão desde 2019, então o offset -03:00 é
 * estável o ano inteiro.
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
