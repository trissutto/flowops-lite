/**
 * PRIORIDADE DE LOJA NO ROTEAMENTO — régua única (dono, 25/09/2026).
 *
 * Regras ditadas pro teste da separação automática, e que valem pro
 * preview que o humano aprova também (uma régua só):
 *
 *   1. FRANQUIA PRIMEIRO, SEMPRE — dentro do MESMO número de caixas. O
 *      roteador continua buscando o menor número de pacotes; entre as opções
 *      com a mesma quantidade de caixas, a franquia (`Store.tipo = FILIAL`)
 *      vence antes de estoque, distância e score. Decisão do dono na
 *      pergunta de 25/09: franquia NÃO custa caixa a mais.
 *
 *   2. INDAIATUBA (04) SÓ EM ÚLTIMO CASO — lá não há coleta dos Correios.
 *      "Último caso" = só quando NENHUMA outra loja tem a peça: mesmo que
 *      ela feche o pedido sozinha em 1 caixa e as outras precisem de 2, vai
 *      pras outras. A engine roda uma passada SEM essas lojas e só as deixa
 *      entrar, na segunda passada, pros SKUs que ficaram em ruptura.
 *
 *   3. Depois de 1 e 2, as regras de estoque e score de sempre.
 *
 * Envs (kill-switches, não configuração de negócio):
 *   ROUTING_FRANQUIA_PRIMEIRO=0  desliga a regra 1.
 *   ROUTING_ULTIMO_CASO_CODES    lista de lojas da regra 2 (default "04";
 *                                vazio = desliga).
 */

export type TierLoja = 0 | 1;

export function franquiaPrimeiroLigado(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.ROUTING_FRANQUIA_PRIMEIRO ?? '').trim() !== '0';
}

/** Código de loja no formato do cadastro: sem "LJ", 2 dígitos quando numérico. */
export function normalizarCodigoLoja(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim().toUpperCase().replace(/^LJ/, '');
  if (!s) return '';
  return /^\d{1,2}$/.test(s) ? s.padStart(2, '0') : s;
}

/** Lojas que só entram quando nenhuma outra tem a peça. `undefined` na env = "04". */
export function lojasUltimoCaso(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.ROUTING_ULTIMO_CASO_CODES;
  const lista = raw === undefined ? '04' : String(raw);
  return Array.from(
    new Set(
      lista
        .split(',')
        .map((c) => normalizarCodigoLoja(c))
        .filter(Boolean),
    ),
  );
}

/**
 * 0 = franquia (vence o desempate), 1 = as demais. Com a regra 1 desligada,
 * todo mundo é 1 e o roteador volta a ignorar o tipo da loja.
 */
export function tierDaLoja(store: { tipo?: string | null }, franquiaPrimeiro: boolean): TierLoja {
  if (!franquiaPrimeiro) return 1;
  return String(store.tipo ?? '').trim().toUpperCase() === 'FILIAL' ? 0 : 1;
}
