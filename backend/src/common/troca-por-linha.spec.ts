import {
  agruparPorSku,
  alocarPedidoDeTroca,
  chaveSku,
  saldoPorLinha,
  somarPorChave,
  type LinhaDeTroca,
} from './troca-por-linha';

/**
 * TROCA POR LINHA — a cliente comprou DUAS peças iguais e quer trocar SÓ UMA.
 *
 * Desde 29/08 ("peça é peça") as duas são duas linhas com o MESMO SKU. As
 * telas de troca usavam o SKU como identidade: marcar uma marcava as duas, e
 * devolvida uma, as duas apareciam "já devolvida". Estes testes são o caso.
 */
describe('troca por linha — duas peças iguais', () => {
  const blusa = (linhaId: string, precoUnit = 79.9, qty = 1): LinhaDeTroca => ({
    linhaId,
    sku: '8000000003652',
    qty,
    precoUnit,
  });
  const comSaldo = (linhas: LinhaDeTroca[], usadas: any[] = []) => {
    const saldo = saldoPorLinha(linhas, usadas);
    return linhas.map((l) => ({ ...l, ...saldo.get(l.linhaId)! }));
  };

  describe('saldoPorLinha', () => {
    test('nada devolvido: cada peça igual tem 1 disponível', () => {
      const s = saldoPorLinha([blusa('a'), blusa('b')], []);
      expect(s.get('a')).toEqual({ ja: 0, disponivel: 1 });
      expect(s.get('b')).toEqual({ ja: 0, disponivel: 1 });
    });

    test('O BUG: devolvida UMA de duas iguais, a OUTRA continua podendo voltar', () => {
      // Antes: o "já devolveu 1" era descontado de CADA linha → as duas zeravam.
      const s = saldoPorLinha([blusa('a'), blusa('b')], [{ sku: '8000000003652', qty: 1, precoUnit: 79.9 }]);
      expect(s.get('a')).toEqual({ ja: 1, disponivel: 0 });
      expect(s.get('b')).toEqual({ ja: 0, disponivel: 1 });
    });

    test('pedido antigo (uma linha qty 2): devolveu 1, sobra 1 — igual a antes', () => {
      const s = saldoPorLinha([blusa('a', 79.9, 2)], [{ sku: '8000000003652', qty: 1 }]);
      expect(s.get('a')).toEqual({ ja: 1, disponivel: 1 });
    });

    test('mesmo SKU com preços diferentes: o que voltou sai da linha de MESMO preço', () => {
      const s = saldoPorLinha(
        [blusa('cheia', 79.9), blusa('trocada', 59.9)],
        [{ sku: '8000000003652', qty: 1, precoUnit: 59.9 }],
      );
      expect(s.get('cheia')).toEqual({ ja: 0, disponivel: 1 });
      expect(s.get('trocada')).toEqual({ ja: 1, disponivel: 0 });
    });

    test('voltou mais do que foi comprado (dado torto): para em zero, nunca negativo', () => {
      const s = saldoPorLinha([blusa('a'), blusa('b')], [{ sku: '8000000003652', qty: 5 }]);
      expect(s.get('a')).toEqual({ ja: 1, disponivel: 0 });
      expect(s.get('b')).toEqual({ ja: 1, disponivel: 0 });
    });

    test('SKU com zero à esquerda é o mesmo código', () => {
      const s = saldoPorLinha(
        [{ linhaId: 'a', sku: '5363735', qty: 1, precoUnit: 10 }],
        [{ sku: '005363735', qty: 1 }],
      );
      expect(s.get('a')).toEqual({ ja: 1, disponivel: 0 });
      expect(chaveSku(' 005363735 ')).toBe('5363735');
      expect(chaveSku('0')).toBe('0');
    });

    test('devolução de OUTRO SKU não mexe nestas linhas', () => {
      const s = saldoPorLinha([blusa('a'), blusa('b')], [{ sku: '999', qty: 1 }]);
      expect(s.get('a')!.disponivel + s.get('b')!.disponivel).toBe(2);
    });
  });

  describe('alocarPedidoDeTroca', () => {
    test('O CASO: a tela marca SÓ a segunda peça → só ela volta', () => {
      const linhas = comSaldo([blusa('a'), blusa('b')]);
      const r = alocarPedidoDeTroca(linhas, [{ linhaId: 'b', sku: '8000000003652', qty: 1 }]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.alocacoes.map((a) => [a.linha.linhaId, a.qty])).toEqual([['b', 1]]);
    });

    test('as duas marcadas → as duas voltam', () => {
      const linhas = comSaldo([blusa('a'), blusa('b')]);
      const r = alocarPedidoDeTroca(linhas, [
        { linhaId: 'a', sku: '8000000003652', qty: 1 },
        { linhaId: 'b', sku: '8000000003652', qty: 1 },
      ]);
      expect(r.ok && r.alocacoes.map((a) => a.linha.linhaId)).toEqual(['a', 'b']);
    });

    test('só SKU (portal / aba velha), pediu 1 de 2 iguais → sai de UMA linha', () => {
      const linhas = comSaldo([blusa('a'), blusa('b')]);
      const r = alocarPedidoDeTroca(linhas, [{ sku: '8000000003652', qty: 1 }]);
      expect(r.ok && r.alocacoes.map((a) => [a.linha.linhaId, a.qty])).toEqual([['a', 1]]);
    });

    test('só SKU, pediu 2 → espalha pelas duas linhas (antes recusava: "só tem 1")', () => {
      const linhas = comSaldo([blusa('a'), blusa('b')]);
      const r = alocarPedidoDeTroca(linhas, [{ sku: '8000000003652', qty: 2 }]);
      expect(r.ok && r.alocacoes.map((a) => [a.linha.linhaId, a.qty])).toEqual([
        ['a', 1],
        ['b', 1],
      ]);
    });

    test('só SKU depois de uma já devolvida → pega a que sobrou', () => {
      const linhas = comSaldo([blusa('a'), blusa('b')], [{ sku: '8000000003652', qty: 1, precoUnit: 79.9 }]);
      const r = alocarPedidoDeTroca(linhas, [{ sku: '8000000003652', qty: 1 }]);
      expect(r.ok && r.alocacoes.map((a) => a.linha.linhaId)).toEqual(['b']);
    });

    test('pediu mais do que tem: recusa dizendo quanto tem', () => {
      const linhas = comSaldo([blusa('a'), blusa('b')], [{ sku: '8000000003652', qty: 1 }]);
      const r = alocarPedidoDeTroca(linhas, [{ sku: '8000000003652', qty: 2 }]);
      expect(r).toMatchObject({ ok: false, erro: 'sem_saldo', pedido: 2, disponivel: 1 });
    });

    /**
     * O registro guarda SKU e preço, não a linha: devolvida UMA das iguais, o
     * saldo "gasta" a primeira linha — mesmo que a vendedora tenha marcado a
     * segunda. Pedir a linha gasta vale como "uma peça igual a ela".
     */
    test('linha "gasta" pelo registro: a peça sai da IGUAL que sobrou', () => {
      const linhas = comSaldo([blusa('a'), blusa('b')], [{ sku: '8000000003652', qty: 1, precoUnit: 79.9 }]);
      expect(linhas.map((l) => l.disponivel)).toEqual([0, 1]);
      const r = alocarPedidoDeTroca(linhas, [{ linhaId: 'a', sku: '8000000003652', qty: 1 }]);
      expect(r.ok && r.alocacoes.map((a) => [a.linha.linhaId, a.qty])).toEqual([['b', 1]]);
    });

    test('as duas iguais já devolvidas: recusa', () => {
      const linhas = comSaldo([blusa('a'), blusa('b')], [{ sku: '8000000003652', qty: 2, precoUnit: 79.9 }]);
      const r = alocarPedidoDeTroca(linhas, [{ linhaId: 'b', qty: 1 }]);
      expect(r).toMatchObject({ ok: false, erro: 'sem_saldo', pedido: 1, disponivel: 0 });
    });

    test('linha de PREÇO diferente nunca substitui a pedida', () => {
      const linhas = comSaldo(
        [blusa('cheia', 79.9), blusa('trocada', 59.9)],
        [{ sku: '8000000003652', qty: 1, precoUnit: 59.9 }],
      );
      const r = alocarPedidoDeTroca(linhas, [{ linhaId: 'trocada', qty: 1 }]);
      expect(r).toMatchObject({ ok: false, erro: 'sem_saldo', disponivel: 0 });
    });

    test('a mesma linha duas vezes = duas peças iguais: só passa se existirem duas', () => {
      const duas = alocarPedidoDeTroca(comSaldo([blusa('a'), blusa('b')]), [
        { linhaId: 'a', qty: 1 },
        { linhaId: 'a', qty: 1 },
      ]);
      expect(duas.ok && duas.alocacoes.map((a) => a.linha.linhaId)).toEqual(['a', 'b']);

      const uma = alocarPedidoDeTroca(comSaldo([blusa('a')]), [
        { linhaId: 'a', qty: 1 },
        { linhaId: 'a', qty: 1 },
      ]);
      expect(uma).toMatchObject({ ok: false, erro: 'sem_saldo', disponivel: 0 });
    });

    test('linha marcada + pedido só por SKU: o SKU pega o que sobrou', () => {
      const linhas = comSaldo([blusa('a'), blusa('b')]);
      const r = alocarPedidoDeTroca(linhas, [
        { sku: '8000000003652', qty: 1 },
        { linhaId: 'a', qty: 1 },
      ]);
      expect(r.ok && r.alocacoes.map((a) => a.linha.linhaId)).toEqual(['a', 'b']);
    });

    test('linha que não existe mais no pedido: recusa (tela velha)', () => {
      const r = alocarPedidoDeTroca(comSaldo([blusa('a')]), [{ linhaId: 'sumiu', sku: '8000000003652', qty: 1 }]);
      expect(r).toMatchObject({ ok: false, erro: 'linha_inexistente', linhaId: 'sumiu' });
    });

    test('linha que mudou de peça (troca de peça no pedido): recusa em vez de devolver a errada', () => {
      const r = alocarPedidoDeTroca(comSaldo([blusa('a')]), [{ linhaId: 'a', sku: '5396870', qty: 1 }]);
      expect(r).toMatchObject({ ok: false, erro: 'linha_mudou', skuPedido: '5396870' });
    });

    test('SKU que não está no pedido / pedido sem SKU', () => {
      expect(alocarPedidoDeTroca(comSaldo([blusa('a')]), [{ sku: '999', qty: 1 }])).toMatchObject({
        ok: false,
        erro: 'fora_do_pedido',
        sku: '999',
      });
      expect(alocarPedidoDeTroca(comSaldo([blusa('a')]), [{ qty: 1 }])).toMatchObject({ ok: false, erro: 'sem_sku' });
    });

    test('quantidade zerada/lixo conta como 1 (o comportamento de sempre)', () => {
      const r = alocarPedidoDeTroca(comSaldo([blusa('a'), blusa('b')]), [{ linhaId: 'b', qty: 0 }]);
      expect(r.ok && r.alocacoes.map((a) => [a.linha.linhaId, a.qty])).toEqual([['b', 1]]);
    });
  });

  test('ciclo completo: devolve a 1ª hoje, a 2ª amanhã, a 3ª não existe', () => {
    const pedido = [blusa('a'), blusa('b')];
    const registro: Array<{ sku: string; qty: number; precoUnit: number }> = [];
    const devolver = (linhaId: string) => {
      const r = alocarPedidoDeTroca(comSaldo(pedido, registro), [{ linhaId, qty: 1 }]);
      if (r.ok) for (const a of r.alocacoes) registro.push({ sku: a.linha.sku, qty: a.qty, precoUnit: a.linha.precoUnit });
      return r.ok;
    };
    const disponiveis = () => comSaldo(pedido, registro).reduce((s, l) => s + l.disponivel, 0);
    expect(devolver('b')).toBe(true);
    expect(disponiveis()).toBe(1);
    // A tela de amanhã mostra a 1ª como "já devolvida" (a régua escolhe a
    // primeira igual) — marcar qualquer uma das duas devolve a que sobrou.
    expect(devolver('a')).toBe(true);
    expect(disponiveis()).toBe(0);
    expect(devolver('a')).toBe(false);
    expect(devolver('b')).toBe(false);
    expect(registro.reduce((s, r) => s + r.qty, 0)).toBe(2);
  });

  test('somarPorChave: duas iguais devolvidas juntas viram UM registro qty 2', () => {
    const linhas = comSaldo([blusa('a'), blusa('b'), { linhaId: 'c', sku: '777', qty: 1, precoUnit: 50 }]);
    const r = alocarPedidoDeTroca(linhas, [
      { linhaId: 'a', qty: 1 },
      { linhaId: 'b', qty: 1 },
      { linhaId: 'c', qty: 1 },
    ]);
    if (!r.ok) throw new Error('alocação devia passar');
    const grupos = somarPorChave(r.alocacoes, (l) => `${chaveSku(l.sku)}|${Math.round(l.precoUnit * 100)}`);
    expect(grupos.map((g) => [g.linha.sku, g.qty])).toEqual([
      ['8000000003652', 2],
      ['777', 1],
    ]);
  });

  test('agruparPorSku: mantém a ordem do pedido', () => {
    const g = agruparPorSku([
      { sku: '1', n: 1 },
      { sku: '2', n: 2 },
      { sku: '01', n: 3 },
    ]);
    expect(g.map((x) => x.map((l) => l.n))).toEqual([[1, 3], [2]]);
  });
});
