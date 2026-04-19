import type { Config } from 'tailwindcss';

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
      },
    },
  },
  plugins: [],
};
export default config;
