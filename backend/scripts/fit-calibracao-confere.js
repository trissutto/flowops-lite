/**
 * FIT AI — CONFERÊNCIA da calibração contra corpos REAIS (somente leitura).
 *
 * Compara, para cada perfil que declarou o tamanho habitual no widget, o que
 * o motor NOVO (medidas estimadas, 13/08/2026) e o ANTIGO (faixas de IMC)
 * diriam só pelo corpo — e mede o erro de cada um contra a declaração da
 * própria cliente. É o mesmo espírito do divergencia-estoque: medir antes de
 * confiar.
 *
 *   railway run --service Postgres node backend/scripts/fit-calibracao-confere.js
 *
 * Não grava nada. Conecta pelo DATABASE_PUBLIC_URL (o DATABASE_URL do serviço
 * aponta pro host interno da Railway, que não resolve de fora).
 */
const { Client } = require('pg');

const GRADE = ['46', '48', '50', '52', '54', '56', '58', '60'];

// Régua tamanho→medidas e estimativa corpo→medidas — cópia 1:1 do
// fit-engine.service.ts (versão neutra, sem porte/formato) pra conferência.
const REGUA = {
  busto: [108, 113, 118, 122, 126, 130, 134, 138],
  cintura: [92, 97, 102, 107, 112, 117, 122, 127],
  quadril: [116, 121, 126, 131, 135, 139, 143, 147],
};

function idxPorMedida(eixo, cm) {
  const v = REGUA[eixo];
  const n = v.length;
  if (cm <= v[0]) return (cm - v[0]) / (v[1] - v[0]);
  if (cm >= v[n - 1]) return n - 1 + (cm - v[n - 1]) / (v[n - 1] - v[n - 2]);
  for (let i = 0; i < n - 1; i++) if (cm <= v[i + 1]) return i + (cm - v[i]) / (v[i + 1] - v[i]);
  return n - 1;
}

function baseNova(alturaCm, pesoKg) {
  const s = Math.sqrt(Math.max(35, Math.min(250, pesoKg)) / Math.max(1.3, Math.min(2.1, alturaCm / 100)));
  const lim = (x) => Math.max(-1.5, Math.min(9, x));
  const B = lim(idxPorMedida('busto', 13.5 * s + 11.5));
  const C = lim(idxPorMedida('cintura', 15.5 * s - 11));
  const Q = lim(idxPorMedida('quadril', 15.5 * s + 2.5));
  return Math.max(0, Math.min(7, 0.6 * Math.max(B, Q) + 0.3 * Math.min(B, Q) + 0.1 * C));
}

function baseAntiga(alturaCm, pesoKg) {
  const m = Math.max(1.3, Math.min(2.1, alturaCm / 100));
  const imc = pesoKg / (m * m);
  const faixas = [[27, 0], [29, 1], [31, 2], [33.5, 3], [36, 4], [39, 5], [42, 6]];
  let i = 7;
  for (const [teto, x] of faixas) { if (imc < teto) { i = x; break; } }
  if (alturaCm >= 172) i -= 0.5; else if (alturaCm >= 166) i -= 0.25;
  else if (alturaCm <= 155) i += 0.5; else if (alturaCm <= 160) i += 0.25;
  return Math.max(0, Math.min(7, i));
}

(async () => {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) { console.error('Defina DATABASE_PUBLIC_URL (railway run ...)'); process.exit(1); }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const { rows } = await client.query(`
    SELECT altura_cm, peso_kg, tamanho_habitual
    FROM fit_body_profile
    WHERE tamanho_habitual = ANY($1)
    ORDER BY created_at
  `, [GRADE]);
  await client.end();

  if (!rows.length) {
    console.log('Nenhum perfil com tamanho habitual declarado ainda — sem base de conferência.');
    return;
  }

  let somaNovo = 0, somaAbsNovo = 0, somaAntigo = 0, somaAbsAntigo = 0;
  const linhas = rows.map((p) => {
    const alvo = GRADE.indexOf(p.tamanho_habitual);
    const eNovo = baseNova(p.altura_cm, p.peso_kg) - alvo;
    const eAntigo = baseAntiga(p.altura_cm, p.peso_kg) - alvo;
    somaNovo += eNovo; somaAbsNovo += Math.abs(eNovo);
    somaAntigo += eAntigo; somaAbsAntigo += Math.abs(eAntigo);
    return {
      corpo: `${p.altura_cm}cm/${p.peso_kg}kg`,
      declara: p.tamanho_habitual,
      antigo: GRADE[Math.round(baseAntiga(p.altura_cm, p.peso_kg))],
      novo: GRADE[Math.round(baseNova(p.altura_cm, p.peso_kg))],
    };
  });

  const n = rows.length;
  console.log(`Perfis com habitual declarado: ${n}\n`);
  console.table(linhas.slice(0, 80));
  console.log(`\nERRO vs o que a cliente declara (passos de grade; + = motor manda MAIOR):`);
  console.log(`  antigo (IMC):     médio ${(somaAntigo / n).toFixed(2)}  |  absoluto ${(somaAbsAntigo / n).toFixed(2)}`);
  console.log(`  novo (medidas):   médio ${(somaNovo / n).toFixed(2)}  |  absoluto ${(somaAbsNovo / n).toFixed(2)}`);
  console.log('\nSe o erro médio do novo ficar fora de ±0,5, ajustar os coeficientes em fit-engine.service.ts.');
})().catch((e) => { console.error(e.message); process.exit(1); });
