/**
 * A TRAVA DO PEDIDO QUE RESSUSCITOU (25/08/2026).
 *
 * O dono trocou a vendedora de um pedido antigo e ele **voltou pra "Em
 * trânsito"**. Causa: a janela de 30 dias media por `Order.updatedAt`, que é
 * `@updatedAt` — qualquer escrita na linha o joga pra agora.
 *
 * Estes testes prendem a régua nova: quem manda é o carimbo do DESPACHO, e o
 * `updatedAt` só entra quando não há carimbo nenhum.
 */
import {
  RASTREIO_JANELA_DIAS,
  inicioDaJanela,
  despachadoEm,
  despachadoDentroDaJanela,
  despachadoForaDaJanela,
} from './janela-rastreio';

const DIA = 86_400_000;
const agora = new Date();
const velho = new Date(Date.now() - 40 * DIA);

describe('despachadoEm — quem manda é o carimbo do despacho', () => {
  it('IGNORA o updatedAt de agora quando o pedido tem shippedAt antigo', () => {
    // ESTE é o caso do dono: atribuir vendedora carimba `updatedAt` com agora
    // num pedido despachado há 40 dias. A resposta tem que ser 40 dias atrás.
    expect(despachadoEm({ shippedAt: velho, updatedAt: agora })).toEqual(velho);
  });

  it('cai no updatedAt só quando NÃO existe carimbo (linha antiga)', () => {
    // Sem plano B o pedido sumiria das duas abas — invisível é pior que na
    // aba errada.
    expect(despachadoEm({ shippedAt: null, updatedAt: velho })).toEqual(velho);
  });

  it('aceita data em string (o que vem do JSON do Prisma raw)', () => {
    expect(despachadoEm({ shippedAt: velho.toISOString() })?.getTime()).toBe(velho.getTime());
  });

  it('sem data nenhuma devolve null, não uma data inventada', () => {
    expect(despachadoEm({ shippedAt: null, updatedAt: null })).toBeNull();
    expect(despachadoEm({ shippedAt: 'não é data' })).toBeNull();
  });
});

describe('os `where` são complementos exatos — nenhum pedido invisível', () => {
  const desde = inicioDaJanela();

  /** Roda o `where` (só os ramos que este arquivo gera) contra uma linha. */
  function casa(where: Record<string, any>, linha: { shippedAt: Date | null; updatedAt: Date }) {
    return (where.OR as any[]).some((ramo) => {
      if (ramo.shippedAt) {
        if (!linha.shippedAt) return false;
        return ramo.shippedAt.gte
          ? linha.shippedAt >= ramo.shippedAt.gte
          : linha.shippedAt < ramo.shippedAt.lt;
      }
      // ramo do plano B: shippedAt null E updatedAt na faixa
      const [{ shippedAt }, { updatedAt }] = ramo.AND;
      if (shippedAt !== null || linha.shippedAt !== null) return false;
      return updatedAt.gte ? linha.updatedAt >= updatedAt.gte : linha.updatedAt < updatedAt.lt;
    });
  }

  const linhas: Array<[string, { shippedAt: Date | null; updatedAt: Date }]> = [
    ['despachado hoje', { shippedAt: agora, updatedAt: agora }],
    ['despachado há 40 dias', { shippedAt: velho, updatedAt: velho }],
    ['despachado há 40 dias e EDITADO agora', { shippedAt: velho, updatedAt: agora }],
    ['sem carimbo, tocado hoje', { shippedAt: null, updatedAt: agora }],
    ['sem carimbo, parado há 40 dias', { shippedAt: null, updatedAt: velho }],
  ];

  it.each(linhas)('%s cai em UMA das duas, nunca nas duas nem em nenhuma', (_nome, linha) => {
    const dentro = casa(despachadoDentroDaJanela(desde), linha);
    const fora = casa(despachadoForaDaJanela(desde), linha);
    expect(dentro).not.toBe(fora);
  });

  it('pedido velho EDITADO hoje fica FORA da janela', () => {
    const linha = { shippedAt: velho, updatedAt: agora };
    expect(casa(despachadoDentroDaJanela(desde), linha)).toBe(false);
    expect(casa(despachadoForaDaJanela(desde), linha)).toBe(true);
  });

  it('a janela abre 30 dias atrás', () => {
    expect(RASTREIO_JANELA_DIAS).toBe(30);
    const delta = Date.now() - inicioDaJanela().getTime();
    expect(Math.round(delta / DIA)).toBe(30);
  });
});
