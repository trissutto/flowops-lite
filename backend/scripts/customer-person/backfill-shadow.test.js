const test=require('node:test');const assert=require('node:assert/strict');const{normalizeCpf}=require('./backfill-shadow');
test('aceita CPF válido formatado',()=>assert.equal(normalizeCpf('529.982.247-25'),'52998224725'));
test('rejeita CPF inválido',()=>{assert.equal(normalizeCpf('111.111.111-11'),null);assert.equal(normalizeCpf('529.982.247-24'),null);assert.equal(normalizeCpf('123'),null);});
