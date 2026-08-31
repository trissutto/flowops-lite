import { describe, expect, it } from 'vitest';
import { heuristicInterpreter } from '@/lib/search';
import { tentativasDeBusca } from './search';

/**
 * A ESCADA DE TENTATIVAS DA BUSCA DE PRODUTO.
 *
 * O que estes testes protegem é o achado de 31/08/2026: **um terço das buscas
 * do site voltava vazia** (25 de 75 medidas no primeiro dia de coleta), e a
 * causa era um filtro destrutivo mandado ao SERVIDOR — não o ranking daqui.
 *
 * A regra de ouro que não pode voltar a quebrar: nenhuma tentativa manda
 * `modelagem`, e a primeira nunca sai sem texto quando o intérprete consumiu
 * todas as palavras em faceta.
 */
const q = (p: URLSearchParams) => Object.fromEntries(p.entries());

describe('tentativasDeBusca', () => {
  const tentar = (termo: string) =>
    tentativasDeBusca(termo, heuristicInterpreter.interpret(termo), '48');

  it('NUNCA manda modelagem pro servidor', () => {
    // 543 das 739 peças no ar estão sem modelagem: no servidor a faceta vira um
    // E lógico contra campo vazio. Medido em produção:
    // categoria=vestidos&modelagem=longo devolve 0; categoria=vestidos, 153.
    for (const termo of ['vestido longo', 'calça pantalona', 'blusa ampla', 'vestido justo']) {
      for (const t of tentar(termo)) expect(q(t)).not.toHaveProperty('modelagem');
    }
  });

  it('"vestido longo" leva o termo INTEIRO como texto', () => {
    // O intérprete consome as duas palavras em faceta e deixa o residual vazio.
    // Sem isto a primeira tentativa iria sem `busca` nenhuma, pescando 60
    // vestidos quaisquer — e "Vestido Longo" podia nem estar entre eles.
    // Medido: busca=vestido longo devolve 27, com "Vestido Longo" nos 3
    // primeiros.
    const [primeira] = tentar('vestido longo');
    expect(primeira.get('busca')).toBe('vestido longo');
    expect(primeira.get('categoria')).toBe('vestidos');
  });

  it('o texto segue a regra: residual quando existe, termo inteiro quando não', () => {
    // Contrato, não string decorada. O que não pode acontecer é a primeira
    // tentativa sair SEM texto porque o intérprete consumiu tudo.
    for (const termo of ['vestido longo', 'vestido para casamento', 'blusa listrada', 'regatas']) {
      const residual = heuristicInterpreter.interpret(termo).residual.trim();
      const esperado = residual.length >= 2 ? residual : termo;
      expect(tentar(termo)[0].get('busca')).toBe(esperado);
    }
  });

  it('quando a primeira tentativa não acha, a escada tem pra onde cair', () => {
    // Medido em produção: com o termo inteiro a busca por ocasião devolve 0, e
    // só com a categoria devolve 153. A segunda tentativa é o que transforma
    // esse zero em resultado.
    const t = tentar('vestido para casamento');
    expect(t.length).toBeGreaterThanOrEqual(2);
    expect(t[1].get('busca')).toBeNull();
    expect(t[1].get('categoria')).toBe('vestidos');
  });

  it('a escada termina no catálogo cru', () => {
    // É a última tentativa que devolve ao motor o direito de relaxar: sem
    // documento nenhum, a promessa "zero results nunca" do rankSearch não vale.
    for (const termo of ['vestido longo', 'casaqueto', 'regatas']) {
      const t = tentar(termo);
      const ultima = q(t[t.length - 1]);
      expect(ultima).not.toHaveProperty('busca');
      expect(ultima).not.toHaveProperty('categoria');
      expect(ultima.perPage).toBe('48');
    }
  });

  it('termo desconhecido tenta o texto antes de abrir o catálogo', () => {
    // "casaqueto" não é faceta nem casa no texto do servidor; quem acha é o
    // índice daqui, por bigrama, contra "casaco".
    const t = tentar('casaqueto');
    expect(t[0].get('busca')).toBe('casaqueto');
    expect(t.length).toBeGreaterThanOrEqual(2);
  });

  it('toda tentativa carrega o perPage pedido', () => {
    for (const t of tentar('regatas')) expect(t.get('perPage')).toBe('48');
  });
});
