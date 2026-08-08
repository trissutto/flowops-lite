import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  PdvStoreSummaryController,
  resolvePdvSummaryStoreCode,
} from './store-summary.controller';

describe('PdvStoreSummaryController', () => {
  it('força a loja do usuário de loja', async () => {
    const summary = { getSummary: jest.fn().mockResolvedValue({ storeCode: '01' }) };
    const controller = new PdvStoreSummaryController(summary as any);

    await controller.getStoreSummary({ user: { role: 'store', storeCode: '1' } }, '01');
    expect(summary.getSummary).toHaveBeenCalledWith('01');
  });

  it('bloqueia usuário de loja tentando consultar outra loja', () => {
    expect(() => resolvePdvSummaryStoreCode(
      { role: 'store', storeCode: '01' },
      '02',
    )).toThrow(ForbiddenException);
  });

  it('permite admin informar a loja e exige o parâmetro', () => {
    expect(resolvePdvSummaryStoreCode({ role: 'admin' }, 'LJ7')).toBe('07');
    expect(() => resolvePdvSummaryStoreCode({ role: 'admin' })).toThrow(BadRequestException);
  });

  it('bloqueia papéis sem acesso ao PDV', () => {
    expect(() => resolvePdvSummaryStoreCode(
      { role: 'franquias', storeCode: '01' },
      '01',
    )).toThrow(ForbiddenException);
  });
});
