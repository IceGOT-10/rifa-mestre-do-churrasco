'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const TOTAL_NUMEROS = 60;
const MINUTOS_PRE_BLOQUEIO = 10;
const MINUTOS_RESERVA = 10;
const MARCA_FIXA = 'Mestre do Churrasco • Rifas';
const CAMINHO_CONFIG_PADRAO = path.join(__dirname, '..', 'config.json');

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatarDataHora(epochMs = Date.now()) {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function normalizarValorMoeda(v) {
  const s = String(v ?? '').trim();
  if (!s) return 'R$ 5,00';
  const limpo = s.replace(/[^\d,.-]/g, '');
  if (!limpo) return s;
  let num;
  if (limpo.includes(',') && limpo.includes('.')) {
    num = parseFloat(limpo.replace(/\./g, '').replace(',', '.'));
  } else if (limpo.includes(',')) {
    num = parseFloat(limpo.replace(',', '.'));
  } else {
    num = parseFloat(limpo);
  }
  if (!Number.isFinite(num) || num < 0) return s;
  return 'R$ ' + num.toFixed(2).replace('.', ',');
}

function extrairValorNumerico(v) {
  const s = String(v ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  let num;
  if (s.includes(',') && s.includes('.')) {
    num = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  } else if (s.includes(',')) {
    num = parseFloat(s.replace(',', '.'));
  } else {
    num = parseFloat(s);
  }
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function lerArquivoConfig(caminhoConfig = CAMINHO_CONFIG_PADRAO) {
  try {
    if (fs.existsSync(caminhoConfig)) {
      const bruto = fs.readFileSync(caminhoConfig, 'utf8');
      return JSON.parse(bruto);
    }
  } catch (e) {
    console.error('Aviso: falha ao ler config.json, usando padrões:', e.message);
  }
  return {};
}

function gerarCotasVazias(total) {
  const arr = [];
  for (let n = 1; n <= total; n++) {
    arr.push({
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
  return arr;
}

function abrir(caminho, opcoesConfig = {}) {
  const db = new DatabaseSync(caminho);
  db._opcoesConfig = opcoesConfig;
  const cfgArquivo = lerArquivoConfig(opcoesConfig.configPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS numeros (
      numero        INTEGER PRIMARY KEY CHECK (numero >= 1),
      status        TEXT NOT NULL DEFAULT 'DISPONIVEL'
                    CHECK (status IN ('DISPONIVEL','PENDENTE','PAGO')),
      etapa         TEXT NOT NULL DEFAULT 'LIVRE'
                    CHECK (etapa IN ('LIVRE','PRE_BLOQUEIO','RESERVADO','PAGO')),
      nome          TEXT,
      reservado_por TEXT,
      whatsapp      TEXT,
      sessao_id     TEXT,
      tempo_limite  INTEGER,
      reservado_em  INTEGER,
      pago_em       INTEGER,
      data_hora     TEXT
    );

    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rifas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo      TEXT NOT NULL,
      valor       TEXT NOT NULL,
      total_cotas INTEGER NOT NULL DEFAULT 60,
      pix_key     TEXT,
      whatsapp    TEXT,
      encerrada   INTEGER NOT NULL DEFAULT 0,
      ativa       INTEGER NOT NULL DEFAULT 1,
      snapshot    TEXT,
      criada_em   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_tentativas (
      ip             TEXT PRIMARY KEY,
      falhas         INTEGER NOT NULL DEFAULT 0,
      bloqueado_ate  INTEGER,
      ultima_falha   INTEGER
    );
  `);

  // Migração defensiva: se a tabela numeros antiga tinha CHECK (numero BETWEEN 1 AND 60), recria permitindo > 60 cotas
  const schemaNumeros = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='numeros'")
    .get();
  if (schemaNumeros && schemaNumeros.sql && /BETWEEN\s+1\s+AND/i.test(schemaNumeros.sql)) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE numeros_novo (
        numero        INTEGER PRIMARY KEY CHECK (numero >= 1),
        status        TEXT NOT NULL DEFAULT 'DISPONIVEL'
                      CHECK (status IN ('DISPONIVEL','PENDENTE','PAGO')),
        etapa         TEXT NOT NULL DEFAULT 'LIVRE'
                      CHECK (etapa IN ('LIVRE','PRE_BLOQUEIO','RESERVADO','PAGO')),
        nome          TEXT,
        reservado_por TEXT,
        whatsapp      TEXT,
        sessao_id     TEXT,
        tempo_limite  INTEGER,
        reservado_em  INTEGER,
        pago_em       INTEGER,
        data_hora     TEXT
      );
      INSERT INTO numeros_novo (numero, status, etapa, nome, reservado_por, whatsapp, sessao_id, tempo_limite, reservado_em, pago_em, data_hora)
      SELECT numero, status, COALESCE(etapa, 'LIVRE'), nome, reservado_por, whatsapp, sessao_id, tempo_limite, reservado_em, pago_em, data_hora
        FROM numeros;
      DROP TABLE numeros;
      ALTER TABLE numeros_novo RENAME TO numeros;
      COMMIT;
    `);
  }

  // Migração defensiva de colunas caso o arquivo rifa.db já existisse
  const colunasExistentes = new Set(
    db.prepare("PRAGMA table_info('numeros')").all().map(c => c.name)
  );
  if (!colunasExistentes.has('etapa')) {
    db.exec("ALTER TABLE numeros ADD COLUMN etapa TEXT NOT NULL DEFAULT 'LIVRE'");
  }
  if (!colunasExistentes.has('nome')) {
    db.exec('ALTER TABLE numeros ADD COLUMN nome TEXT');
  }
  if (!colunasExistentes.has('sessao_id')) {
    db.exec('ALTER TABLE numeros ADD COLUMN sessao_id TEXT');
  }
  if (!colunasExistentes.has('data_hora')) {
    db.exec('ALTER TABLE numeros ADD COLUMN data_hora TEXT');
  }

  const marcaInicial =
    opcoesConfig.marca ??
    process.env.MARCA ??
    cfgArquivo.marca ??
    MARCA_FIXA;
  const tituloInicial =
    opcoesConfig.titulo ??
    process.env.TITULO ??
    cfgArquivo.titulo ??
    'Sorteio de Sábado • Super Kit Churrasco';
  const subtituloInicial =
    opcoesConfig.subtitulo ??
    cfgArquivo.subtitulo ??
    'Escolha um ou mais números livres. Bloqueio de 10 minutos para concluir sua reserva e Pix.';
  const valorInicial = normalizarValorMoeda(
    opcoesConfig.valor ?? process.env.VALOR ?? cfgArquivo.valor ?? 'R$ 25,00'
  );
  const pixInicial =
    opcoesConfig.pixKey ?? process.env.PIX_KEY ?? cfgArquivo.pixKey ?? 'pix@mestredochurrasco.com.br';
  const zapInicial = String(
    opcoesConfig.whatsapp ?? process.env.WHATSAPP ?? cfgArquivo.whatsapp ?? '5511999999999'
  ).replace(/\D/g, '');
  const totalInicial = Number(opcoesConfig.total ?? cfgArquivo.total ?? TOTAL_NUMEROS) || TOTAL_NUMEROS;

  const upsertCfg = db.prepare(`
    INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `);
  const insertIgnoreCfg = db.prepare(`
    INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES (?, ?)
  `);

  upsertCfg.run('marca', marcaInicial);
  if (opcoesConfig.titulo) {
    upsertCfg.run('titulo', tituloInicial);
  } else {
    insertIgnoreCfg.run('titulo', tituloInicial);
  }
  upsertCfg.run('subtitulo', subtituloInicial);
  if (opcoesConfig.valor) {
    upsertCfg.run('valor', valorInicial);
  } else {
    insertIgnoreCfg.run('valor', valorInicial);
  }
  if (opcoesConfig.pixKey) {
    upsertCfg.run('pixKey', pixInicial);
  } else {
    insertIgnoreCfg.run('pixKey', pixInicial);
  }
  if (opcoesConfig.whatsapp) {
    upsertCfg.run('whatsapp', zapInicial);
  } else {
    insertIgnoreCfg.run('whatsapp', zapInicial);
  }
  if (opcoesConfig.total) {
    upsertCfg.run('totalCotas', String(totalInicial));
  } else {
    insertIgnoreCfg.run('totalCotas', String(totalInicial));
  }
  insertIgnoreCfg.run('encerrada', '0');

  const totalAtual = obterTotalCotas(db);
  const insNumero = db.prepare('INSERT OR IGNORE INTO numeros (numero) VALUES (?)');
  for (let n = 1; n <= totalAtual; n++) {
    insNumero.run(n);
  }

  // Garante registro inicial na tabela de rifas
  const qtdRifas = db.prepare('SELECT COUNT(*) AS c FROM rifas').get().c;
  if (!qtdRifas) {
    const cfg = obterConfig(db);
    const cotasIniciais = db.prepare('SELECT * FROM numeros WHERE numero <= ? ORDER BY numero ASC').all(cfg.total);
    db.prepare(`
      INSERT INTO rifas (titulo, valor, total_cotas, pix_key, whatsapp, encerrada, ativa, snapshot, criada_em)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      cfg.titulo,
      cfg.valor,
      cfg.total,
      cfg.pixKey,
      cfg.whatsapp,
      cfg.encerrada ? 1 : 0,
      JSON.stringify(cotasIniciais),
      formatarDataHora()
    );
  } else {
    // Regra: apenas 1 rifa pode estar aberta (encerrada = 0) por vez
    const abertas = db.prepare('SELECT id FROM rifas WHERE encerrada = 0 ORDER BY id DESC').all();
    if (abertas.length > 1) {
      const manterId = abertas[0].id;
      db.prepare('UPDATE rifas SET encerrada = 1 WHERE encerrada = 0 AND id <> ?').run(manterId);
    }
  }

  return db;
}

/**
 * Executa fn dentro de BEGIN IMMEDIATE (adquire trava de escrita imediatamente no SQLite).
 * Caso fn lance qualquer erro ou retorne { _rollback: true }, realiza ROLLBACK explícito.
 */
function transacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = fn();
    if (resultado && resultado._rollback) {
      db.exec('ROLLBACK');
      const { _rollback, ...limpo } = resultado;
      return limpo;
    }
    db.exec('COMMIT');
    return resultado;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      /* transação já revertida */
    }
    throw e;
  }
}

function obterTotalCotas(db) {
  const r = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'totalCotas'").get();
  const n = Number(r && r.valor);
  return Number.isInteger(n) && n >= 1 ? n : TOTAL_NUMEROS;
}

/**
 * Sincroniza o estado atual da tabela `numeros` (rifa visível para o público)
 * dentro da coluna `snapshot` da rifa que está marcada com `ativa = 1`.
 */
function salvarSnapshotRifaPublica(db) {
  const total = obterTotalCotas(db);
  const encerrada = rifaEncerrada(db) ? 1 : 0;
  const cotasAtuais = db
    .prepare('SELECT * FROM numeros WHERE numero <= ? ORDER BY numero ASC')
    .all(total);
  db.prepare(`
    UPDATE rifas
       SET encerrada = ?,
           snapshot = ?
     WHERE ativa = 1
  `).run(encerrada, JSON.stringify(cotasAtuais));
}

/**
 * Carrega uma rifa específica da tabela `rifas` para ser a rifa pública na tela do usuário
 * (tabela `numeros` e `configuracoes`).
 */
function definirRifaPublicaNoBanco(db, idRifa, forcarRecarga = false) {
  const destino = db.prepare('SELECT * FROM rifas WHERE id = ?').get(Number(idRifa));
  if (!destino) return false;

  const atualAtiva = db.prepare('SELECT id FROM rifas WHERE ativa = 1 LIMIT 1').get();
  if (atualAtiva && atualAtiva.id !== destino.id) {
    salvarSnapshotRifaPublica(db);
  }

  db.prepare('UPDATE rifas SET ativa = 0').run();
  db.prepare('UPDATE rifas SET ativa = 1 WHERE id = ?').run(destino.id);

  // Caso já não estivesse carregada em `numeros` (ou se forçada a recarga), restaura seu snapshot
  if (forcarRecarga || !atualAtiva || atualAtiva.id !== destino.id) {
    db.prepare('DELETE FROM numeros').run();
    let cotasDestino = [];
    try {
      if (destino.snapshot) cotasDestino = JSON.parse(destino.snapshot);
    } catch (_) {
      cotasDestino = [];
    }

    if (Array.isArray(cotasDestino) && cotasDestino.length > 0) {
      const insFull = db.prepare(`
        INSERT INTO numeros (numero, status, etapa, nome, reservado_por, whatsapp, sessao_id, tempo_limite, reservado_em, pago_em, data_hora)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of cotasDestino) {
        if (c.numero >= 1 && c.numero <= destino.total_cotas) {
          insFull.run(
            c.numero,
            c.status || 'DISPONIVEL',
            c.etapa || 'LIVRE',
            c.nome || null,
            c.reservado_por || null,
            c.whatsapp || null,
            c.sessao_id || null,
            c.tempo_limite || null,
            c.reservado_em || null,
            c.pago_em || null,
            c.data_hora || null
          );
        }
      }
      const insVazio = db.prepare('INSERT OR IGNORE INTO numeros (numero) VALUES (?)');
      for (let n = 1; n <= destino.total_cotas; n++) {
        insVazio.run(n);
      }
    } else {
      const ins = db.prepare('INSERT INTO numeros (numero) VALUES (?)');
      for (let n = 1; n <= destino.total_cotas; n++) {
        ins.run(n);
      }
    }
  }

  const upsert = db.prepare(`
    INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `);
  upsert.run('titulo', destino.titulo);
  upsert.run('valor', destino.valor);
  upsert.run('totalCotas', String(destino.total_cotas));
  if (destino.pix_key) upsert.run('pixKey', destino.pix_key);
  if (destino.whatsapp) upsert.run('whatsapp', destino.whatsapp);
  upsert.run('encerrada', destino.encerrada ? '1' : '0');

  return true;
}

function obterConfig(db) {
  const linhas = db.prepare('SELECT chave, valor FROM configuracoes').all();
  const mapa = {};
  for (const l of linhas) mapa[l.chave] = l.valor;
  const total = obterTotalCotas(db);
  const valor = mapa.valor || 'R$ 5,00';
  const rifaAtiva = db.prepare('SELECT id FROM rifas WHERE ativa = 1 ORDER BY id DESC LIMIT 1').get();
  return {
    rifaId: rifaAtiva ? rifaAtiva.id : 1,
    marca: mapa.marca || MARCA_FIXA,
    titulo: mapa.titulo || 'Sorteio de Sábado • Super Kit Churrasco',
    subtitulo: mapa.subtitulo || '',
    valor,
    valorNumerico: extrairValorNumerico(valor),
    pixKey: mapa.pixKey || '',
    whatsapp: mapa.whatsapp || '',
    encerrada: mapa.encerrada === '1',
    minutos: MINUTOS_RESERVA,
    minutosPreBloqueio: MINUTOS_PRE_BLOQUEIO,
    minutosReserva: MINUTOS_RESERVA,
    total,
  };
}

/**
 * Obtém os dados de uma rifa específica para visualização no Admin (sem alterar a rifa pública do usuário!).
 */
function obterConfigRifaAdmin(db, rifaId = null) {
  const cfgPublica = obterConfig(db);
  const idAlvo = rifaId ? Number(rifaId) : cfgPublica.rifaId;
  const reg = db.prepare('SELECT * FROM rifas WHERE id = ?').get(idAlvo);
  if (!reg || reg.ativa === 1) {
    return {
      ...cfgPublica,
      naTelaDoUsuario: true,
    };
  }
  return {
    rifaId: reg.id,
    marca: cfgPublica.marca,
    titulo: reg.titulo,
    subtitulo: cfgPublica.subtitulo,
    valor: reg.valor || 'R$ 5,00',
    valorNumerico: extrairValorNumerico(reg.valor || 'R$ 5,00'),
    pixKey: reg.pix_key || cfgPublica.pixKey,
    whatsapp: reg.whatsapp || cfgPublica.whatsapp,
    encerrada: Boolean(reg.encerrada),
    minutos: MINUTOS_RESERVA,
    minutosPreBloqueio: MINUTOS_PRE_BLOQUEIO,
    minutosReserva: MINUTOS_RESERVA,
    total: Number(reg.total_cotas) || TOTAL_NUMEROS,
    naTelaDoUsuario: false,
  };
}

function atualizarTitulo(db, novoTitulo) {
  const t = String(novoTitulo || '').trim();
  if (t.length < 3 || t.length > 120) {
    return { ok: false, codigo: 'TITULO_INVALIDO', erro: 'O título deve ter entre 3 e 120 caracteres.' };
  }
  db.prepare(`
    INSERT INTO configuracoes (chave, valor) VALUES ('titulo', ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `).run(t);
  db.prepare('UPDATE rifas SET titulo = ? WHERE ativa = 1').run(t);
  return { ok: true, titulo: t, marca: MARCA_FIXA };
}

/**
 * Atualiza as configurações de uma rifa (nome/título, valor da cota, quantidade de cotas, Pix, WhatsApp).
 * Se for a rifa pública (`ativa = 1`), atualiza `numeros` e `configuracoes`.
 * Se for outra rifa selecionada pelo Admin (`ativa = 0`), atualiza apenas o registro e snapshot dela em `rifas`!
 */
function atualizarConfigRifa(db, dados = {}) {
  const cfgPublica = obterConfig(db);
  const idAlvo = dados.rifaId ? Number(dados.rifaId) : cfgPublica.rifaId;
  const cfgAlvo = obterConfigRifaAdmin(db, idAlvo);

  const novoTitulo = dados.titulo !== undefined ? String(dados.titulo).trim() : cfgAlvo.titulo;
  if (novoTitulo.length < 3 || novoTitulo.length > 120) {
    return { ok: false, codigo: 'TITULO_INVALIDO', erro: 'O nome da rifa deve ter entre 3 e 120 caracteres.' };
  }

  const novoValor = dados.valor !== undefined ? normalizarValorMoeda(dados.valor) : cfgAlvo.valor;
  if (extrairValorNumerico(novoValor) <= 0) {
    return { ok: false, codigo: 'VALOR_INVALIDO', erro: 'Informe um valor de cota válido maior que zero.' };
  }

  const novoTotal =
    dados.total !== undefined || dados.totalCotas !== undefined
      ? Number(dados.total ?? dados.totalCotas)
      : cfgAlvo.total;
  if (!Number.isInteger(novoTotal) || novoTotal < 1 || novoTotal > 1000) {
    return { ok: false, codigo: 'TOTAL_INVALIDO', erro: 'A quantidade de cotas deve ser entre 1 e 1000.' };
  }

  const novoPix = dados.pixKey !== undefined ? String(dados.pixKey).trim() : cfgAlvo.pixKey;
  const novoZap =
    dados.whatsapp !== undefined ? String(dados.whatsapp).replace(/\D/g, '') : cfgAlvo.whatsapp;

  return transacao(db, () => {
    const regRifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(idAlvo);
    const ehPublica = !regRifa || regRifa.ativa === 1;

    if (ehPublica) {
      if (novoTotal < cfgPublica.total && !dados.forcar) {
        const ocupadasAcima = db
          .prepare("SELECT COUNT(*) AS c FROM numeros WHERE numero > ? AND status <> 'DISPONIVEL'")
          .get(novoTotal).c;
        if (ocupadasAcima > 0) {
          return {
            _rollback: true,
            ok: false,
            codigo: 'COTAS_OCUPADAS_ACIMA',
            erro: `Existem ${ocupadasAcima} cota(s) reservadas/pagas acima do número ${pad(novoTotal)}. Para diminuir a grade, libere-as antes ou crie uma nova rifa.`,
          };
        }
      }

      const upsert = db.prepare(`
        INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
        ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
      `);
      upsert.run('titulo', novoTitulo);
      upsert.run('valor', novoValor);
      upsert.run('totalCotas', String(novoTotal));
      if (novoPix) upsert.run('pixKey', novoPix);
      if (novoZap) upsert.run('whatsapp', novoZap);

      if (novoTotal > cfgPublica.total) {
        const ins = db.prepare('INSERT OR IGNORE INTO numeros (numero) VALUES (?)');
        for (let n = 1; n <= novoTotal; n++) {
          ins.run(n);
        }
      } else if (novoTotal < cfgPublica.total) {
        db.prepare('DELETE FROM numeros WHERE numero > ?').run(novoTotal);
      }

      db.prepare(`
        UPDATE rifas
           SET titulo = ?,
               valor = ?,
               total_cotas = ?,
               pix_key = ?,
               whatsapp = ?
         WHERE ativa = 1
      `).run(novoTitulo, novoValor, novoTotal, novoPix, novoZap);
      salvarSnapshotRifaPublica(db);

      return { ok: true, config: obterConfigRifaAdmin(db, idAlvo) };
    }

    // Edição de rifa que não está na tela do usuário (ativa = 0)
    let cotasSnap = [];
    try {
      cotasSnap = regRifa.snapshot ? JSON.parse(regRifa.snapshot) : [];
    } catch (_) {
      cotasSnap = [];
    }

    if (novoTotal < regRifa.total_cotas && !dados.forcar) {
      const ocupadas = cotasSnap.filter(c => c.numero > novoTotal && c.status !== 'DISPONIVEL').length;
      if (ocupadas > 0) {
        return {
          _rollback: true,
          ok: false,
          codigo: 'COTAS_OCUPADAS_ACIMA',
          erro: `Existem ${ocupadas} cota(s) ocupadas acima do número ${pad(novoTotal)} nesta rifa.`,
        };
      }
    }

    const mapaExistentes = new Map(cotasSnap.map(c => [c.numero, c]));
    const novoSnap = [];
    for (let n = 1; n <= novoTotal; n++) {
      novoSnap.push(
        mapaExistentes.get(n) || {
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
        }
      );
    }

    db.prepare(`
      UPDATE rifas
         SET titulo = ?,
             valor = ?,
             total_cotas = ?,
             pix_key = ?,
             whatsapp = ?,
             snapshot = ?
       WHERE id = ?
    `).run(novoTitulo, novoValor, novoTotal, novoPix, novoZap, JSON.stringify(novoSnap), idAlvo);

    return { ok: true, config: obterConfigRifaAdmin(db, idAlvo) };
  });
}

/**
 * Cria uma nova rifa.
 * Regra de visibilidade para o usuário:
 * - Apenas UMA rifa pode estar aberta (`encerrada = 0`) por vez.
 * - Se já existe uma rifa aberta em andamento e `dados.abrirAgora` não for true,
 *   a nova rifa é criada travada (`encerrada = 1`, `ativa = 0`), mantendo a rifa aberta
 *   intacta na tela dos usuários!
 * - Se NÃO existe nenhuma rifa aberta no momento (ou se `dados.abrirAgora === true`),
 *   a nova rifa passa a ser a única rifa aberta (`encerrada = 0`, `ativa = 1`) e aparece para os usuários.
 */
function criarNovaRifa(db, dados = {}, agora = Date.now()) {
  const cfgAtual = obterConfig(db);
  const titulo = String(dados.titulo || '').trim();
  if (titulo.length < 3 || titulo.length > 120) {
    return { ok: false, codigo: 'TITULO_INVALIDO', erro: 'O nome da nova rifa deve ter entre 3 e 120 caracteres.' };
  }

  const valor = normalizarValorMoeda(dados.valor ?? cfgAtual.valor ?? 'R$ 5,00');
  if (extrairValorNumerico(valor) <= 0) {
    return { ok: false, codigo: 'VALOR_INVALIDO', erro: 'Informe um valor válido para cada cota (ex: R$ 10,00).' };
  }

  const total = Number(dados.total ?? dados.totalCotas ?? 60);
  if (!Number.isInteger(total) || total < 1 || total > 1000) {
    return { ok: false, codigo: 'TOTAL_INVALIDO', erro: 'A quantidade de cotas deve ser um número entre 1 e 1000.' };
  }

  const pixKey =
    dados.pixKey !== undefined && String(dados.pixKey).trim()
      ? String(dados.pixKey).trim()
      : cfgAtual.pixKey;
  const whatsapp =
    dados.whatsapp !== undefined && String(dados.whatsapp).replace(/\D/g, '')
      ? String(dados.whatsapp).replace(/\D/g, '')
      : cfgAtual.whatsapp;

  return transacao(db, () => {
    salvarSnapshotRifaPublica(db);

    const rifaAbertaAtual = db.prepare('SELECT id FROM rifas WHERE encerrada = 0 LIMIT 1').get();
    const deveAbrirAgora = !rifaAbertaAtual || Boolean(dados.abrirAgora);

    const cotasVazias = gerarCotasVazias(total);

    if (deveAbrirAgora) {
      // Fecha qualquer rifa anterior
      db.prepare('UPDATE rifas SET encerrada = 1').run();

      const resIns = db.prepare(`
        INSERT INTO rifas (titulo, valor, total_cotas, pix_key, whatsapp, encerrada, ativa, snapshot, criada_em)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
      `).run(titulo, valor, total, pixKey, whatsapp, JSON.stringify(cotasVazias), formatarDataHora(agora));

      const novoId = Number(resIns.lastInsertRowid);
      definirRifaPublicaNoBanco(db, novoId, true);

      // Garante que a nova rifa fique aberta (encerrada = 0) e todas as demais fiquem encerradas (encerrada = 1)
      db.prepare('UPDATE rifas SET encerrada = 1 WHERE id <> ?').run(novoId);
      db.prepare('UPDATE rifas SET encerrada = 0 WHERE id = ?').run(novoId);
      db.prepare(`
        INSERT INTO configuracoes (chave, valor) VALUES ('encerrada', '0')
        ON CONFLICT(chave) DO UPDATE SET valor = '0'
      `).run();
      salvarSnapshotRifaPublica(db);

      return {
        ok: true,
        rifaId: novoId,
        abertaParaUsuarios: true,
        config: obterConfigRifaAdmin(db, novoId),
      };
    } else {
      // Já existe uma rifa aberta na tela dos usuários!
      // Cria a nova rifa travada (aguardando abertura) sem alterar a rifa aberta para os usuários.
      const resIns = db.prepare(`
        INSERT INTO rifas (titulo, valor, total_cotas, pix_key, whatsapp, encerrada, ativa, snapshot, criada_em)
        VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
      `).run(titulo, valor, total, pixKey, whatsapp, JSON.stringify(cotasVazias), formatarDataHora(agora));

      const novoId = Number(resIns.lastInsertRowid);
      return {
        ok: true,
        rifaId: novoId,
        abertaParaUsuarios: false,
        config: obterConfigRifaAdmin(db, novoId),
      };
    }
  });
}

/**
 * Lista todas as rifas criadas no sistema.
 */
function listarRifas(db) {
  salvarSnapshotRifaPublica(db);
  const linhas = db.prepare(`
    SELECT id, titulo, valor, total_cotas AS total, pix_key AS pixKey, whatsapp, encerrada, ativa, criada_em AS criadaEm
      FROM rifas
     ORDER BY id DESC
  `).all();
  return linhas.map(r => ({
    ...r,
    encerrada: Boolean(r.encerrada),
    ativa: Boolean(r.ativa), // true = é a rifa que está na tela do usuário
  }));
}

/**
 * Destrava (reabre) uma rifa que estava encerrada.
 * Como só pode existir UMA rifa aberta por vez, qualquer outra rifa aberta é encerrada automaticamente,
 * e a rifa destravada passa a ser a rifa aberta exibida para os usuários!
 */
function destravarRifa(db, idRifa = null) {
  return transacao(db, () => {
    salvarSnapshotRifaPublica(db);
    const cfgPublica = obterConfig(db);
    const idAlvo = idRifa ? Number(idRifa) : cfgPublica.rifaId;

    const destino = db.prepare('SELECT * FROM rifas WHERE id = ?').get(idAlvo);
    if (!destino) {
      return { _rollback: true, ok: false, codigo: 'NAO_ENCONTRADA', erro: 'Rifa não encontrada.' };
    }

    // Se havia outra rifa na tela do usuário, limpa pré-bloqueios temporários dela antes de arquivar
    if (destino.ativa !== 1) {
      db.prepare(`
        UPDATE numeros
           SET status = 'DISPONIVEL',
               etapa = 'LIVRE',
               sessao_id = NULL,
               tempo_limite = NULL,
               reservado_em = NULL,
               data_hora = NULL
         WHERE status = 'PENDENTE' AND (etapa = 'PRE_BLOQUEIO' OR reservado_por IS NULL)
      `).run();
      db.prepare(`
        UPDATE numeros
           SET tempo_limite = NULL
         WHERE status = 'PENDENTE' AND reservado_por IS NOT NULL
      `).run();
      salvarSnapshotRifaPublica(db);
    }

    // Coloca esta rifa aberta na tela dos usuários (salva snapshot da anterior se era outra)
    definirRifaPublicaNoBanco(db, idAlvo, true);

    // Garante que apenas esta rifa fique aberta (encerrada = 0) e todas as demais fiquem encerradas (encerrada = 1)
    db.prepare('UPDATE rifas SET encerrada = 1 WHERE id <> ?').run(idAlvo);
    db.prepare('UPDATE rifas SET encerrada = 0 WHERE id = ?').run(idAlvo);
    db.prepare(`
      INSERT INTO configuracoes (chave, valor) VALUES ('encerrada', '0')
      ON CONFLICT(chave) DO UPDATE SET valor = '0'
    `).run();

    return {
      ok: true,
      rifaId: idAlvo,
      encerrada: false,
      config: obterConfigRifaAdmin(db, idAlvo),
    };
  });
}

/**
 * Exclui uma rifa do sistema.
 * Se a rifa excluída era a que estava na tela do usuário, seleciona a rifa aberta (ou a última restante).
 */
function excluirRifa(db, idRifa) {
  const id = Number(idRifa);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, codigo: 'ID_INVALIDO', erro: 'ID de rifa inválido.' };
  }

  return transacao(db, () => {
    salvarSnapshotRifaPublica(db);
    const alvo = db.prepare('SELECT * FROM rifas WHERE id = ?').get(id);
    if (!alvo) {
      return { _rollback: true, ok: false, codigo: 'NAO_ENCONTRADA', erro: 'Rifa não encontrada.' };
    }

    const totalRifas = db.prepare('SELECT COUNT(*) AS c FROM rifas').get().c;
    if (totalRifas <= 1) {
      // Se era a única rifa existente, recria limpa em vez de deixar o sistema sem nenhuma rifa
      db.prepare('DELETE FROM rifas WHERE id = ?').run(id);
      db.prepare('DELETE FROM numeros').run();
      const totalPadrao = TOTAL_NUMEROS;
      const ins = db.prepare('INSERT INTO numeros (numero) VALUES (?)');
      for (let n = 1; n <= totalPadrao; n++) ins.run(n);

      const tituloPadrao = 'Sorteio de Sábado • Super Kit Churrasco';
      const valorPadrao = normalizarValorMoeda(alvo.valor || 'R$ 5,00');
      const upsert = db.prepare(`
        INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
        ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
      `);
      upsert.run('titulo', tituloPadrao);
      upsert.run('valor', valorPadrao);
      upsert.run('totalCotas', String(totalPadrao));
      upsert.run('encerrada', '0');

      const cotasIniciais = gerarCotasVazias(totalPadrao);
      const resIns = db.prepare(`
        INSERT INTO rifas (titulo, valor, total_cotas, pix_key, whatsapp, encerrada, ativa, snapshot, criada_em)
        VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)
      `).run(
        tituloPadrao,
        valorPadrao,
        totalPadrao,
        alvo.pix_key || '',
        alvo.whatsapp || '',
        JSON.stringify(cotasIniciais),
        formatarDataHora()
      );
      const novoId = Number(resIns.lastInsertRowid);
      return {
        ok: true,
        excluidaId: id,
        rifaId: novoId,
        config: obterConfigRifaAdmin(db, novoId),
      };
    }

    db.prepare('DELETE FROM rifas WHERE id = ?').run(id);

    // Se a rifa excluída era a que estava visível para os usuários (ativa = 1),
    // promove a rifa aberta (se houver) ou a última rifa restante.
    if (alvo.ativa === 1) {
      const substituta =
        db.prepare('SELECT id FROM rifas WHERE encerrada = 0 ORDER BY id DESC LIMIT 1').get() ||
        db.prepare('SELECT id FROM rifas ORDER BY id DESC LIMIT 1').get();
      if (substituta) {
        definirRifaPublicaNoBanco(db, substituta.id);
      }
    }

    const proximaAdmin =
      db.prepare('SELECT id FROM rifas WHERE ativa = 1 LIMIT 1').get() ||
      db.prepare('SELECT id FROM rifas ORDER BY id DESC LIMIT 1').get();

    return {
      ok: true,
      excluidaId: id,
      rifaId: proximaAdmin ? proximaAdmin.id : 1,
      config: obterConfigRifaAdmin(db, proximaAdmin ? proximaAdmin.id : null),
    };
  });
}

/**
 * Mantida para compatibilidade de chamadas diretas: no Admin, visualizar outra rifa não altera a tela do usuário;
 * caso chamada explicitamente, retorna os dados da rifa solicitada.
 */
function ativarRifa(db, idRifa) {
  const id = Number(idRifa);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, codigo: 'ID_INVALIDO', erro: 'ID de rifa inválido.' };
  }
  const destino = db.prepare('SELECT * FROM rifas WHERE id = ?').get(id);
  if (!destino) {
    return { ok: false, codigo: 'NAO_ENCONTRADA', erro: 'Rifa não encontrada.' };
  }
  return { ok: true, config: obterConfigRifaAdmin(db, id) };
}

