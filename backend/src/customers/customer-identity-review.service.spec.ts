import { normalizeReviewInstagram, normalizeReviewPhone, reviewHash } from './customer-identity-review.service';

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
});
