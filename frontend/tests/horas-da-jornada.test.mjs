/**
 * HORAS DA JORNADA — o pré-preenchimento da caixa "Ajustar" num dia sem
 * batida (dono, 14/11/2026). O que este teste prende: dia com intervalo vira
 * quatro horas, dia sem intervalo vira duas, e almoço de duração zero ou fora
 * do turno NÃO vira duas batidas no mesmo minuto.
 *
 *   npm run test:horas-da-jornada
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  horasDaJornada,
  podePreencherPelaJornada,
  resumoDaJornada,
} from '../src/lib/horas-da-jornada.ts';

const SEMANA = { inicio: '09:00', fim: '18:00', almocoInicio: '12:00', almocoFim: '13:00' };
const SABADO = { inicio: '09:00', fim: '13:00', almocoInicio: null, almocoFim: null };

test('dia com intervalo preenche as quatro horas', () => {
  assert.deepEqual(horasDaJornada(SEMANA, false), {
    entrada: '09:00',
    saida_almoco: '12:00',
    volta_almoco: '13:00',
    saida: '18:00',
  });
  assert.equal(resumoDaJornada(SEMANA, false), '09:00–18:00 · almoço 12:00–13:00');
});

test('sábado sem intervalo preenche só entrada e saída', () => {
  assert.deepEqual(horasDaJornada(SABADO, true), {
    entrada: '09:00',
    saida_almoco: '',
    volta_almoco: '',
    saida: '13:00',
  });
  assert.equal(resumoDaJornada(SABADO, true), '09:00–13:00 · sem intervalo');
});

test('o backend manda na dúvida: semIntervalo=true esvazia o almoço mesmo cadastrado', () => {
  const horas = horasDaJornada(SEMANA, true);
  assert.equal(horas.saida_almoco, '');
  assert.equal(horas.volta_almoco, '');
});

test('API velha (sem o campo): almoço de duração zero não vira duas batidas no mesmo minuto', () => {
  const grade = { inicio: '09:00', fim: '13:00', almocoInicio: '12:00', almocoFim: '12:00' };
  assert.deepEqual(horasDaJornada(grade), {
    entrada: '09:00',
    saida_almoco: '',
    volta_almoco: '',
    saida: '13:00',
  });
});

test('API velha: almoço fora do turno não entra; dentro do turno entra', () => {
  const fora = { inicio: '09:00', fim: '13:00', almocoInicio: '14:00', almocoFim: '15:00' };
  assert.equal(horasDaJornada(fora).saida_almoco, '');
  assert.equal(horasDaJornada(SEMANA).saida_almoco, '12:00');
});

test('só preenche quando a jornada tem começo e fim que fecham', () => {
  assert.equal(podePreencherPelaJornada(SEMANA), true);
  assert.equal(podePreencherPelaJornada({ inicio: null, fim: null }), false);
  assert.equal(podePreencherPelaJornada({ inicio: '18:00', fim: '09:00' }), false);
  assert.equal(podePreencherPelaJornada(null), false);
  assert.equal(podePreencherPelaJornada({ inicio: '9h', fim: '18:00' }), false);
});
