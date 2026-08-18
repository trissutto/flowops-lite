/**
 * A RÉGUA DA VENDA ONLINE MORA EM DOIS ARQUIVOS — este teste prova que os
 * dois dizem a MESMA coisa.
 *
 *   backend/src/common/dados-cliente-online.ts  → quem COBRA (recusa o
 *                                                 pagamento no addPayment)
 *   frontend/src/lib/dados-cliente-online.ts    → quem MOSTRA (o PDV barra
 *                                                 antes de gerar PIX/link)
 *
 * Régua diferente entre quem mostra e quem cobra é como nasce o "preenchi
 * tudo e não deixa fechar": a tela libera, o servidor recusa, e a vendedora
 * fica com a cliente na frente sem saber o que fazer. Mexeu num lado sem
 * mexer no outro, este teste quebra.
 *
 *   npm run test:dados-cliente-online
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as front from '../src/lib/dados-cliente-online.ts';
import * as back from '../../backend/src/common/dados-cliente-online.ts';

/** O front fala `cpf/name/...`; o back fala `customerCpf/customerName/...`. */
function paraOBackend(c) {
  return {
    customerCpf: c.cpf,
    customerName: c.name,
    customerEmail: c.email,
    customerPhone: c.phone,
    customerCep: c.cep,
    customerEndereco: c.endereco,
    customerNumero: c.numero,
    customerBairro: c.bairro,
    customerCidade: c.cidade,
    customerUf: c.uf,
    entregaTipo: c.entregaTipo,
  };
}

const CONTATO = {
  name: 'Maria Aparecida Silva',
  cpf: '52998224725',
  phone: '(15) 99999-1234',
  email: 'maria@gmail.com',
};
const ENDERECO = {
  cep: '18200-000',
  endereco: 'Rua das Flores',
  numero: '120',
  bairro: 'Centro',
  cidade: 'Itapetininga',
  uf: 'sp',
};

/** Todo tipo de venda × todo estado de cadastro. */
const MODALIDADES = ['sedex', 'pac', 'motoboy', 'retirada', 'RETIRADA', null, undefined, ''];
const CADASTROS = [
  ['vazio', {}],
  ['só contato', { ...CONTATO }],
  ['só endereço', { ...ENDERECO }],
  ['completo', { ...CONTATO, ...ENDERECO }],
  ['nome genérico', { ...CONTATO, ...ENDERECO, name: 'Cliente' }],
  ['CPF torto', { ...CONTATO, ...ENDERECO, cpf: '11111111111' }],
  ['telefone sem DDD', { ...CONTATO, ...ENDERECO, phone: '999991234' }],
  ['e-mail sem domínio', { ...CONTATO, ...ENDERECO, email: 'maria@gmail' }],
  ['CEP curto', { ...CONTATO, ...ENDERECO, cep: '1820' }],
  ['UF inventada', { ...CONTATO, ...ENDERECO, uf: 'CI' }],
  ['sem número', { ...CONTATO, ...ENDERECO, numero: '' }],
];

test('as duas réguas devolvem a MESMA lista em toda combinação', () => {
  for (const modalidade of MODALIDADES) {
    for (const [rotulo, cadastro] of CADASTROS) {
      const c = { ...cadastro, entregaTipo: modalidade };
      assert.deepEqual(
        front.faltandoDadosClienteOnline(c),
        back.faltandoDadosClienteOnline(paraOBackend(c)),
        `divergiu em "${rotulo}" com entrega=${JSON.stringify(modalidade)}`,
      );
      assert.deepEqual(
        front.faltandoDadosBasicosClienteOnline(c),
        back.faltandoDadosBasicosClienteOnline(paraOBackend(c)),
        `contato divergiu em "${rotulo}" com entrega=${JSON.stringify(modalidade)}`,
      );
    }
  }
});

test('pecaViaja é igual dos dois lados', () => {
  for (const modalidade of MODALIDADES) {
    assert.equal(
      front.pecaViaja(modalidade),
      back.pecaViaja(modalidade),
      `pecaViaja divergiu em ${JSON.stringify(modalidade)}`,
    );
  }
});

test('RETIRADA fecha só com contato — a cliente busca no balcão (dono 18/08)', () => {
  const soContato = { ...CONTATO, entregaTipo: 'retirada' };
  assert.deepEqual(front.faltandoDadosClienteOnline(soContato), []);
  assert.deepEqual(back.faltandoDadosClienteOnline(paraOBackend(soContato)), []);
});

test('a peça viajando, o endereço volta a ser cobrado', () => {
  for (const modalidade of ['sedex', 'pac', 'motoboy']) {
    const semEndereco = { ...CONTATO, entregaTipo: modalidade };
    assert.deepEqual(front.faltandoDadosClienteOnline(semEndereco), [
      'CEP', 'rua', 'número', 'bairro', 'cidade', 'UF',
    ]);
  }
});

test('entrega ainda não escolhida cobra endereço — o lado seguro', () => {
  const semModalidade = { ...CONTATO, entregaTipo: null };
  assert.ok(front.faltandoDadosClienteOnline(semModalidade).includes('CEP'));
  assert.ok(back.faltandoDadosClienteOnline(paraOBackend(semModalidade)).includes('CEP'));
});

test('contato continua obrigatório na retirada (NF-e e aviso pra cliente)', () => {
  assert.deepEqual(front.faltandoDadosClienteOnline({ entregaTipo: 'retirada' }), [
    'nome completo (nome e sobrenome)', 'CPF válido', 'WhatsApp com DDD', 'e-mail',
  ]);
});
