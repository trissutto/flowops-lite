/**
 * VALE-TROCA NOMINAL — a amarra do CPF no recálculo local (22/09/2026).
 *
 * O que estes testes protegem: o desconto do vale-troca NÃO pode sobreviver a
 * uma troca de CPF. O servidor sempre reconfere (POST /api/checkout), então o
 * dinheiro nunca esteve em risco — mas até aqui a TELA mantinha o desconto,
 * porque a regra ficava cacheada e `applyCoupon` recalculava sem olhar CPF.
 * A cliente via o abatimento até o último clique e só então levava o erro.
 *
 * Os dois cenários que o dono pediu por escrito estão nomeados abaixo.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCoupon, conheceCupom, cupomNominal, seedCouponRule, type CouponRule } from './cupom';

const CPF_A = '39053344705';
const CPF_B = '11144477735';

const VALE: CouponRule = {
  code: 'TROCA-0VXA8NJT',
  kind: 'fixed',
  value: 80,
  label: 'Vale de troca',
  nominal: true,
};

const CAMPANHA: CouponRule = {
  code: 'PRIMEIRA10',
  kind: 'percent',
  value: 10,
  label: 'Primeira compra 10%',
};

/**
 * `seedCouponRule` é deliberadamente no-op fora do navegador (o Map é de
 * módulo e no servidor seria compartilhado entre clientes). Os testes rodam em
 * node, então fingimos o navegador — é o ambiente que o código de verdade tem.
 */
beforeEach(() => {
  vi.stubGlobal('window', {} as unknown as Window & typeof globalThis);
});

describe('vale-troca nominal × CPF', () => {
  it('CENÁRIO DO DONO ✅ — cupom do CPF A + checkout no CPF A: aplica e PERMANECE aplicado', () => {
    seedCouponRule(VALE, CPF_A);

    const primeira = applyCoupon(VALE.code, 200, CPF_A);
    expect(primeira.ok).toBe(true);
    expect(primeira.discount).toBe(80);
    expect(primeira.nominal).toBe(true);

    // "Permanece aplicado" = sobrevive ao recálculo que acontece a cada
    // mudança de subtotal (ela tirou uma peça no resumo).
    const depoisDeMexerNaSacola = applyCoupon(VALE.code, 150, CPF_A);
    expect(depoisDeMexerNaSacola.ok).toBe(true);
    expect(depoisDeMexerNaSacola.discount).toBe(80);
  });

  it('CENÁRIO DO DONO 🚫 — cupom do CPF A + checkout no CPF B: NÃO aplica', () => {
    seedCouponRule(VALE, CPF_A);
    expect(applyCoupon(VALE.code, 200, CPF_A).ok).toBe(true); // aprovado antes

    const comOutroCpf = applyCoupon(VALE.code, 200, CPF_B);
    expect(comOutroCpf.ok).toBe(false);
    expect(comOutroCpf.discount).toBe(0);
    expect(comOutroCpf.reason).toBe('nominal_cpf_diferente');
    expect(comOutroCpf.message).toContain('vinculado a outro CPF');
  });

  it('a troca de CPF não deixa resíduo: voltar pro CPF certo volta a aplicar', () => {
    seedCouponRule(VALE, CPF_A);
    expect(applyCoupon(VALE.code, 200, CPF_B).ok).toBe(false);
    // Ela corrigiu o CPF — o desconto tem que voltar sozinho.
    expect(applyCoupon(VALE.code, 200, CPF_A).ok).toBe(true);
  });

  it('sem CPF na tela (sacola) o vale fica PENDENTE, não inválido', () => {
    seedCouponRule(VALE, CPF_A);

    const naSacola = applyCoupon(VALE.code, 200);
    expect(naSacola.ok).toBe(false);
    expect(naSacola.discount).toBe(0);
    // `reason` é o que faz sacola e checkout GUARDAREM o código em vez de
    // descartá-lo — é o que evita a cliente digitar duas vezes.
    expect(naSacola.reason).toBe('nominal_sem_cpf');
    expect(naSacola.message).toContain('nominal');
  });

  it('CPF com máscara é o mesmo CPF (a tela manda 390.533.447-05)', () => {
    seedCouponRule(VALE, '390.533.447-05');
    expect(applyCoupon(VALE.code, 200, CPF_A).ok).toBe(true);
    expect(applyCoupon(VALE.code, 200, '390.533.447-05').ok).toBe(true);
  });

  it('regra nominal semeada SEM CPF nunca aplica sozinha', () => {
    // Não deveria acontecer (o backend só devolve `regra` no sucesso, e o
    // sucesso de um nominal exige CPF), mas se acontecer o desconto NÃO sai.
    seedCouponRule(VALE);
    expect(applyCoupon(VALE.code, 200, CPF_A).ok).toBe(false);
    expect(applyCoupon(VALE.code, 200).ok).toBe(false);
  });
});

describe('cupom promocional comum — nada muda', () => {
  it('aplica sem CPF nenhum', () => {
    seedCouponRule(CAMPANHA);
    const r = applyCoupon(CAMPANHA.code, 200);
    expect(r.ok).toBe(true);
    expect(r.discount).toBe(20);
    expect(r.nominal).toBeUndefined();
  });

  it('continua aplicado quando o CPF muda (não é nominal)', () => {
    seedCouponRule(CAMPANHA);
    expect(applyCoupon(CAMPANHA.code, 200, CPF_A).ok).toBe(true);
    expect(applyCoupon(CAMPANHA.code, 200, CPF_B).ok).toBe(true);
  });

  it('as regras de sempre seguem valendo (mínimo e validade)', () => {
    seedCouponRule({ ...CAMPANHA, code: 'MIN300', minSubtotal: 300 });
    expect(applyCoupon('MIN300', 200).ok).toBe(false);

    seedCouponRule({ ...CAMPANHA, code: 'VENCIDO', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(applyCoupon('VENCIDO', 200).ok).toBe(false);
  });
});

describe('helpers de tela', () => {
  it('cupomNominal separa vale de campanha', () => {
    seedCouponRule(VALE, CPF_A);
    seedCouponRule(CAMPANHA);
    expect(cupomNominal(VALE.code)).toBe(true);
    expect(cupomNominal(CAMPANHA.code)).toBe(false);
    expect(cupomNominal('NAO-EXISTE')).toBe(false);
  });

  it('conheceCupom responde pelo código semeado, em qualquer caixa', () => {
    seedCouponRule(VALE, CPF_A);
    expect(conheceCupom('troca-0vxa8njt')).toBe(true);
    expect(conheceCupom('  TROCA-0VXA8NJT  ')).toBe(true);
    expect(conheceCupom('OUTRO')).toBe(false);
  });

  it('código desconhecido não inventa desconto', () => {
    const r = applyCoupon('NAO-EXISTE', 200, CPF_A);
    expect(r.ok).toBe(false);
    expect(r.discount).toBe(0);
  });
});
