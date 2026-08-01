/**
 * LISTA DE CONFERÊNCIA das liquidações de cartão de 01/08/2026.
 *
 * Pedido do dono: "gere uma lista com nome do cliente e quantidade de parcelas
 * baixadas pra eu conferir se não baixou de algum outro cliente".
 *
 * Lê os arquivos de REVERSÃO — o registro exato do que foi escrito, não uma
 * query aproximada. (Uma query do tipo "PAGO='S' e PAGAMENTO=VENCIMENTO" NÃO
 * serve: ela mistura o que o script fez com todo cliente que historicamente
 * pagou na data certa. Isso já assustou o dono à toa hoje.)
 *
 * Só faz SELECT.
 *   railway run --service Postgres -- node backend/scripts/giga-etl/conferir-baixas-cartao.js
 */
const fs=require('fs'), path=require('path'), mysql=require('mysql2/promise'), dotenv=require('dotenv');
dotenv.config({ path: path.join(path.resolve(__dirname,'..','..'), '.env'), override:false });
const BRL=n=>`R$ ${Number(n||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
(async()=>{
  const arquivos=fs.readdirSync(__dirname).filter(f=>/^reversao-cartao.*\.json$/.test(f));
  const regs=new Map();
  for(const a of arquivos){
    const L=JSON.parse(fs.readFileSync(path.join(__dirname,a),'utf8'));
    console.log(`${a}: ${L.length} linhas`);
    for(const r of L) regs.set(String(r.REGISTRO), a);
  }
  console.log(`TOTAL DE PARCELAS ESCRITAS: ${regs.size}`);
  console.log('');
  const my=await mysql.createConnection({host:process.env.ERP_HOST,port:Number(process.env.ERP_PORT||3306),
    user:process.env.ERP_USER,password:process.env.ERP_PASSWORD,database:process.env.ERP_DATABASE,connectTimeout:20000});
  await my.query('SET SQL_BIG_SELECTS=1');
  const ids=[...regs.keys()]; const por=new Map(); const LOTE=800;
  for(let i=0;i<ids.length;i+=LOTE){
    const lote=ids.slice(i,i+LOTE).map(x=>`'${x.replace(/'/g,'')}'`).join(',');
    const [r]=await my.query(
      `SELECT COALESCE(c.NOME,'(ficha nao encontrada)') ficha, m.LOJA, m.CODCLIENTE,
              m.NOME bandeira, COUNT(*) n, SUM(m.VALORPARCELA) v
         FROM movimento m LEFT JOIN clientes c ON c.LOJA=m.LOJA AND c.CODIGO=m.CODCLIENTE
        WHERE m.REGISTRO IN (${lote})
        GROUP BY c.NOME, m.LOJA, m.CODCLIENTE, m.NOME`);
    for(const x of r){
      const k=`${x.ficha}|${x.LOJA}|${x.CODCLIENTE}|${x.bandeira}`;
      const cur=por.get(k)||{...x,n:0,v:0};
      cur.n+=Number(x.n); cur.v+=Number(x.v); por.set(k,cur);
    }
  }
  const linhas=[...por.values()].sort((a,b)=>b.v-a.v);
  console.log('NOME DA FICHA                        LOJA COD   BANDEIRA         PARCELAS           VALOR');
  console.log('─'.repeat(96));
  let tn=0,tv=0;
  for(const x of linhas){
    console.log(`${String(x.ficha).slice(0,34).padEnd(36)} ${String(x.LOJA).padEnd(4)} ${String(x.CODCLIENTE).padEnd(5)} `+
      `${String(x.bandeira).slice(0,14).padEnd(15)} ${String(x.n).padStart(8)}  ${BRL(x.v).padStart(15)}`);
    tn+=x.n; tv+=x.v;
  }
  console.log('─'.repeat(96));
  console.log(`${''.padEnd(63)}${String(tn).padStart(8)}  ${BRL(tv).padStart(15)}`);
  console.log('');
  const bandeiras=new Set(linhas.map(x=>String(x.bandeira).toUpperCase().trim()));
  console.log(`Bandeiras tocadas (${bandeiras.size}): ${[...bandeiras].join(' · ')}`);
  console.log('Se alguma dessas NAO for cartao, a linha correspondente e um erro.');
  await my.end();
})().catch(e=>{console.log('ERRO:',e.message);process.exit(1);});
