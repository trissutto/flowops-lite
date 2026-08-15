const https = require('https');
function api(path, method='GET', body){const base=(process.env.MAUTIC_BASE||'').replace(/\/+$/,'');const auth='Basic '+Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');const data=body?JSON.stringify(body):null;return new Promise((res,rej)=>{const r=https.request(`${base}/api${path}`,{method,headers:{Authorization:auth,Accept:'application/json','Content-Type':'application/json'}},rs=>{let d='';rs.on('data',c=>d+=c);rs.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(new Error(d.slice(0,150)))}})});r.on('error',rej);if(data)r.write(data);r.end()})}
(async()=>{
  for (const id of [132,133]) {
    const r = await api(`/emails/${id}`);
    const e = r.email||{};
    const lists=(e.lists||[]).map(l=>`${l.name}(${l.id})`).join(',');
    console.log(`id ${id}: sent=${e.sentCount} pub=${e.isPublished} listas=${lists} criado=${e.dateAdded}`);
  }
})().catch(e=>{console.error(e.message);process.exit(1)});
