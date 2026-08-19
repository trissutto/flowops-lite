import { describe, expect, it } from 'vitest';
import { youtubeId } from './youtube';

/**
 * Cada formato aqui é um jeito REAL de a retaguarda receber o link — o botão
 * Compartilhar do celular, o da barra do desktop, o de um Short. Errar um
 * significa vídeo cadastrado que não aparece na página, sem erro nenhum.
 */
describe('youtubeId', () => {
  const ID = 'dQw4w9WgXcQ';

  it.each([
    ['https://youtu.be/dQw4w9WgXcQ', ID],
    ['https://youtu.be/dQw4w9WgXcQ?si=AbC123', ID],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', ID],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', ID],
    ['https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ', ID],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', ID],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', ID],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', ID],
    ['  https://youtu.be/dQw4w9WgXcQ  ', ID],
    ['dQw4w9WgXcQ', ID],
  ])('lê %s', (url, esperado) => {
    expect(youtubeId(url)).toBe(esperado);
  });

  it.each([null, undefined, '', '   ', 'https://vimeo.com/76979871', 'ainda não tem'])(
    'devolve null pro que não é vídeo do YouTube (%s)',
    (entrada) => {
      expect(youtubeId(entrada)).toBeNull();
    },
  );
});
