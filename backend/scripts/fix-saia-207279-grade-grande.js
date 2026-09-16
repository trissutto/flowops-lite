/**
 * SAIA 207279 · os tamanhos 56/58/60 estavam cadastrados como 207282 (16/09/2026).
 *
 * O QUE ESTAVA ERRADO
 * No lote MARRIE de 10/03/2025, os tamanhos 56/58/60 da saia de couro 207279
 * PRETO (R$ 219,90) entraram com a REF e a COR do vestido digitado logo antes:
 * 207282 · ESTAMPA PRETO. Só a descrição ficou de saia ("SAIA MID PLUS SIZE
 * COURO 207282 MARRIE ESTAMPA PRETO 56"). Efeitos:
 *   - PDV: a foto é procurada por REF+COR → a saia aparecia com a foto do vestido;
 *   - Consulta: mesma REF e mesma MARCA → um cartão só, e nos 56–60 a saia (mais
 *     estoque) ESCONDIA o vestido na dedup por célula;
 *   - a saia 207279 parecia existir só até o 54 (a grade grande "sumia").
 * O site já se defendia (familiaPublicada separa por tipo de peça).
 *
 * A PROVA: na distribuição de 11/03/2025, cada loja recebeu no MESMO documento
 * de transferência a 207279 em 46–54 e estes 56/58/60 (a grade inteira da
 * saia); o vestido tem os próprios 56–60 (5190409/16/23). Preço e custo seguem
 * a escada da MARRIE (+R$ 20 do 56 em diante). O dono confirmou que a saia vai
 * até o 60.
 *
 * O QUE ESTE SCRIPT FAZ — as mesmas gravações do editor de produtos:
 *   product, wincred_produtos e giga_produto (com ref_base, que a grade da live
 *   usa): REF 207279, COR PRETO, descrição "SAIA MID PLUS SIZE COURO 207279
 *   MARRIE PRETO <tam>". Código, preço, custo, dataAlt e estoque NÃO mudam — a
 *   etiqueta já colada continua bipando. Cada campo vira uma linha em
 *   product_edit_audit (ANTES→DEPOIS), como no editor.
 *
 *   railway run node scripts/fix-saia-207279-grade-grande.js
 *   railway run node scripts/fix-saia-207279-grade-grande.js --apply
 *
 * Desfazer: editor de produtos, os 3 códigos de volta pra 207282 / ESTAMPA PRETO.
 */
const { Client } = require('pg');
const { randomUUID } = require('crypto');

const APPLY = process.argv.includes('--apply');
const log = (s = '') => console.log(s);

const DE = { ref: '207282', cor: 'ESTAMPA PRETO' };
const PARA = { ref: '207279', cor: 'PRETO' };
const CODIGOS = { '5190430': '56', '5190447': '58', '5190454': '60' };
const USUARIO = 'Claude · pedido do Thiago (saia 207279 56-60)';

