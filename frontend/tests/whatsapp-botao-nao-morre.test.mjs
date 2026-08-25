import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guarda o modo de falha de 25/08/2026: o botão de WhatsApp que NÃO FAZ NADA.
 *
 * A migração pro protocolo `whatsapp://` (24/08) trouxe uma validação de
 * telefone com `return false` ANTES de abrir qualquer coisa. Nas telas que não
 * olham o retorno — a do link de pagamento do crediário é uma delas — o clique
 * virava silêncio absoluto. Queixa do dono: "o botão do WhatsApp não abre".
 *
 * Medição do dia (baixas de crediário, 90 dias): 225 telefones válidos, 297
 * vazios e **409 tortos (44%)**, quase todos celular sem DDD do cadastro
 * antigo do Giga. Ou seja: quase metade dos cliques morria calado.
 *
 * A regra que este teste segura: telefone torto abre o WhatsApp na LISTA DE
 * CONTATOS com a mensagem pronta (mesmo desfecho do telefone vazio) e devolve
 * `false` só pra quem chamou poder explicar. Abrir sempre; avisar quando não
 * deu pra mirar na conversa certa.
 *
 * Rodar: node --test tests/whatsapp-botao-nao-morre.test.mjs
 */

const fonte = readFileSync(
  join(import.meta.dirname, '..', 'src', 'lib', 'whatsapp.ts'),
  'utf8',
);

/** O corpo de `abrirWhatsApp`, do cabeçalho até o `return` final. */
function corpoDoAbrir() {
  const i = fonte.indexOf('export function abrirWhatsApp');
  assert.ok(i >= 0, 'não achei `abrirWhatsApp` em src/lib/whatsapp.ts');
  const j = fonte.indexOf('export function falarComCliente');
  return fonte.slice(i, j > i ? j : undefined);
}

test('abrirWhatsApp nunca volta antes de abrir o WhatsApp', () => {
  const corpo = corpoDoAbrir();
  const ateOClique = corpo.slice(0, corpo.indexOf('link.click()'));
  assert.ok(
    corpo.includes('link.click()'),
    'o clique na âncora sumiu — sem ele nada abre',
  );
  // Comentário citando o defeito antigo não conta: só código.
  const codigo = ateOClique
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(
    !/\breturn\b/.test(codigo),
    'voltou um `return` antes de abrir o WhatsApp — é exatamente o botão morto de 25/08',
  );
});

test('telefone torto abre na lista de contatos, sem phone= na URL', () => {
  const corpo = corpoDoAbrir();
  assert.match(
    corpo,
    /const destino = numero \? `phone=\$\{numero\}&` : ''/,
    'sem destino condicional, telefone torto viraria `phone=undefined`',
  );
});

test('o retorno distingue "abri sem destino" de "abri na conversa certa"', () => {
  const corpo = corpoDoAbrir();
  assert.match(
    corpo,
    /return !cru \|\| !!numero;/,
    'o retorno tem que ser false só quando havia telefone e ele não presta',
  );
});

test('falarComCliente continua explicando quando cai na lista de contatos', () => {
  const i = fonte.indexOf('export function falarComCliente');
  assert.ok(i >= 0, 'não achei `falarComCliente`');
  const corpo = fonte.slice(i);
  assert.ok(corpo.includes('alert('), 'sumiu o aviso pra quem clicou');
  assert.match(corpo, /lista de contatos/i, 'o aviso precisa dizer o que fazer agora');
});

test('a tela de recebimentos do crediário usa o caminho que avisa', () => {
  const tela = readFileSync(
    join(import.meta.dirname, '..', 'src', 'app', 'minha-loja', 'pdv', 'recebimentos', 'page.tsx'),
    'utf8',
  );
  assert.ok(
    tela.includes('falarComCliente('),
    'o botão do link de crediário precisa avisar quando o cadastro não tem telefone bom',
  );
});