function rifaEncerrada(db) {
  const r = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'encerrada'").get();
  return Boolean(r && r.valor === '1');
}

/**
 * Libera registros PENDENTEs cujo tempo_limite já venceu (pré-bloqueios ou reservas de 10 min).
 * Retorna a quantidade de cotas liberadas.
 */
function expirar(db, agora = Date.now()) {
  const r = db.prepare(`
    UPDATE numeros
       SET status = 'DISPONIVEL',
           etapa = 'LIVRE',
           nome = NULL,
           reservado_por = NULL,
           whatsapp = NULL,
           sessao_id = NULL,
           tempo_limite = NULL,
           reservado_em = NULL,
           data_hora = NULL
     WHERE status = 'PENDENTE'
       AND tempo_limite IS NOT NULL
       AND tempo_limite <= ?
  `).run(agora);
  return Number(r.changes);
}

function mensagemColisao(numero) {
  return `Ops! O número ${pad(numero)} acabou de ser reservado por outro participante. Por favor, escolha outro número disponível na grade.`;
}

function extrairListaNumeros(numeroOuLista) {
  const bruta = Array.isArray(numeroOuLista) ? numeroOuLista : [numeroOuLista];
  const vistos = new Set();
  const lista = [];
  for (const item of bruta) {
    const n = Number(item);
    if (!Number.isInteger(n)) return { ok: false, lista: [] };
    if (!vistos.has(n)) {
      vistos.add(n);
      lista.push(n);
    }
  }
  return { ok: lista.length > 0, lista };
}

