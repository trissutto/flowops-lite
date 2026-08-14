/**
 * Sobe uma imagem pro R2 (mesmo storage dos banners) e imprime a URL pública.
 * Uso: railway run --service flowops-lite node backend/scripts/subir-arte-r2.js "<caminho>" "<pasta/key-opcional>"
 */
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

async function main() {
  const arquivo = process.argv[2];
  if (!arquivo || !fs.existsSync(arquivo)) {
    console.error('Arquivo não encontrado:', arquivo);
    process.exit(2);
  }
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
    console.error('R2_* ausente no ambiente — rode com railway run --service flowops-lite');
    process.exit(2);
  }

  const ext = path.extname(arquivo).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const nome = path.basename(arquivo).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const key = (process.argv[3] || `email-marketing/${Date.now()}-${nome}`).replace(/^\/+/, '');

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });

  const body = fs.readFileSync(arquivo);
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: mime,
    ContentDisposition: `inline; filename="${nome}"`,
  }));

  const url = `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
  console.log('\n══ ARTE NO AR ══');
  console.log('  tamanho:', (body.length / 1024).toFixed(0), 'KB');
  console.log('  URL PÚBLICA:', url);
}
main().catch((e) => { console.error(e); process.exit(1); });
