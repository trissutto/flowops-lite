import { fotoMorta, fotoViva, fotosVivas } from './foto-viva';

/**
 * As pontas que não podem regredir (incidente de 14/09/2026 — 48 peças com a
 * galeria inteira apontando pro WordPress apagado, no feed E na vitrine):
 *
 *  - URL de `/wp-content/` nunca passa, absoluta ou relativa;
 *  - a foto do R2 nunca é cortada por engano — é o acervo VIVO;
 *  - a ORDEM sobrevive ao filtro, porque é a ordem que decide a capa.
 */
describe('foto viva — o que pode aparecer depois do WordPress apagado', () => {
  const R2 = 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/produtos/3153/CREME/1-IMG.jpg';

  it('URL do WordPress apagado é morta — absoluta, com www e relativa', () => {
    expect(fotoMorta('https://lurds.com.br/wp-content/uploads/2026/03/700906-CHUMBO-4-1.avif')).toBe(true);
    expect(fotoMorta('https://www.lurds.com.br/wp-content/uploads/2023/08/VMM-123.jpeg')).toBe(true);
    expect(fotoMorta('/wp-content/uploads/2025/01/SHORTS-26710A-3.jpeg')).toBe(true);
    expect(fotoMorta('https://lurds.com.br/wp-includes/images/media/default.png')).toBe(true);
  });

  it('caixa alta no caminho também é o WordPress — o 403 não liga pra isso', () => {
    expect(fotoMorta('https://lurds.com.br/WP-CONTENT/uploads/x.jpg')).toBe(true);
  });

  it('foto do R2 é viva — o acervo próprio não pode ser cortado por engano', () => {
    expect(fotoViva(R2)).toBe(true);
    expect(fotoMorta(R2)).toBe(false);
  });

  it('o corte é pelo CAMINHO, não pelo host — lurds.com.br é o site VIVO', () => {
    expect(fotoViva('https://lurds.com.br/produtos/3153/CREME/1-IMG.jpg')).toBe(true);
    // "wp-content" fora de caminho de diretório não é o WordPress apagado.
    expect(fotoViva('https://lurds.com.br/produtos/wp-content-da-peca.jpg')).toBe(true);
  });

  it('sem endereço é morta igual — vazio não abre pra ninguém', () => {
    expect(fotoMorta('')).toBe(true);
    expect(fotoMorta('   ')).toBe(true);
    expect(fotoMorta(null)).toBe(true);
    expect(fotoMorta(undefined)).toBe(true);
  });

  it('descarta a capa morta e PROMOVE a próxima válida, na ordem original', () => {
    const galeria = [
      { src: 'https://lurds.com.br/wp-content/uploads/a.jpg' },
      { src: R2 },
      { src: 'https://lurds.com.br/wp-content/uploads/b.jpg' },
      { src: `${R2}?v=2` },
    ];
    expect(fotosVivas(galeria, (f) => f.src)).toEqual([{ src: R2 }, { src: `${R2}?v=2` }]);
  });

  it('galeria 100% morta vira lista VAZIA — não inventa foto nem placeholder', () => {
    // O caso real das 48: nenhuma delas tinha uma única foto no R2.
    const soMortas = [
      { url: 'https://lurds.com.br/wp-content/uploads/2026/03/700906-CHUMBO-4-1.avif' },
      { url: 'https://lurds.com.br/wp-content/uploads/2026/03/700906-CHUMBO-5-1.avif' },
    ];
    expect(fotosVivas(soMortas, (f) => f.url)).toEqual([]);
  });

  it('lista ausente é lista vazia — nunca estoura em quem monta a peça', () => {
    expect(fotosVivas(null, (f: any) => f?.src)).toEqual([]);
    expect(fotosVivas(undefined, (f: any) => f?.src)).toEqual([]);
    expect(fotosVivas([null as any, undefined as any], (f: any) => f?.src)).toEqual([]);
  });

  it('string crua também serve — é o formato que o feed publica', () => {
    expect(
      fotosVivas([R2, 'https://lurds.com.br/wp-content/uploads/a.jpg'], (u) => u),
    ).toEqual([R2]);
  });
});
