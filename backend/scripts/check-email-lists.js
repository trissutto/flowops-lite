const https = require('https');
function api(path){const base=(process.env.MAUTIC_BASE||'').replace(/\/+$/,'');const auth='Basic '+Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');return new Promise((res,rej)=>{https.get(`${base}/api${path}`,{headers:{Authorization:auth,Accept:'application/json'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(new Error(d.slice(0,150)))}})}).on('error',rej)})}
(async()=>{
  for (const id of [129,130]) {
    const r = await api(`/emails/${id}`);
    const e = r.email || {};
    const lists = (e.lists||[]).map(l=>`${l.name} (id ${l.id})`).join(', ');
    console.log(`email ${id}: "${(e.subject||'').slice(0,40)}" · enviados ${e.sentCount} · listas: ${lists||'—'} · criado ${e.dateAdded}`);
  }
})().catch(e=>{console.error(e.message);process.exit(1)});
