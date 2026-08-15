const https = require('https');
function api(path, method='GET'){const base=(process.env.MAUTIC_BASE||'').replace(/\/+$/,'');const auth='Basic '+Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');return new Promise((res,rej)=>{const r=https.request(`${base}/api${path}`,{method,headers:{Authorization:auth,Accept:'application/json'}},rs=>{let d='';rs.on('data',c=>d+=c);rs.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(new Error(d.slice(0,150)))}})});r.on('error',rej);r.end()})}
(async()=>{
  const id = process.argv[2];
  // primeiro despublica (para a fila na hora), depois apaga
  const del = await api(`/emails/${id}/delete`, 'DELETE');
  console.log('apagado id', id, '->', JSON.stringify(del).slice(0,120));
  // confere o que sobrou
  for (const x of [132,133]) { try { const r=await api(`/emails/${x}`); console.log(`id ${x}:`, r.email?'existe sent='+r.email.sentCount:'APAGADO'); } catch(e){ console.log(`id ${x}: erro`);} }
})().catch(e=>{console.error(e.message);process.exit(1)});
