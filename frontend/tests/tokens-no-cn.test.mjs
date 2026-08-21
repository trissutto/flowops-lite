import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guarda o modo de falha que custou um dia no ecommerce (03/08/2026): token de
 * cor criado no `tailwind.config.ts` e esquecido na lista do `cn()`. Quando
 * isso acontece o tailwind-merge não reconhece o nome, assume que ele é do
 * mesmo grupo de `text-*` que o tamanho de fonte, e mantém só o último — a
 * classe de cor some no caminho e o botão sai preto sem texto. Nenhuma
 * inspeção de estilo mostra isso.
 *
 * Rodar: npm run test:tokens
 */

const raiz = join(import.meta.dirname, '..');
const config = readFileSync(join(raiz, 'tailwind.config.ts'), 'utf8');
const cn = readFileSync(join(raiz, 'src', 'lib', 'cn.ts'), 'utf8');

/** Nomes de cor declarados no bloco `colors` do tailwind.config.ts. */
function coresDoConfig() {
  const bloco = config.match(/colors:\s*\{([\s\S]*?)\n {6}\}/);
  assert.ok(bloco, 'não achei o bloco `colors` no tailwind.config.ts');

  const nomes = new Set();
  let atual = null;

  for (const linha of bloco[1].split('\n')) {
    const semComentario = linha.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
    /* aninhado: `brand: {` abre um grupo — vira brand, brand-light, brand-dark */
    const abre = semComentario.match(/^\s*'?([a-zA-Z][\w-]*)'?:\s*\{\s*$/);
    if (abre) {
      atual = abre[1];
      nomes.add(atual);
      continue;
    }
    if (/^\s*\},?\s*$/.test(semComentario)) {
      atual = null;
      continue;
    }
    const folha = semComentario.match(/^\s*'?([a-zA-Z][\w-]*|DEFAULT)'?:\s*'#/);
    if (folha) {
      const chave = folha[1];
      if (atual) {
        if (chave !== 'DEFAULT') nomes.add(`${atual}-${chave}`);
      } else {
        nomes.add(chave);
      }
    }
  }
  return nomes;
}

/** Nomes listados no array CORES do cn.ts. */
function coresDoCn() {
  const bloco = cn.match(/const CORES = \[([\s\S]*?)\] as const;/);
  assert.ok(bloco, 'não achei o array CORES no src/lib/cn.ts');
  return new Set([...bloco[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

test('todo token de cor do tailwind.config está na lista do cn()', () => {
  const noConfig = coresDoConfig();
  const noCn = coresDoCn();

  assert.ok(noConfig.size >= 15, `esperava 15+ cores no config, achei ${noConfig.size}`);

  const faltando = [...noConfig].filter((c) => !noCn.has(c));
  assert.deepEqual(
    faltando,
    [],
    `Cor(es) no tailwind.config.ts que faltam no array CORES de src/lib/cn.ts: ` +
      `${faltando.join(', ')}. Sem isso o tailwind-merge come a classe de cor em silêncio.`,
  );
});

test('cn() usa extendTailwindMerge, não o twMerge cru', () => {
  assert.match(
    cn,
    /extendTailwindMerge/,
    'src/lib/cn.ts precisa usar extendTailwindMerge — o twMerge cru não conhece nossos tokens',
  );
  assert.match(cn, /'text-color'/, 'o grupo text-color precisa estar declarado');
  assert.match(cn, /'bg-color'/, 'o grupo bg-color precisa estar declarado');
});
