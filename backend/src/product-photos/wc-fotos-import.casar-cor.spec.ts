import { WcFotosImportService } from './wc-fotos-import.service';

/**
 * "FIZ VÁRIAS VEZES A IMPORTAÇÃO" (dono, 13/08/2026).
 *
 * E não adiantava: a cor do ERP tinha que aparecer letra por letra no título
 * do WooCommerce, e o ERP abrevia ("EST MOSTARDA" lá é "Estampa Mostarda"
 * aqui). A foto existia dos dois lados; o importador só não sabia que era a
 * mesma cor. 102 das 322 cores sem foto do catálogo caíam nisso.
 *
 * Este teste é o contrato: se alguém apertar a normalização, a importação
 * volta a falhar em silêncio — que é o pior jeito de falhar.
 */

const svc = Object.create(WcFotosImportService.prototype) as any;
// `semAcento` é o único ajudante que `casarCor` usa de fora da classe.
svc.semAcento = (v: string) =>
  String(v || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const casar = (nomeWc: string, cores: string[]) => svc.casarCor(nomeWc, cores);

describe('casarCor', () => {
  it('casa a abreviação do ERP com a palavra inteira do site', () => {
    expect(casar('Blusa Plus Size Ref 132908 Estampa Mostarda', ['EST MOSTARDA'])).toBe('EST MOSTARDA');
    expect(casar('Blusa Ref S01884 Estampa Verde', ['EST VERDE'])).toBe('EST VERDE');
  });

  it('hífen e espaço são a mesma coisa — o caso OFF WHITE (11 peças)', () => {
    expect(casar('T-shirt Ref VOGUE Off-White', ['OFF WHITE'])).toBe('OFF WHITE');
    expect(casar('T-shirt Ref VOGUE Off White', ['OFF-WHITE'])).toBe('OFF-WHITE');
  });

  it('a cor mais específica ganha DEPOIS de normalizar', () => {
    // "EST BEGE" (8 letras) é mais curto que "BEGE"+4, mas normalizado vira
    // "ESTAMPA BEGE" (12) e ganha. Ordenar pelo nome cru dava a foto da
    // estampa pra cor lisa.
    expect(casar('Blusa Estampa Bege', ['BEGE', 'EST BEGE'])).toBe('EST BEGE');
    expect(casar('Blusa Bege', ['BEGE', 'EST BEGE'])).toBe('BEGE');
  });

  it('continua respeitando fronteira de palavra', () => {
    // A regra que já existia: "UVA" não pode casar dentro de "LUVA".
    expect(casar('Luva Feminina', ['UVA'])).toBeNull();
  });

  it('não inventa cor quando não tem', () => {
    expect(casar('Blusa Plus Size Ref 900890', ['PRETO', 'MARINHO'])).toBeNull();
  });

  it('acento no site não atrapalha', () => {
    expect(casar('Blusa Ref X Rosê', ['ROSE'])).toBe('ROSE');
  });
});
