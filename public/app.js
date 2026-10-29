'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const grade = $('grade');
  const modal = $('modal');
  const pad = n => String(n).padStart(2, '0');

  let config = null;
  let numeros = [];
  let selecionados = new Set(); // Números marcados na grade antes de abrir o modal
  let selecionadosNoModal = []; // Números em pré-bloqueio ativo no modal
  let offset = 0;
  let rifaEncerrada = false;
  let meu = null; // { numeros: [...], limite }
  let timerId = null;
  let preTimerId = null;
  let reservaConcluidaNoModal = false;

  // Identificador persistente do dispositivo (localStorage + sessionStorage)
  let sessaoId = localStorage.getItem('rifa_sessao_id') || sessionStorage.getItem('rifa_sessao_id');
  if (!sessaoId) {
    sessaoId = 'cli_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }
  localStorage.setItem('rifa_sessao_id', sessaoId);
  sessionStorage.setItem('rifa_sessao_id', sessaoId);

  try {
    meu = JSON.parse(localStorage.getItem('rifa_meu'));
    if (meu && meu.numero && !Array.isArray(meu.numeros)) {
      meu.numeros = [meu.numero];
    }
  } catch {
    meu = null;
  }

  function extrairValorNumerico(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
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

  function formatarReais(num) {
    return 'R$ ' + Number(num || 0).toFixed(2).replace('.', ',');
  }

  function obterValorUnitario() {
    if (!config) return 5;
    if (typeof config.valorNumerico === 'number' && config.valorNumerico > 0) {
      return config.valorNumerico;
    }
    return extrairValorNumerico(config.valor) || 5;
  }

  function formatarListaCotas(arr) {
    return arr
      .slice()
      .sort((a, b) => a - b)
      .map(pad)
      .join(', ');
  }

  function toast(msg, duracao = 4000) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.id);
    toast.id = setTimeout(() => {
      t.hidden = true;
    }, duracao);
  }

  function exibirAlertaColisao(msg) {
    const box = $('alerta-colisao');
    if (box) {
      box.textContent = msg;
      box.hidden = false;
      clearTimeout(exibirAlertaColisao.id);
      exibirAlertaColisao.id = setTimeout(() => {
        box.hidden = true;
      }, 9000);
    }
    toast(msg, 6000);
  }

  function aplicarIdentidadeCentral(dados) {
    if (!dados) return;
    const marca = dados.marca || 'Mestre do Churrasco • Rifas';
    const titulo = dados.titulo || '';
    if ($('marca')) $('marca').textContent = marca;
    document.querySelectorAll('[data-marca]').forEach(el => {
      el.textContent = marca;
    });
    if (titulo && $('titulo')) {
      $('titulo').textContent = titulo;
      document.title = `${titulo} — ${marca}`;
    }
    if (dados.valor) {
      if (!config) config = {};
      config.valor = dados.valor;
      if (dados.valorNumerico) config.valorNumerico = dados.valorNumerico;
      const min = dados.minutosPreBloqueio || dados.minutos || 10;
      if ($('min')) $('min').textContent = min;
      if ($('sub')) {
        $('sub').textContent = `Cota: ${dados.valor} • Toque em um ou mais números livres para selecionar seus pontos (${min} min para pagamento Pix).`;
      }
    }
  }

  function atualizarBarraSelecao() {
    const barra = $('barra-selecao');
    const cSel = $('c-sel');
    const lista = Array.from(selecionados).sort((a, b) => a - b);
    if (cSel) cSel.textContent = lista.length;

    if (!barra) return;
    if (lista.length === 0 || rifaEncerrada) {
      barra.hidden = true;
      return;
    }

    const unit = obterValorUnitario();
    const total = lista.length * unit;
    const rotuloCotas =
      lista.length === 1
        ? `1 ponto selecionado: ${formatarListaCotas(lista)}`
        : `${lista.length} pontos selecionados: ${formatarListaCotas(lista)}`;

    $('resumo-cotas').textContent = rotuloCotas;
    $('resumo-total').textContent = `Total: ${formatarReais(total)} (${lista.length} × ${formatarReais(unit)})`;
    $('btn-avancar').textContent =
      lista.length === 1 ? 'Preencher Dados (1 ponto) →' : `Preencher Dados (${lista.length} pontos) →`;
    barra.hidden = false;
  }

  function render(lista) {
    if (grade.children.length !== lista.length) {
      grade.innerHTML = '';
      for (const n of lista) {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = `n${n.numero}`;
        b.dataset.n = n.numero;
        b.textContent = pad(n.numero);
        grade.appendChild(b);
      }
    }

    const bannerEnc = $('banner-encerrada');
    if (bannerEnc) bannerEnc.hidden = !rifaEncerrada;

    const meusSet = new Set(meu && Array.isArray(meu.numeros) ? meu.numeros : []);
    for (const n of lista) {
      if (n.meu && n.status !== 'DISPONIVEL') {
        meusSet.add(n.numero);
      } else if (n.status === 'DISPONIVEL' && meusSet.has(n.numero)) {
        meusSet.delete(n.numero);
      }
    }

    const c = { DISPONIVEL: 0, PENDENTE: 0, PAGO: 0 };

    for (const n of lista) {
      c[n.status] = (c[n.status] || 0) + 1;
      const b = $(`n${n.numero}`);
      if (!b) continue;
      const anterior = b.dataset.status;

      // Se um número que estava selecionado localmente deixou de estar disponível (e não está no nosso modal), desmarca
      if (
        selecionados.has(n.numero) &&
        n.status !== 'DISPONIVEL' &&
        !selecionadosNoModal.includes(n.numero)
      ) {
        selecionados.delete(n.numero);
      }

      const estaSelecionado = selecionados.has(n.numero);
      const ehMeu = Boolean((n.meu || meusSet.has(n.numero)) && n.status !== 'DISPONIVEL');

      b.className =
        `num ${n.status}` +
        (estaSelecionado ? ' SELECIONADO' : '') +
        (ehMeu ? ' meu' : '') +
        (rifaEncerrada ? ' encerrada-travada' : '');
      b.dataset.status = n.status;
      b.dataset.meu = ehMeu ? '1' : '0';
      b.disabled = false;
      b.setAttribute('aria-disabled', (rifaEncerrada && !ehMeu) || (n.status !== 'DISPONIVEL' && !ehMeu));
      b.setAttribute('aria-pressed', estaSelecionado ? 'true' : 'false');
      b.setAttribute(
        'aria-label',
        `Número ${pad(n.numero)}, ${estaSelecionado ? 'selecionado' : { DISPONIVEL: 'livre', PENDENTE: ehMeu ? 'sua reserva pendente' : 'reservado', PAGO: ehMeu ? 'seu número pago' : 'reservado' }[n.status]}`
      );
      if (anterior && anterior !== n.status) {
        b.classList.add('pisca');
        setTimeout(() => b.classList.remove('pisca'), 900);
      }
    }

    $('c-livre').textContent = c.DISPONIVEL;
    $('c-pend').textContent = c.PENDENTE;
    $('c-pago').textContent = c.PAGO;
    atualizarBarraSelecao();

    // Sincroniza registro local das cotas pertencentes a este dispositivo (preservando mesmo quando PAGO)
    const numerosAtivosMeus = Array.from(meusSet);
    if (numerosAtivosMeus.length > 0) {
      const registrosMeus = lista.filter(n => meusSet.has(n.numero));
      const todosPagos = registrosMeus.length > 0 && registrosMeus.every(m => m.status === 'PAGO');
      if (todosPagos && modal.open && !$('passo2').hidden) {
        clearInterval(timerId);
        modal.close();
        toast('✅ Pagamento confirmado! Boa sorte no sorteio! 🥩🔥', 5000);
      }
      meu = {
        numero: numerosAtivosMeus[0],
        numeros: numerosAtivosMeus,
        limite: (meu && meu.limite) || null,
      };
      localStorage.setItem('rifa_meu', JSON.stringify(meu));
    } else if (meu) {
      meu = null;
      localStorage.removeItem('rifa_meu');
    }
  }

  async function atualizar() {
    try {
      const r = await fetch(`/api/numeros?sessaoId=${encodeURIComponent(sessaoId)}`, { cache: 'no-store' });
      const j = await r.json();
      offset = j.agora - Date.now();
      rifaEncerrada = Boolean(j.encerrada);
      aplicarIdentidadeCentral(j);
      numeros = j.numeros;
      render(numeros);
      $('status-rede').textContent = rifaEncerrada
        ? 'Rifa encerrada • Grade travada permanentemente'
        : 'Atualização em tempo real ativa (polling 2s)';
    } catch {
      $('status-rede').textContent = 'Sem conexão… reconectando automaticamente';
    }
  }

  // HTTP Polling curto (a cada 2 segundos)
  let poll = setInterval(atualizar, 2000);
  document.addEventListener('visibilitychange', () => {
    clearInterval(poll);
    if (!document.hidden) {
      atualizar();
      poll = setInterval(atualizar, 2000);
    }
  });

  // ---- Clique na grade: Identifica cotas do próprio dispositivo vs outros participantes ----
  grade.addEventListener('click', e => {
    const b = e.target.closest('button[data-n]');
    if (!b) return;
    const n = Number(b.dataset.n);
    const item = numeros.find(x => x.numero === n);
    const meusSet = new Set(meu && Array.isArray(meu.numeros) ? meu.numeros : []);
    const ehMeu = Boolean(
      b.dataset.meu === '1' ||
      (item && item.status !== 'DISPONIVEL' && (item.meu || meusSet.has(n)))
    );

    if (b.dataset.status !== 'DISPONIVEL') {
      if (ehMeu) {
        // Cota pertence a ESTE dispositivo!
        if (item.status === 'PAGO') {
          toast(`✅ O seu número ${pad(n)} já está PAGO e confirmado! Boa sorte no sorteio! 🥩🔥`, 5000);
          return;
        }
        if (item.etapa === 'PRE_BLOQUEIO') {
          // Estava preenchendo os dados: reabre o modal de preenchimento com os números pré-bloqueados deste dispositivo
          const meusPre = numeros
            .filter(x => (x.meu || meusSet.has(x.numero)) && x.status === 'PENDENTE' && x.etapa === 'PRE_BLOQUEIO')
            .map(x => x.numero);
          abrirModal(meusPre.length ? meusPre : [n], item.tempo_limite);
          return;
        }
        // Saiu sem querer da tela de Pix (status PENDENTE / etapa RESERVADO): reabre a tela de Pix e WhatsApp!
        const meusReservados = numeros
          .filter(x => (x.meu || meusSet.has(x.numero)) && x.status === 'PENDENTE' && x.etapa !== 'PRE_BLOQUEIO')
          .map(x => x.numero);
        const limitePix = item.tempo_limite || (meu && meu.limite) || Date.now() + 10 * 60 * 1000;
        reservaConcluidaNoModal = true;
        mostrarPagamento(meusReservados.length ? meusReservados : [n], limitePix);
        if (!modal.open) modal.showModal();
        return;
      }

      // Cota pertence a OUTRA pessoa (seja PENDENTE ou PAGO): exibe sempre a mensagem de reservado por outro participante
      const msg = `Ops! O número ${pad(n)} acabou de ser reservado por outro participante. Por favor, escolha outro número disponível na grade.`;
      exibirAlertaColisao(msg);
      return;
    }

    if (rifaEncerrada) {
      toast('Esta rifa já foi encerrada e não aceita novas reservas.');
      return;
    }

    if (selecionados.has(n)) {
      selecionados.delete(n);
    } else {
      selecionados.add(n);
    }
    render(numeros);
  });

  // Botão Limpar Seleção
  if ($('btn-limpar-selecao')) {
    $('btn-limpar-selecao').addEventListener('click', () => {
      selecionados.clear();
      render(numeros);
    });
  }

  // ---- ETAPA 1: Ao clicar em "Preencher Dados", aplica pré-bloqueio de 10 minutos nos pontos selecionados ----
  if ($('btn-avancar')) {
    $('btn-avancar').addEventListener('click', async () => {
      const lista = Array.from(selecionados).sort((a, b) => a - b);
      if (!lista.length) return;

      const btn = $('btn-avancar');
      btn.disabled = true;
      try {
        const r = await fetch('/api/pre-reservar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ numeros: lista, numero: lista[0], sessaoId }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) {
          if (j.numeroConflito) {
            selecionados.delete(j.numeroConflito);
          }
          const msg =
            j.erro ||
            `Ops! Um dos números selecionados acabou de ser reservado por outro participante. Por favor, escolha outro número disponível na grade.`;
          exibirAlertaColisao(msg);
          await atualizar();
          return;
        }
        abrirModal(j.numeros || lista, j.tempo_limite);
        await atualizar();
      } catch {
        toast('Falha de rede ao pré-bloquear os pontos selecionados. Tente novamente.');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function iniciarCronometroPreBloqueio(limite) {
    clearInterval(preTimerId);
    const tick = () => {
      const resta = limite - (Date.now() + offset);
      if (resta <= 0) {
        clearInterval(preTimerId);
        $('timer-pre').textContent = '00:00';
        if (modal.open && !reservaConcluidaNoModal) {
          modal.close();
          toast('O pré-bloqueio de 10 minutos expirou. Os números voltaram a ficar livres.');
          atualizar();
        }
        return;
      }
      const s = Math.ceil(resta / 1000);
      $('timer-pre').textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    };
    tick();
    preTimerId = setInterval(tick, 1000);
  }

  function abrirModal(listaNumeros, limitePreBloqueio) {
    const arr = Array.isArray(listaNumeros) ? listaNumeros : [Number(listaNumeros)];
    selecionadosNoModal = arr.slice().sort((a, b) => a - b);
    reservaConcluidaNoModal = false;

    const unit = obterValorUnitario();
    const total = selecionadosNoModal.length * unit;

    $('modal-titulo').textContent = formatarListaCotas(selecionadosNoModal);
    if ($('modal-valor-resumo')) {
      $('modal-valor-resumo').textContent =
        selecionadosNoModal.length === 1
          ? `1 cota • Valor: ${formatarReais(total)}`
          : `${selecionadosNoModal.length} cotas × ${formatarReais(unit)} = ${formatarReais(total)}`;
    }

    $('erro').hidden = true;
    $('btn-reservar').disabled = false;
    $('passo1').hidden = false;
    $('passo2').hidden = true;
    $('nome').value = localStorage.getItem('rifa_nome') || '';
    $('zap').value = localStorage.getItem('rifa_zap') || '';
    const min = (config && (config.minutosPreBloqueio || config.minutos)) || 10;
    iniciarCronometroPreBloqueio(limitePreBloqueio || Date.now() + min * 60 * 1000);
    modal.showModal();
  }

  modal.addEventListener('click', e => {
    // Fecha apenas se clicar explicitamente no botão X, evitando fechar/cancelar por toque acidental fora da caixa
    if (e.target.closest('[data-fechar]')) {
      modal.close();
    }
  });

  // Evita cancelamento/fechamento acidental ao pressionar ESC enquanto preenche os dados
  modal.addEventListener('cancel', e => {
    if (selecionadosNoModal.length > 0 && !reservaConcluidaNoModal) {
      e.preventDefault();
    }
  });

  modal.addEventListener('close', () => {
    clearInterval(timerId);
    clearInterval(preTimerId);
    // Se fechou o modal na Etapa 1 sem concluir a Etapa 2, libera o pré-bloqueio para outros
    if (selecionadosNoModal.length > 0 && !reservaConcluidaNoModal) {
      const numsParaLiberar = selecionadosNoModal.slice();
      selecionadosNoModal = [];
      fetch('/api/cancelar-pre-reserva', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numeros: numsParaLiberar, numero: numsParaLiberar[0], sessaoId }),
      })
        .then(() => atualizar())
        .catch(() => {});
    }
  });

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch {
      /* fallback para navegadores sem permissão na Clipboard API */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = texto;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function copiarPix() {
    const ok = await copiar(config.pixKey);
    const el = $('copiado');
    el.hidden = false;
    el.textContent = ok
      ? '✓ Chave Pix copiada! Cole no aplicativo do seu banco.'
      : 'Não foi possível copiar automaticamente. Selecione a chave acima.';
  }
  $('btn-copiar').addEventListener('click', copiarPix);

  // ---- ETAPA 2: Transação Final Atômica ("Reservar e Pagar") ----
  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('btn-reservar');
    const erro = $('erro');
    erro.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Validando reserva…';
    const nome = $('nome').value.trim();
    const whatsapp = $('zap').value.trim();

    try {
      const r = await fetch('/api/reservar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          numeros: selecionadosNoModal,
          numero: selecionadosNoModal[0],
          nome,
          whatsapp,
          sessaoId,
        }),
      });
      const j = await r.json();

      if (!r.ok || !j.ok) {
        const numRef = j.numeroConflito || selecionadosNoModal[0] || 0;
        const msgErro =
          j.erro ||
          `Ops! O número ${pad(numRef)} acabou de ser reservado por outro participante. Por favor, escolha outro número disponível na grade.`;

        if (j.codigo === 'INDISPONIVEL' || r.status === 409) {
          reservaConcluidaNoModal = true;
          clearInterval(preTimerId);
          if (j.numeroConflito) selecionados.delete(j.numeroConflito);
          selecionadosNoModal = [];
          $('form').reset();
          erro.textContent = '';
          erro.hidden = true;
          modal.close();
          exibirAlertaColisao(msgErro);
          await atualizar();
          return;
        }

        erro.textContent = msgErro;
        erro.hidden = false;
        return;
      }

      const listaConfirmada = j.numeros || selecionadosNoModal.slice();
      reservaConcluidaNoModal = true;
      clearInterval(preTimerId);
      selecionados.clear();
      selecionadosNoModal = [];
      localStorage.setItem('rifa_nome', nome);
      localStorage.setItem('rifa_zap', whatsapp);
      meu = { numero: listaConfirmada[0], numeros: listaConfirmada, limite: j.tempo_limite };
      localStorage.setItem('rifa_meu', JSON.stringify(meu));
      mostrarPagamento(listaConfirmada, j.tempo_limite);
      copiarPix();
      await atualizar();
    } catch {
      erro.textContent = 'Falha de conexão com o servidor. Tente novamente.';
      erro.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Reservar e Pagar';
    }
  });

  function mostrarPagamento(listaNums, limite) {
    const arr = Array.isArray(listaNums) ? listaNums : [Number(listaNums)];
    const unit = obterValorUnitario();
    const total = arr.length * unit;
    const strNums = formatarListaCotas(arr);

    $('passo1').hidden = true;
    $('passo2').hidden = false;
    $('reservado-num').textContent = strNums;
    if ($('pix-valor-resumo')) {
      $('pix-valor-resumo').textContent =
        arr.length === 1
          ? `Valor do Pix: ${formatarReais(total)}`
          : `${arr.length} cotas • Total do Pix: ${formatarReais(total)}`;
    }
    $('pix-chave').textContent = config.pixKey;
    $('copiado').hidden = true;
    const marca = config.marca || 'Mestre do Churrasco • Rifas';
    const rotuloMsg = arr.length === 1 ? `o número ${strNums}` : `os números ${strNums}`;
    const msg = `Olá! Reservei ${rotuloMsg} (Total: ${formatarReais(total)}) na rifa "${config.titulo}" (${marca}). Segue o comprovante do Pix:`;
    $('btn-zap').href = `https://wa.me/${config.whatsapp}?text=${encodeURIComponent(msg)}`;

    clearInterval(timerId);
    const tick = () => {
      const resta = limite - (Date.now() + offset);
      if (resta <= 0) {
        clearInterval(timerId);
        $('timer').textContent = '00:00';
        modal.close();
        toast('Tempo limite de 10 minutos esgotado. Os números foram liberados.');
        atualizar();
        return;
      }
      const s = Math.ceil(resta / 1000);
      $('timer').textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    };
    tick();
    timerId = setInterval(tick, 1000);
  }

  (async function init() {
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      config = await r.json();
      aplicarIdentidadeCentral(config);
    } catch {
      config = {
        marca: 'Mestre do Churrasco • Rifas',
        titulo: 'Sorteio de Sábado • Super Kit Churrasco',
        valor: 'R$ 5,00',
        valorNumerico: 5,
        pixKey: '',
        whatsapp: '',
        minutos: 10,
      };
    }
    await atualizar();
  })();
})();
