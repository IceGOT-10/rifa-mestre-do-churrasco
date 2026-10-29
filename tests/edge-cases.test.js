'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');
const db = require('../src/db');
const { criarApp } = require('../src/server');

const arqDb = path.join(os.tmpdir(), `rifa-edge-${process.pid}.db`);
const limpar = () => ['', '-wal', '-shm'].forEach(s => fs.rmSync(arqDb + s, { force: true }));
limpar();

(async () => {
  const conn = db.abrir(arqDb, { total: 60 });
  const app = criarApp(conn, {
    adminUser: 'admin',
    adminPass: 'churrasco123',
  });

  const srv = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;

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

  // Login para operações de admin
  const resLogin = await post('/api/admin/login', { usuario: 'admin', senha: 'churrasco123' });
  const jsonLogin = await resLogin.json();
  assert.equal(resLogin.status, 200);
  const tokenAdmin = jsonLogin.token;
  const adminHeaders = { Authorization: `Bearer ${tokenAdmin}` };

  console.log('--- ETAPA 1: AUDITORIA DE LÓGICA E CASOS DE BORDA (EDGE CASES) ---');

  // =========================================================================
  // CENÁRIO 1: Validação de Entrada nas Cotas
  // =========================================================================
  console.log('1. Validação de Entrada nas Cotas:');

  // 1.1 Array vazio []
  {
    const r = await post('/api/reservar', {
      numeros: [],
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    const j = await r.json();
    assert.equal(r.status, 400, 'Array vazio [] deve retornar 400');
    assert.equal(j.ok, false);
    assert.equal(j.codigo, 'NUMERO_INVALIDO');
    console.log('  [PASS] Array vazio [] rejeitado com 400 NUMERO_INVALIDO');
  }

  // 1.2 Strings (não-numéricas ou vazias)
  {
    const r1 = await post('/api/reservar', {
      numero: 'abc',
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    assert.equal(r1.status, 400, 'String "abc" deve retornar 400');
    const j1 = await r1.json();
    assert.equal(j1.codigo, 'NUMERO_INVALIDO');

    const r2 = await post('/api/reservar', {
      numeros: ['xyz', '123'],
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    assert.equal(r2.status, 400, 'Array com string ["xyz"] deve retornar 400');

    const r3 = await post('/api/reservar', {
      numero: '',
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    assert.equal(r3.status, 400, 'String vazia "" deve retornar 400');
    console.log('  [PASS] Strings ("abc", ["xyz"], "") rejeitadas com 400 NUMERO_INVALIDO');
  }

  // 1.3 Floats (12.5)
  {
    const r1 = await post('/api/reservar', {
      numero: 12.5,
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    assert.equal(r1.status, 400, 'Float 12.5 deve retornar 400');
    const j1 = await r1.json();
    assert.equal(j1.codigo, 'NUMERO_INVALIDO');

    const r2 = await post('/api/reservar', {
      numeros: [10, 12.5],
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    assert.equal(r2.status, 400, 'Array com float [10, 12.5] deve retornar 400');
    console.log('  [PASS] Floats (12.5, [10, 12.5]) rejeitados com 400 NUMERO_INVALIDO');
  }

  // 1.4 Números negativos (-1, -10)
  {
    const r1 = await post('/api/reservar', {
      numero: -1,
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    assert.equal(r1.status, 400, 'Número negativo -1 deve retornar 400');
    const j1 = await r1.json();
    assert.equal(j1.codigo, 'NUMERO_INVALIDO');

    const r2 = await post('/api/reservar', {
      numeros: [-5, 10],
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    assert.equal(r2.status, 400, 'Array com negativo [-5, 10] deve retornar 400');
    console.log('  [PASS] Números negativos (-1, [-5, 10]) rejeitados com 400 NUMERO_INVALIDO');
  }

  // 1.5 Números acima do total da rifa ativa (61 quando total = 60)
  {
    const r = await post('/api/reservar', {
      numero: 61,
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    assert.equal(r.status, 400, 'Número acima do total (61) deve retornar 400');
    const j = await r.json();
    assert.equal(j.codigo, 'NUMERO_INVALIDO');
    console.log('  [PASS] Número acima do total (61 > 60) rejeitado com 400 NUMERO_INVALIDO');
  }

  // 1.6 Números repetidos no mesmo payload [10, 10]
  {
    const r = await post('/api/reservar', {
      numeros: [10, 10],
      nome: 'Testador',
      whatsapp: '11999990001',
    });
    assert.equal(r.status, 400, 'Payload com cotas repetidas [10, 10] deve retornar 400');
    const j = await r.json();
    assert.equal(j.codigo, 'NUMERO_INVALIDO');
    assert.match(j.erro, /repetid/i);
    console.log('  [PASS] Cotas repetidas no payload [10, 10] rejeitadas com 400 e erro descritivo');
  }

  // =========================================================================
  // CENÁRIO 2: Atomicidade em Seleção Múltipla
  // =========================================================================
  console.log('\n2. Atomicidade em Seleção Múltipla:');
  {
    // Cota 12 é previamente reservada
    const rPre12 = await post('/api/reservar', {
      numero: 12,
      nome: 'Ocupante 12',
      whatsapp: '11988880012',
      sessaoId: 'sess_ocupante_12',
    });
    assert.equal(rPre12.status, 200);

    // Certifica que 10 e 11 estão DISPONÍVEIS antes do teste
    const row10Antes = conn.prepare('SELECT status FROM numeros WHERE numero = 10').get();
    const row11Antes = conn.prepare('SELECT status FROM numeros WHERE numero = 11').get();
    assert.equal(row10Antes.status, 'DISPONIVEL');
    assert.equal(row11Antes.status, 'DISPONIVEL');

    // Tenta reservar [10, 11, 12] -> Conflito na cota 12
    const rMulti = await post('/api/reservar', {
      numeros: [10, 11, 12],
      nome: 'Tentativa Invalida',
      whatsapp: '11977770000',
      sessaoId: 'sess_tentativa',
    });
    assert.equal(rMulti.status, 409, 'Deve retornar 409 INDISPONIVEL devido à cota 12');
    const jMulti = await rMulti.json();
    assert.equal(jMulti.codigo, 'INDISPONIVEL');
    assert.equal(jMulti.numeroConflito, 12);

    // Garantir ROLLBACK total: 10 e 11 devem permanecer rigorosamente DISPONÍVEIS
    const row10Depois = conn.prepare('SELECT status, nome FROM numeros WHERE numero = 10').get();
    const row11Depois = conn.prepare('SELECT status, nome FROM numeros WHERE numero = 11').get();
    const row12Depois = conn.prepare('SELECT status, nome FROM numeros WHERE numero = 12').get();

    assert.equal(row10Depois.status, 'DISPONIVEL', 'Cota 10 deve continuar DISPONIVEL após rollback');
    assert.equal(row10Depois.nome, null);
    assert.equal(row11Depois.status, 'DISPONIVEL', 'Cota 11 deve continuar DISPONIVEL após rollback');
    assert.equal(row11Depois.nome, null);
    assert.equal(row12Depois.status, 'PENDENTE');
    assert.equal(row12Depois.nome, 'Ocupante 12', 'Cota 12 deve permanecer com o titular original');

    console.log('  [PASS] Pedido [10, 11, 12] sofreu ROLLBACK completo: 10 e 11 continuam 100% DISPONÍVEIS');
  }

  // =========================================================================
  // CENÁRIO 3: Ciclo de Vida do sessaoId e Timers
  // =========================================================================
  console.log('\n3. Ciclo de Vida do sessaoId e Timers:');
  {
    const agora = Date.now();

    // 3.1 Consistência de timers (10 minutos para Etapa 1 e Etapa 2)
    const rPre20 = await post('/api/pre-reservar', { numero: 20, sessaoId: 'sess_dono_20' });
    const jPre20 = await rPre20.json();
    assert.equal(rPre20.status, 200);
    const prazoPre = jPre20.tempo_limite - agora;
    assert.ok(prazoPre >= 10 * 60 * 1000 - 1000 && prazoPre <= 10 * 60 * 1000 + 2000, 'Pré-reserva deve ter timer de 10 min');

    // 3.2 sessaoId diferente NÃO consegue confirmar/reservar cota pré-bloqueada
    const rRoubo = await post('/api/reservar', {
      numero: 20,
      nome: 'Atacante Sessao B',
      whatsapp: '11999990002',
      sessaoId: 'sess_intruso',
    });
    assert.equal(rRoubo.status, 409, 'Sessão diferente deve receber 409 INDISPONIVEL');
    const jRoubo = await rRoubo.json();
    assert.equal(jRoubo.codigo, 'INDISPONIVEL');

    // Nem mesmo requisição sem sessaoId consegue roubar cota pré-bloqueada
    const rSemSessao = await post('/api/reservar', {
      numero: 20,
      nome: 'Sem Sessao',
      whatsapp: '11999990003',
    });
    assert.equal(rSemSessao.status, 409, 'Requisição sem sessaoId deve receber 409 INDISPONIVEL');

    // 3.3 sessaoId diferente NÃO consegue cancelar pré-reserva alheia
    const rCancelaIntruso = await post('/api/cancelar-pre-reserva', {
      numero: 20,
      sessaoId: 'sess_intruso',
    });
    const jCancelaIntruso = await rCancelaIntruso.json();
    assert.equal(jCancelaIntruso.ok, false);
    assert.equal(conn.prepare('SELECT status, etapa FROM numeros WHERE numero = 20').get().status, 'PENDENTE');

    // 3.4 O legítimo titular (sess_dono_20) consegue concluir a reserva
    const rDono = await post('/api/reservar', {
      numero: 20,
      nome: 'Dono Legítimo',
      whatsapp: '11999990020',
      sessaoId: 'sess_dono_20',
    });
    assert.equal(rDono.status, 200);
    const jDono = await rDono.json();
    const prazoPix = jDono.tempo_limite - agora;
    assert.ok(prazoPix >= 10 * 60 * 1000 - 1000 && prazoPix <= 10 * 60 * 1000 + 2000, 'Etapa 2 Pix deve ter timer de 10 min');

    // 3.5 Liberação EXATA de cotas após o prazo
    const limite20 = jDono.tempo_limite;
    // 1 segundo antes do prazo: NÃO expira
    db.expirar(conn, limite20 - 1000);
    assert.equal(conn.prepare('SELECT status FROM numeros WHERE numero = 20').get().status, 'PENDENTE');

    // Exatamente no prazo: DEVE expirar e voltar para DISPONIVEL
    const liberadas = db.expirar(conn, limite20);
    assert.ok(liberadas >= 1);
    const row20Expirada = conn.prepare('SELECT status, etapa, nome, sessao_id FROM numeros WHERE numero = 20').get();
    assert.equal(row20Expirada.status, 'DISPONIVEL');
    assert.equal(row20Expirada.etapa, 'LIVRE');
    assert.equal(row20Expirada.nome, null);
    assert.equal(row20Expirada.sessao_id, null);

    console.log('  [PASS] Timers consistentes de 10 min, sessaoId isolado contra intrusos e expiração precisa validada');
  }

  // =========================================================================
  // CENÁRIO 4: Regras do Painel Administrativo
  // =========================================================================
  console.log('\n4. Regras do Painel Administrativo:');
  {
    // 4.1 Impedir redução de cotas abaixo do maior número reservado ou pago
    // Reserva cota 45
    await post('/api/reservar', {
      numero: 45,
      nome: 'Participante 45',
      whatsapp: '11988880045',
      sessaoId: 'sess_45',
    });

    // Admin tenta reduzir para 40 (sendo que a cota 45 está ocupada)
    const rReduzir = await post(
      '/api/admin/config',
      { total: 40 },
      adminHeaders
    );
    assert.equal(rReduzir.status, 400, 'Redução de cotas abaixo da maior cota ocupada deve ser impedida com 400');
    const jReduzir = await rReduzir.json();
    assert.equal(jReduzir.codigo, 'COTAS_OCUPADAS_ACIMA');
    assert.match(jReduzir.erro, /45/);

    // Confirma que o total da rifa permaneceu inalterado (60)
    assert.equal(db.obterTotalCotas(conn), 60);
    console.log('  [PASS] Redução de cotas abaixo do maior número ocupado (40 < 45) foi bloqueada');

    // 4.2 Divisão por zero na fórmula de margem de lucro com 0 cotas pagas
    // Limpa todas as cotas para deixar 0 pagas
    conn.prepare("UPDATE numeros SET status = 'DISPONIVEL', etapa = 'LIVRE', nome = null, reservado_por = null, whatsapp = null").run();

    // Exporta planilha com 0 cotas pagas
    const bufPlanilha0 = await db.gerarPlanilhaXLSX(conn, Date.now(), null, 100);
    assert.ok(bufPlanilha0 && bufPlanilha0.byteLength > 0);

    // Carrega o workbook e valida a célula de Margem de Lucro (B16)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bufPlanilha0);
    const ws = wb.getWorksheet('Relatório da Rifa');
    const cellMargem = ws.getCell('B16');

    const formulaStr = cellMargem.formula || (cellMargem.value && cellMargem.value.formula) || '';
    const resCalculado = cellMargem.result !== undefined ? cellMargem.result : (cellMargem.value && cellMargem.value.result);

    assert.match(formulaStr, /IF\(B13>0/i, 'Fórmula deve proteger contra divisão por zero');
    assert.equal(resCalculado, 0, 'Resultado pré-calculado com 0 cotas pagas deve ser exatamente 0, nunca NaN/Infinity');
    console.log('  [PASS] Margem de lucro tratou divisão por zero com 0 cotas pagas (Fórmula segura e result = 0)');

    // 4.3 Sanitização contra Formula Injection no Excel (.xlsx) e CSV
    // Insere nomes maliciosos com caracteres de fórmula no início: '=', '+', '-', '@'
    const nomesMaliciosos = [
      { num: 1, nome: '=SUM(1+1)' },
      { num: 2, nome: '+cmd|"/C calc"!A0' },
      { num: 3, nome: '-123456789' },
      { num: 4, nome: '@SUM(A1:A10)' },
    ];

    for (const item of nomesMaliciosos) {
      await post('/api/reservar', {
        numero: item.num,
        nome: item.nome,
        whatsapp: '11999990000',
        sessaoId: `sess_${item.num}`,
      });
      await post(`/api/admin/confirmar/${item.num}`, {}, adminHeaders);
    }

    // Gera planilha XLSX e inspeciona células de nomes
    const bufPlanilhaInj = await db.gerarPlanilhaXLSX(conn, Date.now());
    const wbInj = new ExcelJS.Workbook();
    await wbInj.xlsx.load(bufPlanilhaInj);
    const wsInj = wbInj.getWorksheet('Relatório da Rifa');

    // Linha 20 é cota 1, linha 21 é cota 2, linha 22 é cota 3, linha 23 é cota 4
    for (let i = 0; i < nomesMaliciosos.length; i++) {
      const linha = 20 + i;
      const cellNome = wsInj.getCell(`B${linha}`);
      const valStr = String(cellNome.value || '');
      assert.ok(
        valStr.startsWith("'"),
        `Nome com caractere de fórmula deve ser prefixado com apóstrofo (') para neutralizar execução. Valor: ${valStr}`
      );
      assert.equal(cellNome.numFmt, '@', 'Formato da célula deve ser texto (@)');
    }

    // Valida também no CSV
    const csvStr = db.gerarCSV(conn, Date.now());
    for (const item of nomesMaliciosos) {
      assert.ok(
        csvStr.includes(`'${item.nome.slice(0, 5)}`),
        `CSV deve conter nome sanitizado prefixado com apóstrofo: '${item.nome}`
      );
    }
    console.log('  [PASS] Nomes com (=, +, -, @) devidamente sanitizados contra Formula Injection no XLSX e CSV');
  }

  srv.close();
  conn.close();
  limpar();
  console.log('\n--> ETAPA 1 CONCLUÍDA COM 100% DE SUCESSO!\n');
})().catch(err => {
  console.error('\n[FALHA NA ETAPA 1]:', err);
  try { conn.close(); } catch (_) {}
  try { srv.close(); } catch (_) {}
  try { limpar(); } catch (_) {}
  process.exit(1);
});
