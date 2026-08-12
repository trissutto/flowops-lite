import { describe, expect, it } from 'vitest';
import { lerDimensoes } from './dimensoes-imagem';

/**
 * Cabeçalhos montados à mão: o que este módulo lê são os primeiros bytes, então
 * o teste escreve exatamente esses bytes. Não precisa de arquivo de exemplo no
 * repositório, e o teste falha pelo motivo certo se alguém trocar um offset.
 */

function png(largura: number, altura: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x08], 0);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  new DataView(b.buffer).setUint32(16, largura);
  new DataView(b.buffer).setUint32(20, altura);
  return b;
}

function jpeg(largura: number, altura: number): Uint8Array {
  const b = new Uint8Array(20);
  const v = new DataView(b.buffer);
  b.set([0xff, 0xd8], 0); // SOI
  b.set([0xff, 0xe0], 2); // APP0 vazio, pra provar que o segmento é pulado
  v.setUint16(4, 4);
  b.set([0xff, 0xc0], 8); // SOF0
  v.setUint16(10, 11);
  b[12] = 8; // precisão
  v.setUint16(13, altura);
  v.setUint16(15, largura);
  return b;
}

function webpVP8X(largura: number, altura: number): Uint8Array {
  const b = new Uint8Array(32);
  const texto = (s: string, i: number) => b.set([...s].map((c) => c.charCodeAt(0)), i);
  texto('RIFF', 0);
  texto('WEBP', 8);
  texto('VP8X', 12);
  const le24 = (n: number, i: number) => b.set([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff], i);
  le24(largura - 1, 24);
  le24(altura - 1, 27);
  return b;
}

function gif(largura: number, altura: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([...'GIF89a'].map((c) => c.charCodeAt(0)), 0);
  new DataView(b.buffer).setUint16(6, largura, true);
  new DataView(b.buffer).setUint16(8, altura, true);
  return b;
}

function avif(largura: number, altura: number): Uint8Array {
  const b = new Uint8Array(64);
  const texto = (s: string, i: number) => b.set([...s].map((c) => c.charCodeAt(0)), i);
  texto('ftyp', 4);
  texto('avif', 8);
  texto('ispe', 32);
  const v = new DataView(b.buffer);
  v.setUint32(40, largura);
  v.setUint32(44, altura);
  return b;
}

describe('lerDimensoes', () => {
  it('lê PNG', () => {
    expect(lerDimensoes(png(2400, 1350))).toEqual({ largura: 2400, altura: 1350 });
  });

  it('lê JPEG pulando os segmentos até o SOF', () => {
    expect(lerDimensoes(jpeg(1350, 431))).toEqual({ largura: 1350, altura: 431 });
  });

  it('lê WebP estendido', () => {
    expect(lerDimensoes(webpVP8X(1080, 1350))).toEqual({ largura: 1080, altura: 1350 });
  });

  it('lê GIF', () => {
    expect(lerDimensoes(gif(600, 400))).toEqual({ largura: 600, altura: 400 });
  });

  it('lê AVIF pela caixa ispe', () => {
    expect(lerDimensoes(avif(1920, 614))).toEqual({ largura: 1920, altura: 614 });
  });

  /**
   * O contrato que segura a home: qualquer coisa estranha vira `null`, e quem
   * chama volta pro padrão. Banner é enfeite — não derruba a página.
   */
  it('devolve null pro que não reconhece', () => {
    expect(lerDimensoes(new Uint8Array(0))).toBeNull();
    expect(lerDimensoes(new Uint8Array(64))).toBeNull();
    expect(lerDimensoes(new TextEncoder().encode('<!doctype html><html>...'))).toBeNull();
  });

  it('devolve null quando o arquivo está truncado no meio do cabeçalho', () => {
    expect(lerDimensoes(png(2400, 1350).subarray(0, 14))).toBeNull();
  });

  it('recusa tamanho absurdo em vez de reservar uma altura impossível', () => {
    expect(lerDimensoes(png(0, 0))).toBeNull();
    expect(lerDimensoes(png(500_000, 10))).toBeNull();
  });
});
