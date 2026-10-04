import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

/**
 * O que estes testes seguram:
 *
 * Em 04/10/2026 a auditoria achou que o token da CONTA DE CLIENTE do site
 * (assinado com o mesmo JWT_SECRET, `scope: 'customer'`, sem `role`) passava
 * no `JwtAuthGuard` da retaguarda. Cadastro no site é público — então qualquer
 * pessoa entrava em mais de mil rotas de operador.
 *
 * O caso que importa é o primeiro. Os outros garantem que o conserto não
 * derruba quem tem que entrar: admin, loja, totem e loja assumida pelo admin.
 */
describe('JwtStrategy.validate', () => {
  function estrategia() {
    const config = { get: () => 'segredo-de-teste' } as any;
    const prisma = { store: { findUnique: jest.fn().mockResolvedValue(null) } } as any;
    return new JwtStrategy(config, prisma);
  }

  it('recusa token de cliente do site (scope customer, sem role)', async () => {
    const payload = { sub: 'conta-1', cpf: '00000000000', name: 'Cliente', scope: 'customer' };
    await expect(estrategia().validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('recusa escopo de cliente mesmo que alguém acrescente um role', async () => {
    const payload = { sub: 'conta-1', scope: 'customer', role: 'admin' };
    await expect(estrategia().validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('recusa token sem role nenhum', async () => {
    await expect(estrategia().validate({ sub: 'x', email: 'a@b.c' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['admin', { sub: 'u1', email: 'a@b.c', name: 'Dono', role: 'admin', storeId: null }],
    ['operator', { sub: 'u2', email: 'o@b.c', name: 'Op', role: 'operator', storeId: null }],
    ['loja', { sub: 'u3', email: 'l@b.c', name: 'Loja', role: 'store', storeId: 's1', storeCode: '01', storeName: 'Santos' }],
    ['totem', { sub: 'u3', role: 'store', storeId: 's1', storeCode: '01', storeName: 'Santos', kiosk: true }],
    ['loja assumida', { sub: 'u1', role: 'store', storeId: 's1', storeCode: '01', storeName: 'Santos', impersonatedBy: 'u1' }],
  ])('aceita token de %s e devolve o papel', async (_nome, payload) => {
    const user = await estrategia().validate(payload);
    expect(user.role).toBe(payload.role);
    expect(user.userId).toBe(payload.sub);
  });
});
