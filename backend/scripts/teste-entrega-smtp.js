/**
 * O CAMINHO DO FLOWOPS ENTREGA? Manda a peça da campanha pelo NOSSO SMTP
 * (Google Workspace, atendimento@lurdsplussize.com.br) — sem passar pelo
 * Mautic nem pelo SES.
 *
 * Serve pra isolar a falha: se chega por aqui e não chega pelo Mautic, o
 * problema está no Mautic/SES, não na peça nem na base.
 *
 * Uso: railway run --service flowops-lite node backend/scripts/teste-entrega-smtp.js <destino> [arquivo.html]
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require(path.join(__dirname, '..', 'node_modules', 'nodemailer'));

(async () => {
  const destino = (process.argv[2] || '').trim();
  if (!destino.includes('@')) { console.error('uso: <destino> [arquivo.html]'); process.exit(2); }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) { console.error('SMTP_* ausente — rode com railway run'); process.exit(2); }
  console.log(`SMTP: ${SMTP_HOST}:${SMTP_PORT} · de ${SMTP_USER}`);

  const arquivo = process.argv[3];
  const html = arquivo && fs.existsSync(arquivo)
    ? fs.readFileSync(arquivo, 'utf8')
    : '<p>Teste de entrega do FlowOps.</p>';

  const t = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await t.verify();
  console.log('conexão SMTP: OK');

  const info = await t.sendMail({
    from: SMTP_FROM && SMTP_FROM.includes('@') ? SMTP_FROM : `Lurd's Plus Size <${SMTP_USER}>`,
    to: destino,
    subject: '[TESTE FlowOps] A camiseta que estica muito e não dá bolinha — R$ 69,90',
    html,
    text: 'Teste de entrega pelo caminho do FlowOps (Google Workspace), sem passar pelo Mautic.',
  });

  console.log(`\n  ✉️  enviado pra ${destino}`);
  console.log(`  messageId: ${info.messageId}`);
  console.log(`  aceito por: ${JSON.stringify(info.accepted)} · recusado: ${JSON.stringify(info.rejected)}`);
  console.log(`  resposta do servidor: ${info.response}`);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
