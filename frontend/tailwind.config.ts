import type { Config } from 'tailwindcss';

/**
 * Tokens do sistema visual SEMÁFORO (escolhido pelo dono em 21/08/2026).
 *
 * A ideia da direção: o sistema é cinza e preto, e COR É PROPRIEDADE
 * EXCLUSIVA DO ESTADO. Por isso salta de longe — numa tela sem cor, a linha
 * vermelha grita. Só existem três cores no sistema inteiro, e as três
 * significam alguma coisa: `crit` (parado), `warn` (a fazer), `ok` (em dia).
 *
 * ⚠️ MUDANÇA DE REGRA: até aqui o verde #2E7D46 era EXCLUSIVO de dinheiro
 * (total, Finalizar). Verde agora significa "em dia", e DINHEIRO É `ink`
 * (grafite, com peso forte). Verde não pode ser as duas coisas — num fundo
 * cinza, número preto e pesado lê melhor que verde, e o total deixa de
 * competir com o alerta na mesma tela.
 *
 * MIGRAÇÃO POR ADIÇÃO: nada aqui remove nada. `brand` continua, e as cores
 * arbitrárias inline das 243 telas seguem funcionando. A tela migra quando
 * alguém já estiver mexendo nela — PR que troca cor em 243 arquivos é
 * irrevisável e impossível de reverter com a loja aberta.
 *
 * ⚠️ Token novo aqui TEM que entrar também na lista do `cn()`
 * (src/lib/cn.ts). O tailwind-merge só conhece os tokens que a gente declara;
 * sem isso ele come a classe de cor e o botão sai preto sem texto.
 */
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#1F4E79',
          light:   '#2E75B6',
          dark:    '#163D5C',
        },

        /* ── Superfícies ─────────────────────────────────────────── */
        ground:      '#F6F6F5',
        surface:     '#FFFFFF',
        'surface-2': '#FAFAF9',

        /* ── Tinta ───────────────────────────────────────────────── */
        ink:         '#17181A',
        'ink-soft':  '#6C6E73',
        'ink-faint': '#9A9CA1',

        /* ── Fios ────────────────────────────────────────────────── */
        line:        '#E2E3E5',
        'line-soft': '#EDEEEF',

        /* ── Ação (grafite — não é cor de estado) ─────────────────── */
        action:       '#2B2D31',
        'action-ink': '#FFFFFF',

        /* ── As três cores de ESTADO. Nada mais no sistema usa cor. ─ */
        crit:        '#C4291A',
        'crit-soft': '#FBE9E7',
        warn:        '#B4720F',
        'warn-soft': '#FBF1DE',
        ok:          '#2E9E5B',
        'ok-soft':   '#E7F5ED',
      },
      borderRadius: {
        card:  '7px',
        field: '5px',
      },
      spacing: {
        /* altura de linha de tabela — densidade é token, não decisão de tela */
        row:      '46px',
        'row-sm': '36px',
      },
    },
  },
  plugins: [],
};
export default config;