/**
 * ETAPA 1 (Pré-bloqueio):
 * Aplica um bloqueio temporário de 10 minutos no banco de dados para 1 ou mais números selecionados
 * enquanto o usuário preenche Nome e WhatsApp.
 */
function preBloquear(db, numeroOuLista, sessaoId, agora = Date.now()) {
  const totalMax = obterTotalCotas(db);
  const { ok, lista } = extrairListaNumeros(numeroOuLista);
  if (!ok || lista.some(n => n < 1 || n > totalMax)) {
    return {
      ok: false,
      codigo: 'NUMERO_INVALIDO',
      erro: `Número inválido (escolha de 01 a ${pad(totalMax)}).`,
    };
  }
  const token = String(sessaoId || '').trim() || `sess_${agora}_${Math.random().toString(36).slice(2, 8)}`;

  return transacao(db, () => {
    expirar(db, agora);

    if (rifaEncerrada(db)) {
      return {
        _rollback: true,
        ok: false,
        codigo: 'RIFA_ENCERRADA',
        erro: 'Esta rifa já foi encerrada e não aceita novas reservas.',
      };
    }

    const sel = db.prepare('SELECT * FROM numeros WHERE numero = ?');
    for (const numero of lista) {
      const linha = sel.get(numero);
      if (!linha) {
        return { _rollback: true, ok: false, codigo: 'NUMERO_INVALIDO', erro: 'Número inexistente.' };
      }

      const mesmoPreBloqueio =
        linha.status === 'PENDENTE' &&
        linha.etapa === 'PRE_BLOQUEIO' &&
        linha.sessao_id === token;

      if (linha.status !== 'DISPONIVEL' && !mesmoPreBloqueio) {
        return {
          _rollback: true,
          ok: false,
          codigo: 'INDISPONIVEL',
          numeroConflito: numero,
          erro: mensagemColisao(numero),
        };
      }
    }

    const limite = agora + MINUTOS_PRE_BLOQUEIO * 60 * 1000;
    const dataHora = formatarDataHora(agora);
    const upd = db.prepare(`
      UPDATE numeros
         SET status = 'PENDENTE',
             etapa = 'PRE_BLOQUEIO',
             sessao_id = ?,
             tempo_limite = ?,
             reservado_em = ?,
             data_hora = ?
       WHERE numero = ?
    `);

    for (const numero of lista) {
      upd.run(token, limite, agora, dataHora, numero);
    }

    return {
      ok: true,
      numero: lista[0],
      numeros: lista,
      sessaoId: token,
      tempo_limite: limite,
      etapa: 'PRE_BLOQUEIO',
    };
  });
}

