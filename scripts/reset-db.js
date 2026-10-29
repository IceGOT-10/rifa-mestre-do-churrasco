'use strict';
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');

const conn = db.abrir(path.resolve(__dirname, '..', 'rifa.db'));

conn.exec('BEGIN IMMEDIATE;');

// 1. Limpa números
conn.exec('DELETE FROM numeros;');
const insNumero = conn.prepare('INSERT INTO numeros (numero) VALUES (?);');
for (let n = 1; n <= 60; n++) {
  insNumero.run(n);
}

// 2. Limpa tentativas de login
conn.exec('DELETE FROM login_tentativas;');

// 3. Limpa rifas e cria apenas Rifa 0
conn.exec('DELETE FROM rifas;');

const cotasVazias = [];
for (let n = 1; n <= 60; n++) {
  cotasVazias.push({
    numero: n,
    status: 'DISPONIVEL',
    etapa: 'LIVRE',
    nome: null,
    reservado_por: null,
    whatsapp: null,
    sessao_id: null,
    tempo_limite: null,
    reservado_em: null,
    pago_em: null,
    data_hora: null,
  });
}

const agoraStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

conn.prepare(`
  INSERT INTO rifas (id, titulo, valor, total_cotas, pix_key, whatsapp, encerrada, ativa, snapshot, criada_em)
  VALUES (0, 'Rifa 0 • Inicial', 'R$ 10,00', 60, '89994365037', '5589994365037', 1, 1, ?, ?)
`).run(JSON.stringify(cotasVazias), agoraStr);

// 4. Configura sqlite_sequence para que a próxima rifa criada seja ID 1
conn.exec(`
  DELETE FROM sqlite_sequence WHERE name = 'rifas';
  INSERT INTO sqlite_sequence (name, seq) VALUES ('rifas', 0);
`);

// 5. Atualiza configurações centrais
const upsertCfg = conn.prepare(`
  INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor;
`);
upsertCfg.run('marca', 'Mestre do Churrasco • Rifas');
upsertCfg.run('titulo', 'Rifa 0 • Inicial');
upsertCfg.run('subtitulo', 'Escolha um ou mais números livres. Bloqueio de 10 minutos para concluir sua reserva e Pix.');
upsertCfg.run('valor', 'R$ 10,00');
upsertCfg.run('pixKey', '89994365037');
upsertCfg.run('whatsapp', '5589994365037');
upsertCfg.run('totalCotas', '60');
upsertCfg.run('encerrada', '1');

conn.exec('COMMIT;');

// 6. Atualiza config.json para sincronizar
const cfgPath = path.resolve(__dirname, '..', 'config.json');
if (fs.existsSync(cfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.titulo = 'Rifa 0 • Inicial';
  cfg.total = 60;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

console.log('RESET CONCLUIDO COM SUCESSO');
console.log('RIFAS:', conn.prepare('SELECT id, titulo, total_cotas, encerrada, ativa FROM rifas').all());
console.log('NUMEROS DISPONIVEIS:', conn.prepare("SELECT COUNT(*) as c FROM numeros WHERE status = 'DISPONIVEL'").get().c);
console.log('NUMEROS OCUPADOS:', conn.prepare("SELECT COUNT(*) as c FROM numeros WHERE status != 'DISPONIVEL'").get().c);

conn.close();
