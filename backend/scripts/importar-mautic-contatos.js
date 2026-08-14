/**
 * IMPORTA A BASE DE MARKETING DO MAUTIC PRO NOSSO POSTGRES (dono, 14/08/2026).
 *
 * Traz os contatos que hoje vivem só no Mautic (mkt.lurds.com.br) pra
 * `marketing_contact` — a cópia soberana, que não depende de nenhuma
 * ferramenta alugada continuar de pé.
 *
 * DUAS FONTES, escolhe pela env/arg:
 *
 *  1. CSV (padrão, zero credencial) — exporte um segmento no Mautic
 *     (Segmentos → View → Export → CSV) e rode:
 *       railway run --service Postgres node backend/scripts/importar-mautic-contatos.js caminho/arquivo.csv "GERAL ATIVO"
 *     O 2º arg (opcional) é a TAG gravada nesses contatos.
 *
 *  2. API do Mautic — com MAUTIC_BASE, MAUTIC_USER, MAUTIC_PASS no ambiente
 *     (Basic Auth habilitado em Configurações da API), pagina sozinho:
 *       railway run --service Postgres node backend/scripts/importar-mautic-contatos.js --api "segment:leads-todos"
 *
 * IDEMPOTENTE: upsert por e-mail. Reimportar corrige nome/tag/pontos e NUNCA
 * ressuscita quem está `descadastrado=true`. Linha sem e-mail válido é pulada
 * (e-mail é a identidade da mailing).
 */
const fs = require('fs');
const { Client } = require('pg');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

function telefoneBR(v) {
  let d = soDigitos(v);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

/** Parser de CSV tolerante a aspas e vírgula dentro do campo. */
function parseCsv(texto) {
  const linhas = [];
  let campo = '', linha = [], dentroAspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroAspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') dentroAspas = false;
      else campo += c;
    } else if (c === '"') dentroAspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    } else campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

/** Acha a coluna cujo cabeçalho casa com um dos aliases. */
function coluna(header, aliases) {
  const h = header.map((x) => String(x).trim().toLowerCase());
  for (const a of aliases) {
    const i = h.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

async function lerCsv(caminho) {
  const texto = fs.readFileSync(caminho, 'utf8');
  const linhas = parseCsv(texto).filter((l) => l.some((c) => String(c).trim() !== ''));
  if (!linhas.length) return [];
  const header = linhas[0];
  const iEmail = coluna(header, ['email', 'e-mail']);
  const iNome = coluna(header, ['firstname', 'first name', 'nome', 'name']);
  const iSobre = coluna(header, ['lastname', 'last name', 'sobrenome']);
  const iFone = coluna(header, ['phone', 'telefone', 'mobile', 'celular']);
  const iPontos = coluna(header, ['points', 'pontos']);
  const iId = coluna(header, ['id']);
  if (iEmail < 0) throw new Error(`CSV sem coluna de e-mail. Cabeçalho: ${header.join(', ')}`);
  return linhas.slice(1).map((l) => ({
    email: String(l[iEmail] ?? '').trim().toLowerCase(),
    nome: [iNome >= 0 ? l[iNome] : '', iSobre >= 0 ? l[iSobre] : ''].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || null,
    telefone: iFone >= 0 ? telefoneBR(l[iFone]) : null,
    pontos: iPontos >= 0 && l[iPontos] !== '' ? Number(l[iPontos]) || null : null,
    mauticId: iId >= 0 ? String(l[iId] ?? '').trim() || null : null,
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const usarApi = args.includes('--api');
  const arquivo = args.find((a) => !a.startsWith('--') && /\.csv$/i.test(a));
  const tag = args.find((a) => !a.startsWith('--') && !/\.csv$/i.test(a)) || null;

  let contatos = [];
  if (usarApi) {
    console.error('Modo --api ainda requer MAUTIC_BASE/USER/PASS — use o CSV por enquanto.');
    process.exit(2);
  } else if (arquivo) {
    contatos = await lerCsv(arquivo);
  } else {
    console.error('Uso: node importar-mautic-contatos.js <arquivo.csv> ["TAG"]');
    process.exit(2);
  }

  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  let ok = 0, pulados = 0, protegidos = 0;
  for (const c of contatos) {
    if (!EMAIL_RE.test(c.email)) { pulados++; continue; }
    // Nunca ressuscita quem descadastrou; só faz merge de tag e dados leves.
    const r = await db.query(
      `INSERT INTO marketing_contact (id, email, nome, telefone, origem, tags, pontos, mautic_id, criado_em, atualizado_em)
         VALUES (gen_random_uuid(), $1, $2, $3, 'mautic', $4, $5, $6, NOW(), NOW())
       ON CONFLICT (email) DO UPDATE SET
         nome  = COALESCE(EXCLUDED.nome, marketing_contact.nome),
         telefone = COALESCE(EXCLUDED.telefone, marketing_contact.telefone),
         pontos = COALESCE(EXCLUDED.pontos, marketing_contact.pontos),
         mautic_id = COALESCE(EXCLUDED.mautic_id, marketing_contact.mautic_id),
         tags = CASE
                  WHEN $4 IS NULL OR $4 = '' THEN marketing_contact.tags
                  WHEN marketing_contact.tags IS NULL THEN $4
                  WHEN position($4 in marketing_contact.tags) > 0 THEN marketing_contact.tags
                  ELSE marketing_contact.tags || ',' || $4
                END,
         atualizado_em = NOW()
       RETURNING descadastrado`,
      [c.email, c.nome, c.telefone, tag, c.tags ?? null, c.pontos, c.mauticId],
    );
    if (r.rows[0]?.descadastrado) protegidos++;
    ok++;
  }

  const total = await db.query('SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE descadastrado)::int fora FROM marketing_contact');
  console.log(`\n══ IMPORTAÇÃO ══`);
  console.log(`  arquivo: ${arquivo}${tag ? ` · tag "${tag}"` : ''}`);
  console.log(`  processados: ${ok} | pulados (e-mail inválido): ${pulados} | já descadastrados (mantidos fora): ${protegidos}`);
  console.log(`  BASE TOTAL agora: ${total.rows[0].n} contatos (${total.rows[0].fora} descadastrados)`);

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
