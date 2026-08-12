/**
 * DIMENSÕES DA IMAGEM PELO CABEÇALHO DO ARQUIVO.
 *
 * Existe por causa de UM defeito concreto (12/08/2026): o hero de campanha
 * (`Hero` em modo `arte`) declarava 2400×1350 pro navegador e a arte no ar é
 * 2216×709. Em tela de 1350px o navegador reservava 751px de altura, a arte
 * chegava com 427px e a home INTEIRA subia 324px — CLS 0,13 no PageSpeed
 * desktop, o único indicador vermelho da página.
 *
 * Chutar proporção não tem conserto: cada campanha nova vem com a sua. A
 * reserva só fica certa se vier do arquivo, e o arquivo é o único lugar que
 * sabe. Por isso este módulo lê o CABEÇALHO — os primeiros bytes, onde todo
 * formato guarda largura e altura — em vez de decodificar a imagem (que
 * exigiria `sharp`, binário nativo pesado, na Vercel).
 *
 * Cobre o que a retaguarda aceita subir: PNG, JPEG, GIF, WebP e AVIF/HEIC.
 * Formato desconhecido ou arquivo truncado devolve `null` — quem chama volta
 * pro comportamento antigo em vez de quebrar a home por causa de um banner.
 */

export interface Dimensoes {
  largura: number;
  altura: number;
}

/** Lê `n` bytes big-endian a partir de `i`. */
function be(b: Uint8Array, i: number, n: number): number {
  let v = 0;
  for (let k = 0; k < n; k++) v = v * 256 + b[i + k];
  return v;
}

/** Lê `n` bytes little-endian a partir de `i`. */
function le(b: Uint8Array, i: number, n: number): number {
  let v = 0;
  for (let k = n - 1; k >= 0; k--) v = v * 256 + b[i + k];
  return v;
}

/** Compara uma assinatura ASCII na posição `i` (sem alocar string). */
function marca(b: Uint8Array, i: number, texto: string): boolean {
  if (i + texto.length > b.length) return false;
  for (let k = 0; k < texto.length; k++) if (b[i + k] !== texto.charCodeAt(k)) return false;
  return true;
}

function valido(d: Dimensoes | null): Dimensoes | null {
  if (!d) return null;
  const { largura, altura } = d;
  if (!Number.isFinite(largura) || !Number.isFinite(altura)) return null;
  if (largura < 1 || altura < 1 || largura > 100_000 || altura > 100_000) return null;
  return { largura, altura };
}

/** PNG — IHDR é sempre o primeiro chunk, em posição fixa. */
function png(b: Uint8Array): Dimensoes | null {
  if (b.length < 24) return null;
  if (!(b[0] === 0x89 && marca(b, 1, 'PNG'))) return null;
  return { largura: be(b, 16, 4), altura: be(b, 20, 4) };
}

/** GIF — largura e altura no Logical Screen Descriptor, 16 bits LE. */
function gif(b: Uint8Array): Dimensoes | null {
  if (b.length < 10 || !marca(b, 0, 'GIF8')) return null;
  return { largura: le(b, 6, 2), altura: le(b, 8, 2) };
}

/**
 * JPEG — não tem posição fixa: é uma sequência de segmentos e o tamanho mora
 * no SOF (Start Of Frame). Percorremos os segmentos pulando pelo comprimento
 * declarado em cada um até achar o SOF.
 */
function jpeg(b: Uint8Array): Dimensoes | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;

  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++; // byte de preenchimento entre segmentos
      continue;
    }
    const marcador = b[i + 1];
    // SOF0..SOF15, menos DHT (C4), JPG (C8) e DAC (CC), que não são frame.
    if (marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc) {
      return { altura: be(b, i + 5, 2), largura: be(b, i + 7, 2) };
    }
    // 0xD0-0xD9 não têm corpo; o resto declara o comprimento nos 2 bytes seguintes.
    if (marcador >= 0xd0 && marcador <= 0xd9) i += 2;
    else i += 2 + be(b, i + 2, 2);
  }
  return null;
}

/** WebP — três variantes de bloco, cada uma guarda o tamanho num lugar. */
function webp(b: Uint8Array): Dimensoes | null {
  if (b.length < 30 || !marca(b, 0, 'RIFF') || !marca(b, 8, 'WEBP')) return null;

  if (marca(b, 12, 'VP8X')) {
    // Estendido (o que o `cwebp` gera com alfa/animação): 24 bits, menos 1.
    return { largura: le(b, 24, 3) + 1, altura: le(b, 27, 3) + 1 };
  }
  if (marca(b, 12, 'VP8L')) {
    // Sem perdas: 14 bits pra cada, empacotados em 4 bytes.
    const pacote = le(b, 21, 4);
    return { largura: (pacote & 0x3fff) + 1, altura: ((pacote >> 14) & 0x3fff) + 1 };
  }
  if (marca(b, 12, 'VP8 ')) {
    // Com perdas: depois do sync code 0x9d 0x01 0x2a.
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    return { largura: le(b, 26, 2) & 0x3fff, altura: le(b, 28, 2) & 0x3fff };
  }
  return null;
}

/**
 * AVIF / HEIC — contêiner ISO-BMFF. O tamanho mora na caixa `ispe`, em
 * profundidade variável, então procuramos a assinatura em vez de navegar a
 * árvore de caixas (que custaria dez vezes mais código pelo mesmo resultado).
 */
function avif(b: Uint8Array): Dimensoes | null {
  if (b.length < 32 || !marca(b, 4, 'ftyp')) return null;
  const familia = ['avif', 'avis', 'heic', 'heix', 'hevc', 'mif1', 'msf1'];
  if (!familia.some((f) => marca(b, 8, f))) return null;

  for (let i = 12; i + 16 <= b.length; i++) {
    if (marca(b, i, 'ispe')) {
      // ispe: [4 tipo][4 versão+flags][4 largura][4 altura]
      return { largura: be(b, i + 8, 4), altura: be(b, i + 12, 4) };
    }
  }
  return null;
}

/**
 * Descobre largura e altura pelos primeiros bytes do arquivo.
 * `null` = formato não reconhecido ou cabeçalho incompleto.
 */
export function lerDimensoes(bytes: Uint8Array): Dimensoes | null {
  if (!bytes || bytes.length < 10) return null;
  return valido(png(bytes) ?? gif(bytes) ?? webp(bytes) ?? avif(bytes) ?? jpeg(bytes));
}
