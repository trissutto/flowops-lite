/**
 * O QUE O PAINEL DA COR MOSTRA QUANDO A FICHA CHEGA — fora do componente pra
 * ter teste (`npm run test:ficha-cor`).
 *
 * O problema (11/09/2026, /retaguarda/produto-estoque/produtos): a cor abre e
 * SÓ ENTÃO o GET da ficha sai. `useState(fichaCor?…)` lê apenas o primeiro
 * render, então o painel nascia vazio e ficava vazio. A galeria tinha efeito
 * próprio e se corrigia; o resto não. Deu a tela em que "Fotos desta cor
 * (1/6)" mostra a foto, ao lado se lê "Nenhuma foto" e o select de PUBLICAÇÃO
 * está travado — a peça com foto, com estoque e sem caminho pro site.
 *
 * A régua, então:
 *
 * 1. FOTO e PUBLICAÇÃO espelham o servidor sempre que a ficha desta cor muda.
 *    Ninguém digita foto: o que o banco diz é o que vale.
 * 2. O QUE A PESSOA ESTÁ FAZENDO AGORA ganha do eco de um PATCH em voo —
 *    título/vídeo sendo digitados, bolinha recém-escolhida e publicação ainda
 *    salvando não são sobrescritos pela resposta de OUTRA gravação.
 * 3. Campo que a tela não carregou NÃO é resposta: quando não há ficha, o
 *    espelho não devolve nada (em vez de devolver vazio como se fosse verdade).
 *    É o mesmo motivo pelo qual "Salvar título e vídeo" não manda mais a
 *    publicação junto — vazio de tela não pode tirar peça do ar.
 */

export type SwatchTipo = 'cor' | 'foto';

export interface SwatchEspelho {
  swatchTipo: SwatchTipo;
  corHex: string | null;
  swatchFocoX: number | null;
  swatchFocoY: number | null;
}

export interface FichaCorEspelho<F = { id: string }> {
  tituloComercial?: string | null;
  youtubeUrl?: string | null;
  statusPublicacao?: string | null;
  swatchTipo?: SwatchTipo | null;
  corHex?: string | null;
  swatchFocoX?: number | null;
  swatchFocoY?: number | null;
  fotos?: F[] | null;
}

/** O que a pessoa já mexeu nesta sessão — e que o espelho não pode pisar. */
export interface TravasDaCor {
  /** Título ou vídeo digitados depois de abrir a cor. */
  tocouTexto: boolean;
  /** Bolinha escolhida (ou lida pela IA) e com gravação a caminho. */
  tocouSwatch: boolean;
  /** PATCH de publicação ainda no ar. */
  publicacaoEmVoo: boolean;
}

/** Só os campos que devem ser aplicados; ausente = não encoste. */
export interface EspelhoDaCor<F = { id: string }> {
  fotos?: F[];
  status?: string;
  titulo?: string;
  youtube?: string;
  swatch?: SwatchEspelho;
}

/**
 * 'sem_fotos' é conclusão do sistema (backend `statusEfetivo`), não opção do
 * select — na tela ele aparece como "Fora do site".
 */
export function statusNoSelect(gravado: string | null | undefined): string {
  if (!gravado || gravado === 'sem_fotos') return 'nao_publicar';
  return gravado;
}

/**
 * Assinatura do que o SERVIDOR diz sobre esta cor. Muda quando a ficha chega
 * ou quando alguém mexeu de verdade (outra aba, importação de fotos) — e NÃO
 * muda a cada re-render do pai, que é o que tornaria o espelho um ladrão de
 * digitação.
 */
export function assinaturaDaCor(fichaCor: FichaCorEspelho | null | undefined): string {
  if (!fichaCor) return '';
  return JSON.stringify([
    fichaCor.tituloComercial ?? '',
    fichaCor.youtubeUrl ?? '',
    fichaCor.statusPublicacao ?? '',
    fichaCor.swatchTipo ?? 'cor',
    fichaCor.corHex ?? '',
    fichaCor.swatchFocoX ?? '',
    fichaCor.swatchFocoY ?? '',
    (fichaCor.fotos ?? []).map((f) => f.id).join('|'),
  ]);
}

export function espelharCor<F extends { id: string }>(
  fichaCor: FichaCorEspelho<F> | null | undefined,
  travas: TravasDaCor,
): EspelhoDaCor<F> {
  // Sem ficha não há o que espelhar: o painel segue com o que já tem. Devolver
  // vazio aqui seria justamente transformar "ainda não carregou" em "não tem".
  if (!fichaCor) return {};

  const espelho: EspelhoDaCor<F> = { fotos: fichaCor.fotos ?? [] };

  if (!travas.publicacaoEmVoo) {
    espelho.status = statusNoSelect(fichaCor.statusPublicacao);
  }
  if (!travas.tocouTexto) {
    espelho.titulo = fichaCor.tituloComercial ?? '';
    espelho.youtube = fichaCor.youtubeUrl ?? '';
  }
  if (!travas.tocouSwatch) {
    espelho.swatch = {
      swatchTipo: fichaCor.swatchTipo ?? 'cor',
      corHex: fichaCor.corHex ?? null,
      swatchFocoX: fichaCor.swatchFocoX ?? null,
      swatchFocoY: fichaCor.swatchFocoY ?? null,
    };
  }
  return espelho;
}