/**
 * Cancela o pré-bloqueio caso o próprio usuário feche o modal antes de preencher os dados.
 */
function cancelarPreBloqueio(db, numeroOuLista, sessaoId) {
  if (!sessaoId) return { ok: false };
  const { ok, lista } = extrairListaNumeros(numeroOuLista);

  return transacao(db, () => {
    if (!ok || lista.length === 0) {
      const rAll = db.prepare(`
        UPDATE numeros
           SET status = 'DISPONIVEL',
               etapa = 'LIVRE',
               sessao_id = NULL,
               tempo_limite = NULL,
               reservado_em = NULL,
               data_hora = NULL
         WHERE status = 'PENDENTE'
           AND etapa = 'PRE_BLOQUEIO'
           AND sessao_id = ?
      `).run(String(sessaoId));
      return { ok: Number(rAll.changes) > 0 };
    }

    const stmt = db.prepare(`
      UPDATE numeros
         SET status = 'DISPONIVEL',
             etapa = 'LIVRE',
             sessao_id = NULL,
             tempo_limite = NULL,
             reservado_em = NULL,
             data_hora = NULL
       WHERE numero = ?
         AND status = 'PENDENTE'
         AND etapa = 'PRE_BLOQUEIO'
         AND sessao_id = ?
    `);
    let changes = 0;
    for (const n of lista) {
      const r = stmt.run(n, String(sessaoId));
      changes += Number(r.changes);
    }
    return { ok: changes > 0 };
  });
}

