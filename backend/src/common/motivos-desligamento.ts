/**
 * MOTIVOS DE DESLIGAMENTO — lista fechada, definida pelo dono em 01/08/2026.
 *
 * É lista fechada de propósito: campo livre viraria "saiu", "mandada embora" e
 * "acordo" escritos de dez jeitos, e aí não dá pra contar rotatividade nem
 * separar o que gera verba rescisória do que não gera.
 *
 * O `codigo` é o que vai pro banco e NUNCA muda — mudar quebra o histórico já
 * gravado. O `label` é o que aparece na tela e pode ser reescrito à vontade.
 */

export interface MotivoDesligamento {
  codigo: string;
  label: string;
  /** Quem tomou a iniciativa. Serve pra separar rotatividade voluntária da
   *  involuntária, que são problemas diferentes de RH. */
  iniciativa: 'empresa' | 'empregada' | 'ambas' | 'outro';
  /** Marca os que não seguem o rito padrão de rescisão. */
  observacao?: string;
}

export const MOTIVOS_DESLIGAMENTO: MotivoDesligamento[] = [
  { codigo: 'SEM_JUSTA_CAUSA', label: 'Demissão sem justa causa', iniciativa: 'empresa' },
  { codigo: 'PEDIDO_DEMISSAO', label: 'Pedido de demissão', iniciativa: 'empregada' },
  { codigo: 'TERMINO_CONTRATO', label: 'Término de contrato', iniciativa: 'ambas' },
  { codigo: 'ACORDO_PARTES', label: 'Acordo entre as partes', iniciativa: 'ambas',
    observacao: 'Rescisão por acordo (art. 484-A da CLT).' },
  {
    codigo: 'ACORDO_INFORMAL',
    label: 'Acordo "informal"',
    iniciativa: 'ambas',
    // Registrado porque acontece e o RH precisa saber quantos são. Não é
    // modalidade prevista na CLT — as aspas do nome vieram do próprio dono.
    observacao: 'Sem respaldo na CLT. Registrado pra o RH ter o número real.',
  },
  { codigo: 'TERMINO_ANTECIPADO_EMPRESA', label: 'Término de contrato antecipado — Empresa', iniciativa: 'empresa' },
  { codigo: 'TERMINO_ANTECIPADO_EMPREGADA', label: 'Término de contrato antecipado — Empregada', iniciativa: 'empregada' },
  { codigo: 'COM_JUSTA_CAUSA', label: 'Demissão com justa causa', iniciativa: 'empresa' },
  { codigo: 'FALECIMENTO', label: 'Falecimento', iniciativa: 'outro' },
];

const PORCODIGO = new Map(MOTIVOS_DESLIGAMENTO.map((m) => [m.codigo, m]));

export function motivoValido(codigo: unknown): boolean {
  return !!codigo && PORCODIGO.has(String(codigo));
}

export function rotuloMotivo(codigo: unknown): string | null {
  return PORCODIGO.get(String(codigo))?.label ?? null;
}
