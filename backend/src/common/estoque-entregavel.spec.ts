import { sqlEstoqueEntregavelPorCodigo, estoqueEntregavelLigado } from './estoque-entregavel';

/**
 * A régua do saldo que o site promete. O que se testa aqui é o TEXTO do SQL —
 * a execução contra o Postgres foi conferida à mão antes do PR (o CI não tem
 * banco), comparando ANTES e DEPOIS na mesma rodada.
 *
 * O motivo de cada teste está no incidente de 12/09: o site vendeu uma peça
 * marcada como extraviada e o card nasceu em ruptura.
 */
describe('estoque entregável — a mesma conta do roteamento', () => {
  const envOriginal = process.env.SITE_ESTOQUE_ENTREGAVEL;
  afterEach(() => {
    if (envOriginal === undefined) delete process.env.SITE_ESTOQUE_ENTREGAVEL;
    else process.env.SITE_ESTOQUE_ENTREGAVEL = envOriginal;
  });

  it('nasce LIGADO — default-off aqui seria vender peça que ninguém entrega', () => {
    delete process.env.SITE_ESTOQUE_ENTREGAVEL;
    expect(estoqueEntregavelLigado()).toBe(true);
  });

  it('tira a loja INATIVA — e o DISTINCT impede que o anti-join duplique a linha do espelho', () => {
    delete process.env.SITE_ESTOQUE_ENTREGAVEL;
    const sql = sqlEstoqueEntregavelPorCodigo();
    expect(sql).toContain('active = false');
    expect(sql).toContain('SELECT DISTINCT');
    expect(sql).toContain('inativa.loja IS NULL');
    // NOT IN com um code nulo viraria NULL e apagaria a rede inteira
    expect(sql).not.toContain('NOT IN (SELECT');
  });

  it('desconta a peça EXTRAVIADA ABERTA, por loja+SKU', () => {
    delete process.env.SITE_ESTOQUE_ENTREGAVEL;
    const sql = sqlEstoqueEntregavelPorCodigo();
    expect(sql).toContain('pecas_extraviadas');
    expect(sql).toContain('achada_em IS NULL');
    // a achada volta pro jogo sozinha: nada de filtro de data ou de status
    expect(sql).toMatch(/x\.loja\s*=/);
    expect(sql).toMatch(/x\.sku\s*=/);
  });

  it('o desconto NUNCA vira crédito — o espelho tem 150 linhas negativas', () => {
    delete process.env.SITE_ESTOQUE_ENTREGAVEL;
    const sql = sqlEstoqueEntregavelPorCodigo();
    // LEAST(qtd, GREATEST(estoque,0)): loja sem peça desconta zero, e o saldo
    // negativo continua pesando igual. Com o piso por linha da 1ª versão
    // (GREATEST(estoque − qtd, 0)), 143 SKUs GANHAVAM saldo em produção.
    expect(sql).toContain('LEAST(COALESCE(x.qtd, 0), GREATEST(z.estoque, 0))');
    expect(sql).not.toContain('GREATEST(COALESCE(e.estoque, 0) - COALESCE(x.qtd, 0), 0)');
  });

  it('continua sem a loja-canal (a régua de 24/08 não se perdeu no caminho)', () => {
    delete process.env.SITE_ESTOQUE_ENTREGAVEL;
    expect(sqlEstoqueEntregavelPorCodigo()).toContain("'13'");
    process.env.SITE_ESTOQUE_ENTREGAVEL = '0';
    expect(sqlEstoqueEntregavelPorCodigo()).toContain("'13'");
  });

  it('SITE_ESTOQUE_ENTREGAVEL=0 volta ao saldo bruto', () => {
    process.env.SITE_ESTOQUE_ENTREGAVEL = '0';
    const sql = sqlEstoqueEntregavelPorCodigo();
    expect(estoqueEntregavelLigado()).toBe(false);
    expect(sql).not.toContain('pecas_extraviadas');
    expect(sql).not.toContain('stores');
  });

  it('o contrato de colunas é o mesmo nos dois modos — quem soma não muda', () => {
    for (const modo of ['1', '0']) {
      process.env.SITE_ESTOQUE_ENTREGAVEL = modo;
      const sql = sqlEstoqueEntregavelPorCodigo();
      expect(sql).toMatch(/AS total/);
      expect(sql).toMatch(/codigo/);
    }
  });

  it('NÃO carrega placeholder — ele renumeraria os $N de quem interpola', () => {
    for (const modo of ['1', '0']) {
      process.env.SITE_ESTOQUE_ENTREGAVEL = modo;
      expect(sqlEstoqueEntregavelPorCodigo()).not.toMatch(/\$\d/);
    }
  });
});
