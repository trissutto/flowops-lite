const fs = require('node:fs');
const SELECT_ONLY = /^\s*(?:with\b[\s\S]+?\bselect\b|select\b)/i;
const FORBIDDEN_SQL = /\b(insert|update|delete|merge|alter|drop|truncate|create|grant|revoke|copy|call|do|vacuum|reindex|refresh)\b/i;
function assertReadOnlySql(sql) { const clean=String(sql||'').replace(/--.*$/gm,'').trim(); if(!SELECT_ONLY.test(clean)||FORBIDDEN_SQL.test(clean)) throw new Error('Consulta de baseline deve ser exclusivamente SELECT'); }
function valueAt(source,path){return path.split('.').reduce((value,key)=>value?.[key],source);}
function compareSnapshots(before,after,config){
 if(before.schemaVersion!==after.schemaVersion||after.schemaVersion!==config.schemaVersion)return [{path:'schemaVersion',reason:'versão incompatível',before:before.schemaVersion,after:after.schemaVersion}];
 const failures=[]; for(const [path,allowed] of Object.entries(config.allowedDecreases||{})){const oldValue=Number(valueAt(before,path));const newValue=Number(valueAt(after,path));if(!Number.isFinite(oldValue)||!Number.isFinite(newValue)){failures.push({path,reason:'valor ausente ou inválido',before:valueAt(before,path),after:valueAt(after,path)});continue;}const decrease=oldValue-newValue;if(decrease>Number(allowed))failures.push({path,reason:'redução acima da tolerância',before:oldValue,after:newValue,decrease,allowedDecrease:allowed});} return failures;
}
function readJson(path){return JSON.parse(fs.readFileSync(path,'utf8'));}
module.exports={assertReadOnlySql,compareSnapshots,readJson,valueAt};
