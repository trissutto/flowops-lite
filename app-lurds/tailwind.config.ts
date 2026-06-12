import type { Config } from 'tailwindcss';

/**
 * Paleta Lurd's Plus Size — luxo plus size
 *   - black:  fundo principal, headers, base
 *   - gold:   CTAs, destaques, badges premium
 *   - white:  texto sobre preto
 *   - cream:  fundos secundários suaves
 *
 * Tipografia:
 *   - serif (Playfair Display) → títulos elegantes (combina com logo cursivo)
 *   - sans  (Inter)            → corpo, botões, formulários (legível mobile)
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta principal
        ink: {
          DEFAULT: '#0A0A0A', // preto profundo (fundo)
          800: '#1A1A1A',
          700: '#2A2A2A',
          600: '#3A3A3A',
        },
        gold: {
          DEFAULT: '#C9A961', // dourado principal (CTAs)
          light: '#E0C589',   // hover claro
          dark: '#8B7355',    // bordas / ativos
          deep: '#5C4A2F',    // detalhes finos
        },
        cream: {
          DEFAULT: '#F5F2EC',
          100: '#FAF8F4',
          200: '#EFE9DD',
        },
      },
      fontFamily: {
        serif: ['var(--font-serif)', 'Playfair Display', 'Georgia', 'serif'],
        sans: ['var(--font-sans)', 'Inter', 'system-ui', 'sans-serif'],
      },
      maxWidth: {
        app: '440px', // largura ideal pra app mobile (não estica em tablet)
      },
      boxShadow: {
        gold: '0 4px 12px -2px rgba(201, 169, 97, 0.35)',
        'gold-lg': '0 8px 24px -4px rgba(201, 169, 97, 0.45)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
