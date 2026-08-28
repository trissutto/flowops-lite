import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminOnlyGuard, ADMIN_ONLY_KEY, PERMITE_LOJA_KEY } from './admin-only.guard';

/**
 * O que estes testes seguram:
 *
 * O `@PermiteLoja` nasceu em 26/08/2026 pra abrir a fila de carrinho pra loja
 * de Santos. É um relaxamento de PERMISSÃO — errar pra um lado tranca a
 * vendedora fora, errar pro outro abre endpoint de matriz pra rede inteira.
 * Por isso o caso mais importante aqui é o último: **sem o decorator, nada muda**.
 */
describe('AdminOnlyGuard', () => {
  const ENV = 'CARRINHO_LOJAS_TESTE';

  /** Contexto falso: `meta` é o @AdminOnly da classe, `envVar` o @PermiteLoja. */
  function contexto(user: any, meta: any, envVar?: string): ExecutionContext {
    return {
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      __meta: meta,
      __envVar: envVar,
    } as any;
  }

  function guardPara(meta: any, envVar?: string) {
    const reflector = {
      get: (key: string, alvo: any) => {
        // metadata vive na CLASSE nos dois casos (é assim no controller real)
        if (alvo !== 'class') return undefined;
        if (key === ADMIN_ONLY_KEY) return meta;
        if (key === PERMITE_LOJA_KEY) return envVar;
        return undefined;
      },
    } as unknown as Reflector;
    return new AdminOnlyGuard(reflector);
  }

  afterEach(() => {
    delete process.env[ENV];
  });

  const LOJA = { role: 'store', storeCode: '02' };
  const MATRIZ = { role: 'admin' };

  it('matriz continua entrando', () => {
    const g = guardPara({ strict: false }, ENV);
    expect(g.canActivate(contexto(MATRIZ, { strict: false }, ENV))).toBe(true);
  });

  it('loja SEM a env continua barrada', () => {
    const g = guardPara({ strict: false }, ENV);
    expect(() => g.canActivate(contexto(LOJA, { strict: false }, ENV))).toThrow(ForbiddenException);
  });

  it('loja NA lista da env entra', () => {
    process.env[ENV] = '02';
    const g = guardPara({ strict: false }, ENV);
    expect(g.canActivate(contexto(LOJA, { strict: false }, ENV))).toBe(true);
  });

  it('loja FORA da lista da env continua barrada', () => {
    process.env[ENV] = '06,07';
    const g = guardPara({ strict: false }, ENV);
    expect(() => g.canActivate(contexto(LOJA, { strict: false }, ENV))).toThrow(ForbiddenException);
  });

  it('env sem zero à esquerda ("2") casa com storeCode "02"', () => {
    process.env[ENV] = '2';
    const g = guardPara({ strict: false }, ENV);
    expect(g.canActivate(contexto(LOJA, { strict: false }, ENV))).toBe(true);
  });

  it('strict (só admin) NÃO é afetado pelo PermiteLoja', () => {
    process.env[ENV] = '02';
    const g = guardPara({ strict: true }, ENV);
    expect(() => g.canActivate(contexto(LOJA, { strict: true }, ENV))).toThrow(ForbiddenException);
  });

  it('🔒 SEM o decorator @PermiteLoja, loja segue barrada mesmo com a env cheia', () => {
    process.env[ENV] = '02';
    const g = guardPara({ strict: false }, undefined);
    expect(() => g.canActivate(contexto(LOJA, { strict: false }, undefined))).toThrow(
      ForbiddenException,
    );
  });
});

/**
 * `*` — A REDE INTEIRA (28/08/2026).
 *
 * A régua nasceu loja a loja e isso valeu pro piloto. Quando a ordem virou
 * "libera o carrinho em todos os PDVs", lista fixa passou a ser armadilha:
 * loja nova abre e a vendedora leva 403 sem ninguém entender por quê.
 */
describe('AdminOnlyGuard · curinga', () => {
  const ENV = 'CARRINHO_LOJAS_TESTE';

  function contexto(user: any, meta: any, envVar?: string): ExecutionContext {
    return {
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as any;
  }

  function guardPara(meta: any, envVar?: string) {
    const reflector = {
      get: (key: string, alvo: any) => {
        if (alvo !== 'class') return undefined;
        if (key === ADMIN_ONLY_KEY) return meta;
        if (key === PERMITE_LOJA_KEY) return envVar;
        return undefined;
      },
    } as unknown as Reflector;
    return new AdminOnlyGuard(reflector);
  }

  afterEach(() => {
    delete process.env[ENV];
  });

  it('`*` libera QUALQUER loja, inclusive uma que ninguém listou', () => {
    process.env[ENV] = '*';
    const g = guardPara({ strict: false }, ENV);
    expect(g.canActivate(contexto({ role: 'store', storeCode: '19' }, { strict: false }, ENV))).toBe(true);
    expect(g.canActivate(contexto({ role: 'store', storeCode: '99' }, { strict: false }, ENV))).toBe(true);
  });

  it('`*` NÃO libera autenticado sem loja — curinga abre pra PDV, não pra qualquer token', () => {
    process.env[ENV] = '*';
    const g = guardPara({ strict: false }, ENV);
    expect(() => g.canActivate(contexto({ role: 'store' }, { strict: false }, ENV))).toThrow();
  });

  it('`*` no meio da lista também vale', () => {
    process.env[ENV] = '02, *';
    const g = guardPara({ strict: false }, ENV);
    expect(g.canActivate(contexto({ role: 'store', storeCode: '07' }, { strict: false }, ENV))).toBe(true);
  });

  it('strict continua imune ao curinga — `*` não fura senha master', () => {
    process.env[ENV] = '*';
    const g = guardPara({ strict: true }, ENV);
    expect(() => g.canActivate(contexto({ role: 'store', storeCode: '02' }, { strict: true }, ENV))).toThrow();
  });
});