const descricaoNova = (tam) => `SAIA MID PLUS SIZE COURO ${PARA.ref} MARRIE ${PARA.cor} ${tam}`;

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  const codigos = Object.keys(CODIGOS);

  log(APPLY ? '\n>>> APLICANDO <<<\n' : '\n>>> SIMULAÇÃO (rode com --apply pra valer) <<<\n');

  // ── Conferência: cada código tem que estar EXATAMENTE no estado errado ──
  const atuais = await db.query(
    `SELECT codigo, ref, cor, tamanho, marca, "descricaoCompleta" AS descricao, "vendaUn" AS preco
       FROM product WHERE codigo = ANY($1) ORDER BY codigo`,
    [codigos],
  );
  if (atuais.rowCount !== codigos.length) {
    throw new Error(`esperava ${codigos.length} códigos na product, achei ${atuais.rowCount}`);
  }
  const pendentes = [];
  for (const p of atuais.rows) {
    const tam = CODIGOS[p.codigo];
    const jaFeito = p.ref === PARA.ref && p.cor === PARA.cor && p.descricao === descricaoNova(tam);
    if (jaFeito) {
      log(`   ${p.codigo} (${tam}) já está como ${PARA.ref} · ${PARA.cor} — nada a fazer`);
      continue;
    }
    const errado =
      p.ref === DE.ref &&
      p.cor === DE.cor &&
      p.tamanho === tam &&
      p.marca === 'MARRIE' &&
      String(p.descricao || '').startsWith(`SAIA MID PLUS SIZE COURO ${DE.ref} `);
    if (!errado) {
      throw new Error(`${p.codigo} não está no estado esperado: ${JSON.stringify(p)} — nada foi gravado`);
    }
    pendentes.push({ ...p, tam, nova: descricaoNova(tam) });
  }

  // ── Colisão: a 207279 PRETO não pode já ter código nesses tamanhos ──
  const colisao = await db.query(
    `SELECT codigo, tamanho FROM product
      WHERE ref = $1 AND cor = $2 AND tamanho = ANY($3) AND NOT (codigo = ANY($4))`,
    [PARA.ref, PARA.cor, Object.values(CODIGOS), codigos],
  );
  if (colisao.rowCount) {
    throw new Error(`a ${PARA.ref} ${PARA.cor} já tem ${JSON.stringify(colisao.rows)} — conferir antes de juntar`);
  }

  if (!pendentes.length) {
    log('\nNada pendente.');
    await db.end();
    return;
  }

  await db.query('BEGIN');
  try {
    const batchId = randomUUID();
    for (const p of pendentes) {
      const nat = await db.query(
        `UPDATE product
            SET ref = $2, cor = $3, "descricaoCompleta" = $4::text, "descricaoPdv" = LEFT($4::text, 50),
                flow_is_source = true, edited_at = NOW(), updated_at = NOW()
          WHERE codigo = $1 AND ref = $5 AND cor = $6`,
        [p.codigo, PARA.ref, PARA.cor, p.nova, DE.ref, DE.cor],
      );
      const esp = await db.query(
        `UPDATE wincred_produtos
            SET ref = $2, cor = $3, "descricaoCompleta" = $4::text, "descricaoPdv" = LEFT($4::text, 50)
          WHERE codigo = $1 AND ref = $5`,
        [p.codigo, PARA.ref, PARA.cor, p.nova, DE.ref],
      );
      const gig = await db.query(
        `UPDATE giga_produto SET ref = $2, ref_base = $2, cor = $3, descricao = $4 WHERE codigo = $1`,
        [p.codigo, PARA.ref, PARA.cor, p.nova],
      );
      if (nat.rowCount !== 1) throw new Error(`${p.codigo}: product atualizou ${nat.rowCount} linhas`);

      for (const [field, oldValue, newValue] of [
        ['REF', p.ref, PARA.ref],
        ['COR', p.cor, PARA.cor],
        ['DESCRICAO', p.descricao, p.nova],
      ]) {
        await db.query(
          `INSERT INTO product_edit_audit
             (id, batch_id, codigo, ref, field, old_value, new_value, user_name, applied, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())`,
          [randomUUID(), batchId, p.codigo, p.ref, field, oldValue, newValue, USUARIO],
        );
      }
      log(`   ${p.codigo} (${p.tam}): product=${nat.rowCount} wincred=${esp.rowCount} giga=${gig.rowCount}`);
      log(`      ${p.descricao}`);
      log(`   →  ${p.nova}`);
    }

    // ── Retrato de conferência, dentro da transação ──
    const depois = await db.query(
      `SELECT ref, cor, LEFT("descricaoCompleta", 30) AS tipo,
              STRING_AGG(tamanho, ',' ORDER BY tamanho) AS tamanhos
         FROM product WHERE ref IN ($1, $2)
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [DE.ref, PARA.ref],
    );
    log('\n── como fica ──');
    for (const r of depois.rows) {
      log(`   ${r.ref} · ${String(r.cor).padEnd(14)} ${String(r.tipo).padEnd(31)} ${r.tamanhos}`);
    }

    if (APPLY) {
      await db.query('COMMIT');
      log(`\nGRAVADO (auditoria batch ${batchId}).`);
    } else {
      await db.query('ROLLBACK');
      log('\nSimulação: nada gravado.');
    }
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error('\nERRO:', e.message);
  process.exit(1);
});
