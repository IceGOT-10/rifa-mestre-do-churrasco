'use strict';
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const CAMINHO_PUBLIC = path.resolve(__dirname, '..', 'public');
const CAMINHO_VIEWS = path.resolve(__dirname, '..', 'views');
const CAMINHO_CONFIG = path.resolve(__dirname, '..', 'config.json');

function carregarCredenciaisAdmin(cfg = {}) {
  let arquivo = {};
  try {
    if (fs.existsSync(CAMINHO_CONFIG)) {
      arquivo = JSON.parse(fs.readFileSync(CAMINHO_CONFIG, 'utf8'));
    }
  } catch (_) {
    /* usa fallback seguro */
  }
  return {
    adminUser: cfg.adminUser ?? process.env.ADMIN_USER ?? arquivo.adminUser ?? 'admin',
    adminPass: cfg.adminPass ?? process.env.ADMIN_PASS ?? arquivo.adminPass ?? 'churrasco123',
  };
}

function extrairCookies(headerCookie = '') {
  const out = {};
  for (const par of String(headerCookie).split(';')) {
    const idx = par.indexOf('=');
    if (idx > 0) {
      const k = par.slice(0, idx).trim();
      const v = par.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function formatarMinSeg(segundos) {
  const m = String(Math.floor(segundos / 60)).padStart(2, '0');
  const s = String(segundos % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function criarApp(conn, cfg = {}) {
  // Sincroniza parâmetros customizados passados em cfg para a tabela central configuracoes
  if (cfg.titulo) db.atualizarTitulo(conn, cfg.titulo);
  if (cfg.pixKey) {
    conn.prepare("INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES ('pixKey', ?)").run(String(cfg.pixKey));
  }
  if (cfg.whatsapp) {
    conn.prepare("INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES ('whatsapp', ?)").run(
      String(cfg.whatsapp).replace(/\D/g, '')
    );
  }
  if (cfg.valor) {
    conn.prepare("INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES ('valor', ?)").run(String(cfg.valor));
  }

  const credenciais = carregarCredenciaisAdmin(cfg);
  const sessoesAtivas = new Map(); // token -> { usuario, criadoEm }

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(express.json({ limit: '10kb' }));

  // ---- Controle de Cache Anti-Stale (Objetivo 1 - Cenário 2) ----
  function semCache(_req, res, next) {
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store',
    });
    next();
  }
  app.use(semCache);

  // ---- Guarda de Rede Local para o Admin (bloqueia túneis externos) ----
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const HOSTS_LOCAIS = new Set(['localhost', '127.0.0.1', '[::1]']);
  const PROXY_HEADERS = [
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'forwarded',
    'x-real-ip',
    'cf-connecting-ip',
    'cf-ray',
    'x-original-host',
    'ngrok-trace-id',
  ];

  function somenteLocal(req, res, next) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const ok =
      LOOPBACK.has(req.socket.remoteAddress) &&
      HOSTS_LOCAIS.has(host) &&
      !PROXY_HEADERS.some(h => req.headers[h] !== undefined);
    if (!ok) return res.status(403).type('text').send('Acesso restrito ao computador local.');
    next();
  }

  function obterIpCliente(req) {
    return String(req.headers['x-client-id'] || req.socket.remoteAddress || '127.0.0.1');
  }

  function extrairTokenAdmin(req) {
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const cookies = extrairCookies(req.headers.cookie);
    return cookies.rifa_admin_token || null;
  }

  function exigirAuthAdmin(req, res, next) {
    const token = extrairTokenAdmin(req);
    if (!token || !sessoesAtivas.has(token)) {
      return res.status(401).json({
        ok: false,
        codigo: 'NAO_AUTENTICADO',
        erro: 'Sessão administrativa expirada ou não autenticada. Faça login.',
      });
    }
    next();
  }

  // ---- API Pública ----
  app.get('/api/config', (_req, res) => {
    const configuracao = db.obterConfig(conn);
    res.json(configuracao);
  });

  app.get('/api/numeros', (req, res) => {
    const cfgAtual = db.obterConfig(conn);
    const sessaoId = req.query.sessaoId || req.headers['x-sessao-id'] || null;
    res.json({
      agora: Date.now(),
      rifaId: cfgAtual.rifaId,
      marca: cfgAtual.marca,
      titulo: cfgAtual.titulo,
      valor: cfgAtual.valor,
      valorNumerico: cfgAtual.valorNumerico,
      total: cfgAtual.total,
      minutos: cfgAtual.minutos,
      minutosPreBloqueio: cfgAtual.minutosPreBloqueio,
      encerrada: cfgAtual.encerrada,
      numeros: db.listarPublico(conn, Date.now(), sessaoId),
    });
  });

  // Etapa 1: Pré-bloqueio temporário de 10 minutos para 1 ou múltiplos números selecionados
  app.post('/api/pre-reservar', (req, res) => {
    const { numero, numeros, sessaoId } = req.body || {};
    const alvo = Array.isArray(numeros) ? numeros : numero !== undefined ? numero : [];
    try {
      const r = db.preBloquear(conn, alvo, sessaoId);
      if (r.ok) return res.json(r);
      const statusHttp =
        r.codigo === 'INDISPONIVEL' ? 409 : r.codigo === 'RIFA_ENCERRADA' ? 423 : 400;
      res.status(statusHttp).json(r);
    } catch (e) {
      console.error('Erro em /api/pre-reservar:', e);
      res.status(500).json({ ok: false, codigo: 'ERRO_INTERNO', erro: 'Erro interno ao pré-reservar.' });
    }
  });

  app.post('/api/cancelar-pre-reserva', (req, res) => {
    const { numero, numeros, sessaoId } = req.body || {};
    const alvo = Array.isArray(numeros) ? numeros : numero !== undefined ? numero : [];
    try {
      const r = db.cancelarPreBloqueio(conn, alvo, sessaoId);
      res.json(r);
    } catch (_) {
      res.json({ ok: false });
    }
  });

  // Etapa 2: Transação Final Atômica ("Reservar e Pagar") para 1 ou múltiplos números
  app.post('/api/reservar', (req, res) => {
    const { numero, numeros, nome, whatsapp, sessaoId } = req.body || {};
    const alvo = Array.isArray(numeros) ? numeros : numero !== undefined ? numero : [];
    try {
      const r = db.reservar(conn, alvo, nome, whatsapp, sessaoId);
      if (r.ok) return res.json(r);
      const statusHttp =
        r.codigo === 'INDISPONIVEL' ? 409 : r.codigo === 'RIFA_ENCERRADA' ? 423 : 400;
      res.status(statusHttp).json(r);
    } catch (e) {
      console.error('Erro em /api/reservar:', e);
      res.status(500).json({ ok: false, codigo: 'ERRO_INTERNO', erro: 'Erro interno. Tente novamente.' });
    }
  });

  // ---- Autenticação e Rate Limiting do Painel Admin ----
  app.get('/admin', somenteLocal, (_req, res) => {
    res.sendFile(path.join(CAMINHO_VIEWS, 'admin.html'));
  });

  app.get('/api/admin/sessao', somenteLocal, (req, res) => {
    const ip = obterIpCliente(req);
    const bloqueio = db.verificarBloqueioLogin(conn, ip);
    const token = extrairTokenAdmin(req);
    const autenticado = Boolean(token && sessoesAtivas.has(token));
    const cfgAtual = db.obterConfig(conn);
    res.json({
      ok: true,
      autenticado,
      marca: cfgAtual.marca,
      titulo: cfgAtual.titulo,
      encerrada: cfgAtual.encerrada,
      bloqueado: bloqueio.bloqueado,
      segundosRestantes: bloqueio.segundosRestantes,
      bloqueadoAte: bloqueio.bloqueadoAte || null,
    });
  });

  app.post('/api/admin/login', somenteLocal, (req, res) => {
    const ip = obterIpCliente(req);
    const agora = Date.now();
    const statusBloqueio = db.verificarBloqueioLogin(conn, ip, agora);

    if (statusBloqueio.bloqueado) {
      return res.status(429).json({
        ok: false,
        codigo: 'BLOQUEADO_TEMPORARIAMENTE',
        segundosRestantes: statusBloqueio.segundosRestantes,
        bloqueadoAte: statusBloqueio.bloqueadoAte,
        erro: `Muitas tentativas incorretas. Aguarde ${formatarMinSeg(statusBloqueio.segundosRestantes)} para tentar novamente.`,
      });
    }

    const { usuario, senha } = req.body || {};
    const uOk = String(usuario || '').trim() === credenciais.adminUser;
    const sOk = String(senha || '') === credenciais.adminPass;

    if (!uOk || !sOk) {
      const falha = db.registrarFalhaLogin(conn, ip, agora);
      return res.status(401).json({
        ok: false,
        codigo: 'CREDENCIAIS_INVALIDAS',
        falhas: falha.falhas,
        tentativasRestantes: falha.tentativasRestantes,
        bloqueado: falha.bloqueado,
        segundosRestantes: falha.segundosRestantes,
        erro: falha.bloqueado
          ? `Limite de 3 tentativas excedido! Próximas tentativas bloqueadas por 5 minutos (${formatarMinSeg(falha.segundosRestantes)}).`
          : `Usuário ou senha incorretos. Tentativas restantes: ${falha.tentativasRestantes}.`,
      });
    }

    db.limparTentativasLogin(conn, ip);
    const token = crypto.randomBytes(24).toString('hex');
    sessoesAtivas.set(token, { usuario: credenciais.adminUser, criadoEm: agora });
    res.setHeader('Set-Cookie', `rifa_admin_token=${token}; HttpOnly; SameSite=Strict; Path=/`);
    res.json({ ok: true, token, usuario: credenciais.adminUser });
  });

  app.post('/api/admin/logout', somenteLocal, (req, res) => {
    const token = extrairTokenAdmin(req);
    if (token) sessoesAtivas.delete(token);
    res.setHeader('Set-Cookie', 'rifa_admin_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  function persistirConfigSeProducao(cfgObj) {
    if (conn && conn._opcoesConfig && conn._opcoesConfig.forcarRateLimit) return;
    try {
      const atual = fs.existsSync(CAMINHO_CONFIG)
        ? JSON.parse(fs.readFileSync(CAMINHO_CONFIG, 'utf8'))
        : {};
      if (cfgObj.titulo) atual.titulo = cfgObj.titulo;
      if (cfgObj.valor) atual.valor = cfgObj.valor;
      if (cfgObj.total) atual.total = cfgObj.total;
      if (cfgObj.pixKey) atual.pixKey = cfgObj.pixKey;
      if (cfgObj.whatsapp) atual.whatsapp = cfgObj.whatsapp;
      atual.marca = db.MARCA_FIXA;
      fs.writeFileSync(CAMINHO_CONFIG, JSON.stringify(atual, null, 2) + '\n', 'utf8');
    } catch (_) {
      /* banco já atualizado */
    }
  }

  function extrairRifaId(req) {
    if (req.body && req.body.rifaId !== undefined && req.body.rifaId !== null && req.body.rifaId !== '') {
      return Number(req.body.rifaId);
    }
    if (req.query && req.query.rifaId !== undefined && req.query.rifaId !== null && req.query.rifaId !== '') {
      return Number(req.query.rifaId);
    }
    return null;
  }

  // ---- Rotas Administrativas Protegidas ----
  app.get('/api/admin/pedidos', somenteLocal, exigirAuthAdmin, (req, res) => {
    const rifaIdSolicitada = extrairRifaId(req);
    const cfgPublica = db.obterConfig(conn);
    const cfgAdmin = db.obterConfigRifaAdmin(conn, rifaIdSolicitada);
    res.json({
      agora: Date.now(),
      rifaId: cfgAdmin.rifaId,
      rifaPublicaId: cfgPublica.rifaId,
      naTelaDoUsuario: cfgAdmin.naTelaDoUsuario,
      marca: cfgAdmin.marca,
      titulo: cfgAdmin.titulo,
      valor: cfgAdmin.valor,
      valorNumerico: cfgAdmin.valorNumerico,
      total: cfgAdmin.total,
      pixKey: cfgAdmin.pixKey,
      whatsapp: cfgAdmin.whatsapp,
      encerrada: cfgAdmin.encerrada,
      rifas: db.listarRifas(conn),
      pedidos: db.listarPedidos(conn, Date.now(), cfgAdmin.rifaId),
    });
  });

  app.get('/api/admin/rifas', somenteLocal, exigirAuthAdmin, (_req, res) => {
    res.json({
      ok: true,
      config: db.obterConfig(conn),
      rifas: db.listarRifas(conn),
    });
  });

  app.post('/api/admin/nova-rifa', somenteLocal, exigirAuthAdmin, (req, res) => {
    const r = db.criarNovaRifa(conn, req.body || {});
    if (r.ok && r.abertaParaUsuarios && r.config) {
      persistirConfigSeProducao(r.config);
    }
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/admin/ativar-rifa/:id', somenteLocal, exigirAuthAdmin, (req, res) => {
    const r = db.ativarRifa(conn, Number(req.params.id));
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/admin/destravar', somenteLocal, exigirAuthAdmin, (req, res) => {
    const rifaId = extrairRifaId(req);
    const r = db.destravarRifa(conn, rifaId);
    if (r.ok && r.config) {
      persistirConfigSeProducao(r.config);
    }
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/admin/destravar/:id', somenteLocal, exigirAuthAdmin, (req, res) => {
    const r = db.destravarRifa(conn, Number(req.params.id));
    if (r.ok && r.config) {
      persistirConfigSeProducao(r.config);
    }
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/admin/excluir-rifa/:id', somenteLocal, exigirAuthAdmin, (req, res) => {
    const r = db.excluirRifa(conn, Number(req.params.id));
    if (r.ok) {
      persistirConfigSeProducao(db.obterConfig(conn));
    }
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.delete('/api/admin/rifas/:id', somenteLocal, exigirAuthAdmin, (req, res) => {
    const r = db.excluirRifa(conn, Number(req.params.id));
    if (r.ok) {
      persistirConfigSeProducao(db.obterConfig(conn));
    }
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/admin/confirmar/:n', somenteLocal, exigirAuthAdmin, (req, res) => {
    const rifaId = extrairRifaId(req);
    const r = db.confirmar(conn, Number(req.params.n), Date.now(), rifaId);
    res.status(r.ok ? 200 : 409).json(r);
  });

  app.post('/api/admin/liberar/:n', somenteLocal, exigirAuthAdmin, (req, res) => {
    const rifaId = extrairRifaId(req);
    const r = db.liberar(conn, Number(req.params.n), rifaId);
    res.status(r.ok ? 200 : 409).json(r);
  });

  app.post('/api/admin/encerrar', somenteLocal, exigirAuthAdmin, (req, res) => {
    const rifaId = extrairRifaId(req);
    const r = db.encerrarRifa(conn, rifaId);
    res.json(r);
  });

  app.post('/api/admin/config', somenteLocal, exigirAuthAdmin, (req, res) => {
    const r = db.atualizarConfigRifa(conn, req.body || {});
    if (r.ok && r.config && r.config.naTelaDoUsuario) {
      persistirConfigSeProducao(r.config);
    }
    res.status(r.ok ? 200 : 400).json(r);
  });

  async function exportarPlanilhaHandler(req, res) {
    try {
      const rifaId = extrairRifaId(req);
      const custoKit = req.query.custoKit !== undefined ? req.query.custoKit : 0;
      const buffer = await db.gerarPlanilhaXLSX(conn, Date.now(), rifaId, custoKit);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="relatorio-rifa.xlsx"');
      res.send(buffer);
    } catch (e) {
      console.error('Erro ao gerar planilha Excel:', e);
      res.status(500).json({ ok: false, erro: 'Falha ao gerar planilha Excel.' });
    }
  }

  app.get('/api/admin/exportar-planilha', somenteLocal, exigirAuthAdmin, exportarPlanilhaHandler);
  app.get('/api/admin/exportar-csv', somenteLocal, exigirAuthAdmin, exportarPlanilhaHandler);

  app.get('/api/admin/mensagem-whatsapp', somenteLocal, exigirAuthAdmin, (req, res) => {
    const rifaId = extrairRifaId(req);
    const r = db.gerarMensagemWhatsapp(conn, rifaId);
    res.status(r.ok ? 200 : 409).json(r);
  });

  // ---- Entrega Explícita do Frontend Raiz /public (Objetivo 1 - Cenário 3) ----
  app.get('/', (_req, res) => {
    res.sendFile(path.join(CAMINHO_PUBLIC, 'index.html'));
  });

  app.use(
    express.static(CAMINHO_PUBLIC, {
      etag: false,
      lastModified: false,
      maxAge: 0,
      index: 'index.html',
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      },
    })
  );

  return app;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const conn = db.abrir(process.env.DB_PATH || path.join(__dirname, '..', 'rifa.db'));
  const app = criarApp(conn);

  setInterval(() => {
    try {
      const n = db.expirar(conn);
      if (n) console.log(`[expiração] ${n} cota(s) com bloqueio vencido liberada(s)`);
    } catch (e) {
      console.error('Falha no job de expiração:', e);
    }
  }, 10_000).unref();

  app.listen(PORT, () => {
    console.log(`[${db.MARCA_FIXA}] Servidor ativo em: http://localhost:${PORT}`);
    console.log(`[${db.MARCA_FIXA}] Painel Admin em:   http://localhost:${PORT}/admin`);
  });
}

module.exports = { criarApp };
