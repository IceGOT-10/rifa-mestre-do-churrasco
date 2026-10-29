'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const db = require('../src/db');
const { criarApp } = require('../src/server');

const arq = path.join(os.tmpdir(), `rifa-conc-${process.pid}.db`);
const limpar = () => ['', '-wal', '-shm'].forEach(s => fs.rmSync(arq + s, { force: true }));
limpar();

function worker(numero, nome, t0) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(__dirname, '_worker.js'), arq, numero, nome, t0]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', c => c === 0 ? res(JSON.parse(out.trim())) : rej(new Error(err)));
  });
}

(async () => {
  const conn = db.abrir(arq);

  console.log('== TESTE 1: 2 processos independentes disputando o número 07 no mesmo instante ==');
  let t0 = Date.now() + 600;
  const r1 = await Promise.all([worker(7, 'Ana', t0), worker(7, 'Bruno', t0)]);
  r1.forEach(r => console.log(' ', JSON.stringify(r)));
  assert.equal(r1.filter(r => r.ok).length, 1, 'exatamente 1 vencedor');
  const perdedor1 = r1.find(r => !r.ok);
  assert.equal(perdedor1.codigo, 'INDISPONIVEL');
  assert.equal(
    perdedor1.erro,
    'Ops! O número 07 acabou de ser reservado por outro participante. Por favor, escolha outro número disponível na grade.'
  );
  const venc = r1.find(r => r.ok).nome;
  const linha = conn.prepare('SELECT * FROM numeros WHERE numero=7').get();
  assert.equal(linha.status, 'PENDENTE');
  assert.equal(linha.reservado_por, venc, 'banco guarda apenas o vencedor');
  console.log(`  OK: vencedor=${venc}, perdedor recebeu rollback e alerta padrão.`);

  console.log('== TESTE 2: Simulação HTTP de 2 clientes (simultâneo + atraso de 1 segundo do Usuário B) ==');
  const app = criarApp(conn);
  const srv = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (url, body) =>
    fetch(base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // 2A: Colisão simultânea HTTP no número 12
  const [respSimA, respSimB] = await Promise.all([
    post('/api/reservar', { numero: 12, nome: 'Cliente A', whatsapp: '11988881111', sessaoId: 'sess_A' }),
    post('/api/reservar', { numero: 12, nome: 'Cliente B', whatsapp: '11988882222', sessaoId: 'sess_B' }),
  ]);
  const statusSim = [respSimA.status, respSimB.status].sort((a, b) => a - b);
  assert.deepEqual(statusSim, [200, 409], '1 transação confirmada (200) e 1 rejeitada com conflito (409)');
  const jsonSimA = await respSimA.json();
  const jsonSimB = await respSimB.json();
  const vencedoresSim = [jsonSimA, jsonSimB].filter(x => x.ok);
  const perdedoresSim = [jsonSimA, jsonSimB].filter(x => !x.ok);
  assert.equal(vencedoresSim.length, 1);
  assert.equal(perdedoresSim.length, 1);
  assert.equal(
    perdedoresSim[0].erro,
    'Ops! O número 12 acabou de ser reservado por outro participante. Por favor, escolha outro número disponível na grade.'
  );
  console.log('  OK (2A): Colisão simultânea via HTTP tratada atomicamente.');

  // 2B: Etapa 1 (Pré-bloqueio de 3 min) + Etapa 2 com Usuário B enviando 1 segundo após Usuário A na cota 15
  const preA = await (await post('/api/pre-reservar', { numero: 15, sessaoId: 'token_user_A' })).json();
  assert.equal(preA.ok, true);

  // Usuário A finaliza a Etapa 2 ("Reservar e Pagar")
  const resFinalA = await post('/api/reservar', {
    numero: 15,
    nome: 'Usuário A (Vencedor)',
    whatsapp: '11999990001',
    sessaoId: 'token_user_A',
  });
  const bodyFinalA = await resFinalA.json();
  assert.equal(resFinalA.status, 200);
  assert.equal(bodyFinalA.ok, true);

  // Aguarda 1 segundo (1000ms) conforme especificação e dispara requisição do Usuário B
  await new Promise(r => setTimeout(r, 1000));
  const resFinalB = await post('/api/reservar', {
    numero: 15,
    nome: 'Usuário B (Atrasado 1s)',
    whatsapp: '11999990002',
    sessaoId: 'token_user_B',
  });
  const bodyFinalB = await resFinalB.json();
  assert.equal(resFinalB.status, 409);
  assert.equal(bodyFinalB.ok, false);
  assert.equal(bodyFinalB.codigo, 'INDISPONIVEL');
  assert.equal(
    bodyFinalB.erro,
    'Ops! O número 15 acabou de ser reservado por outro participante. Por favor, escolha outro número disponível na grade.'
  );

  // Verifica que o banco manteve intacto o registro do Usuário A (rollback de B confirmado)
  const reg15 = conn.prepare('SELECT * FROM numeros WHERE numero = 15').get();
  assert.equal(reg15.reservado_por, 'Usuário A (Vencedor)');
  assert.equal(reg15.whatsapp, '11999990001');
  console.log('  OK (2B): Usuário B (1s após A) sofreu rollback com mensagem exata e estado de A preservado.');

  srv.close();

  console.log('== TESTE 3: 12 processos simultâneos disputando o número 08 ==');
  t0 = Date.now() + 900;
  const nomes = Array.from({ length: 12 }, (_, i) => `Cliente${i}`);
  const r2 = await Promise.all(nomes.map(n => worker(8, n, t0)));
  const ok = r2.filter(r => r.ok);
  console.log(`  sucessos=${ok.length} falhas=${r2.length - ok.length} vencedor=${ok[0]?.nome}`);
  assert.equal(ok.length, 1);
  assert.equal(conn.prepare('SELECT reservado_por FROM numeros WHERE numero=8').get().reservado_por, ok[0].nome);

  console.log('== TESTE 4: 20 reservas concorrentes em números DIFERENTES (sem interferência) ==');
  t0 = Date.now() + 900;
  const r3 = await Promise.all(Array.from({ length: 20 }, (_, i) => worker(20 + i, `U${i}`, t0)));
  assert.equal(r3.filter(r => r.ok).length, 20);
  console.log('  OK: 20/20 reservados');

  console.log('== TESTE 5: validações de entrada ==');
  assert.equal(db.reservar(conn, 61, 'X Y', '11999998888').codigo, 'NUMERO_INVALIDO');
  assert.equal(db.reservar(conn, 1, '', '11999998888').codigo, 'NOME_INVALIDO');
  assert.equal(db.reservar(conn, 1, 'Ana', '123').codigo, 'WHATSAPP_INVALIDO');
  console.log('  OK');

  conn.close();
  limpar();
  console.log('\nCONCORRÊNCIA: TODOS OS TESTES PASSARAM');
})().catch(e => {
  console.error('FALHOU:', e);
  limpar();
  process.exit(1);
});
