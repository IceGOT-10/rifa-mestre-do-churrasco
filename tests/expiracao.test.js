'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const db = require('../src/db');
const { criarApp } = require('../src/server');

const arq = path.join(os.tmpdir(), `rifa-exp-${process.pid}.db`);
const limpar = () => ['', '-wal', '-shm'].forEach(s => fs.rmSync(arq + s, { force: true }));
limpar();

const conn = db.abrir(arq, {
  titulo: 'Sorteio de Sábado • Super Kit Churrasco',
  forcarRateLimit: true,
});
const app = criarApp(conn, {
  whatsapp: '5511988887777',
  pixKey: 'teste@pix',
  adminUser: 'admin',
  adminPass: 'churrasco123',
});

let base;
let tokenAdmin = '';

const get = (url, headers = {}) =>
  fetch(base + url, {
    headers: tokenAdmin ? { Authorization: `Bearer ${tokenAdmin}`, ...headers } : headers,
  });

const post = (url, body, headers = {}) =>
  fetch(base + url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(tokenAdmin ? { Authorization: `Bearer ${tokenAdmin}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const status = n => conn.prepare('SELECT * FROM numeros WHERE numero=?').get(n);

const srv = app.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${srv.address().port}`;
  try {
    console.log('== TESTE 1: Identidade centralizada e Headers Anti-Cache ==');
    const rCfg = await get('/api/config');
    assert.match(String(rCfg.headers.get('cache-control')), /no-store/);
    const cfg = await rCfg.json();
    assert.equal(cfg.marca, 'Mestre do Churrasco • Rifas');
    assert.equal(cfg.titulo, 'Sorteio de Sábado • Super Kit Churrasco');
    assert.equal(cfg.minutosPreBloqueio, 10);
    assert.equal(cfg.minutos, 10);
    console.log(`  OK: marca="${cfg.marca}", titulo="${cfg.titulo}", minutos=${cfg.minutos}`);

    console.log('== TESTE 2: Bloqueio em 2 Etapas (10 min) + Seleção de Múltiplos Pontos ==');
    const antes = Date.now();
    let rPre = await post('/api/pre-reservar', { numero: 5, sessaoId: 'sess_maria' });
    let jPre = await rPre.json();
    assert.equal(rPre.status, 200);
    assert.ok(jPre.ok);
    const deltaPre = jPre.tempo_limite - antes;
    assert.ok(deltaPre >= 10 * 60000 - 100 && deltaPre <= 10 * 60000 + 5000, 'Bloqueio de 10 minutos');
    assert.equal(status(5).status, 'PENDENTE');
    assert.equal(status(5).etapa, 'PRE_BLOQUEIO');

    // Etapa 2: Maria conclui a reserva
    let r = await post('/api/reservar', {
      numero: 5,
      nome: 'Maria Churrasqueira',
      whatsapp: '(11) 98888-7777',
      sessaoId: 'sess_maria',
    });
    let j = await r.json();
    assert.equal(r.status, 200);
    assert.ok(j.ok);
    assert.equal(status(5).etapa, 'RESERVADO');
    assert.equal(status(5).nome, 'Maria Churrasqueira');

    // Reserva múltipla de pontos (números 11, 12, 13 de uma só vez)
    const rMultiPre = await post('/api/pre-reservar', { numeros: [11, 12, 13], sessaoId: 'sess_multi' });
    assert.equal(rMultiPre.status, 200);
    const rMultiRes = await post('/api/reservar', {
      numeros: [11, 12, 13],
      nome: 'Pedro Multi',
      whatsapp: '11988881234',
      sessaoId: 'sess_multi',
    });
    const jMultiRes = await rMultiRes.json();
    assert.equal(rMultiRes.status, 200);
    assert.deepEqual(jMultiRes.numeros, [11, 12, 13]);
    assert.equal(status(11).nome, 'Pedro Multi');
    assert.equal(status(12).nome, 'Pedro Multi');
    assert.equal(status(13).nome, 'Pedro Multi');
    console.log(`  OK: Pré-bloqueio (${(deltaPre / 60000).toFixed(2)} min) + Reserva única e múltipla finalizadas.`);

    console.log('== TESTE 3: Segunda reserva do mesmo número => 409 com mensagem padronizada ==');
    r = await post('/api/reservar', { numero: 5, nome: 'João', whatsapp: '11977776666' });
    assert.equal(r.status, 409);
    const errJoao = await r.json();
    assert.equal(
      errJoao.erro,
      'Ops! O número 05 acabou de ser reservado por outro participante. Por favor, escolha outro número disponível na grade.'
    );
    console.log('  OK:', errJoao.erro);

    console.log('== TESTE 4: HTTP concorrente (10 requisições) no número 06 ==');
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post('/api/reservar', { numero: 6, nome: `Cli${i}`, whatsapp: '11977776666' })
      )
    );
    const cods = rs.map(x => x.status);
    assert.equal(cods.filter(c => c === 200).length, 1);
    assert.equal(cods.filter(c => c === 409).length, 9);
    console.log('  OK: status HTTP =', cods.join(','));

    console.log('== TESTE 5: Expiração automática após os 3 minutos ==');
    conn.prepare('UPDATE numeros SET tempo_limite=? WHERE numero=6').run(Date.now() - 1000);
    const lista = await (await get('/api/numeros')).json();
    const n6 = lista.numeros.find(n => n.numero === 6);
    assert.equal(n6.status, 'DISPONIVEL');
    assert.equal(status(6).reservado_por, null);
    console.log('  OK: Cota 06 expirou e voltou a DISPONIVEL.');

    console.log('== TESTE 6: Segurança do Admin — Rate Limiting (3 falhas => bloqueio de 5 min) ==');
    // Simula IP separado via header x-client-id para testar o bloqueador
    const ipBrute = { 'x-client-id': 'ip-atacante-1' };
    const f1 = await post('/api/admin/login', { usuario: 'admin', senha: 'err1' }, ipBrute);
    assert.equal(f1.status, 401);
    const f2 = await post('/api/admin/login', { usuario: 'admin', senha: 'err2' }, ipBrute);
    assert.equal(f2.status, 401);
    const f3 = await post('/api/admin/login', { usuario: 'admin', senha: 'err3' }, ipBrute);
    assert.equal(f3.status, 401, '3ª tentativa com erro deve falhar com 401 e ativar o bloqueio para a próxima');
    const jf3 = await f3.json();
    assert.equal(jf3.tentativasRestantes, 0);
    assert.equal(jf3.bloqueado, true);

    // A partir da 4ª requisição, o sistema deve responder com 429
    const f4 = await post('/api/admin/login', { usuario: 'admin', senha: 'err4' }, ipBrute);
    assert.equal(f4.status, 429, '4ª requisição deve responder com 429');
    const jf4 = await f4.json();
    assert.equal(jf4.codigo, 'BLOQUEADO_TEMPORARIAMENTE');
    assert.ok(jf4.segundosRestantes > 290 && jf4.segundosRestantes <= 300);

    // Mesmo tentando a senha correta durante o bloqueio, continua 429
    const f5 = await post('/api/admin/login', { usuario: 'admin', senha: 'churrasco123' }, ipBrute);
    assert.equal(f5.status, 429);
    console.log(`  OK: 3 tentativas falhas com 401 e bloqueio ativado a partir da 4ª requisição com 429 (${jf4.segundosRestantes}s).`);

    console.log('== TESTE 7: Login Admin válido, Confirmação, CSV e Restrição de Túnel ==');
    const rLogin = await post(
      '/api/admin/login',
      { usuario: 'admin', senha: 'churrasco123' },
      { 'x-client-id': 'ip-admin-legitimo' }
    );
    assert.equal(rLogin.status, 200);
    const jLogin = await rLogin.json();
    assert.ok(jLogin.ok && jLogin.token);
    tokenAdmin = jLogin.token;

    // Confirma cota 5 -> PAGO
    r = await post('/api/admin/confirmar/5');
    assert.equal(r.status, 200);
    assert.equal(status(5).status, 'PAGO');

    // Verifica que o dispositivo de Maria (sess_maria) continua reconhecendo a cota 5 como sua mesmo após PAGO,
    // enquanto outro dispositivo vê meu=false
    const visaoMaria = await (await get('/api/numeros?sessaoId=sess_maria')).json();
    assert.equal(visaoMaria.numeros.find(n => n.numero === 5).meu, true);
    assert.equal(visaoMaria.numeros.find(n => n.numero === 11).meu, false);
    const visaoPedro = await (await get('/api/numeros?sessaoId=sess_multi')).json();
    assert.equal(visaoPedro.numeros.find(n => n.numero === 11).meu, true);
    assert.equal(visaoPedro.numeros.find(n => n.numero === 5).meu, false);

    // Exportação nativa Excel (.xlsx) via exceljs
    const rXlsx = await get('/api/admin/exportar-planilha');
    assert.equal(rXlsx.status, 200);
    const contentType = rXlsx.headers.get('content-type') || '';
    const contentDisp = rXlsx.headers.get('content-disposition') || '';
    assert.ok(
      contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      `Content-Type esperado para .xlsx, recebido: ${contentType}`
    );
    assert.ok(contentDisp.includes('relatorio-rifa.xlsx'));
    const bufXlsx = Buffer.from(await rXlsx.arrayBuffer());
    assert.ok(bufXlsx.byteLength > 0, 'O arquivo .xlsx exportado deve possuir tamanho em bytes maior que zero');
    console.log(`  OK: Login, confirmação PAGO e exportação Excel (.xlsx, ${bufXlsx.byteLength} bytes) validados.`);

    console.log('== TESTE 8: Encerramento da Rifa e Gerador de Mensagem para WhatsApp (sem telefone) ==');
    // Antes de encerrar, gerador de mensagem retorna 409
    const rZapAntes = await get('/api/admin/mensagem-whatsapp');
    assert.equal(rZapAntes.status, 409);

    // Reserva mais um participante (cota 10)
    await post('/api/reservar', { numero: 10, nome: 'Carlos Picanha', whatsapp: '11966665555' });

    // Encerra a rifa
    const rEnc = await post('/api/admin/encerrar');
    assert.equal(rEnc.status, 200);

    // Novas reservas devem ser negadas após encerramento
    const rPosEnc = await post('/api/reservar', { numero: 22, nome: 'Atrasado', whatsapp: '11955554444' });
    assert.equal(rPosEnc.status, 423);

    // Gera mensagem para WhatsApp
    const rZapDepois = await get('/api/admin/mensagem-whatsapp');
    assert.equal(rZapDepois.status, 200);
    const jZap = await rZapDepois.json();
    assert.ok(jZap.ok);
    assert.ok(jZap.mensagem.includes('05 - Maria Churrasqueira'));
    assert.ok(jZap.mensagem.includes('10 - Carlos Picanha'));
    assert.ok(!jZap.mensagem.includes('988887777'), 'Telefone omitido por privacidade');
    assert.ok(!jZap.mensagem.includes('966665555'), 'Telefone omitido por privacidade');
    console.log('  OK: Rifa encerrada, reservas bloqueadas e lista WhatsApp gerada sem telefones.');

    console.log('== TESTE 9: Restrição local vs túnel externo ==');
    assert.equal((await get('/api/admin/pedidos', { 'x-forwarded-for': '8.8.8.8' })).status, 403);
    const st = await new Promise(ok =>
      http.get(
        {
          host: '127.0.0.1',
          port: srv.address().port,
          path: '/api/admin/pedidos',
          headers: { host: 'abc123.ngrok-free.app', Authorization: `Bearer ${tokenAdmin}` },
        },
        x => {
          x.resume();
          ok(x.statusCode);
        }
      )
    );
    assert.equal(st, 403);
    console.log('  OK: Túnel bloqueado com 403.');

    console.log('== TESTE 10: Criar Nova Rifa e Editar Nome, Quantidade de Cotas e Valor ==');
    const rNova = await post('/api/admin/nova-rifa', {
      titulo: 'Rifa Especial de Domingo • Kit Picanha',
      total: 80,
      valor: '15,00',
    });
    assert.equal(rNova.status, 200);
    const jNova = await rNova.json();
    assert.ok(jNova.ok);
    assert.equal(jNova.config.titulo, 'Rifa Especial de Domingo • Kit Picanha');
    assert.equal(jNova.config.total, 80);
    assert.equal(jNova.config.valor, 'R$ 15,00');
    assert.equal(jNova.config.encerrada, false);

    // Edita nome, cotas e valor da rifa ativa
    const rEdit = await post('/api/admin/config', {
      titulo: 'Rifa Especial Editada • Super Churrasco',
      total: 100,
      valor: 'R$ 20,00',
    });
    assert.equal(rEdit.status, 200);
    const jEdit = await rEdit.json();
    assert.equal(jEdit.config.titulo, 'Rifa Especial Editada • Super Churrasco');
    assert.equal(jEdit.config.total, 100);
    assert.equal(jEdit.config.valor, 'R$ 20,00');
    console.log('  OK: Criação de nova rifa e edição de nome/cotas/valor validadas.');

    console.log('== TESTE 11: Destravar, Excluir e Isolamento da Tela do Usuário ao Navegar no Admin ==');
    // Como a Rifa #2 ("Rifa Especial Editada • Super Churrasco") está ABERTA:
    // Se o Admin criar uma Rifa #3 sem forçar substituição, a Rifa #2 deve continuar aberta para o usuário!
    const rRifa3 = await post('/api/admin/nova-rifa', {
      titulo: 'Rifa Futura de Natal • Cesta Especial',
      total: 50,
      valor: '30,00',
    });
    const jRifa3 = await rRifa3.json();
    assert.equal(rRifa3.status, 200);
    assert.equal(jRifa3.abertaParaUsuarios, false, 'Não deve substituir a rifa que já está aberta');

    // Quando o Admin navega para a Rifa #1 ou Rifa #3 no painel, o usuário público continua vendo a Rifa #2 aberta!
    const rNav1 = await get('/api/admin/pedidos?rifaId=1');
    const jNav1 = await rNav1.json();
    assert.equal(jNav1.rifaId, 1);
    const pubDuranteNav = await (await get('/api/numeros')).json();
    assert.equal(pubDuranteNav.titulo, 'Rifa Especial Editada • Super Churrasco');
    assert.equal(pubDuranteNav.encerrada, false);

    // Se o Admin encerrar a Rifa #2 (que estava aberta), como nenhuma outra está aberta,
    // a Rifa #2 permanece na tela do usuário com a mensagem de encerrada!
    await post('/api/admin/encerrar', { rifaId: jNova.rifaId });
    const pubAposEncerrar = await (await get('/api/numeros')).json();
    assert.equal(pubAposEncerrar.titulo, 'Rifa Especial Editada • Super Churrasco');
    assert.equal(pubAposEncerrar.encerrada, true, 'Fica a última rifa aberta com status encerrada');

    // Se o Admin encerrar por engano e clicar em "Destravar Rifa" na Rifa #2, ela volta a ficar aberta!
    const rDest2 = await post('/api/admin/destravar', { rifaId: jNova.rifaId });
    assert.equal(rDest2.status, 200);
    const pubAposDestravar = await (await get('/api/numeros')).json();
    assert.equal(pubAposDestravar.encerrada, false);
    assert.equal(pubAposDestravar.titulo, 'Rifa Especial Editada • Super Churrasco');

    // Se o Admin destravar a Rifa #3, a Rifa #2 é encerrada automaticamente (apenas 1 aberta por vez) e a Rifa #3 vai para a tela do usuário
    await post('/api/admin/destravar', { rifaId: jRifa3.rifaId });
    const pubRifa3 = await (await get('/api/numeros')).json();
    assert.equal(pubRifa3.titulo, 'Rifa Futura de Natal • Cesta Especial');
    assert.equal(pubRifa3.encerrada, false);
    const listaRifas = (await (await get('/api/admin/rifas')).json()).rifas;
    assert.equal(listaRifas.filter(x => !x.encerrada).length, 1, 'Apenas 1 rifa aberta por vez');

    // Reserva e paga o número 1 na Rifa #3
    await post('/api/reservar', { numero: 1, nome: 'Carlos', whatsapp: '11999990000', sessaoId: 'sess_carlos' });
    await post('/api/admin/confirmar/1', { rifaId: jRifa3.rifaId });

    // Cria a Rifa #4 com a caixinha "abrirAgora: true" marcada enquanto a Rifa #3 tem cotas pagas
    const rRifa4 = await post('/api/admin/nova-rifa', {
      titulo: 'Rifa de Ano Novo • Kit Picanha Limpo',
      total: 40,
      valor: '10,00',
      abrirAgora: true,
    });
    const jRifa4 = await rRifa4.json();
    assert.equal(jRifa4.abertaParaUsuarios, true);

    // A nova rifa aberta para os usuários DEVE estar 100% LIMPA (nenhum número pago ou reservado)
    const pubRifa4 = await (await get('/api/numeros')).json();
    assert.equal(pubRifa4.titulo, 'Rifa de Ano Novo • Kit Picanha Limpo');
    assert.equal(pubRifa4.encerrada, false);
    assert.equal(pubRifa4.total, 40);
    assert.equal(pubRifa4.numeros.length, 40);
    const ocupadasRifa4 = pubRifa4.numeros.filter(x => x.status !== 'DISPONIVEL');
    assert.equal(ocupadasRifa4.length, 0, 'A nova rifa aberta não deve herdar nenhum número da rifa anterior');

    // E a Rifa #3 anterior deve ter sido travada/encerrada com seu histórico de pagamentos preservado
    const rPedidosRifa3 = await get(`/api/admin/pedidos?rifaId=${jRifa3.rifaId}`);
    const jPedidosRifa3 = await rPedidosRifa3.json();
    assert.ok(jPedidosRifa3.encerrada, 'Rifa anterior foi encerrada automaticamente');
    assert.ok(
      jPedidosRifa3.pedidos.some(p => p.numero === 1 && p.status === 'PAGO'),
      'Rifa anterior preservou seu histórico de pagamentos intacto'
    );

    // Excluir a Rifa #1 (antiga)
    const rDel = await post('/api/admin/excluir-rifa/1');
    assert.equal(rDel.status, 200);
    const listaAposDel = (await (await get('/api/admin/rifas')).json()).rifas;
    assert.ok(!listaAposDel.some(x => x.id === 1), 'Rifa #1 foi excluída');
    console.log('  OK: Destravar, excluir e isolamento da visão pública vs navegação do Admin validados.');

    console.log('\nEXPIRAÇÃO, SEGURANÇA E FUNCIONALIDADES: TODOS OS TESTES PASSARAM');
    srv.close();
    conn.close();
    limpar();
  } catch (e) {
    console.error('FALHOU:', e);
    srv.close();
    try { conn.close(); } catch (_) {}
    limpar();
    process.exit(1);
  }
});