/**
 * ETAPA 2 (Transação Final):
 * Ao clicar em "Reservar e Pagar", valida atomicamente dentro de BEGIN IMMEDIATE (suporta 1 ou múltiplos números).
 * Define o prazo de 10 minutos para conclusão do pagamento via Pix.
 */
function reservar(db, numeroOuLista, nome, whatsapp, sessaoId = null, agora = Date.now()) {
  const totalMax = obterTotalCotas(db);
  const { ok, lista } = extrairListaNumeros(numeroOuLista);
  if (!ok || lista.some(n => n < 1 || n > totalMax)) {
    return { ok: false, codigo: 'NUMERO_INVALIDO', erro: 'Número inválido.' };
  }

  nome = String(nome || '').trim();
  whatsapp = String(whatsapp || '').replace(/\D/g, '');
  if (nome.length < 2 || nome.length > 60) {
    return { ok: false, codigo: 'NOME_INVALIDO', erro: 'Informe um nome válido (2 a 60 caracteres).' };
  }
  if (whatsapp.length < 10 || whatsapp.length > 13) {
    return { ok: false, codigo: 'WHATSAPP_INVALIDO', erro: 'Informe um WhatsApp válido com DDD.' };
  }

  return transacao(db, () => {
    expirar(db, agora);

    if (rifaEncerrada(db)) {
      return {
        _rollback: true,
        ok: false,
        codigo: 'RIFA_ENCERRADA',
        erro: 'Esta rifa já foi encerrada e não aceita novas reservas.',
      };
    }

    const sel = db.prepare('SELECT * FROM numeros WHERE numero = ?');
    for (const numero of lista) {
      const linha = sel.get(numero);
      if (!linha) {
        return { _rollback: true, ok: false, codigo: 'NUMERO_INVALIDO', erro: 'Número inválido.' };
      }

      const disponivelParaEsteCliente =
        linha.status === 'DISPONIVEL' ||
        (linha.status === 'PENDENTE' &&
          linha.etapa === 'PRE_BLOQUEIO' &&
          (!linha.sessao_id || !sessaoId || linha.sessao_id === String(sessaoId)));

      if (!disponivelParaEsteCliente) {
        return {
          _rollback: true,
          ok: false,
          codigo: 'INDISPONIVEL',
          numeroConflito: numero,
          erro: mensagemColisao(numero),
        };
      }
    }

    const limite = agora + MINUTOS_RESERVA * 60 * 1000;
    const dataHora = formatarDataHora(agora);

    const tokenSessao = sessaoId ? String(sessaoId).trim() : null;
    const upd = db.prepare(`
      UPDATE numeros
         SET status = 'PENDENTE',
             etapa = 'RESERVADO',
             nome = ?,
             reservado_por = ?,
             whatsapp = ?,
             sessao_id = COALESCE(?, sessao_id),
             tempo_limite = ?,
             reservado_em = ?,
             data_hora = ?
       WHERE numero = ?
    `);

    for (const numero of lista) {
      const rUpd = upd.run(nome, nome, whatsapp, tokenSessao, limite, agora, dataHora, numero);
      if (Number(rUpd.changes) !== 1) {
        return {
          _rollback: true,
          ok: false,
          codigo: 'INDISPONIVEL',
          numeroConflito: numero,
          erro: mensagemColisao(numero),
        };
      }
    }

    return {
      ok: true,
      numero: lista[0],
      numeros: lista,
      nome,
      whatsapp,
      tempo_limite: limite,
      data_hora: dataHora,
    };
  });
}

function confirmar(db, numero, agora = Date.now(), rifaId = null) {
  return transacao(db, () => {
    expirar(db, agora);
    const dataHora = formatarDataHora(agora);
    const cfgPublica = obterConfig(db);
    const idAlvo = rifaId ? Number(rifaId) : cfgPublica.rifaId;
    const regRifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(idAlvo);

    if (!regRifa || regRifa.ativa === 1) {
      const r = db.prepare(`
        UPDATE numeros
           SET status = 'PAGO',
               etapa = 'PAGO',
               pago_em = ?,
               tempo_limite = NULL,
               data_hora = COALESCE(data_hora, ?)
         WHERE numero = ? AND status = 'PENDENTE'
      `).run(agora, dataHora, numero);

      if (Number(r.changes) === 0) {
        return {
          _rollback: true,
          ok: false,
          codigo: 'NAO_PENDENTE',
          erro: 'Número não está pendente (pode ter expirado ou já foi confirmado).',
        };
      }
      salvarSnapshotRifaPublica(db);
      return { ok: true, numero };
    }

    // Confirmação em uma rifa arquivada (ativa = 0)
    let cotas = [];
    try {
      cotas = regRifa.snapshot ? JSON.parse(regRifa.snapshot) : [];
    } catch (_) {
      cotas = [];
    }
    const item = cotas.find(c => c.numero === Number(numero));
    if (!item || item.status !== 'PENDENTE') {
      return {
        _rollback: true,
        ok: false,
        codigo: 'NAO_PENDENTE',
        erro: 'Número não está pendente nesta rifa.',
      };
    }
    item.status = 'PAGO';
    item.etapa = 'PAGO';
    item.pago_em = agora;
    item.tempo_limite = null;
    item.data_hora = item.data_hora || dataHora;

    db.prepare('UPDATE rifas SET snapshot = ? WHERE id = ?').run(JSON.stringify(cotas), idAlvo);
    return { ok: true, numero };
  });
}

function liberar(db, numero, rifaId = null) {
  return transacao(db, () => {
    const cfgPublica = obterConfig(db);
    const idAlvo = rifaId ? Number(rifaId) : cfgPublica.rifaId;
    const regRifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(idAlvo);

    if (!regRifa || regRifa.ativa === 1) {
      const r = db.prepare(`
        UPDATE numeros
           SET status = 'DISPONIVEL',
               etapa = 'LIVRE',
               nome = NULL,
               reservado_por = NULL,
               whatsapp = NULL,
               sessao_id = NULL,
               tempo_limite = NULL,
               reservado_em = NULL,
               pago_em = NULL,
               data_hora = NULL
         WHERE numero = ? AND status <> 'DISPONIVEL'
      `).run(numero);

      if (!Number(r.changes)) {
        return { _rollback: true, ok: false, codigo: 'JA_DISPONIVEL', erro: 'Número já está disponível.' };
      }
      salvarSnapshotRifaPublica(db);
      return { ok: true, numero };
    }

    // Liberação em uma rifa arquivada (ativa = 0)
    let cotas = [];
    try {
      cotas = regRifa.snapshot ? JSON.parse(regRifa.snapshot) : [];
    } catch (_) {
      cotas = [];
    }
    const item = cotas.find(c => c.numero === Number(numero));
    if (!item || item.status === 'DISPONIVEL') {
      return { _rollback: true, ok: false, codigo: 'JA_DISPONIVEL', erro: 'Número já está disponível.' };
    }
    item.status = 'DISPONIVEL';
    item.etapa = 'LIVRE';
    item.nome = null;
    item.reservado_por = null;
    item.whatsapp = null;
    item.sessao_id = null;
    item.tempo_limite = null;
    item.reservado_em = null;
    item.pago_em = null;
    item.data_hora = null;

    db.prepare('UPDATE rifas SET snapshot = ? WHERE id = ?').run(JSON.stringify(cotas), idAlvo);
    return { ok: true, numero };
  });
}

/**
 * Encerra a rifa selecionada, travando a grade contra novas reservas.
 * Caso seja a rifa atualmente aberta na tela do usuário, ela permanece na tela do usuário
 * (como a última rifa que estava aberta) com a mensagem de que foi encerrada!
 */
function encerrarRifa(db, rifaId = null) {
  return transacao(db, () => {
    const cfgPublica = obterConfig(db);
    const idAlvo = rifaId ? Number(rifaId) : cfgPublica.rifaId;
    const regRifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(idAlvo);

    if (!regRifa || regRifa.ativa === 1) {
      db.prepare(`
        UPDATE numeros
           SET status = 'DISPONIVEL',
               etapa = 'LIVRE',
               sessao_id = NULL,
               tempo_limite = NULL,
               reservado_em = NULL,
               data_hora = NULL
         WHERE status = 'PENDENTE' AND (etapa = 'PRE_BLOQUEIO' OR reservado_por IS NULL)
      `).run();

      db.prepare(`
        UPDATE numeros
           SET tempo_limite = NULL
         WHERE status = 'PENDENTE' AND reservado_por IS NOT NULL
      `).run();

      db.prepare(`
        INSERT INTO configuracoes (chave, valor) VALUES ('encerrada', '1')
        ON CONFLICT(chave) DO UPDATE SET valor = '1'
      `).run();

      db.prepare('UPDATE rifas SET encerrada = 1 WHERE ativa = 1').run();
      salvarSnapshotRifaPublica(db);

      return { ok: true, rifaId: idAlvo, encerrada: true };
    }

    // Encerra uma rifa que não era a ativa
    let cotas = [];
    try {
      cotas = regRifa.snapshot ? JSON.parse(regRifa.snapshot) : [];
    } catch (_) {
      cotas = [];
    }
    for (const c of cotas) {
      if (c.status === 'PENDENTE' && (c.etapa === 'PRE_BLOQUEIO' || !c.reservado_por)) {
        c.status = 'DISPONIVEL';
        c.etapa = 'LIVRE';
        c.sessao_id = null;
        c.tempo_limite = null;
        c.reservado_em = null;
        c.data_hora = null;
      } else if (c.status === 'PENDENTE') {
        c.tempo_limite = null;
      }
    }
    db.prepare('UPDATE rifas SET encerrada = 1, snapshot = ? WHERE id = ?').run(JSON.stringify(cotas), idAlvo);
    return { ok: true, rifaId: idAlvo, encerrada: true };
  });
}

