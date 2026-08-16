/**
 * A SESSÃO É DA PESSOA, NÃO DA ABA.
 *
 * Até 16/08/2026 o `session_id` morava no `sessionStorage`, que é por aba. A
 * cliente que abria quatro peças em quatro abas virava quatro "pessoas" no
 * relatório: quatro que viram produto, uma que pôs na sacola. O funil da
 * retaguarda lia isso como abandono em massa na página de produto.
 *
 * O teste observa pelo storage porque é ele que define o escopo — é o ponto
 * exato onde a regressão volta se alguém trocar 'local' por 'session'.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSessionId } from './identity';

const SESSION_KEY = 'lurds_session';
const TIMEOUT_MS = 30 * 60 * 1000;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
});

describe('getSessionId', () => {
  it('grava no localStorage, não no sessionStorage — senão a sessão é por aba', () => {
    const id = getSessionId();

    expect(localStorage.getItem(SESSION_KEY)).toContain(id);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('devolve o mesmo id em chamadas seguidas', () => {
    expect(getSessionId()).toBe(getSessionId());
  });

  it('outra aba enxerga a MESMA sessão (é o bug que motivou a mudança)', () => {
    const primeiraAba = getSessionId();

    // Aba nova = mesmo localStorage, sessionStorage próprio e vazio.
    sessionStorage.clear();

    expect(getSessionId()).toBe(primeiraAba);
  });

  it('encerra a visita depois de 30 min sem evento nenhum', () => {
    const antigo = getSessionId();

    const gravado = JSON.parse(localStorage.getItem(SESSION_KEY) as string);
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...gravado, last_seen: Date.now() - TIMEOUT_MS - 1 }),
    );

    expect(getSessionId()).not.toBe(antigo);
  });

  it('renova o last_seen a cada chamada, então navegar não estoura a janela', () => {
    getSessionId();
    const gravado = JSON.parse(localStorage.getItem(SESSION_KEY) as string);
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...gravado, last_seen: Date.now() - TIMEOUT_MS + 60_000 }),
    );

    const id = getSessionId();
    const depois = JSON.parse(localStorage.getItem(SESSION_KEY) as string);

    expect(depois.id).toBe(id);
    expect(depois.last_seen).toBeGreaterThan(gravado.last_seen - 1);
  });

  it('adota a sessão que estava em curso no deploy, em vez de partir a visita', () => {
    const emCurso = { id: 'sessao-antiga', started_at: Date.now(), last_seen: Date.now() };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(emCurso));

    expect(getSessionId()).toBe('sessao-antiga');
    expect(localStorage.getItem(SESSION_KEY)).toContain('sessao-antiga');
    // Absorvido: deixar os dois vivos é convite pra divergir.
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('ignora sessão antiga já vencida e abre uma nova', () => {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ id: 'vencida', started_at: 0, last_seen: Date.now() - TIMEOUT_MS - 1 }),
    );

    expect(getSessionId()).not.toBe('vencida');
  });

  it('não quebra com registro corrompido', () => {
    localStorage.setItem(SESSION_KEY, '{ isto não é json');

    expect(getSessionId()).toMatch(/.+/);
  });
});
