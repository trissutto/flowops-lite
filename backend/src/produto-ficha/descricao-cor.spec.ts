import { citaCorAncorada, coresCitadas, semAcento } from './descricao-cor';

describe('descricao-cor — a régua "descrição por REF não cita cor" (06/09)', () => {
  it('normaliza acento (Café → cafe)', () => {
    expect(semAcento('Café')).toBe('cafe');
    expect(semAcento('MARROM Dourado')).toBe('marrom dourado');
  });

  describe('coresCitadas — dicionário sobre texto corrido', () => {
    it('caso real 900890: descrição escrita pra variante preta', () => {
      const texto =
        'Vestido Sem Manga Plus Size – Ref 900890 | Cor Preta. O vestido plus size ' +
        'preto é aquela peça curinga. Cor: Preto sofisticado e atemporal.';
      expect(coresCitadas(texto)).toContain('preto');
    });

    it('caso real 900919: meta-description citando estampa verde', () => {
      expect(coresCitadas('Vestido com manga curta em estampa verde')).toContain('verde');
    });

    it('acha a cor com acento e caixa diferentes', () => {
      expect(coresCitadas('Tom CARAMELO com detalhes em Café')).toEqual(['marrom']);
    });

    it('não acha cor dentro de outra palavra', () => {
      // "rosado" não é "rosa"; "empretecido" não é "preto".
      expect(coresCitadas('tecido arrosado empretecido')).toEqual([]);
    });

    it('texto neutro passa limpo', () => {
      expect(
        coresCitadas('Peça básica de uso versátil para compor looks diversos.'),
      ).toEqual([]);
    });
  });

  describe('citaCorAncorada — a construção que BLOQUEIA o save', () => {
    it('pega "Cor: Preto" e "| Cor Preta"', () => {
      expect(citaCorAncorada('Detalhes | Cor Preta')).toMatch(/cor preta/i);
      expect(citaCorAncorada('Cor: Preto sofisticado')).toMatch(/cor:?\s+preto/i);
    });

    it('NÃO pega "cor" seguida de não-cor (cores vivas, cor do verão)', () => {
      expect(citaCorAncorada('estampa em cores vivas')).toBeNull();
      expect(citaCorAncorada('a cor do verão é você quem escolhe')).toBeNull();
    });

    it('NÃO pega modelo chamado Vinho sem a âncora', () => {
      // Sem a palavra "cor" na frente, não bloqueia — a lição do nome-vitrine.
      expect(citaCorAncorada('o modelo Vinho veste do 44 ao 60')).toBeNull();
    });

    it('texto vazio/nulo devolve null', () => {
      expect(citaCorAncorada('')).toBeNull();
      expect(citaCorAncorada(null)).toBeNull();
    });
  });
});
