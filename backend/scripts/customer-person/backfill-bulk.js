/* Bulk equivalent of backfill-shadow: one atomic, audited transaction. */
const {Client}=require('pg');const{randomUUID}=require('node:crypto');const path=require('node:path');const{normalizeCpf}=require('./backfill-shadow');const{collect}=require('../customer-integrity/collect');const{compareSnapshots,readJson}=require('../customer-integrity/lib');
async function run(){
 if(process.env.CUSTOMER_PERSON_BACKFILL_ENABLED!=='1')throw new Error('CUSTOMER_PERSON_BACKFILL_ENABLED=1 obrigatório');
 const batchId=process.argv.find(x=>x.startsWith('--batch-id='))?.slice(11);if(!batchId||!/^[\w.:-]{8,80}$/.test(batchId))throw new Error('batch-id inválido');
 const connectionString=process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL;const c=new Client({connectionString,ssl:{rejectUnauthorized:false}});await c.connect();
 try{
  const reused=await c.query('SELECT 1 FROM person_link_audits WHERE batch_id=$1 LIMIT 1',[batchId]);if(reused.rowCount)throw new Error('batch-id já usado');
  const rows=(await c.query(`SELECT id,cpf,name,email,phone,created_at FROM customers WHERE person_id IS NULL AND cpf IS NOT NULL ORDER BY created_at,id`)).rows;
  const payload=rows.map(customer=>({customer,cpf:normalizeCpf(customer.cpf)})).filter(x=>x.cpf).map(({customer,cpf})=>({customerId:customer.id,cpf,name:customer.name,email:customer.email,phone:customer.phone,createdAt:customer.created_at,personId:randomUUID(),identifierId:randomUUID(),auditId:randomUUID()}));
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='120s'");const before=await collect(c);
  await c.query(`CREATE TEMP TABLE b(customer_id text PRIMARY KEY,cpf varchar(11),name text,email text,phone text,created_at timestamptz,person_id text,identifier_id text,audit_id text) ON COMMIT DROP`);
  await c.query(`INSERT INTO b SELECT "customerId",cpf,name,email,phone,"createdAt","personId","identifierId","auditId" FROM jsonb_to_recordset($1::jsonb) x("customerId" text,cpf text,name text,email text,phone text,"createdAt" timestamptz,"personId" text,"identifierId" text,"auditId" text)`,[JSON.stringify(payload)]);
  await c.query(`INSERT INTO persons(id,cpf_normalized,identity_status,name,email,phone,primary_customer_id,first_registration_at,first_registration_source,created_at,updated_at) SELECT DISTINCT ON(cpf) person_id,cpf,'confirmed',name,email,phone,customer_id,created_at,'flow',now(),now() FROM b ORDER BY cpf,created_at,customer_id ON CONFLICT(cpf_normalized) DO NOTHING`);
  await c.query(`UPDATE b SET person_id=p.id FROM persons p WHERE p.cpf_normalized=b.cpf`);
  const updated=await c.query(`UPDATE customers SET person_id=b.person_id FROM b WHERE customers.id=b.customer_id AND customers.person_id IS NULL RETURNING customers.id`);
  await c.query(`INSERT INTO person_identifiers(id,person_id,type,normalized_value,unique_key,verified,source,source_customer_id,verified_at,created_at,updated_at) SELECT identifier_id,person_id,'cpf',cpf,'cpf:'||cpf,true,'customer_backfill',customer_id,now(),now(),now() FROM b ON CONFLICT DO NOTHING`);
  await c.query(`INSERT INTO person_link_audits(id,person_id,entity_type,entity_id,rule,confidence,automatic,batch_id,metadata,created_at) SELECT audit_id,person_id,'customer',customer_id,'valid_cpf_exact',100,true,$1,jsonb_build_object('cpfLast4',right(cpf,4),'source','safe_bulk_v2'),now() FROM b ON CONFLICT(person_id,entity_type,entity_id,rule) DO NOTHING`,[batchId]);
  const after=await collect(c);const failures=compareSnapshots(before,after,readJson(path.join(__dirname,'..','customer-integrity','config.json')));if(failures.length)throw new Error(`gate reprovado: ${JSON.stringify(failures)}`);
  await c.query('COMMIT');console.log(JSON.stringify({batchId,eligible:payload.length,applied:updated.rowCount,gate:'approved'},null,2));
 }catch(e){try{await c.query('ROLLBACK')}catch{}throw e}finally{await c.end()}
}
run().catch(e=>{console.error(e.message);process.exitCode=1});
