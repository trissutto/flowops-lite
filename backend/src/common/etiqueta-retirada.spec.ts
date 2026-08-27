import { janelaEtiquetaRetiradaDias, podeGanharCaixa } from './etiqueta-retirada';

describe('etiqueta-retirada — quando o card ainda ganha caixa', () => {
  const agora = new Date('2026-08-27T18:00:00.000Z');
  const haDias = (d: number) => new Date(agora.getTime() - d * 24 * 60 * 60 * 1000);

  afterEach(() => {
    delete process.env.RETIRADA_ETIQUETA_APOS_ENVIO_DIAS;
  });

  it('card bipado e não despachado sempre pode — juntada e retirada', () => {
    for (const status of ['separated', 'ready']) {
      expect(podeGanharCaixa({ status }, false, agora)).toBe(true);
      expect(podeGanharCaixa({ status }, true, agora)).toBe(true);
    }
  });

  it('card ainda separando não gera caixa', () => {
    expect(podeGanharCaixa({ status: 'separating' }, true, agora)).toBe(false);
    expect(podeGanharCaixa({ status: 'new' }, true, agora)).toBe(false);
  });

  // O caso da Hellen: São José fechou o card no "Enviei pra loja INDAIATUBA"
  // sem nunca ter tirado etiqueta (LP-000296, 27/08).
  it('retirada JÁ enviada hoje ainda tira etiqueta', () => {
    expect(podeGanharCaixa({ status: 'shipped', updatedAt: haDias(0) }, true, agora)).toBe(true);
    expect(podeGanharCaixa({ status: 'shipped', updatedAt: haDias(2) }, true, agora)).toBe(true);
  });

  it('retirada enviada além da janela NÃO ressuscita', () => {
    expect(podeGanharCaixa({ status: 'shipped', updatedAt: haDias(4) }, true, agora)).toBe(false);
    expect(podeGanharCaixa({ status: 'shipped', updatedAt: haDias(120) }, true, agora)).toBe(false);
  });

  // No feeder de juntada `shipped` quer dizer "a caixa CHEGOU na âncora"
  // (carimbo do cron juntada-reconcile) — abrir caixa ali é segunda viagem.
  it('feeder de juntada enviado nunca ganha caixa nova', () => {
    expect(podeGanharCaixa({ status: 'shipped', updatedAt: haDias(0) }, false, agora)).toBe(false);
  });

  it('sem data de envio não arrisca', () => {
    expect(podeGanharCaixa({ status: 'shipped', updatedAt: null }, true, agora)).toBe(false);
  });

  it('a janela é configurável pela env (e cai no padrão de 3 dias)', () => {
    expect(janelaEtiquetaRetiradaDias()).toBe(3);
    process.env.RETIRADA_ETIQUETA_APOS_ENVIO_DIAS = '10';
    expect(janelaEtiquetaRetiradaDias()).toBe(10);
    expect(podeGanharCaixa({ status: 'shipped', updatedAt: haDias(9) }, true, agora)).toBe(true);
    process.env.RETIRADA_ETIQUETA_APOS_ENVIO_DIAS = 'abacaxi';
    expect(janelaEtiquetaRetiradaDias()).toBe(3);
  });
});
