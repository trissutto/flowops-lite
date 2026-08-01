/**
 * Dá pra reservar uma faixa alta em `caixa.NUMERO` pro Flow?
 *
 * O marcado agrupa suas linhas por `caixa.NUMERO` (o "controle"), hoje gerado
 * por MAX+1 no Giga. Pro Flow passar a numerar, a ideia seria reservar uma
 * faixa alta — mas essa coluna é FLOAT, e float NÃO representa inteiro grande
 * de forma exata:
 *
 *   float  (4 bytes): exato só até 16.777.216   (2^24)
 *   double (8 bytes): exato até 9.007.199.254.740.992  (2^53)
 *
 * Se for float simples, 900.000.001 e 900.000.002 viram O MESMO número, e dois
 * marcados diferentes se fundem. Já houve incidente desta família: ler NUMERO
 * como texto achatou ~100 vendas num valor só.
 *
 * Este script mede o tipo real, o maior valor em uso, e testa na prática se o
 * banco devolve de volta o número que recebeu.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-numero-caixa.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  const [cols] = await my.query('SHOW COLUMNS FROM `caixa`');
  const alvo = cols.filter((c) => /^(numero|controle|registro)$/i.test(String(c.Field)));

  for (const c of alvo) {
    const nome = String(c.Field);
    const tipo = String(c.Type).toLowerCase();
    console.log('');
    console.log('=== caixa.' + nome + ' ===');
    console.log(`  tipo: ${c.Type}`);

    const ehFloat = /^float/.test(tipo);
    const ehDouble = /^(double|real|decimal|numeric)/.test(tipo);
    let exatoAte = null;
    if (ehFloat) exatoAte = 16777216;
    else if (/^(double|real)/.test(tipo)) exatoAte = 9007199254740992;

    if (exatoAte) console.log(`  inteiro exato ate: ${nf(exatoAte)}`);
    if (ehFloat) console.log('  *** FLOAT DE PRECISAO SIMPLES — faixa alta e PERIGOSA aqui');

    const [[m]] = await my.query(
      `SELECT MAX(CAST(\`${nome}\` AS UNSIGNED)) AS mx, COUNT(*) AS n,
              COUNT(DISTINCT CAST(\`${nome}\` AS UNSIGNED)) AS distintos
         FROM \`caixa\``,
    );
    console.log(`  maior em uso: ${nf(m.mx)}`);
    console.log(`  linhas: ${nf(m.n)}   valores distintos: ${nf(m.distintos)}`);

    if (exatoAte && Number(m.mx) > exatoAte) {
      console.log(`  *** O MAIOR EM USO JA PASSOU do limite exato — ha valores achatados AGORA`);
    }

    // Teste prático: o banco devolve o que recebeu? Sem escrever nada —
    // faz o round-trip na expressao, que usa o MESMO tipo da coluna.
    if (ehFloat || ehDouble) {
      for (const cand of [16777217, 900000001, 900000002]) {
        const [[t]] = await my.query(
          `SELECT CAST(CAST(? AS ${ehFloat ? 'FLOAT' : 'DOUBLE'}) AS CHAR) AS volta`,
          [cand],
        );
        const volta = String(t.volta);
        const ok = Number(volta) === cand;
        console.log(`  round-trip ${nf(cand)} -> ${volta} ${ok ? 'OK' : '*** PERDEU PRECISAO'}`);
      }
    }
  }

  console.log('');
  console.log('=========================================');
  const numero = alvo.find((c) => /^numero$/i.test(String(c.Field)));
  if (numero && /^float/.test(String(numero.Type).toLowerCase())) {
    console.log('VEREDITO: caixa.NUMERO e FLOAT simples. NAO usar faixa alta aqui —');
    console.log('numeros grandes se fundem e dois marcados viram um so.');
    console.log('O agrupamento do marcado tem que ser chave do FLOW (tabela marcados),');
    console.log('e o NUMERO do Giga vira detalhe da replica, nao a identidade.');
  } else if (numero) {
    console.log('VEREDITO: caixa.NUMERO nao e float simples — checar o round-trip acima');
    console.log('antes de decidir a faixa.');
  }

  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
