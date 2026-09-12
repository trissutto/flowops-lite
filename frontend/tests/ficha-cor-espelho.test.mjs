/**
 * A COR ABRE ANTES DA FICHA CHEGAR — e o painel tem que se corrigir sozinho.
 *
 * 11/09/2026, /retaguarda/produto-estoque/produtos: o clique na cor abre o
 * painel E SÓ ENTÃO dispara o GET da ficha. Como o estado nascia de
 * `useState(fichaCor?…)`, que lê só o primeiro render, o painel ficava no
 * vazio pra sempre: a galeria (que tem efeito próprio) mostrava "Fotos desta
 * cor (1/6)" com a foto na tela, e ao lado se lia "Nenhuma foto" com o select
 * de PUBLICAÇÃO travado. Peça com foto, com estoque, sem caminho pro site.
 *
 *   npm run test:ficha-cor
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assinaturaDaCor, espelharCor, statusNoSelect } from '../src/lib/ficha-cor-espelho.ts';

const LIVRE = { tocouTexto: false, tocouSwatch: false, publicacaoEmVoo: false };

const fichaCheia = {
  tituloComercial: 'Blusa Coração Oncinha',
  youtubeUrl: 'https://youtu.be/abc',
  statusPublicacao: 'publicado',
  swatchTipo: 'cor',
  corHex: '#1A1A1A',
  swatchFocoX: null,
  swatchFocoY: null,
  fotos: [{ id: 'f1' }],
};

test('a ficha que chega DEPOIS solta a publicação: a foto entra e o status é o do banco', () => {
  const e = espelharCor(fichaCheia, LIVRE);
  assert.deepEqual(e.fotos, [{ id: 'f1' }], 'a galeria do painel passa a ter a foto');
  assert.equal(e.fotos.length > 0, true, 'com foto o select de publicação destrava');
  assert.equal(e.status, 'publicado');
  assert.equal(e.titulo, 'Blusa Coração Oncinha');
  assert.equal(e.youtube, 'https://youtu.be/abc');
  assert.deepEqual(e.swatch, {
    swatchTipo: 'cor', corHex: '#1A1A1A', swatchFocoX: null, swatchFocoY: null,
  });
});

test('sem ficha carregada o espelho não responde nada — "ainda não chegou" ≠ "não tem"', () => {
  assert.deepEqual(espelharCor(undefined, LIVRE), {});
  assert.deepEqual(espelharCor(null, LIVRE), {});
});

test('"faltam fotos" é conclusão do sistema: no select vira "Fora do site"', () => {
  assert.equal(statusNoSelect('sem_fotos'), 'nao_publicar');
  assert.equal(statusNoSelect(null), 'nao_publicar');
  assert.equal(statusNoSelect(undefined), 'nao_publicar');
  assert.equal(statusNoSelect('publicado'), 'publicado');
  assert.equal(statusNoSelect('pronto'), 'pronto');
  assert.equal(espelharCor({ ...fichaCheia, statusPublicacao: 'sem_fotos' }, LIVRE).status, 'nao_publicar');
});

test('o eco de um PATCH não apaga o que a pessoa está fazendo agora', () => {
  const e = espelharCor(fichaCheia, { tocouTexto: true, tocouSwatch: true, publicacaoEmVoo: true });
  assert.equal(e.titulo, undefined, 'título sendo digitado fica');
  assert.equal(e.youtube, undefined, 'vídeo sendo digitado fica');
  assert.equal(e.swatch, undefined, 'bolinha recém-escolhida fica');
  assert.equal(e.status, undefined, 'publicação ainda salvando fica');
  assert.deepEqual(e.fotos, [{ id: 'f1' }], 'foto NÃO é digitada: espelha sempre');
});

test('cor sem nada gravado ainda espelha: campos vazios e bolinha padrão', () => {
  const e = espelharCor(
    { statusPublicacao: 'nao_publicar', fotos: [] },
    LIVRE,
  );
  assert.deepEqual(e.fotos, []);
  assert.equal(e.titulo, '');
  assert.equal(e.youtube, '');
  assert.deepEqual(e.swatch, {
    swatchTipo: 'cor', corHex: null, swatchFocoX: null, swatchFocoY: null,
  });
});

test('a assinatura muda quando o servidor muda — e NÃO a cada re-render do pai', () => {
  const copia = { ...fichaCheia, fotos: [{ id: 'f1' }] };
  assert.equal(
    assinaturaDaCor(copia), assinaturaDaCor(fichaCheia),
    'objeto novo com o mesmo conteúdo = mesma assinatura (o efeito não roda)',
  );
  assert.notEqual(
    assinaturaDaCor({ ...fichaCheia, fotos: [{ id: 'f1' }, { id: 'f2' }] }),
    assinaturaDaCor(fichaCheia),
    'foto importada em outra aba muda a assinatura',
  );
  assert.notEqual(
    assinaturaDaCor({ ...fichaCheia, statusPublicacao: 'nao_publicar' }),
    assinaturaDaCor(fichaCheia),
    'publicação mudada fora daqui muda a assinatura',
  );
  assert.equal(assinaturaDaCor(undefined), '', 'ficha ausente tem assinatura própria');
  assert.notEqual(
    assinaturaDaCor({ statusPublicacao: 'nao_publicar', fotos: [] }), '',
    'ficha vazia NÃO é igual a ficha ausente — é isso que dispara o espelho ao chegar',
  );
});
