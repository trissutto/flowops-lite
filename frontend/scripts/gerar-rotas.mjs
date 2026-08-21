/**
 * Gera src/data/rotas.json — a lista de TODAS as rotas do frontend.
 *
 * Por que isso existe: a tabela `page_access` só tem linha pra rota que já foi
 * acessada pelo menos uma vez. Rota que ninguém abriu não aparece em lugar
 * nenhum — e é justamente essa que a gente quer cortar. Cruzando a telemetria
 * com esta lista, a tela /retaguarda/telemetria consegue mostrar o silêncio.
 *
 * Rodar depois de criar/apagar/renomear rota:
 *   node scripts/gerar-rotas.mjs
 */
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const APP = join(process.cwd(), 'src', 'app');
const SAIDA = join(process.cwd(), 'src', 'data', 'rotas.json');

const rotas = [];

function varrer(dir) {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      varrer(caminho);
    } else if (nome === 'page.tsx' || nome === 'page.ts') {
      const relativo = relative(APP, dir);
      const partes = relativo
        .split(sep)
        .filter(Boolean)
        /* grupo de rota (pasta) não entra na URL */
        .filter((p) => !(p.startsWith('(') && p.endsWith(')')));
      rotas.push('/' + partes.join('/'));
    }
  }
}

varrer(APP);

const unicas = [...new Set(rotas.map((r) => (r === '/' ? '/' : r.replace(/\/$/, ''))))].sort();

mkdirSync(join(process.cwd(), 'src', 'data'), { recursive: true });
writeFileSync(
  SAIDA,
  JSON.stringify({ geradoEm: new Date().toISOString().slice(0, 10), rotas: unicas }, null, 2) + '\n',
  'utf8',
);

console.log(`${unicas.length} rotas → src/data/rotas.json`);
