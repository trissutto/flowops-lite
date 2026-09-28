import {
  classificarLinha,
  ehEan13,
  normalizarCodigo,
  ordenarPorDinheiro,
  planoDeAjuste,
  resumirContagem,
  sugereRecontagem,
  type LinhaContagem,
} from './inventario-contagem';

const linha = (p: Partial<LinhaContagem> & { contado: number; esperado: number }): LinhaContagem => ({
  sku: '8000000001234',
  rotulo: 'REF · PRETO · 48',
  custo: 30,
  ...p,
});

describe('inventário — a régua da contagem', () => {
  it('sem zeros à esquerda, como o espelho e o bipe', () => {
    expect(normalizarCodigo('008000000001234')).toBe('8000000001234');
    expect(normalizarCodigo('  132908 ')).toBe('132908');
    expect(normalizarCodigo(null)).toBe('');
  });

  describe('só EAN-13 entra — o leitor pega o QR code da etiqueta às vezes', () => {
    it('13 dígitos passa, com espaço em volta também', () => {
      expect(ehEan13('8000000001234')).toBe(true);
      expect(ehEan13(' 8000000001234 ')).toBe(true);
      expect(ehEan13('0000011264750')).toBe(true);
    });
    it('QR code (URL, ref, texto) é recusado', () => {
      expect(ehEan13('https://lurds.com.br/produto/ref-207279?cor=preto')).toBe(false);
      expect(ehEan13('207279 PRETO 48')).toBe(false);
      expect(ehEan13('REF207279')).toBe(false);
    });
    it('código curto, 12 ou 14 dígitos e vazio são recusados', () => {
      expect(ehEan13('132908')).toBe(false);
      expect(ehEan13('800000000123')).toBe(false);
      expect(ehEan13('80000000012345')).toBe(false);
      expect(ehEan13('')).toBe(false);
      expect(ehEan13(null)).toBe(false);
    });
  });

  describe('delta e situação', () => {
    it('contou menos do que o sistema diz: faltou', () => {
      const l = classificarLinha(linha({ contado: 3, esperado: 5 }));
      expect(l.delta).toBe(-2);
      expect(l.situacao).toBe('faltou');
      expect(l.pecas).toBe(2);
      expect(l.valor).toBe(60);
    });

    it('contou mais: sobrou', () => {
      const l = classificarLinha(linha({ contado: 6, esperado: 5 }));
      expect(l.delta).toBe(1);
      expect(l.situacao).toBe('sobrou');
      expect(l.valor).toBe(30);
    });

    it('bateu: confere, e não gera movimento', () => {
      const l = classificarLinha(linha({ contado: 4, esperado: 4 }));
      expect(l.situacao).toBe('confere');
      expect(planoDeAjuste([l])).toEqual({ entradas: [], saidas: [] });
    });

    it('peça sem custo no cadastro tem valor null — nunca R$ 0', () => {
      const l = classificarLinha(linha({ contado: 0, esperado: 2, custo: null }));
      expect(l.pecas).toBe(2);
      expect(l.valor).toBeNull();
    });
  });

  /**
   * O ponto do módulo inteiro: a loja vende durante a contagem e o número
   * final continua certo, porque o que vai pro estoque é o DELTA sobre o
   * esperado CONGELADO no primeiro bipe — não o contado no lugar do saldo.
   */
  describe('a loja vende durante a contagem', () => {
    it('delta calculado no congelamento preserva a venda do meio', () => {
      const esperadoCongelado = 5; // saldo quando a peça foi bipada, às 14h
      const contado = 3;
      const saldoNaHoraDeAplicar = 4; // vendeu 1 às 14h30

      const l = classificarLinha(linha({ contado, esperado: esperadoCongelado }));
      expect(l.delta).toBe(-2);

      const saldoFinal = saldoNaHoraDeAplicar + l.delta;
      expect(saldoFinal).toBe(2); // contou 3, vendeu 1 — certo
    });

    it('substituir o saldo pelo contado devolveria a peça vendida ao estoque', () => {
      // O caminho ERRADO, registrado de propósito: "o saldo passa a ser 3"
      // devolve ao estoque a peça que saiu na sacola da cliente.
      const contado = 3;
      const saldoNaHoraDeAplicar = 4;
      expect(contado).toBeGreaterThan(saldoNaHoraDeAplicar - 2);
      expect(contado).not.toBe(2);
    });
  });

  describe('resumo', () => {
    const linhas = [
      classificarLinha(linha({ sku: '1', contado: 3, esperado: 5, custo: 30 })), // faltou 2 = 60
      classificarLinha(linha({ sku: '2', contado: 6, esperado: 5, custo: 40 })), // sobrou 1 = 40
      classificarLinha(linha({ sku: '3', contado: 4, esperado: 4 })), // confere
      classificarLinha(linha({ sku: '4', contado: 0, esperado: 1, custo: null })), // faltou 1, sem custo
    ];

    it('conta peças, SKUs e dinheiro dos dois lados', () => {
      const r = resumirContagem(linhas);
      expect(r.skus).toBe(4);
      expect(r.pecasContadas).toBe(13);
      expect(r.skusConferem).toBe(1);
      expect(r.skusFaltou).toBe(2);
      expect(r.pecasFaltou).toBe(3);
      expect(r.valorFaltou).toBe(60);
      expect(r.skusSobrou).toBe(1);
      expect(r.valorSobrou).toBe(40);
      expect(r.pecasLiquido).toBe(-2);
      expect(r.valorLiquido).toBe(-20);
    });

    it('avisa quantas linhas estão sem custo — o R$ está incompleto por elas', () => {
      expect(resumirContagem(linhas).semCusto).toBe(1);
    });
  });

  it('a matriz confere pelo dinheiro: 1 peça de R$ 180 antes de 4 de R$ 9', () => {
    const caro = classificarLinha(linha({ sku: 'caro', contado: 0, esperado: 1, custo: 180 }));
    const barato = classificarLinha(linha({ sku: 'barato', contado: 0, esperado: 4, custo: 9 }));
    expect(ordenarPorDinheiro([barato, caro]).map((l) => l.sku)).toEqual(['caro', 'barato']);
  });

  describe('o que pede recontagem antes de virar ajuste', () => {
    it('muita peça de uma vez', () => {
      expect(sugereRecontagem(classificarLinha(linha({ contado: 0, esperado: 3 })))).toBe(true);
    });

    it('pouca peça, mas muito dinheiro', () => {
      expect(
        sugereRecontagem(classificarLinha(linha({ contado: 0, esperado: 1, custo: 250 }))),
      ).toBe(true);
    });

    it('uma peça barata de diferença não para o inventário', () => {
      expect(
        sugereRecontagem(classificarLinha(linha({ contado: 2, esperado: 3, custo: 20 }))),
      ).toBe(false);
    });

    it('linha que confere nunca pede recontagem', () => {
      expect(sugereRecontagem(classificarLinha(linha({ contado: 9, esperado: 9 })))).toBe(false);
    });

    it('sobra também entra — costuma ser marcado ou card bipado, não peça achada', () => {
      expect(sugereRecontagem(classificarLinha(linha({ contado: 8, esperado: 5 })))).toBe(true);
    });
  });

  it('plano de ajuste separa entrada de saída pelo sinal do delta', () => {
    const plano = planoDeAjuste([
      classificarLinha(linha({ sku: 'sobrou', contado: 7, esperado: 5 })),
      classificarLinha(linha({ sku: 'faltou', contado: 1, esperado: 4 })),
      classificarLinha(linha({ sku: 'confere', contado: 2, esperado: 2 })),
    ]);
    expect(plano.entradas).toEqual([{ sku: 'sobrou', qty: 2 }]);
    expect(plano.saidas).toEqual([{ sku: 'faltou', qty: 3 }]);
  });
});
