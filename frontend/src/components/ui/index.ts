/**
 * Primitivos do sistema visual SEMÁFORO.
 *
 * Antes disto o `frontend/` não tinha NENHUM primitivo: 34 componentes soltos
 * em `src/components/` e 243 telas redesenhando o próprio botão com cor
 * arbitrária inline. Tela nova usa daqui; tela velha migra quando alguém já
 * estiver mexendo nela.
 */
export { default as Button } from './Button';
export type { ButtonProps } from './Button';

export { default as Badge } from './Badge';

export { Card, CardHead, Numero } from './Card';

export { Input, Select, Rotulo } from './Field';

export { Table, Th, Tr, Td, TabelaVazia } from './Table';
export type { EstadoLinha } from './Table';

export { default as Tabs } from './Tabs';
export type { Aba } from './Tabs';

export {
  default as FiltroData,
  todayIso,
  isoDaysAgo,
  firstOfMonthIso,
  PERIODO_PADRAO,
} from './FiltroData';
export type { Periodo } from './FiltroData';