/** Visão pública: sempre retorna a rifa aberta (ou a última aberta com status encerrada). */
function listarPublico(db, agora = Date.now(), sessaoIdCliente = null) {
  expirar(db, agora);
  const total = obterTotalCotas(db);
  const linhas = db
    .prepare('SELECT numero, status, etapa, tempo_limite, sessao_id FROM numeros WHERE numero <= ? ORDER BY numero')
    .all(total);
  const sid = sessaoIdCliente ? String(sessaoIdCliente).trim() : '';
  return linhas.map(l => ({
    numero: l.numero,
    status: l.status,
    etapa: l.etapa,
    tempo_limite: l.tempo_limite,
    meu: Boolean(sid && l.sessao_id && l.sessao_id === sid && l.status !== 'DISPONIVEL'),
  }));
}

/** Lista todas as cotas de uma rifa específica (para o Admin ou exportação). */
function listarTodasCotas(db, agora = Date.now(), rifaId = null) {
  expirar(db, agora);
  const cfgPublica = obterConfig(db);
  const idAlvo = rifaId ? Number(rifaId) : cfgPublica.rifaId;
  const regRifa = db.prepare('SELECT * FROM rifas WHERE id = ?').get(idAlvo);

  if (!regRifa || regRifa.ativa === 1) {
    return db
      .prepare(`
        SELECT numero,
               status,
               etapa,
               COALESCE(nome, reservado_por) AS nome,
               reservado_por,
               whatsapp,
               tempo_limite,
               reservado_em,
               pago_em,
               data_hora
          FROM numeros
         WHERE numero <= ?
         ORDER BY numero ASC
      `)
      .all(cfgPublica.total)
      .map(c => ({ ...c, valor: cfgPublica.valor }));
  }

  let cotas = [];
  try {
    cotas = regRifa.snapshot ? JSON.parse(regRifa.snapshot) : [];
  } catch (_) {
    cotas = gerarCotasVazias(regRifa.total_cotas);
  }
  return cotas
    .filter(c => c.numero <= regRifa.total_cotas)
    .map(c => ({
      numero: c.numero,
      status: c.status || 'DISPONIVEL',
      etapa: c.etapa || 'LIVRE',
      nome: c.nome || c.reservado_por || null,
      reservado_por: c.reservado_por || c.nome || null,
      whatsapp: c.whatsapp || null,
      tempo_limite: c.tempo_limite || null,
      reservado_em: c.reservado_em || null,
      pago_em: c.pago_em || null,
      data_hora: c.data_hora || null,
      valor: regRifa.valor || 'R$ 5,00',
    }));
}

/** Visão administrativa: lista os pedidos ocupados da rifa selecionada pelo Admin. */
function listarPedidos(db, agora = Date.now(), rifaId = null) {
  const todas = listarTodasCotas(db, agora, rifaId);
  return todas.filter(c => c.status !== 'DISPONIVEL');
}

/**
 * Gera planilha nativa do Microsoft Excel (.xlsx) usando exceljs com:
 * - Paleta visual elegante (#1F4E78 Azul Marinho / #1E4620 Verde Escuro com fonte branca em negrito)
 * - Bloco 1: Cabeçalho e Identidade (Linhas 1 a 5)
 * - Bloco 2: Painel Financeiro & DRE (Fórmulas SUM, subtração de Lucro Líquido e Margem % sem referência circular)
 * - Bloco 3: Tabela Detalhada de Cotas (Cota texto 2 dígitos, preenchimento condicional PAGO/PENDENTE, linhas zebradas)
 * - Auto-ajuste de largura de coluna (mínimo 16 caracteres para nunca exibir '######')
 */
