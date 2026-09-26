/**
 * ATESTADO DE HORAS — o que a caixa diz enquanto a supervisão digita "até tal hora".
 *
 * Pedido do dono (26/09/2026): "o atestado de justificativa de horas tem que
 * ser fácil de colocar — um campo pro horário de ATÉ tal hora; essa jornada
 * não desconta da funcionária". A conta é do backend (mesma régua do
 * espelho); aqui se prende o que a TELA faz com ela: o das nasce com a
 * entrada cadastrada, o até em branco não grava, e a frase diz o que vai
 * acontecer com o dia — inclusive quando a hora não cai na jornada.
 *
 *   npm run test:atestado-horas
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIA_INTEIRO,
  fmtMin,
  fraseDaPrevia,
  horasAoLigarParcial,
  janelaTexto,
  validarHoras,
} from '../src/lib/atestado-horas.ts';

const JANELA = { inicio: '09:00', fim: '18:00', almocoInicio: '12:00', almocoFim: '13:00' };

const previa = (over = {}) => ({
  data: '2026-09-28',
  diaSemana: 'SEG',
  janela: JANELA,
  folga: false,
  semCadastro: false,
  minPrevisto: 480,
  minAfetados: 120,
  minRestantes: 360,
  efeito: 'abona',
  parcial: true,
  foraDaJornada: false,
  ...over,
});

// ── validarHoras ───────────────────────────────────────────────

test('dia inteiro nunca trava', () => {
  assert.equal(validarHoras(DIA_INTEIRO), null);
  assert.equal(validarHoras({ diaInteiro: true, horaInicio: 'lixo', horaFim: '' }), null);
});

test('"só algumas horas" com o até em branco NÃO grava — é o campo que a pessoa esqueceu', () => {
  assert.equal(
    validarHoras({ diaInteiro: false, horaInicio: '09:00', horaFim: '' }),
    'Preencha até que horas.',
  );
  assert.equal(
    validarHoras({ diaInteiro: false, horaInicio: '', horaFim: '11:00' }),
    'Preencha a partir de que horas.',
  );
  assert.equal(
    validarHoras({ diaInteiro: false, horaInicio: '', horaFim: '' }),
    'Preencha das/até que horas.',
  );
});

test('até antes do das é erro; janela em ordem passa', () => {
  assert.match(
    validarHoras({ diaInteiro: false, horaInicio: '11:00', horaFim: '09:00' }),
    /depois do "das"/,
  );
  assert.match(
    validarHoras({ diaInteiro: false, horaInicio: '11:00', horaFim: '11:00' }),
    /depois do "das"/,
  );
  assert.equal(validarHoras({ diaInteiro: false, horaInicio: '09:00', horaFim: '11:00' }), null);
});

// ── horasAoLigarParcial ────────────────────────────────────────

test('ao escolher "só algumas horas", o das nasce com a ENTRADA cadastrada e o até fica pra digitar', () => {
  assert.deepEqual(horasAoLigarParcial(DIA_INTEIRO, JANELA), {
    diaInteiro: false,
    horaInicio: '09:00',
    horaFim: '',
  });
});

test('hora que a pessoa já digitou não é sobrescrita pela entrada cadastrada', () => {
  const r = horasAoLigarParcial({ diaInteiro: true, horaInicio: '15:00', horaFim: '18:00' }, JANELA);
  assert.deepEqual(r, { diaInteiro: false, horaInicio: '15:00', horaFim: '18:00' });
});

test('sem jornada conhecida, nasce vazio — a prévia preenche quando chegar', () => {
  assert.deepEqual(horasAoLigarParcial(DIA_INTEIRO, null), {
    diaInteiro: false,
    horaInicio: '',
    horaFim: '',
  });
});

// ── fraseDaPrevia ──────────────────────────────────────────────

test('o caso do pedido: consulta da entrada até 11:00 → abona 2h, ela deve só 6h', () => {
  const f = fraseDaPrevia(previa(), { horas: { diaInteiro: false, horaInicio: '09:00', horaFim: '11:00' } });
  assert.equal(f.tom, 'ok');
  assert.equal(f.texto, 'Abona 2h das 8h do dia — ela deve só 6h.');
});

test('papel maior que a jornada explica o recorte: 08:00–11:00 abona 2h, não 3h', () => {
  const f = fraseDaPrevia(previa(), { horas: { diaInteiro: false, horaInicio: '08:00', horaFim: '11:00' } });
  assert.equal(f.tom, 'ok');
  assert.match(f.texto, /^Abona 2h das 8h do dia \(só o que cai na jornada 09:00–18:00 · almoço 12:00–13:00\)/);
});

test('hora que não cai na jornada é ALERTA, não silêncio', () => {
  const f = fraseDaPrevia(previa({ minAfetados: 0, minRestantes: 480, foraDaJornada: true }));
  assert.equal(f.tom, 'alerta');
  assert.match(f.texto, /não caem na jornada \(09:00–18:00/);
  assert.match(f.texto, /nada seria abonado/);
});

test('dia inteiro zera o saldo do dia', () => {
  const f = fraseDaPrevia(previa({ parcial: false, minAfetados: 480, minRestantes: 0 }));
  assert.equal(f.tom, 'ok');
  assert.equal(f.texto, 'Abona o dia inteiro (8h) — o saldo do dia fica zerado.');
});

test('vários dias: a frase diz que vale em cada um', () => {
  const parcial = fraseDaPrevia(previa(), { dias: 5 });
  assert.match(parcial.texto, /Abona 2h em cada um dos 5 dias das 8h do dia — ela deve só 6h por dia\./);
  const inteiro = fraseDaPrevia(previa({ parcial: false, minAfetados: 480, minRestantes: 0 }), { dias: 15 });
  assert.match(inteiro.texto, /Abona os 15 dias inteiros \(8h por dia\)/);
});

test('sem cadastro e folga são alerta — abonar o nada é lançamento que não faz nada', () => {
  const sem = fraseDaPrevia(previa({ semCadastro: true, janela: null, minPrevisto: 0, minAfetados: 0, minRestantes: 0 }));
  assert.equal(sem.tom, 'alerta');
  assert.match(sem.texto, /Sem horário cadastrado pra segunda/);
  const folga = fraseDaPrevia(previa({ diaSemana: 'DOM', folga: true, janela: null, minPrevisto: 0, minAfetados: 0, minRestantes: 0 }));
  assert.equal(folga.tom, 'alerta');
  assert.match(folga.texto, /^Domingo é folga no cadastro/);
});

test('treinamento credita, folga compensatória debita, falta não abona', () => {
  const cred = fraseDaPrevia(previa({ efeito: 'credita', minAfetados: 300, minRestantes: 180 }));
  assert.equal(cred.tom, 'ok');
  assert.equal(cred.texto, 'Conta 5h como trabalhadas — ela estava em jornada, só que fora da loja.');

  const deb = fraseDaPrevia(previa({ efeito: 'debita', minAfetados: 240, minRestantes: 240 }));
  assert.equal(deb.tom, 'neutro');
  assert.match(deb.texto, /^Consome 4h do banco de horas/);

  const falta = fraseDaPrevia(previa({ efeito: 'nenhum', parcial: false, minAfetados: 0, minRestantes: 480 }));
  assert.equal(falta.tom, 'neutro');
  assert.equal(falta.texto, 'Não abona — o dia continua devendo as 8h.');
});

test('sem prévia, sem frase (a tela não inventa número)', () => {
  assert.equal(fraseDaPrevia(null), null);
  assert.equal(fraseDaPrevia(undefined), null);
});

// ── formatação ─────────────────────────────────────────────────

test('fmtMin e janelaTexto', () => {
  assert.equal(fmtMin(0), '0h');
  assert.equal(fmtMin(90), '1h30');
  assert.equal(fmtMin(120), '2h');
  assert.equal(fmtMin(-30), '-0h30');
  assert.equal(janelaTexto(JANELA), '09:00–18:00 · almoço 12:00–13:00');
  assert.equal(janelaTexto({ inicio: '09:00', fim: '13:00', almocoInicio: null, almocoFim: null }), '09:00–13:00');
  // Almoço "início = fim" é como a ficha diz "sem intervalo".
  assert.equal(janelaTexto({ inicio: '09:00', fim: '13:00', almocoInicio: '13:00', almocoFim: '13:00' }), '09:00–13:00');
  assert.equal(janelaTexto(null), '');
});
