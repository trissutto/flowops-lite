import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * O tracking vive metade no navegador (storage, window, listeners), então o
 * ambiente padrão é jsdom. Teste de módulo puro roda igual — jsdom só adiciona
 * as APIs, não atrapalha.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
