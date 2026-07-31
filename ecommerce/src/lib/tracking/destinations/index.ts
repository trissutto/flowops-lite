/**
 * REGISTRO DE DESTINOS DE NAVEGADOR.
 *
 * Ligar uma plataforma nova = escrever o arquivo e acrescentar na lista. Nada
 * mais no app muda. Destino sem variável de ambiente é ignorado em silêncio
 * (`isEnabled()`), então este arquivo pode listar tudo sem custo.
 */

import { ga4 } from './ga4';
import { metaPixel } from './meta-pixel';
import { tiktok } from './tiktok';
import { microsoftClarity } from './clarity';
import type { Destination } from './types';

export const BROWSER_DESTINATIONS: readonly Destination[] = [ga4, metaPixel, tiktok, microsoftClarity];

export type { Destination } from './types';
