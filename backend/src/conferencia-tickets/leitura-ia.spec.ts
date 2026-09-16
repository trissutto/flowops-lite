import { cruzar } from './cruzamento';
import { normalizarLeitura, SCHEMA_LEITURA, textoDaFoto } from './leitura-ia';
import { diaCurto, frasesDoResultado } from './resumo-texto';

/**
 * A resposta da IA vira coluna de banco sem confiar em nada, e o resultado
 * vira a MESMA frase na tela e no WhatsApp.
 */
describe('leitura da IA — normalização', () => {
  it('converte datas, horas e valores pro formato das colunas', () => {
    const r = normalizarLeitura({
      foto_legivel: true,
      observacao: null,
      tickets: [
        {
          origem: 'maquininha',
          operacao: 'credito',
          valor: 149.899,
          data: '15/09/26',
          hora: '9:07',
          nsu: ' 000123 ',
          autorizacao: 'A1B2C3',
          bandeira: 'MASTERCARD',
          final_cartao: '**** 4321',
          parcelas: 3,
          adquirente: 'Stone',
          numero: null,
          formas: [],
          cliente: null,
          legivel: true,
          confianca: 'alta',
          observacao: null,
        },
      ],
    });
    expect(r.tickets[0]).toMatchObject({
      valor: 149.9,
      data: '2026-09-15',
      hora: '09:07',
      nsu: '000123',
      finalCartao: '4321',
      parcelas: 3,
      legivel: true,
    });
  });

  it('valor ausente derruba o "legível", enum desconhecido vira o neutro', () => {
    const r = normalizarLeitura({
      foto_legivel: false,
      observacao: 'reflexo',
      tickets: [{ origem: 'nota_fiscal', operacao: 'boleto', valor: null, legivel: true, confianca: 'sei-la', formas: ['PIX', '', null] }],
    });
    expect(r.fotoLegivel).toBe(false);
    expect(r.tickets[0]).toMatchObject({
      origem: 'outro',
      operacao: 'desconhecida',
      legivel: false,
      confianca: 'media',
      formas: ['PIX'],
      data: null,
      hora: null,
    });
  });

  it('valor em texto brasileiro também entra', () => {
    const r = normalizarLeitura({ tickets: [{ origem: 'cupom_venda', operacao: 'dinheiro', valor: 'R$ 1.234,50' }] });
    expect(r.tickets[0].valor).toBe(1234.5);
  });

  it('hora impossível e parcelas absurdas viram nulo', () => {
    const r = normalizarLeitura({ tickets: [{ origem: 'maquininha', operacao: 'credito', valor: 10, hora: '25:61', parcelas: 999 }] });
    expect(r.tickets[0].hora).toBeNull();
    expect(r.tickets[0].parcelas).toBeNull();
  });

  it('o schema exige todos os campos e fecha os objetos', () => {
    const item = (SCHEMA_LEITURA.properties.tickets as any).items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(Object.keys(item.properties));
    expect(SCHEMA_LEITURA.additionalProperties).toBe(false);
  });

  it('a mensagem da foto leva loja e dia, o prompt não', () => {
    expect(textoDaFoto({ storeCode: '05', storeName: 'Piracicaba', dia: '2026-09-15' })).toContain('05 (Piracicaba)');
    expect(textoDaFoto({ storeCode: '05', dia: '2026-09-15' })).toContain('15/09/2026');
  });
});

describe('resumo — frases do checklist', () => {
  it('conta as pendências no idioma da loja', () => {
    const r = cruzar(
      [
        { chave: 'a', tipo: 'cartao', obrigatorio: true, valor: 100, minuto: 600, titulo: 'a' },
        { chave: 'b', tipo: 'cartao', obrigatorio: true, valor: 89.8, minuto: 700, titulo: 'b' },
        { chave: 'c', tipo: 'pix', obrigatorio: true, valor: 50, minuto: 800, pixExterno: true, titulo: 'c' },
      ],
      [],
      '2026-09-15',
    );
    expect(frasesDoResultado(r)).toEqual(['2 vendas no cartão sem ticket (R$ 189,80)', '1 PIX sem comprovante (R$ 50,00)']);
  });

  it('sem pendência não fala nada', () => {
    expect(frasesDoResultado(cruzar([], [], '2026-09-15'))).toEqual([]);
    expect(frasesDoResultado(null)).toEqual([]);
  });

  it('dia curto com o dia da semana', () => {
    expect(diaCurto('2026-09-15')).toBe('ter 15/09');
    expect(diaCurto('2026-09-13')).toBe('dom 13/09');
  });
});
