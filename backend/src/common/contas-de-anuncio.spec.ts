import {
  contasEcommerce,
  contasDeLoja,
  contasEcommerceGoogle,
  contasDeLojaGoogle,
  contasDeLojaTodas,
} from './contas-de-anuncio';

/**
 * A régua que decide de QUEM é o gasto. Errar aqui não dá erro em lugar
 * nenhum: o número simplesmente aparece na tela errada, e ninguém confere.
 */
describe('contas de anúncio', () => {
  describe('leitura da env', () => {
    it('tolera espaço, prefixo act_ e vírgula sobrando', () => {
      expect(contasEcommerce(' act_613189030710755 , 123 ,')).toEqual(['613189030710755', '123']);
    });

    it('env ausente devolve lista vazia — ausência desliga, não quebra', () => {
      expect(contasDeLoja(undefined)).toEqual([]);
      expect(contasDeLojaGoogle(undefined)).toEqual([]);
      expect(contasEcommerceGoogle('')).toEqual([]);
    });
  });

  describe('Google entrou na régua (02/09/2026)', () => {
    it('lê as contas de e-commerce e as de loja separadamente', () => {
      expect(contasEcommerceGoogle('8925231246')).toEqual(['8925231246']);
      expect(contasDeLojaGoogle('9564998046')).toEqual(['9564998046']);
    });
  });

  describe('contasDeLojaTodas — é esta que o SQL usa', () => {
    it('junta as lojas das DUAS redes', () => {
      expect(
        contasDeLojaTodas({
          META_ADS_CONTAS_LOJA: '157208321008735',
          GOOGLE_ADS_CONTAS_LOJA: '9564998046',
        } as any),
      ).toEqual(['157208321008735', '9564998046']);
    });

    /**
     * O caso que motivou a mudança: a conta Google de loja gastou R$ 26.648 em
     * 30 dias. Se só o Meta fosse excluído, esse dinheiro cairia no
     * denominador do ROAS do site — junto com R$ 184.865 de "valor de
     * conversão" que é visita de loja estimada, não receita.
     */
    it('a conta Google de loja NÃO escapa quando só o Meta está configurado', () => {
      const todas = contasDeLojaTodas({
        META_ADS_CONTAS_LOJA: '157208321008735',
        GOOGLE_ADS_CONTAS_LOJA: '9564998046',
      } as any);
      expect(todas).toContain('9564998046');
    });

    it('sem nenhuma env, lista vazia — `<> ALL (\'{}\')` não exclui ninguém', () => {
      expect(contasDeLojaTodas({} as any)).toEqual([]);
    });

    it('só uma rede configurada devolve só aquela', () => {
      expect(contasDeLojaTodas({ GOOGLE_ADS_CONTAS_LOJA: '9564998046' } as any)).toEqual([
        '9564998046',
      ]);
    });
  });
});
