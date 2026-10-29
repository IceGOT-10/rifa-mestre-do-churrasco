'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const db = require('../src/db');
const { criarApp } = require('../src/server');

const arqDb = path.join(os.tmpdir(), `rifa-stress-120-${process.pid}.db`);
const limpar = () => ['', '-wal', '-shm'].forEach(s => fs.rmSync(arqDb + s, { force: true }));
limpar();

(async () => {
  // Inicializa rifa com 150 cotas para permitir reservas simultâneas
  const conn = db.abrir(arqDb, { total: 150 });
  const app = criarApp(conn);

  const srv = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;

  const post = (url, body, headers = {}) =>
    fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const get = (url, headers = {}) => fetch(base + url, { headers });

  console.log('========================================================================');
  console.log('--- TESTE DE ESTRESSE COM 120 PARTICIPANTES SIMULTÂNEOS ---');
  console.log('========================================================================\n');

  const TOTAL_USUARIOS = 120;
  console.log(`Configuração: ${TOTAL_USUARIOS} clientes concorrentes simulados.`);

  // -------------------------------------------------------------------------
  // FASE 1: Acesso Inicial em Massa (120 usuários carregando a página e grade)
  // -------------------------------------------------------------------------
  console.log('\n[Fase 1] 120 usuários requisitando a grade simultaneamente (GET /api/numeros)...');
  const tInicioFase1 = performance.now();
  const reqsFase1 = Array.from({ length: TOTAL_USUARIOS }, async (_, i) => {
    const t0 = performance.now();
    const res = await get(`/api/numeros?sessaoId=user_${i + 1}`);
    const t1 = performance.now();
    return {
      userId: i + 1,
      status: res.status,
      duracaoMs: t1 - t0,
    };
  });

  const resultadosFase1 = await Promise.all(reqsFase1);
  const tFimFase1 = performance.now();

  const sucessosF1 = resultadosFase1.filter(r => r.status === 200).length;
  const latF1 = resultadosFase1.map(r => r.duracaoMs);
  const medF1 = (latF1.reduce((a, b) => a + b, 0) / latF1.length).toFixed(2);
  const maxF1 = Math.max(...latF1).toFixed(2);
  const minF1 = Math.min(...latF1).toFixed(2);
  const rpsF1 = ((TOTAL_USUARIOS / (tFimFase1 - tInicioFase1)) * 1000).toFixed(1);

  console.log(`  -> Sucessos (HTTP 200): ${sucessosF1}/${TOTAL_USUARIOS}`);
  console.log(`  -> Latência (min / média / máx): ${minF1}ms / ${medF1}ms / ${maxF1}ms`);
  console.log(`  -> Vazão (Throughput): ${rpsF1} req/s`);
  assert.equal(sucessosF1, TOTAL_USUARIOS, 'Todas as 120 leituras devem responder 200 OK');

  // -------------------------------------------------------------------------
  // FASE 2: Disputa Feroz por "Número da Sorte" (50 usuários no número 07)
  // -------------------------------------------------------------------------
  console.log('\n[Fase 2] Colisão direta: 50 dos 120 usuários tentando reservar a MESMA cota (#07) no mesmo milissegundo...');
  const tDisparoFase2 = Date.now() + 40;
  const reqsFase2 = Array.from({ length: 50 }, async (_, i) => {
    const espera = tDisparoFase2 - Date.now();
    if (espera > 0) await new Promise(r => setTimeout(r, espera));

    const t0 = performance.now();
    const res = await post('/api/reservar', {
      numero: 7,
      nome: `Participante_Hot_${i + 1}`,
      whatsapp: `1199999${String(i + 1).padStart(4, '0')}`,
      sessaoId: `sess_hot_${i + 1}`,
    });
    const t1 = performance.now();
    const json = await res.json().catch(() => ({}));
    return {
      userId: i + 1,
      status: res.status,
      duracaoMs: t1 - t0,
      json,
    };
  });

  const resultadosFase2 = await Promise.all(reqsFase2);
  const sucessosF2 = resultadosFase2.filter(r => r.status === 200);
  const conflitosF2 = resultadosFase2.filter(r => r.status === 409);
  const erros500F2 = resultadosFase2.filter(r => r.status >= 500);

  const latF2 = resultadosFase2.map(r => r.duracaoMs);
  const medF2 = (latF2.reduce((a, b) => a + b, 0) / latF2.length).toFixed(2);
  const maxF2 = Math.max(...latF2).toFixed(2);

  console.log(`  -> Vencedor único (HTTP 200): ${sucessosF2.length} (${sucessosF2[0]?.json?.nome || 'Nenhum'})`);
  console.log(`  -> Rejeições elegantes com rollback (HTTP 409): ${conflitosF2.length}`);
  console.log(`  -> Falhas ou erros 500 / SQLITE_BUSY: ${erros500F2.length}`);
  console.log(`  -> Latência média: ${medF2}ms (máx: ${maxF2}ms)`);

  assert.equal(sucessosF2.length, 1, 'Exatamente 1 deve ser reservado');
  assert.equal(conflitosF2.length, 49, 'Outros 49 devem receber 409');
  assert.equal(erros500F2.length, 0, 'Zero erros 500');

  // -------------------------------------------------------------------------
  // FASE 3: Carga Mista Extrema (120 usuários ativos em simultâneo)
  // - 70 usuários reservando cotas distintas
  // - 50 usuários em polling contínuo (GET /api/numeros)
  // -------------------------------------------------------------------------
  console.log('\n[Fase 3] Carga Mista: 70 usuários gravando cotas diferentes enquanto 50 realizam polling contínuo...');
  let pollingAtivo = true;
  let totalPollings = 0;
  let falhasPolling = 0;
  const latenciasPolling = [];

  // 50 usuários em polling contínuo
  const promessasPolling = Array.from({ length: 50 }, async (_, idx) => {
    while (pollingAtivo) {
      const t0 = performance.now();
      try {
        const res = await get(`/api/numeros?sessaoId=poll_user_${idx + 1}`);
        const t1 = performance.now();
        latenciasPolling.push(t1 - t0);
        if (res.status === 200) totalPollings++;
        else falhasPolling++;
      } catch {
        falhasPolling++;
      }
      await new Promise(r => setTimeout(r, 150));
    }
  });

  // 70 usuários efetuando reservas em cotas disponíveis (de 10 a 79)
  const tInicioGravacoes = performance.now();
  const reqsGravacaoF3 = Array.from({ length: 70 }, async (_, i) => {
    const cota = 10 + i;
    const t0 = performance.now();
    const res = await post('/api/reservar', {
      numero: cota,
      nome: `Comprador_${i + 1}`,
      whatsapp: `1198888${String(i + 1).padStart(4, '0')}`,
      sessaoId: `sess_comprador_${i + 1}`,
    });
    const t1 = performance.now();
    return {
      cota,
      status: res.status,
      duracaoMs: t1 - t0,
    };
  });

  const resultadosGravacaoF3 = await Promise.all(reqsGravacaoF3);
  const tFimGravacoes = performance.now();

  // Deixa o polling rodar por mais 500ms
  await new Promise(r => setTimeout(r, 500));
  pollingAtivo = false;
  await Promise.all(promessasPolling);

  const escritasOkF3 = resultadosGravacaoF3.filter(r => r.status === 200).length;
  const escritasErroF3 = resultadosGravacaoF3.filter(r => r.status !== 200).length;
  const latGravF3 = resultadosGravacaoF3.map(r => r.duracaoMs);
  const medGravF3 = (latGravF3.reduce((a, b) => a + b, 0) / latGravF3.length).toFixed(2);
  const maxGravF3 = Math.max(...latGravF3).toFixed(2);

  const medPollF3 = (latenciasPolling.reduce((a, b) => a + b, 0) / latenciasPolling.length).toFixed(2);
  const maxPollF3 = Math.max(...latenciasPolling).toFixed(2);

  console.log(`  -> Reservas simultâneas confirmadas: ${escritasOkF3}/70 (HTTP 200)`);
  console.log(`  -> Falhas de escrita: ${escritasErroF3}`);
  console.log(`  -> Latência média de escrita: ${medGravF3}ms (máx: ${maxGravF3}ms)`);
  console.log(`  -> Consultas de polling atendidas sem travar: ${totalPollings} (falhas: ${falhasPolling})`);
  console.log(`  -> Latência média de leitura durante as escritas: ${medPollF3}ms (máx: ${maxPollF3}ms)`);

  assert.equal(escritasOkF3, 70, 'Todas as 70 reservas devem ser concluídas com sucesso');
  assert.equal(falhasPolling, 0, 'Zero falhas de leitura durante concorrência de escritas');

  // -------------------------------------------------------------------------
  // FASE 4: Verificação de Integridade e Isolamento no Banco de Dados
  // -------------------------------------------------------------------------
  console.log('\n[Fase 4] Auditoria de Integridade e Consistência no SQLite...');
  const totalOcupadas = conn.prepare("SELECT COUNT(*) AS c FROM numeros WHERE status <> 'DISPONIVEL'").get().c;
  // Cota 7 (1 da Fase 2) + 70 cotas (Fase 3) = 71 cotas reservadas
  assert.equal(totalOcupadas, 71, 'Total de cotas ocupadas no banco deve ser exatamente 71');

  // Checa duplicidades no banco
  const duplicados = conn.prepare(`
    SELECT numero, COUNT(*) as c FROM numeros GROUP BY numero HAVING c > 1
  `).all();
  assert.equal(duplicados.length, 0, 'Nenhuma cota duplicada');

  console.log(`  -> Total de cotas ocupadas registradas com integridade: ${totalOcupadas}`);
  console.log('  -> Nenhuma colisão residual, double-booking ou corrupção identificada.');

  srv.close();
  conn.close();
  limpar();

  console.log('\n========================================================================');
  console.log('--> TESTE DE ESTRESSE COM 120 PESSOAS FINALIZADO COM 100% DE SUCESSO!');
  console.log('========================================================================\n');
})().catch(err => {
  console.error('\n[FALHA NO TESTE DE ESTRESSE]:', err);
  try { srv.close(); } catch (_) {}
  try { conn.close(); } catch (_) {}
  try { limpar(); } catch (_) {}
  process.exit(1);
});