async function gerarPlanilhaXLSX(db, agora = Date.now(), rifaId = null, custoKitInformado = 0) {
  const cfg = obterConfigRifaAdmin(db, rifaId);
  const cotas = listarTodasCotas(db, agora, cfg.rifaId);

  const totalCotas = cotas.length;
  const unitarioNum = cfg.valorNumerico || extrairValorNumerico(cfg.valor) || 5;
  const custoNum =
    typeof custoKitInformado === 'number' && Number.isFinite(custoKitInformado) && custoKitInformado >= 0
      ? custoKitInformado
      : extrairValorNumerico(custoKitInformado) || 0;

  const cotasPagas = cotas.filter(c => c.status === 'PAGO').length;
  const cotasPendentes = cotas.filter(c => c.status === 'PENDENTE').length;
  const cotasLivres = cotas.filter(c => c.status === 'DISPONIVEL').length;
  const totalArrecadadoNum = cotasPagas * unitarioNum;
  const lucroLiquidoNum = totalArrecadadoNum - custoNum;
  const margemNum = totalArrecadadoNum > 0 ? lucroLiquidoNum / totalArrecadadoNum : 0;

  const formatarZap = zap => {
    const d = String(zap || '').replace(/\D/g, '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return zap || '-';
  };

  const workbook = new ExcelJS.Workbook();
  workbook.creator = MARCA_FIXA;
  workbook.created = new Date(agora);

  const sheet = workbook.addWorksheet('Relatório da Rifa', {
    views: [{ showGridLines: true }],
  });

  const bordaFinaCinza = {
    top: { style: 'thin', color: { argb: 'FFD0D5DD' } },
    left: { style: 'thin', color: { argb: 'FFD0D5DD' } },
    bottom: { style: 'thin', color: { argb: 'FFD0D5DD' } },
    right: { style: 'thin', color: { argb: 'FFD0D5DD' } },
  };

  const bordaDestaque = {
    top: { style: 'medium', color: { argb: 'FFD99B00' } },
    left: { style: 'medium', color: { argb: 'FFD99B00' } },
    bottom: { style: 'medium', color: { argb: 'FFD99B00' } },
    right: { style: 'medium', color: { argb: 'FFD99B00' } },
  };

  // =========================================================================
  // BLOCO 1: CABEÇALHO E IDENTIDADE (Linhas 1 a 5)
  // =========================================================================
  sheet.mergeCells('A1:F1');
  const cellMarca = sheet.getCell('A1');
  cellMarca.value = MARCA_FIXA;
  cellMarca.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  cellMarca.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  cellMarca.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  sheet.getRow(1).height = 28;

  sheet.mergeCells('A2:F2');
  const cellTitulo = sheet.getCell('A2');
  cellTitulo.value = `Edição: ${cfg.titulo}`;
  cellTitulo.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF1F4E78' } };
  cellTitulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  cellTitulo.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  sheet.getRow(2).height = 22;

  sheet.getCell('A3').value = 'Data/Hora Exportação:';
  sheet.getCell('A3').font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF333333' } };
  sheet.getCell('B3').value = formatarDataHora(agora);
  sheet.getCell('B3').font = { name: 'Calibri', size: 10, color: { argb: 'FF333333' } };

  sheet.getCell('A4').value = 'Status da Rifa:';
  sheet.getCell('A4').font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF333333' } };
  sheet.getCell('B4').value = cfg.encerrada ? 'ENCERRADA' : 'ABERTA / EM ANDAMENTO';
  sheet.getCell('B4').font = {
    name: 'Calibri',
    size: 10,
    bold: true,
    color: { argb: cfg.encerrada ? 'FFC00000' : 'FF1E4620' },
  };

  sheet.getRow(5).height = 10;

  // =========================================================================
  // BLOCO 2: PAINEL FINANCEIRO & DRE (Linhas 6 a 16)
  // Tabela de cotas começará na linha 20 (F20 até F{19 + totalCotas}),
  // totalmente fora do intervalo B8:B16 para jamais haver referência circular.
  // =========================================================================
  const linhaInicioCotas = 20;
  const linhaFimCotas = 19 + totalCotas;

  sheet.mergeCells('A6:C6');
  const cellDreTitulo = sheet.getCell('A6');
  cellDreTitulo.value = 'PAINEL FINANCEIRO & DRE (RESUMO DA RIFA)';
  cellDreTitulo.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  cellDreTitulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  cellDreTitulo.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  sheet.getRow(6).height = 22;

  const cabecalhosDre = ['Indicador Financeiro', 'Valor / Resultado', 'Observação / Cálculo'];
  const rowCabDre = sheet.getRow(7);
  rowCabDre.height = 20;
  cabecalhosDre.forEach((texto, i) => {
    const c = rowCabDre.getCell(i + 1);
    c.value = texto;
    c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
    c.alignment = { vertical: 'middle', horizontal: i === 1 ? 'right' : 'left', indent: i === 1 ? 0 : 1 };
    c.border = bordaFinaCinza;
  });

  const linhasDre = [
    {
      linha: 8,
      indicador: 'Total de Cotas',
      valor: totalCotas,
      numFmt: '#,##0',
      obs: 'Quantidade total de números da rifa',
    },
    {
      linha: 9,
      indicador: 'Valor por Cota',
      valor: unitarioNum,
      numFmt: '"R$" #,##0.00',
      obs: 'Preço unitário de cada número',
    },
    {
      linha: 10,
      indicador: 'Cotas Pagas',
      valor: cotasPagas,
      numFmt: '#,##0',
      obs: 'Cotas com pagamento confirmado',
    },
    {
      linha: 11,
      indicador: 'Cotas Pendentes',
      valor: cotasPendentes,
      numFmt: '#,##0',
      obs: 'Cotas reservadas aguardando Pix',
    },
    {
      linha: 12,
      indicador: 'Cotas Livres',
      valor: cotasLivres,
      numFmt: '#,##0',
      obs: 'Cotas disponíveis na grade',
    },
    {
      linha: 13,
      indicador: 'Total Arrecadado',
      valor: { formula: `SUM(F${linhaInicioCotas}:F${linhaFimCotas})`, result: totalArrecadadoNum },
      numFmt: '"R$" #,##0.00',
      obs: `Soma automática dos valores pagos (F${linhaInicioCotas}:F${linhaFimCotas})`,
      negrito: true,
    },
    {
      linha: 14,
      indicador: 'Custo do Kit / Prêmios',
      valor: custoNum,
      numFmt: '"R$" #,##0.00',
      obs: '<< Preencha aqui quanto você gastou no kit (célula editável)',
      destaqueAmarelo: true,
    },
    {
      linha: 15,
      indicador: 'Lucro Líquido Real',
      valor: { formula: 'B13-B14', result: lucroLiquidoNum },
      numFmt: '"R$" #,##0.00',
      obs: 'Fórmula: Total Arrecadado (B13) - Custo do Kit (B14)',
      negrito: true,
      destaqueLucro: true,
    },
    {
      linha: 16,
      indicador: 'Margem de Lucro (%)',
      valor: { formula: 'IF(B13>0,B15/B13,0)', result: margemNum },
      numFmt: '0.0%',
      obs: 'Fórmula: Lucro Líquido (B15) / Total Arrecadado (B13)',
      negrito: true,
      destaqueLucro: true,
    },
  ];

  for (const item of linhasDre) {
    const r = sheet.getRow(item.linha);
    r.height = 20;
    const cInd = r.getCell(1);
    const cVal = r.getCell(2);
    const cObs = r.getCell(3);

    cInd.value = item.indicador;
    cVal.value = item.valor;
    cVal.numFmt = item.numFmt;
    cObs.value = item.obs;

    const bgPadrao = item.linha % 2 === 0 ? 'FFFFFFFF' : 'FFF9FAFB';
    cInd.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgPadrao } };
    cObs.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgPadrao } };

    cInd.font = { name: 'Calibri', size: 10, bold: Boolean(item.negrito || item.destaqueAmarelo) };
    cObs.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF595959' } };

    if (item.destaqueAmarelo) {
      cVal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
      cVal.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF7F6000' } };
      cVal.border = bordaDestaque;
    } else if (item.destaqueLucro) {
      cVal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
      cVal.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF1E4620' } };
      cVal.border = bordaFinaCinza;
    } else {
      cVal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgPadrao } };
      cVal.font = { name: 'Calibri', size: 10, bold: Boolean(item.negrito) };
      cVal.border = bordaFinaCinza;
    }

    cInd.border = bordaFinaCinza;
    cObs.border = bordaFinaCinza;
    cInd.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cVal.alignment = { vertical: 'middle', horizontal: 'right' };
    cObs.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  }

  sheet.getRow(17).height = 12;

  // =========================================================================
  // BLOCO 3: TABELA DETALHADA DE COTAS (Linhas 18 em diante)
  // =========================================================================
  sheet.mergeCells('A18:F18');
  const cellTabTitulo = sheet.getCell('A18');
  cellTabTitulo.value = `TABELA DETALHADA DE COTAS (01 A ${pad(totalCotas)})`;
  cellTabTitulo.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  cellTabTitulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E4620' } };
  cellTabTitulo.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  sheet.getRow(18).height = 22;

  const cabecalhosCotas = [
    'Cota',
    'Nome do Participante',
    'WhatsApp',
    'Status',
    'Data da Reserva',
    'Valor (R$)',
  ];
  const rowCabCotas = sheet.getRow(19);
  rowCabCotas.height = 22;
  cabecalhosCotas.forEach((texto, idx) => {
    const cell = rowCabCotas.getCell(idx + 1);
    cell.value = texto;
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = {
      vertical: 'middle',
      horizontal: idx === 0 || idx === 3 || idx === 4 ? 'center' : idx === 5 ? 'right' : 'left',
    };
    cell.border = bordaFinaCinza;
  });

  cotas.forEach((c, idx) => {
    const numLinha = linhaInicioCotas + idx;
    const r = sheet.getRow(numLinha);
    r.height = 19;

    const cotaTexto = String(c.numero).padStart(2, '0');
    const nome = c.nome || c.reservado_por || '-';
    const zap = c.whatsapp ? formatarZap(c.whatsapp) : '-';
    const status = c.status;
    const dataReserva = c.data_hora || (c.reservado_em ? formatarDataHora(c.reservado_em) : '-');
    const valorPago = status === 'PAGO' ? unitarioNum : 0;

    const cellCota = r.getCell(1);
    const cellNome = r.getCell(2);
    const cellZap = r.getCell(3);
    const cellStatus = r.getCell(4);
    const cellData = r.getCell(5);
    const cellValor = r.getCell(6);

    cellCota.value = cotaTexto;
    cellCota.numFmt = '@'; // Forçado como texto para preservar o zero à esquerda
    cellNome.value = nome;
    cellZap.value = zap;
    cellStatus.value = status;
    cellData.value = dataReserva;
    cellValor.value = valorPago;
    cellValor.numFmt = '"R$" #,##0.00';

    const corZebra = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF2F4F8';

    [cellCota, cellNome, cellZap, cellStatus, cellData, cellValor].forEach((cell, colIdx) => {
      cell.border = bordaFinaCinza;
      cell.font = {
        name: 'Calibri',
        size: 10,
        bold: colIdx === 0 || colIdx === 3,
        color: { argb: status === 'DISPONIVEL' && colIdx !== 0 ? 'FF667085' : 'FF1D2939' },
      };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: corZebra } };
    });

    if (status === 'PAGO') {
      cellStatus.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
      cellStatus.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF1E4620' } };
      cellValor.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF1E4620' } };
    } else if (status === 'PENDENTE') {
      cellStatus.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
      cellStatus.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFB54708' } };
    }

    cellCota.alignment = { vertical: 'middle', horizontal: 'center' };
    cellNome.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cellZap.alignment = { vertical: 'middle', horizontal: 'center' };
    cellStatus.alignment = { vertical: 'middle', horizontal: 'center' };
    cellData.alignment = { vertical: 'middle', horizontal: 'center' };
    cellValor.alignment = { vertical: 'middle', horizontal: 'right' };
  });

  // =========================================================================
  // AUTO-AJUSTE DE LARGURA DE COLUNAS (Mínimo de 15 caracteres para nunca exibir '######')
  // =========================================================================
  const largurasMinimas = [16, 32, 22, 18, 24, 20];
  for (let colIdx = 1; colIdx <= 6; colIdx++) {
    const col = sheet.getColumn(colIdx);
    let maxLen = largurasMinimas[colIdx - 1] || 16;
    col.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      // Ignora células mescladas de título (linhas 1, 2, 6, 18) no cálculo individual da coluna
      if (rowNumber === 1 || rowNumber === 2 || rowNumber === 6 || rowNumber === 18) return;
      let texto = '';
      if (cell.value && typeof cell.value === 'object' && 'result' in cell.value) {
        texto = `R$ ${Number(cell.value.result || 0).toFixed(2)}`;
      } else if (cell.value !== null && cell.value !== undefined) {
        texto = String(cell.value);
      }
      if (texto.length + 4 > maxLen) {
        maxLen = Math.min(55, texto.length + 4);
      }
    });
    col.width = Math.max(15, maxLen);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Gera conteúdo CSV legado caso chamado diretamente.
 */
