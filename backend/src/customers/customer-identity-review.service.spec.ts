import { classifyReviewCandidates, normalizeReviewInstagram, normalizeReviewPhone, reviewHash } from './customer-identity-review.service';

describe('customer identity review normalization', () => {
  it('normalizes Brazilian phone variants to the same value', () => {
    expect(normalizeReviewPhone('(13) 99999-1234')).toBe('13999991234');
    expect(normalizeReviewPhone('+55 13 99999-1234')).toBe('13999991234');
    expect(normalizeReviewPhone('123')).toBeNull();
  });

  it('normalizes Instagram without making it an automatic identity key', () => {
    expect(normalizeReviewInstagram(' @Lurds.Cliente ')).toBe('lurds.cliente');
    expect(normalizeReviewInstagram('@')).toBeNull();
  });

  it('creates deterministic, non-plain suggestion hashes', () => {
    expect(reviewHash('phone:13999991234')).toBe(reviewHash('phone:13999991234'));
    expect(reviewHash('phone:13999991234')).not.toContain('13999991234');
  });

  const candidate = (overrides: any = {}) => ({ name: 'Maria Silva', email: 'maria@example.com', cpf: null, personId: null, originSource: 'site', orderCount: 1, ...overrides });

  it('prioritizes explainable high-confidence groups without deciding them', () => {
    const result = classifyReviewCandidates([candidate(), candidate({ originSource: 'live' })]);
    expect(result.priority).toBe('high');
    expect(result.signals).toEqual(expect.arrayContaining(['Nomes iguais', 'E-mails iguais', 'Site + Live']));
  });

  it('marks distinct Persons and CPFs as conflicts', () => {
    expect(classifyReviewCandidates([candidate({ personId: 'p1' }), candidate({ personId: 'p2' })]).priority).toBe('conflict');
    expect(classifyReviewCandidates([candidate({ cpf: '11111111111' }), candidate({ cpf: '22222222222' })]).priority).toBe('conflict');
  });

  it('identifies a partial group without turning it into an automatic match', () => {
    const result = classifyReviewCandidates([candidate({ personId: 'p1' }), candidate()]);
    expect(result.partial).toBe(true);
    expect(result.signals).toContain('Vínculo parcial');
  });
});
