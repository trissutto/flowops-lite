import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();

const legacyRoutes = [
  'src/app/retaguarda/produto-master/page.tsx',
  'src/app/retaguarda/editor-produtos/page.tsx',
  'src/app/retaguarda/ficha-fila/page.tsx',
  'src/app/cadastros/classificacao-produtos/page.tsx',
  'src/app/cadastros/classificacao-peca/page.tsx',
  'src/app/loja/pedidos-compra/page.tsx',
  'src/app/loja/reposicao/page.tsx',
  'src/app/loja/etiquetas-avulsas/page.tsx',
  'src/app/retaguarda/inteligencia-estoque/page.tsx',
  'src/app/retaguarda/realinhamento/page.tsx',
];

const newRoutes = [
  'src/app/retaguarda/produto-estoque/page.tsx',
  'src/app/retaguarda/produto-estoque/produtos/page.tsx',
  'src/app/retaguarda/produto-estoque/produtos/grade-geral/page.tsx',
  'src/app/retaguarda/produto-estoque/produtos/pendencias/page.tsx',
  'src/app/retaguarda/produto-estoque/produtos/classificacao/page.tsx',
  'src/app/retaguarda/produto-estoque/entradas/page.tsx',
  'src/app/retaguarda/produto-estoque/estoque/page.tsx',
  'src/app/retaguarda/produto-estoque/inteligencia/page.tsx',
  'src/app/retaguarda/produto-estoque/cadastros/page.tsx',
];

await Promise.all([...legacyRoutes, ...newRoutes].map((file) => access(path.join(root, file))));

const reuseExpectations = [
  ['src/app/retaguarda/produto-estoque/produtos/page.tsx', '@/app/retaguarda/produto-master/page'],
  ['src/app/retaguarda/produto-estoque/produtos/grade-geral/page.tsx', '@/app/retaguarda/editor-produtos/page'],
  ['src/app/retaguarda/produto-estoque/produtos/pendencias/page.tsx', '@/app/retaguarda/ficha-fila/page'],
  ['src/app/retaguarda/produto-estoque/produtos/classificacao/page.tsx', '@/app/cadastros/classificacao-produtos/page'],
  ['src/app/retaguarda/produto-estoque/inteligencia/page.tsx', '@/app/retaguarda/inteligencia-estoque/page'],
];

for (const [file, expectedImport] of reuseExpectations) {
  const content = await readFile(path.join(root, file), 'utf8');
  if (!content.includes(expectedImport)) {
    throw new Error(`${file} não reutiliza ${expectedImport}`);
  }
}

const shell = await readFile(
  path.join(root, 'src/features/produto-estoque/module-nav.ts'),
  'utf8',
);

for (const segment of ['produtos', 'entradas', 'estoque', 'inteligencia', 'cadastros']) {
  if (!shell.includes(`/${segment}`)) throw new Error(`Navegação sem a área ${segment}`);
}

console.log(
  `Produto & Estoque OK: ${newRoutes.length} rotas novas, ${legacyRoutes.length} rotas antigas preservadas e ${reuseExpectations.length} telas reutilizadas.`,
);