function gerarCSV(db, agora = Date.now(), rifaId = null, custoKitInformado = 0) {
  const cfg = obterConfigRifaAdmin(db, rifaId);
  const cotas = listarTodasCotas(db, agora, cfg.rifaId);

  const escapar = val => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.startsWith('=')) {
      // Fórmulas para o Excel: se contiver ponto-e-vírgula interno (como em SE), deve ser envolvida em aspas
      if (s.includes(';')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const totalCotas = cotas.length;
  const unitarioNum = cfg.valorNumerico || extrairValorNumerico(cfg.valor) || 5;
  const unitarioStr = unitarioNum.toFixed(2).replace('.', ',');

  const custoNum =
    typeof custoKitInformado === 'number' && Number.isFinite(custoKitInformado) && custoKitInformado >= 0
      ? custoKitInformado
      : extrairValorNumerico(custoKitInformado) || 0;
  const custoStr = custoNum.toFixed(2).replace('.', ',');

  const cotasPagas = cotas.filter(c => c.status === 'PAGO').length;
  const cotasPendentes = cotas.filter(c => c.status === 'PENDENTE').length;
  const cotasLivres = cotas.filter(c => c.status === 'DISPONIVEL').length;

  const formatarZap = zap => {
    const d = String(zap || '').replace(/\D/g, '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return zap || '';
  };

  // Linhas da tabela de participantes começam na linha 27 e vão até 26 + totalCotas
  const linhaInicioCotas = 27;
  const linhaFimCotas = 26 + totalCotas;

  const linhasResumo = [
    'sep=;',
    ['RELATÓRIO FINANCEIRO E CONTROLE DE COTAS', '', '', '', '', '', ''].map(escapar).join(';'),
    ['Rifa:', cfg.titulo, '', '', '', '', ''].map(escapar).join(';'),
    ['Marca:', MARCA_FIXA, '', '', '', '', ''].map(escapar).join(';'),
    ['Data de Exportação:', formatarDataHora(agora), '', '', '', '', ''].map(escapar).join(';'),
    ['Status da Rifa:', cfg.encerrada ? 'ENCERRADA' : 'ABERTA / EM ANDAMENTO', '', '', '', '', ''].map(escapar).join(';'),
    ['', '', '', '', '', '', ''].map(escapar).join(';'),
    ['========================================', '====================', '========', '==================================================', '', '', ''].map(escapar).join(';'),
    ['PAINEL DE RESUMO FINANCEIRO E LUCRO', '', '', '', '', '', ''].map(escapar).join(';'),
    ['Indicador', 'Valor / Fórmula', 'Unidade', 'Descrição / Como Funciona', '', '', ''].map(escapar).join(';'),
    ['Total de Cotas da Rifa', String(totalCotas), 'cotas', 'Quantidade total de números na grade', '', '', ''].map(escapar).join(';'),
    ['Valor por Cota', unitarioStr, 'R$', 'Preço unitário de cada número da rifa', '', '', ''].map(escapar).join(';'),
    ['Cotas Pagas (Confirmadas)', String(cotasPagas), 'cotas', 'Quantidade de cotas com pagamento confirmado', '', '', ''].map(escapar).join(';'),
    ['Cotas Reservadas (Pendentes)', String(cotasPendentes), 'cotas', 'Quantidade de cotas aguardando confirmação do Pix', '', '', ''].map(escapar).join(';'),
    ['Cotas Disponíveis (Livres)', String(cotasLivres), 'cotas', 'Quantidade de números ainda disponíveis para venda', '', '', ''].map(escapar).join(';'),
    ['Total Arrecadado (Confirmado)', `=SOMA(G${linhaInicioCotas}:G${linhaFimCotas})`, 'R$', 'Soma real recebida das cotas pagas (calculado via Coluna G)', '', '', ''].map(escapar).join(';'),
    ['Faturamento Potencial Máximo', '=B11*B12', 'R$', 'Faturamento total projetado se vender 100% das cotas (B11 × B12)', '', '', ''].map(escapar).join(';'),
    ['CUSTO DO KIT (DIGITE SEU GASTO AQUI)', custoStr, 'R$', '>> CAMPO EDITÁVEL: Digite aqui quanto gastou no kit para recalcular <<', '', '', ''].map(escapar).join(';'),
    ['LUCRO LÍQUIDO REAL', '=B16-B18', 'R$', 'Fórmula: Total Arrecadado (B16) - Custo do Kit (B18)', '', '', ''].map(escapar).join(';'),
    ['LUCRO POTENCIAL MÁXIMO', '=B17-B18', 'R$', 'Fórmula: Faturamento Potencial (B17) - Custo do Kit (B18)', '', '', ''].map(escapar).join(';'),
    ['MARGEM DE LUCRO SOBRE O CUSTO (%)', '=SE(B18>0;(B19/B18)*100;0)', '%', 'Fórmula: (Lucro Líquido Real / Custo do Kit) × 100', '', '', ''].map(escapar).join(';'),
    ['MARGEM DE LUCRO SOBRE A VENDA (%)', '=SE(B16>0;(B19/B16)*100;0)', '%', 'Fórmula: (Lucro Líquido Real / Total Arrecadado) × 100', '', '', ''].map(escapar).join(';'),
    ['========================================', '====================', '========', '==================================================', '', '', ''].map(escapar).join(';'),
    ['', '', '', '', '', '', ''].map(escapar).join(';'),
    ['TABELA DETALHADA DE COTAS E PARTICIPANTES', '', '', '', '', '', ''].map(escapar).join(';'),
    ['Cota', 'Nome do Participante', 'WhatsApp', 'Status', 'Data/Hora da Reserva', 'Valor Cota (R$)', 'Valor Pago (R$)'].map(escapar).join(';'),
  ];

  const linhasCotas = cotas.map((c, idx) => {
    const numLinha = linhaInicioCotas + idx;
    const cota = pad(c.numero);
    const nome = c.nome || c.reservado_por || '';
    const whatsapp = formatarZap(c.whatsapp);
    const status = c.status;
    const dataHora = c.data_hora || (c.reservado_em ? formatarDataHora(c.reservado_em) : '');
    const formulaValorPago = `=SE(D${numLinha}="PAGO";F${numLinha};0)`;
    return [cota, nome, whatsapp, status, dataHora, unitarioStr, formulaValorPago].map(escapar).join(';');
  });

  return '\uFEFF' + [...linhasResumo, ...linhasCotas].join('\r\n');
}

/**
 * Gera a mensagem formatada para WhatsApp após o encerramento da rifa selecionada.
 * Contém APENAS "Número - Nome do Participante" (omitindo o telefone por privacidade).
 */
function gerarMensagemWhatsapp(db, rifaId = null) {
  const cfg = obterConfigRifaAdmin(db, rifaId);
  if (!cfg.encerrada) {
    return {
      ok: false,
      codigo: 'RIFA_NAO_ENCERRADA',
      erro: 'A mensagem para WhatsApp só pode ser gerada após encerrar a rifa.',
    };
  }

  const cotas = listarTodasCotas(db, Date.now(), cfg.rifaId);
  const participantes = cotas
    .filter(c => (c.status === 'PENDENTE' || c.status === 'PAGO') && (c.nome || c.reservado_por))
    .map(c => ({ numero: c.numero, participante: c.nome || c.reservado_por }));

  const linhas = participantes.map(p => `${pad(p.numero)} - ${p.participante}`);
  const cabecalho = [
    `*${MARCA_FIXA}*`,
    `*${cfg.titulo}*`,
    `Status: Rifa Encerrada`,
    ``,
    `*Lista de Participantes:*`,
  ];

  const corpo = linhas.length > 0 ? linhas : ['Nenhum participante registrado.'];
  const texto = [...cabecalho, ...corpo].join('\n');
  const somenteLista = linhas.join('\n');

  return {
    ok: true,
    marca: MARCA_FIXA,
    titulo: cfg.titulo,
    totalParticipantes: linhas.length,
    lista: linhas,
    somenteLista,
    mensagem: texto,
  };
}

// ---- Controle de Rate Limit (Anti-Força Bruta no Login Admin) ----
const MAX_TENTATIVAS_LOGIN = 3;
const TEMPO_BLOQUEIO_LOGIN_MS = 5 * 60 * 1000; // 5 minutos

function obterParametrosSeguranca(db) {
  if (db && db._opcoesConfig && db._opcoesConfig.forcarRateLimit) {
    return { desabilitado: false, maxTentativas: MAX_TENTATIVAS_LOGIN, tempoBloqueioMs: TEMPO_BLOQUEIO_LOGIN_MS };
  }
  const cfg = lerArquivoConfig();
  if (cfg.desabilitarBloqueioLogin === true) {
    return { desabilitado: true, maxTentativas: Infinity, tempoBloqueioMs: 0 };
  }
  const max = Number(cfg.maxTentativasLogin) || MAX_TENTATIVAS_LOGIN;
  const tempoMs = Number.isFinite(cfg.tempoBloqueioLoginMinutos)
    ? Number(cfg.tempoBloqueioLoginMinutos) * 60 * 1000
    : TEMPO_BLOQUEIO_LOGIN_MS;
  return { desabilitado: false, maxTentativas: max, tempoBloqueioMs: tempoMs };
}

function verificarBloqueioLogin(db, ip, agora = Date.now()) {
  const seguranca = obterParametrosSeguranca(db);
  if (seguranca.desabilitado) {
    return { bloqueado: false, falhas: 0, segundosRestantes: 0 };
  }

  const chaveIp = String(ip || 'local');
  const reg = db.prepare('SELECT * FROM login_tentativas WHERE ip = ?').get(chaveIp);
  if (!reg) return { bloqueado: false, falhas: 0, segundosRestantes: 0 };

  if (reg.bloqueado_ate && reg.bloqueado_ate > agora) {
    const segundosRestantes = Math.ceil((reg.bloqueado_ate - agora) / 1000);
    return {
      bloqueado: true,
      falhas: reg.falhas,
      bloqueadoAte: reg.bloqueado_ate,
      segundosRestantes,
    };
  }

  if (reg.bloqueado_ate && reg.bloqueado_ate <= agora) {
    db.prepare('DELETE FROM login_tentativas WHERE ip = ?').run(chaveIp);
    return { bloqueado: false, falhas: 0, segundosRestantes: 0 };
  }

  return { bloqueado: false, falhas: reg.falhas, segundosRestantes: 0 };
}

function registrarFalhaLogin(db, ip, agora = Date.now()) {
  const seguranca = obterParametrosSeguranca(db);
  if (seguranca.desabilitado) {
    return { bloqueado: false, falhas: 0, tentativasRestantes: 999, segundosRestantes: 0 };
  }

  const chaveIp = String(ip || 'local');
  return transacao(db, () => {
    const atual = verificarBloqueioLogin(db, chaveIp, agora);
    if (atual.bloqueado) return atual;

    const novasFalhas = atual.falhas + 1;
    const bloqueadoAte = novasFalhas >= seguranca.maxTentativas ? agora + seguranca.tempoBloqueioMs : null;

    db.prepare(`
      INSERT INTO login_tentativas (ip, falhas, bloqueado_ate, ultima_falha)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET
        falhas = excluded.falhas,
        bloqueado_ate = excluded.bloqueado_ate,
        ultima_falha = excluded.ultima_falha
    `).run(chaveIp, novasFalhas, bloqueadoAte, agora);

    const segundosRestantes = bloqueadoAte ? Math.ceil((bloqueadoAte - agora) / 1000) : 0;
    return {
      bloqueado: Boolean(bloqueadoAte),
      falhas: novasFalhas,
      tentativasRestantes: Math.max(0, seguranca.maxTentativas - novasFalhas),
      bloqueadoAte,
      segundosRestantes,
    };
  });
}

function limparTentativasLogin(db, ip) {
  const chaveIp = String(ip || 'local');
  db.prepare('DELETE FROM login_tentativas WHERE ip = ?').run(chaveIp);
}

module.exports = {
  abrir,
  expirar,
  preBloquear,
  cancelarPreBloqueio,
  reservar,
  confirmar,
  liberar,
  encerrarRifa,
  destravarRifa,
  excluirRifa,
  obterConfig,
  obterConfigRifaAdmin,
  obterTotalCotas,
  atualizarTitulo,
  atualizarConfigRifa,
  criarNovaRifa,
  listarRifas,
  ativarRifa,
  normalizarValorMoeda,
  extrairValorNumerico,
  rifaEncerrada,
  listarPublico,
  listarPedidos,
  listarTodasCotas,
  gerarPlanilhaXLSX,
  gerarCSV,
  gerarMensagemWhatsapp,
  verificarBloqueioLogin,
  registrarFalhaLogin,
  limparTentativasLogin,
  TOTAL_NUMEROS,
  MINUTOS_PRE_BLOQUEIO,
  MINUTOS_RESERVA,
  MARCA_FIXA,
  MAX_TENTATIVAS_LOGIN,
  TEMPO_BLOQUEIO_LOGIN_MS,
};
