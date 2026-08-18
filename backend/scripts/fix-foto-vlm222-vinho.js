/**
 * VLM-222 "VINHO" ESTAVA MOSTRANDO O VESTIDO ESTAMPADO (18/08/2026).
 *
 * Reportado pelo dono na PDP `/produto/ref-vlm-222` — a mesma peça que o
 * banner da home passou a anunciar hoje. A bolinha "Vinho" abria a foto de um
 * vestido de estampa geométrica: outra peça, outra REF (`VLM222EST`, ESTAMPA
 * VINHO, R$ 199,90, 65 pç).
 *
 * PROVA (não é suposição): as duas linhas abaixo apontam pra arquivos cujo
 * conteúdo é IDÊNTICO, byte a byte (md5 85d1cf97779ce0baca0fe78d4c7ebeeb), à
 * foto que já está corretamente guardada sob VLM222EST / ESTAMPA VINHO. Foram
 * subidas em 03/08; as certas, sob a REF do estampado, em 07/08. Ninguém
 * apagou as primeiras.
 *
 *   VLM-222 | VINHO | ordem 0 | …/produtos/VLM-222/VINHO/1785775563110-VLM-222-VINHO-1-jpg.jpg
 *   VLM-222 | VINHO | ordem 1 | …/produtos/VLM-222/VINHO/1785775563441-VLM-222-VINHO-2-jpg.jpg
 *
 * O nome do arquivo diz "VLM-222-VINHO" — por isso nenhuma varredura por REF,
 * cor ou nome jamais pegaria. Só o conteúdo entrega
 * (`diag-foto-de-outra-peca.js`).
 *
 * A cor VINHO é de verdade: REF `VLM222`, R$ 179,90, 33 peças em 13 lojas. O
 * que não existe é FOTO dela. Apagando estas duas linhas a bolinha Vinho sai
 * da PDP pela regra que já existe ("cor sem foto não vira bolinha") — some uma
 * cor da vitrine, mas para de vender estampado no lugar de liso. Pra ela
 * voltar: subir a foto REAL do vinho liso na REF **VLM222** (é lá que a cor
 * mora), pela tela de fotos da retaguarda.
 *
 * ⚠️ Só apaga a LINHA do banco. O arquivo continua no R2 (é o mesmo objeto que
 * o estampado usa por outro caminho) e o backup abaixo permite recriar a linha.
 *
 *   # conferir (não grava nada)
 *   railway run --service Postgres node backend/scripts/fix-foto-vlm222-vinho.js
 *   # gravar
 *   railway run --service Postgres node backend/scripts/fix-foto-vlm222-vinho.js --aplicar
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const APLICAR = process.argv.includes('--aplicar');

/** Lista EXPLÍCITA — id de linha, nunca LIKE. Uma REF vizinha não pode cair
 *  junto por descuido de padrão. */
const FOTOS_ERRADAS = [
  { id: '6b8b800b-a7cf-4516-a1f9-f1886a7fa32c', ref: 'VLM-222', cor: 'VINHO', ordem: 0 },
  { id: '05f3d7a9-72c1-40a6-b603-93dd86a9ce07', ref: 'VLM-222', cor: 'VINHO', ordem: 1 },
];

/** Md5 do arquivo do ESTAMPADO. Confere antes de apagar: se o conteúdo mudou
 *  (alguém já corrigiu a foto), o script PARA em vez de apagar foto boa. */
const MD5_DO_ESTAMPADO = '85d1cf97779ce0baca0fe78d4c7ebeeb';

const BACKUP = path.join(__dirname, 'fix-foto-vlm222-vinho-backup-antes.json');

(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  const ids = FOTOS_ERRADAS.map((f) => f.id);
  const { rows: atuais } = await db.query(
    `SELECT * FROM product_photos WHERE id = ANY($1::text[]) ORDER BY ref, cor, ordem`, [ids]);

  if (atuais.length !== FOTOS_ERRADAS.length) {
    console.log(`⚠️  esperava ${FOTOS_ERRADAS.length} linhas, achei ${atuais.length}. Alguém já mexeu — conferir antes de aplicar.`);
  }

  console.log('LINHAS A REMOVER\n');
  for (const f of atuais) {
    const resp = await fetch(f.url, { method: 'HEAD' });
    const etag = (resp.headers.get('etag') || '').replace(/"/g, '');
    const bate = etag === MD5_DO_ESTAMPADO;
    console.log(`  ${f.ref} | ${f.cor} | ordem ${f.ordem}`);
    console.log(`     ${f.url}`);
    console.log(`     conteúdo: ${etag || '(sem resposta)'} ${bate ? '= foto do ESTAMPADO ✔' : '❌ NÃO é a foto do estampado — NÃO apagar'}\n`);
    if (!bate) {
      console.log('PARANDO: o arquivo não é mais o do estampado. Conferir na mão.');
      await db.end();
      process.exit(1);
    }
  }

  // Como fica a cor depois: sem foto, a bolinha sai da PDP.
  const { rows: sobra } = await db.query(
    `SELECT COUNT(*)::int AS fotos FROM product_photos WHERE ref IN ('VLM-222','VLM222') AND upper(cor) = 'VINHO' AND id <> ALL($1::text[])`, [ids]);
  console.log(`Fotos que sobram na cor VINHO da família: ${sobra[0].fotos} → a bolinha "Vinho" ${sobra[0].fotos ? 'continua' : 'SAI'} da PDP.`);

  if (!APLICAR) {
    console.log('\n(seco — nada foi gravado. rode com --aplicar)');
    await db.end();
    return;
  }

  fs.writeFileSync(BACKUP, JSON.stringify(atuais, null, 2));
  console.log(`\nbackup em ${BACKUP}`);

  try {
    await db.query('BEGIN');
    const r = await db.query(`DELETE FROM product_photos WHERE id = ANY($1::text[])`, [ids]);
    await db.query('COMMIT');
    console.log(`✅ ${r.rowCount} linha(s) removida(s).`);
  } catch (e) {
    await db.query('ROLLBACK');
    console.log('❌ rollback: ' + e.message);
    process.exitCode = 1;
  }
  await db.end();
})();
