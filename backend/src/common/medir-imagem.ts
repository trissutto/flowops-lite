/**
 * TAMANHO DA IMAGEM PELO CABEÇALHO — sem `sharp`, sem decodificar.
 *
 * Foto de produto pequena entrava no acervo em silêncio e só aparecia como
 * borrão na vitrine: em 13/08/2026 a PDP da VLM-222 servia um arquivo de
 * **700×1000** num quadro de 513 CSS px — num monitor a 150% o navegador
 * precisa de ~770px de largura e amplia o que tem. Medido no acervo: das 60
 * fotos mais recentes, 44 tinham 1200px ou menos.
 *
 * Lê só os primeiros bytes porque isso roda no caminho do upload: `sharp` é
 * binário nativo (pode não estar disponível) e decodificar um PNG de 1 MB pra
 * saber a largura é trabalho jogado fora.
 */

export interface TamanhoImagem {
  largura: number;
  altura: number;
}

/** `null` quando o formato não é reconhecido — nunca derruba o upload. */
export function medirImagem(buf: Buffer): TamanhoImagem | null {
  if (!buf || buf.length < 24) return null;

  // PNG: assinatura + IHDR nos bytes 16..23.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { largura: buf.readUInt32BE(16), altura: buf.readUInt32BE(20) };
  }

  // JPEG: procura o marcador SOFn, que é onde as dimensões moram.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marcador = buf[i + 1];
      // C4 = tabela Huffman, C8 = extensão JPEG, CC = tabela aritmética:
      // parecem SOF pelo número e não são.
      const ehSof = marcador >= 0xc0 && marcador <= 0xcf
        && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc;
      if (ehSof) return { altura: buf.readUInt16BE(i + 5), largura: buf.readUInt16BE(i + 7) };
      const tamanho = buf.readUInt16BE(i + 2);
      if (tamanho < 2) return null; // cabeçalho corrompido: não trava o loop
      i += 2 + tamanho;
    }
    return null;
  }

  // WebP: "RIFF"…"WEBP" + VP8 / VP8L / VP8X.
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    const tipo = buf.slice(12, 16).toString('latin1');
    if (tipo === 'VP8X') {
      return {
        largura: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        altura: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    if (tipo === 'VP8 ') {
      return { largura: buf.readUInt16LE(26) & 0x3fff, altura: buf.readUInt16LE(28) & 0x3fff };
    }
    if (tipo === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { largura: (bits & 0x3fff) + 1, altura: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  return null;
}

/**
 * O mínimo que a foto de produto precisa ter (decisão do dono, 13/08).
 *
 * 1400 × 2000 é a mesma proporção 7:10 que a casa já usa e cobre a PDP em
 * monitor a 150% e 200% ainda sobrando pro zoom. Foto menor NÃO é recusada —
 * entra e fica marcada pra refazer, porque travar quem só tem a foto pequena
 * na mão pararia a operação por um problema de qualidade.
 */
export const FOTO_LARGURA_MINIMA = 1400;
export const FOTO_ALTURA_MINIMA = 2000;

/**
 * O TETO DO ARQUIVO-MESTRE NO BUCKET (16/08/2026).
 *
 * Mesma proporção 7:10 do mínimo, com folga de sobra: o maior quadro da PDP
 * pede ~1540px num monitor a 200%, e o `next/image` reencoda pra AVIF/WebP no
 * tamanho do dispositivo — ninguém baixa o mestre. Quem consome o mestre CRU é
 * o feed do Meta/Google, e lá 2000px já é o dobro do recomendado.
 *
 * Existe porque o acervo do WordPress traz arquivo de qualquer tamanho, e um
 * mestre de 4000px é banda e memória do `sharp` jogadas fora.
 *
 * ⚠️ É TETO, NUNCA PISO: reduzir preserva o que a foto tem, AMPLIAR inventa
 * pixel e entrega peça borrada. Foto abaixo do mínimo se resolve refazendo a
 * foto — `fotoBaixaResolucao` marca quais são.
 */
export const FOTO_LARGURA_MAXIMA = 2000;
export const FOTO_ALTURA_MAXIMA = 2858;

export function fotoBaixaResolucao(largura?: number | null, altura?: number | null): boolean {
  if (!largura || !altura) return false; // não medida ≠ ruim
  return largura < FOTO_LARGURA_MINIMA || altura < FOTO_ALTURA_MINIMA;
}
