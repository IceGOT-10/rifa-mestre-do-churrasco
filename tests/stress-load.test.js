'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const db = require('../src/db');
const { criarApp } = require('../src/server');

const arqDb = path.join(os.tmpdir(), `rifa-stress-${process.pid}.db`);
const limpar = () => ['', '-wal', '-shm'].forEach(s => fs.rmSync(arqDb + s, { force: true }));
limpar();

(async () => {
  const conn = db.abrir(arqDb, { total: 100, forcarRateLimit: true });
  const app = criarApp(conn, {
    adminUser: 'admin',
    adminPass: 'churrasco123',
  });

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

  const get = (url, headers = {}) =>
    fetch(base + url, {
      headers,
    });

  console.log('================================================================');
  console.log('--- ETAPA 2: TESTES DE CONCORRÊNCIA E CARGA (STRESS / LOAD) ---');
  console.log('================================================================\n');

  // =========================================================================
  // 1. Teste de Colisão Massiva de Gravação (50 Concorrentes na Mesma Cota)
  // =========================================================================
  console.log('1. Teste de Colisão Massiva de Gravação (50 requisições simultâneas na cota 25):');
  const cotaAlvo = 25;
  const totalConcorrentes = 50;
  const temposInicio = [];
  const temposFim = [];

  const tDisparo = Date.now() + 50;
  const promessasColisao = Array.from({ length: totalConcorrentes }, async (_, idx) => {
    const espera = tDisparo - Date.now();
    if (espera > 0) await new Promise(r => setTimeout(r, espera));

    const t0 = performance.now();
    temposInicio.push(t0);
    const resp = await post('/api/reservar', {
      numero: cotaAlvo,
      nome: `Participante_${idx + 1}`,
      whatsapp: `1199999${String(idx + 1).padStart(4, '0')}`,
      sessaoId: `sess_colisao_${idx + 1}`,
    });
    const t1 = performance.now();
    temposFim.push(t1);

    const json = await resp.json().catch(() => ({}));
    return {
      idx: idx + 1,
      status: resp.status,
      duracaoMs: t1 - t0,
      json,
    };
  });

  const resultadosColisao = await Promise.all(promessasColisao);

  const sucessos = resultadosColisao.filter(r => r.status === 200 || r.status === 201);
  const conflitos = resultadosColisao.filter(r => r.status === 409);
  const erros500 = resultadosColisao.filter(r => r.status >= 500);
  const outrosErros = resultadosColisao.filter(r => r.status !== 200 && r.status !== 201 && r.status !== 409);

  const duracoes = resultadosColisao.map(r => r.duracaoMs);
  const latenciaMin = Math.min(...duracoes).toFixed(2);
  const latenciaMax = Math.max(...duracoes).toFixed(2);
  const latenciaMed = (duracoes.reduce((a, b) => a + b, 0) / duracoes.length).toFixed(2);

  console.log(`  -> Requisições disparadas: ${totalConcorrentes}`);
  console.log(`  -> Sucessos (Status 200/201): ${sucessos.length} (Vencedor: ${sucessos[0]?.json?.nome || 'N/A'})`);
  console.log(`  -> Conflitos tratados (Status 409): ${conflitos.length}`);
  console.log(`  -> Erros 500 ou SQLITE_BUSY: ${erros500.length}`);
  console.log(`  -> Outros status anômalos: ${outrosErros.length}`);
  console.log(`  -> Latência (min / média / max): ${latenciaMin}ms / ${latenciaMed}ms / ${latenciaMax}ms`);

  // Asserções estritas
  assert.equal(sucessos.length, 1, 'Critério: Exatamente 1 requisição deve receber status 200/201');
  assert.equal(conflitos.length, 49, 'Critério: As outras 49 requisições devem receber status 409');
  assert.equal(erros500.length, 0, 'Critério: NENHUMA requisição pode estourar status 500 ou SQLITE_BUSY');
  assert.equal(outrosErros.length, 0, 'Nenhum outro status inesperado');

  // Validação da mensagem amigável em todos os 49 conflitos
  const mensagemEsperada = `Ops! O número 25 acabou de ser reservado por outro participante. Por favor, escolha outro número disponível na grade.`;
  for (const c of conflitos) {
    assert.equal(c.json.codigo, 'INDISPONIVEL');
    assert.equal(c.json.erro, mensagemEsperada);
  }

  // Validação de integridade no banco
  const rowCota25 = conn.prepare('SELECT status, etapa, reservado_por FROM numeros WHERE numero = 25').get();
  assert.equal(rowCota25.status, 'PENDENTE');
  assert.equal(rowCota25.etapa, 'RESERVADO');
  assert.equal(rowCota25.reservado_por, sucessos[0].json.nome);
  console.log('  [PASS] Teste de Colisão Massiva: 100% aprovado!\n');

  // =========================================================================
  // 2. Teste de Sobrecarga de Leitura vs. Escrita (Polling Burden)
  // =========================================================================
  console.log('2. Teste de Sobrecarga de Leitura vs. Escrita (Polling Burden):');
  console.log('   Simulando 30 clientes em polling a cada 200ms com reservas simultâneas sob BEGIN IMMEDIATE...');

  let pollingAtivo = true;
  let totalLeituras = 0;
  let leiturasFalhas = 0;
  const latenciasLeitura = [];

  // Inicia 30 clientes executando polling GET /api/numeros a cada 200ms
  const clientesPolling = Array.from({ length: 30 }, async (_, clientId) => {
    while (pollingAtivo) {
      const t0 = performance.now();
      try {
        const res = await get(`/api/numeros?sessaoId=poll_client_${clientId}`);
        const t1 = performance.now();
        latenciasLeitura.push(t1 - t0);
        if (res.status === 200) {
          totalLeituras++;
        } else {
          leiturasFalhas++;
        }
      } catch (err) {
        leiturasFalhas++;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  });

  // Aguarda 400ms para o polling começar a rodar a plena carga
  await new Promise(r => setTimeout(r, 400));

  // Dispara reservas simultâneas em cotas livres distintas (30 a 49) com BEGIN IMMEDIATE concorrente
  const reservasParalelas = Array.from({ length: 20 }, async (_, i) => {
    const num = 30 + i;
    const res = await post('/api/reservar', {
      numero: num,
      nome: `Participante_Poll_${num}`,
      whatsapp: `1198888${String(num).padStart(4, '0')}`,
      sessaoId: `sess_poll_write_${num}`,
    });
    return { num, status: res.status };
  });

  const resEscritas = await Promise.all(reservasParalelas);
  const escritasSucesso = resEscritas.filter(r => r.status === 200).length;

  // Mantém o polling rodando por mais 1,5 segundo para capturar o estado pós-escritas
  await new Promise(r => setTimeout(r, 1500));
  pollingAtivo = false;
  await Promise.all(clientesPolling);

  const medLatLeitura = (latenciasLeitura.reduce((a, b) => a + b, 0) / latenciasLeitura.length).toFixed(2);
  const maxLatLeitura = Math.max(...latenciasLeitura).toFixed(2);

  console.log(`  -> Total de leituras (GET /api/numeros) realizadas: ${totalLeituras}`);
  console.log(`  -> Leituras com falha: ${leiturasFalhas}`);
  console.log(`  -> Latência de leitura (média / max): ${medLatLeitura}ms / ${maxLatLeitura}ms`);
  console.log(`  -> Transações de escrita simultâneas concluídas: ${escritasSucesso}/20 com status 200`);

  assert.ok(totalLeituras > 200, 'Deve ter executado mais de 200 requisições de leitura');
  assert.equal(leiturasFalhas, 0, 'Zero falhas de leitura sob carga');
  assert.equal(escritasSucesso, 20, 'Todas as 20 escritas com BEGIN IMMEDIATE devem ter concluído com sucesso');
  console.log('  [PASS] Teste de Sobrecarga de Leitura vs. Escrita: WAL mode operou sem degradação nem bloqueios!\n');

  // =========================================================================
  // 3. Teste de Proteção contra Força Bruta
  // =========================================================================
  console.log('3. Teste de Proteção contra Força Bruta (6 tentativas consecutivas do mesmo IP):');
  const ipTeste = { 'x-client-id': 'ip-forca-bruta-stress-test' };
  const historicoTentativas = [];

  for (let tentativa = 1; tentativa <= 6; tentativa++) {
    const res = await post(
      '/api/admin/login',
      { usuario: 'admin', senha: `senha_incorreta_${tentativa}` },
      ipTeste
    );
    const json = await res.json().catch(() => ({}));
    historicoTentativas.push({
      tentativa,
      status: res.status,
      json,
    });
    console.log(`  -> Tentativa #${tentativa}: HTTP ${res.status} | Código: ${json.codigo} | Msg: ${json.erro}`);
  }

  // Validação dos critérios de aceite
  assert.equal(historicoTentativas[0].status, 401, 'Tentativa 1 deve falhar com 401');
  assert.equal(historicoTentativas[1].status, 401, 'Tentativa 2 deve falhar com 401');
  assert.equal(historicoTentativas[2].status, 401, 'Tentativa 3 deve falhar com 401');

  assert.equal(historicoTentativas[3].status, 429, 'Tentativa 4 deve responder com 429');
  assert.equal(historicoTentativas[4].status, 429, 'Tentativa 5 deve responder com 429');
  assert.equal(historicoTentativas[5].status, 429, 'Tentativa 6 deve responder com 429');

  assert.equal(historicoTentativas[3].json.codigo, 'BLOQUEADO_TEMPORARIAMENTE');
  assert.ok(historicoTentativas[3].json.segundosRestantes > 0);

  console.log('  [PASS] Proteção contra Força Bruta: Primeiras 3 requisições 401; da 4ª em diante 429 bloqueado!\n');

  srv.close();
  conn.close();
  limpar();
  console.log('================================================================');
  console.log('--> ETAPA 2 (STRESS & LOAD TESTING) CONCLUÍDA COM SUCESSO 100%!');
  console.log('================================================================\n');
})().catch(err => {
  console.error('\n[FALHA NA ETAPA 2]:', err);
  try { srv.close(); } catch (_) {}
  try { conn.close(); } catch (_) {}
  try { limpar(); } catch (_) {}
  process.exit(1);
});

