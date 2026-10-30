'use strict';

const PREFIXO = 'cvl-';
const ALFABETO = '23456789abcdefghjkmnpqrstuvwxyz'; // sem 0, 1, i, l e o, que se confundem
const TAMANHO_CODIGO = 10;
const OPCOES_PEER = { config: { iceServers: [] }, debug: 0 };
const NIVEIS_VOLUME = [100, 150, 200, 250, 300];
const CHAVE_VOLUME = 'cvl-volume';
const CHAVE_REGISTRO = 'cvl-registro';
const CHAVE_REGISTRO_ANTERIOR = 'cvl-registro-anterior';
const MAX_EVENTOS = 400;
const LEITURAS_POR_MEDICAO = 30; // uma linha de medição no registro a cada 60 segundos

const $ = (id) => document.getElementById(id);
const audioRemoto = $('audioRemoto');

// ---------------------------------------------------------------------------
// Somente endereços de rede local seguem para o outro celular. Sem servidor
// STUN/TURN e sem endereço da operadora, a voz não sai da rede Wi-Fi.
// ---------------------------------------------------------------------------
const contagem = { locais: 0, ocultos: 0, bloqueados: 0 };

function enderecoLocal(ip) {
  if (!ip) return false;
  ip = ip.toLowerCase();
  if (ip.endsWith('.local')) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(ip) || /^f[cd][0-9a-f]{2}:/.test(ip)) return true;
  return false;
}

function enderecoDoCandidato(candidato) {
  return candidato.address || (candidato.candidate || '').split(' ')[4] || '';
}

const ConexaoOriginal = window.RTCPeerConnection;

class ConexaoSoLocal extends ConexaoOriginal {
  constructor(config) {
    super(Object.assign({}, config, { iceServers: [] }));
  }

  get onicecandidate() {
    return super.onicecandidate;
  }

  set onicecandidate(funcao) {
    if (typeof funcao !== 'function') {
      super.onicecandidate = funcao;
      return;
    }
    super.onicecandidate = (evento) => {
      if (evento.candidate && evento.candidate.candidate) {
        const endereco = enderecoDoCandidato(evento.candidate);
        if (!enderecoLocal(endereco)) {
          contagem.bloqueados++;
          return;
        }
        contagem.locais++;
        if (endereco.endsWith('.local')) contagem.ocultos++; // o navegador trocou o IP por um nome
      }
      funcao.call(this, evento);
    };
  }
}

window.RTCPeerConnection = ConexaoSoLocal;

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
let peer = null;
let chamada = null;
let streamLocal = null;
let papel = '';
let codigo = '';
let silenciado = false;
let microfoneEscolhido = '';
let wakeLock = null;
let pedidoTela = null;
let servidorConectado = false;
let jaChamou = false;
let timerStats = null;
let timerReconexao = null;
let timerConexao = null;
let timerNota = null;
let pacotesAnteriores = -1;
let ultimoPacoteEm = 0;
let leiturasParadas = 0;
let semAudioAvisado = false;
let tentandoConectar = false;
let reentrarAoConectar = false;
let esperaAnterior = null;
let leituras = 0;
let volume = lerVolumeSalvo();
let contextoAudio = null;
let amplificador = null;
let gravandoRegistro = false;
const eventos = [];

const AVISO_PERDIDA = 'Conexão perdida. Confira se o roteador Wi-Fi continua ligado e se os dois celulares estão no mesmo Wi-Fi.';
const AVISO_SEM_INTERNET = 'Sem internet para encontrar o outro celular. Ligue os dados móveis do celular que tem o roteador Wi-Fi.';

const NOMES_ICE = {
  new: 'nova',
  checking: 'verificando',
  connected: 'conectada',
  completed: 'conectada',
  disconnected: 'instável',
  failed: 'perdida',
  closed: 'encerrada',
};

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------
function mostrarTela(nome) {
  $('inicio').hidden = nome !== 'inicio';
  $('conversa').hidden = nome !== 'conversa';
  window.scrollTo(0, 0);
}

function avisoInicio(texto) {
  $('aviso').textContent = texto;
  $('aviso').hidden = !texto;
}

function definirStatus(texto, tipo) {
  const status = $('status');
  status.textContent = texto;
  status.className = 'status ' + tipo;
}

function mostrarNota(texto, id = 'nota') {
  $(id).textContent = texto;
  clearTimeout(timerNota);
  timerNota = setTimeout(() => { $(id).textContent = ''; }, 3000);
}

function bloquearBotoes(sim) {
  $('criar').disabled = sim;
  $('entrar').disabled = sim;
}

function registrar(texto) {
  const hora = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const linha = hora + '  ' + texto;
  eventos.push(linha);
  if (eventos.length > MAX_EVENTOS) eventos.splice(0, eventos.length - MAX_EVENTOS);
  const lista = $('listaRegistro');
  const item = document.createElement('li');
  item.textContent = linha;
  lista.prepend(item);
  while (lista.children.length > MAX_EVENTOS) lista.lastElementChild.remove();
  salvarRegistro();
}

// ---------------------------------------------------------------------------
// Registro guardado no celular: sobrevive a fechar a página e guarda também a
// conversa anterior, para ser enviado depois.
// ---------------------------------------------------------------------------
function lerSalvo(chave) {
  try {
    return localStorage.getItem(chave) || '';
  } catch (e) {
    return '';
  }
}

function iniciarRegistroSalvo() {
  if (gravandoRegistro) return;
  gravandoRegistro = true;
  const ultimo = lerSalvo(CHAVE_REGISTRO);
  try {
    if (ultimo) localStorage.setItem(CHAVE_REGISTRO_ANTERIOR, ultimo);
    localStorage.removeItem(CHAVE_REGISTRO);
  } catch (e) { /* sem espaço ou armazenamento bloqueado: o registro fica só na tela */ }
}

function salvarRegistro() {
  if (!gravandoRegistro) return;
  try {
    localStorage.setItem(CHAVE_REGISTRO, textoRegistro());
  } catch (e) { /* idem */ }
}

function juntarRegistros(atual, anterior) {
  if (!anterior) return atual;
  return atual + '\n\n--- Conversa anterior ---\n' + anterior;
}

function falhar(texto) {
  definirStatus(texto, 'erro');
  registrar(texto);
  $('voltar').hidden = false;
}

// ---------------------------------------------------------------------------
// Código da sala
// ---------------------------------------------------------------------------
function gerarCodigo() {
  let resultado = '';
  while (resultado.length < TAMANHO_CODIGO) {
    const byte = crypto.getRandomValues(new Uint8Array(1))[0];
    if (byte < 248) resultado += ALFABETO[byte % ALFABETO.length]; // 248 = 31 * 8, sem viés
  }
  return resultado;
}

function normalizarCodigo(texto) {
  return (texto || '').toLowerCase().replace(/[^0-9a-z]/g, '');
}

function codigoValido(texto) {
  return texto.length === TAMANHO_CODIGO && [...texto].every((c) => ALFABETO.includes(c));
}

function formatarCodigo(texto) {
  return texto.slice(0, 5) + '-' + texto.slice(5);
}

function linkDaSala() {
  return location.origin + location.pathname + '#sala=' + codigo;
}

// ---------------------------------------------------------------------------
// Microfone
// ---------------------------------------------------------------------------
function trackAtual() {
  return streamLocal ? streamLocal.getAudioTracks()[0] : null;
}

function pedirModoLigacao() {
  // iOS 17 ou mais novo: avisa o Safari que a página grava e toca ao mesmo tempo, como numa
  // ligação, para o som sair pelo mesmo caminho da ligação (fone Bluetooth, se conectado).
  if (navigator.audioSession) {
    try { navigator.audioSession.type = 'play-and-record'; } catch (e) { /* versão sem suporte */ }
  }
}

function pegarMicrofone(deviceId) {
  pedirModoLigacao();
  // Os três filtros ligados fazem o Android usar o microfone do fone Bluetooth.
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
}

function vigiarMicrofone(track) {
  track.addEventListener('mute', () => { registrar('Microfone cortado pelo sistema.'); atualizarMicrofone(); });
  track.addEventListener('unmute', () => { registrar('Microfone voltou a funcionar.'); atualizarMicrofone(); });
  track.addEventListener('ended', () => { registrar('Microfone desligado pelo sistema.'); atualizarMicrofone(); });
}

function atualizarMicrofone() {
  const track = trackAtual();
  if (!track) {
    $('micAtual').textContent = 'Nenhum';
    return;
  }
  let texto = track.label || 'Sem nome';
  if (track.readyState === 'ended') texto += ' (desligado)';
  else if (track.muted) texto += ' (cortado pelo sistema)';
  else if (silenciado) texto += ' (silenciado)';
  $('micAtual').textContent = texto;
}

// Nomes que o Chrome do Android dá aos microfones, traduzidos. O registro guarda o nome original.
function nomeDoMicrofone(rotulo, indice) {
  if (!rotulo) return 'Microfone ' + (indice + 1);
  if (/bluetooth/i.test(rotulo)) return 'Fone Bluetooth';
  if (/earpiece/i.test(rotulo)) return 'Celular (modo ligação)';
  if (/speakerphone/i.test(rotulo)) return 'Celular (viva-voz)';
  if (/wired/i.test(rotulo)) return 'Fone com fio';
  if (/^(default|padrão)$/i.test(rotulo.trim())) return 'Padrão do celular';
  return rotulo;
}

async function listarMicrofones() {
  const seletor = $('microfone');
  let dispositivos = [];
  try {
    dispositivos = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {
    return;
  }
  const track = trackAtual();
  const atual = track && track.getSettings ? track.getSettings().deviceId : '';
  seletor.replaceChildren();
  dispositivos.filter((d) => d.kind === 'audioinput').forEach((d, i) => {
    const opcao = document.createElement('option');
    opcao.value = d.deviceId;
    opcao.textContent = nomeDoMicrofone(d.label, i);
    opcao.dataset.original = d.label;
    if (d.deviceId === atual) opcao.selected = true;
    seletor.append(opcao);
  });
}

function aplicarSilencio() {
  if (streamLocal) streamLocal.getAudioTracks().forEach((t) => { t.enabled = !silenciado; });
  $('silenciar').textContent = silenciado ? 'Ativar microfone' : 'Silenciar microfone';
  $('silenciar').setAttribute('aria-pressed', String(silenciado));
  atualizarMicrofone();
}

async function prepararMicrofone() {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    avisoInicio('Este navegador não permite usar o microfone nesta página.');
    return false;
  }
  try {
    streamLocal = await pegarMicrofone();
  } catch (e) {
    avisoInicio('Não foi possível acessar o microfone. Verifique a permissão do navegador e tente novamente.');
    registrar('Microfone recusado: ' + (e.name || e));
    return false;
  }
  vigiarMicrofone(trackAtual());
  aplicarSilencio();
  await listarMicrofones();
  registrar('Microfone ativo: ' + (trackAtual().label || 'sem nome'));
  return true;
}

async function trocarMicrofone(deviceId) {
  const antigo = trackAtual();
  if (antigo) antigo.stop();
  let novoStream;
  try {
    novoStream = await pegarMicrofone(deviceId);
  } catch (e) {
    registrar('Não foi possível reativar o microfone: ' + (e.name || e) + '. Toque em "Reativar microfone".');
    atualizarMicrofone();
    return;
  }
  streamLocal = novoStream;
  const novo = trackAtual();
  vigiarMicrofone(novo);
  aplicarSilencio();
  const pc = chamada && chamada.peerConnection;
  if (pc) {
    const remetentes = pc.getSenders();
    const remetente = remetentes.find((r) => r.track && r.track.kind === 'audio') || remetentes[0];
    if (remetente) {
      try {
        await remetente.replaceTrack(novo);
      } catch (e) {
        registrar('Não foi possível trocar o microfone na conversa: ' + (e.name || e));
      }
    }
  }
  registrar('Microfone ativo: ' + (novo.label || 'sem nome'));
  await listarMicrofones();
}

async function conferirMicrofone() {
  const track = trackAtual();
  if (track && (track.muted || track.readyState === 'ended')) {
    registrar('Microfone continua cortado. Tentando reativar.');
    await trocarMicrofone(microfoneEscolhido || undefined);
  }
}

// ---------------------------------------------------------------------------
// Volume da voz recebida. Até 100%, o som sai direto pelo elemento de áudio,
// que segue o volume do celular (o iPhone não deixa a página mudar esse volume).
// Acima de 100%, a voz passa por um amplificador do Web Audio com limitador,
// para não distorcer, e o elemento fica mudo para o som não sair duas vezes.
// ---------------------------------------------------------------------------
function lerVolumeSalvo() {
  const salvo = parseInt(lerSalvo(CHAVE_VOLUME), 10);
  return NIVEIS_VOLUME.includes(salvo) ? salvo : 100;
}

// Precisa ser chamado num toque: fora dele, o iPhone deixa o Web Audio parado.
function prepararContextoAudio() {
  const Contexto = window.AudioContext || window.webkitAudioContext;
  if (!Contexto) return null;
  if (!contextoAudio) {
    try {
      contextoAudio = new Contexto();
    } catch (e) {
      registrar('Não foi possível preparar o amplificador: ' + (e.name || e));
      return null;
    }
    contextoAudio.addEventListener('statechange', () => {
      registrar('Amplificador ' + nomeEstadoAmplificador() + '.');
      atualizarSaidaDeAudio();
    });
  }
  if (contextoAudio.state !== 'running') contextoAudio.resume().catch(() => {});
  return contextoAudio;
}

function nomeEstadoAmplificador() {
  const nomes = { running: 'ativo', suspended: 'parado', interrupted: 'interrompido pelo sistema', closed: 'desligado' };
  return contextoAudio ? nomes[contextoAudio.state] || contextoAudio.state : 'desligado';
}

function montarAmplificador(stream) {
  if (amplificador && amplificador.stream === stream) return true;
  desmontarAmplificador();
  const ctx = prepararContextoAudio();
  if (!ctx) return false;
  try {
    const fonte = ctx.createMediaStreamSource(stream);
    const ganho = ctx.createGain();
    const limitador = ctx.createDynamicsCompressor();
    limitador.threshold.value = -3;
    limitador.knee.value = 0;
    limitador.ratio.value = 20;
    limitador.attack.value = 0.003;
    limitador.release.value = 0.25;
    fonte.connect(ganho);
    ganho.connect(limitador);
    limitador.connect(ctx.destination);
    amplificador = { stream, fonte, ganho, limitador };
    return true;
  } catch (e) {
    registrar('Não foi possível amplificar o volume: ' + (e.name || e));
    return false;
  }
}

function desmontarAmplificador() {
  if (!amplificador) return;
  try {
    amplificador.fonte.disconnect();
    amplificador.limitador.disconnect();
  } catch (e) { /* já desconectado */ }
  amplificador = null;
}

// Se o amplificador parar (sem toque, tela apagada, ligação), a voz volta a sair
// direto, no volume normal, em vez de sumir.
function atualizarSaidaDeAudio() {
  audioRemoto.muted = !!amplificador && !!contextoAudio && contextoAudio.state === 'running';
}

function aplicarVolume() {
  $('volumeValor').textContent = volume + '%';
  $('volumeMenos').disabled = volume <= NIVEIS_VOLUME[0];
  $('volumeMais').disabled = volume >= NIVEIS_VOLUME[NIVEIS_VOLUME.length - 1];
  const remoto = audioRemoto.srcObject;
  if (volume > 100 && remoto && montarAmplificador(remoto)) {
    amplificador.ganho.gain.value = volume / 100;
  } else {
    desmontarAmplificador();
  }
  atualizarSaidaDeAudio();
}

function mudarVolume(passo) {
  const atual = NIVEIS_VOLUME.indexOf(volume);
  const novo = NIVEIS_VOLUME[Math.max(0, Math.min(NIVEIS_VOLUME.length - 1, atual + passo))];
  if (novo === volume) return;
  volume = novo;
  try { localStorage.setItem(CHAVE_VOLUME, String(volume)); } catch (e) { /* vale só nesta conversa */ }
  if (volume > 100) prepararContextoAudio();
  aplicarVolume();
  registrar('Volume: ' + volume + '%.');
}

function descreverVolume() {
  if (volume <= 100) return '100% (volume do celular)';
  if (!amplificador) return volume + '% (amplificador aguardando a voz da outra pessoa)';
  let texto = volume + '% (amplificador ' + nomeEstadoAmplificador();
  const latencia = contextoAudio && (contextoAudio.outputLatency || contextoAudio.baseLatency);
  if (latencia) texto += ', atraso de saída ' + Math.round(latencia * 1000) + ' ms';
  return texto + ')';
}

// ---------------------------------------------------------------------------
// Tela sempre ligada
// ---------------------------------------------------------------------------
async function manterTelaLigada() {
  if (!('wakeLock' in navigator)) {
    $('telaLigada').textContent = 'Indisponível neste navegador';
    return;
  }
  if ((wakeLock && !wakeLock.released) || pedidoTela) return;
  try {
    pedidoTela = navigator.wakeLock.request('screen');
    wakeLock = await pedidoTela;
    $('telaLigada').textContent = 'Ativa';
    wakeLock.addEventListener('release', () => { $('telaLigada').textContent = 'Desativada'; });
  } catch (e) {
    $('telaLigada').textContent = 'Não permitida (' + (e.name || e) + ')';
  } finally {
    pedidoTela = null;
  }
}

function liberarTela() {
  if (wakeLock && !wakeLock.released) wakeLock.release().catch(() => {});
}

// ---------------------------------------------------------------------------
// Servidor de encontro (só para os dois celulares se acharem)
// ---------------------------------------------------------------------------
function ligarEventosPeer() {
  peer.on('open', () => {
    clearTimeout(timerReconexao);
    if (!servidorConectado) registrar('Servidor de encontro conectado.');
    servidorConectado = true;
    if (papel === 'anfitriao') {
      if (!chamada) definirStatus('Aguardando a outra pessoa entrar na sala.', 'espera');
    } else if (!jaChamou) {
      jaChamou = true;
      chamar();
    } else if (reentrarAoConectar) {
      reentrarAoConectar = false;
      if (!conectado()) chamar();
    }
  });

  peer.on('disconnected', () => {
    if (servidorConectado) {
      registrar('Sem conexão com o servidor de encontro. A conversa em andamento continua pela rede local.');
    }
    servidorConectado = false;
    agendarReconexao();
  });

  peer.on('error', tratarErro);

  if (papel === 'anfitriao') peer.on('call', receberChamada);
}

function agendarReconexao() {
  clearTimeout(timerReconexao);
  timerReconexao = setTimeout(() => {
    if (peer && !peer.destroyed && peer.disconnected) {
      try { peer.reconnect(); } catch (e) { /* tenta de novo no próximo ciclo */ }
      agendarReconexao();
    }
  }, 15000);
}

function reconectarServidorAgora() {
  if (!peer || peer.destroyed || !peer.disconnected) return;
  registrar('Reconectando ao servidor de encontro.');
  try { peer.reconnect(); } catch (e) { /* o ciclo de 15 segundos tenta de novo */ }
  agendarReconexao();
}

// Quando o celular de quem entrou volta da tela bloqueada ou de outro app, a conversa
// pode ter caído. A página entra de novo sozinha; se faltar internet para o encontro,
// entra assim que o servidor responder.
function reentrarSePerdeu() {
  if (papel !== 'convidado' || !jaChamou || !peer || peer.destroyed) return;
  if (conectado() || tentandoConectar) return;
  registrar('A conversa foi interrompida enquanto a página estava fechada. Entrando novamente na sala.');
  // Pedido feito antes de o servidor responder se perde: espera o "open".
  if (!peer.open) {
    reentrarAoConectar = true;
    reconectarServidorAgora();
    return;
  }
  chamar();
}

function tratarErro(erro) {
  const tipo = (erro && erro.type) || '';
  const fatais = {
    'peer-unavailable': 'Sala não encontrada. Confira o código e se a sala continua aberta no outro celular.',
    'unavailable-id': 'Este código de sala já está em uso. Crie outra sala.',
    'invalid-id': 'Código de sala inválido.',
    'browser-incompatible': 'Este navegador não é compatível com a conversa.',
    'ssl-unavailable': 'Não foi possível abrir uma conexão segura.',
  };
  const semInternet = ['network', 'server-error', 'socket-error', 'socket-closed'];

  if (fatais[tipo]) {
    if (tipo === 'peer-unavailable' && papel === 'convidado') {
      definirStatus(fatais[tipo], 'erro');
      registrar(fatais[tipo]);
      clearTimeout(timerConexao);
      tentandoConectar = false;
      $('entrarNovamente').hidden = false;
      $('voltar').hidden = false;
      return;
    }
    falhar(fatais[tipo]);
    return;
  }
  if (semInternet.includes(tipo)) {
    if (!chamada && !servidorConectado) {
      definirStatus(AVISO_SEM_INTERNET + ' Nova tentativa a cada 15 segundos.', 'alerta');
    }
    agendarReconexao();
    return;
  }
  registrar('Erro: ' + (tipo || (erro && erro.message) || erro));
}

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------
function conectado() {
  const pc = chamada && chamada.peerConnection;
  return !!pc && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
}

// A conexão pode continuar "conectada" por até 30 segundos depois que o outro
// celular fecha a página. O áudio chegando é o sinal confiável de conversa viva.
function recebendoAudio() {
  return conectado() && Date.now() - ultimoPacoteEm < 6000;
}

function chamar() {
  reentrarAoConectar = false;
  $('entrarNovamente').hidden = true;
  definirStatus('Conectando ao outro celular.', 'espera');
  const antiga = chamada;
  const nova = peer.call(PREFIXO + codigo, streamLocal);
  if (!nova) {
    falhar('Não foi possível iniciar a conexão.');
    return;
  }
  configurarChamada(nova);
  if (antiga) antiga.close();
  tentandoConectar = true;
  clearTimeout(timerConexao);
  timerConexao = setTimeout(() => {
    tentandoConectar = false;
    if (!conectado()) {
      definirStatus('A conexão não foi concluída. Confira se os dois celulares estão no mesmo Wi-Fi: o roteador de um ligado e o outro conectado nele.', 'alerta');
      registrar('A conexão não foi concluída em 20 segundos.');
      $('entrarNovamente').hidden = false;
    }
  }, 20000);
}

function receberChamada(recebida) {
  // Com a conversa ativa, ninguém mais entra. Se a conexão atual caiu (por exemplo,
  // a outra pessoa recarregou a página), a nova entrada substitui a antiga. A mesma
  // pessoa voltando (mesmo identificador, depois de bloquear a tela) entra sempre.
  if (chamada && recebendoAudio() && recebida.peer !== chamada.peer) {
    registrar('Pedido de entrada recusado: a sala já está em uso.');
    recebida.close();
    return;
  }
  const antiga = chamada;
  registrar('Outra pessoa entrando na sala.');
  definirStatus('Conectando ao outro celular.', 'espera');
  recebida.answer(streamLocal);
  configurarChamada(recebida);
  if (antiga) antiga.close();
}

function configurarChamada(nova) {
  chamada = nova;
  pacotesAnteriores = -1;
  ultimoPacoteEm = 0;
  leiturasParadas = 0;
  semAudioAvisado = false;
  esperaAnterior = null;

  const pc = nova.peerConnection;
  if (pc) {
    pc.addEventListener('connectionstatechange', () => {
      if (chamada !== nova) return;
      if (pc.connectionState === 'failed') {
        registrar('Conexão perdida.');
        definirStatus(AVISO_PERDIDA, 'erro');
      }
    });
  }

  nova.on('stream', (remoto) => {
    if (chamada !== nova) return;
    clearTimeout(timerConexao);
    tentandoConectar = false;
    audioRemoto.srcObject = remoto;
    tocarAudio();
    aplicarVolume();
    $('convite').hidden = true;
    $('entrarNovamente').hidden = true;
    registrar('Conversa conectada.');
    definirStatus('Conversa ativa.', 'ok');
  });

  nova.on('iceStateChanged', (estado) => {
    if (chamada !== nova) return;
    registrar('Conexão ' + (NOMES_ICE[estado] || estado) + '.');
    if (estado === 'connected' || estado === 'completed') {
      if (semAudioAvisado) definirStatus('Conectado, mas sem áudio da outra pessoa.', 'alerta');
      else definirStatus('Conversa ativa.', 'ok');
    } else if (estado === 'disconnected') definirStatus('Conexão instável. Tentando recuperar.', 'alerta');
    else if (estado === 'failed') definirStatus(AVISO_PERDIDA, 'erro');
  });

  nova.on('close', () => {
    if (chamada !== nova) return;
    chamada = null;
    tentandoConectar = false;
    clearTimeout(timerConexao);
    registrar('Conversa encerrada.');
    if (papel === 'anfitriao') {
      definirStatus('Conversa encerrada. Aguardando a outra pessoa entrar novamente.', 'alerta');
      $('convite').hidden = false;
    } else {
      definirStatus('Conversa encerrada.', 'erro');
      $('entrarNovamente').hidden = false;
    }
  });

  nova.on('error', (erro) => {
    if (chamada !== nova) return;
    registrar('Erro na conexão: ' + ((erro && (erro.type || erro.message)) || erro));
  });
}

function tocarAudio() {
  const tentativa = audioRemoto.play();
  if (tentativa && tentativa.catch) {
    tentativa.then(() => { $('ativarAudio').hidden = true; }).catch(() => {
      $('ativarAudio').hidden = false;
      registrar('O navegador bloqueou o áudio recebido. Toque em "Ativar áudio".');
    });
  }
}

// ---------------------------------------------------------------------------
// Diagnóstico
// ---------------------------------------------------------------------------
function mostrarNivel(id, nivel) {
  const barra = $(id);
  barra.style.width = typeof nivel === 'number' ? Math.min(100, Math.round(Math.sqrt(nivel) * 100)) + '%' : '0';
}

function enderecoDoRelatorio(c) {
  return (c && (c.address || c.ip)) || '';
}

function descreverRede(local, remoto) {
  if (!local || !remoto) return 'Procurando caminho na rede';
  const tiposLocais = ['host', 'prflx'];
  const a = enderecoDoRelatorio(local);
  const b = enderecoDoRelatorio(remoto);
  const direta = tiposLocais.includes(local.candidateType) && tiposLocais.includes(remoto.candidateType);
  const privados = (!a || enderecoLocal(a)) && (!b || enderecoLocal(b));
  if (!direta || !privados) return 'Rota fora da rede local: ' + (a || '?') + ' e ' + (b || '?');
  if (!a || !b) return 'Rede local (endereços ocultos pelo navegador)';
  return 'Rede local: ' + a + ' e ' + b;
}

function acompanharRecebimento(recebidos) {
  if (recebidos > 0 && recebidos > pacotesAnteriores) {
    ultimoPacoteEm = Date.now();
    leiturasParadas = 0;
    if (semAudioAvisado) {
      semAudioAvisado = false;
      registrar('Áudio da outra pessoa voltou.');
      if (conectado()) definirStatus('Conversa ativa.', 'ok');
    }
  } else if (pacotesAnteriores >= 0) {
    leiturasParadas++;
    if (leiturasParadas >= 3 && !semAudioAvisado && conectado()) {
      semAudioAvisado = true;
      registrar('Nenhum áudio da outra pessoa há 6 segundos.');
      definirStatus('Conectado, mas sem áudio da outra pessoa.', 'alerta');
    }
  }
  pacotesAnteriores = recebidos;
}

// Atraso medido: o tempo de ida e volta na rede e quanto a voz espera no buffer
// antes de tocar. O atraso do fone Bluetooth não aparece aqui.
function descreverAtraso(par, entrada) {
  const partes = [];
  if (par && typeof par.currentRoundTripTime === 'number') {
    partes.push('Rede ' + Math.round(par.currentRoundTripTime * 1000) + ' ms ida e volta');
  }
  if (entrada && typeof entrada.jitterBufferDelay === 'number' && entrada.jitterBufferEmittedCount > 0) {
    const total = entrada.jitterBufferDelay;
    const emitidos = entrada.jitterBufferEmittedCount;
    const media = Math.round((total / emitidos) * 1000);
    let recente = media;
    if (esperaAnterior && emitidos > esperaAnterior.emitidos) {
      recente = Math.round(((total - esperaAnterior.total) / (emitidos - esperaAnterior.emitidos)) * 1000);
    }
    esperaAnterior = { total, emitidos };
    partes.push('espera para tocar ' + recente + ' ms (média ' + media + ' ms)');
  }
  return partes.length ? partes.join(', ') : 'Sem dados';
}

async function lerStats() {
  leituras++;
  if (leituras % 5 === 0) salvarRegistro();
  $('enderecos').textContent = contagem.locais + ' locais enviados (' + contagem.ocultos + ' com nome oculto), ' + contagem.bloqueados + ' externos bloqueados';
  const pc = chamada && chamada.peerConnection;
  if (!pc) {
    $('rede').textContent = 'Sem conexão';
    $('atraso').textContent = 'Sem dados';
    mostrarNivel('nivelEnviado', null);
    mostrarNivel('nivelRecebido', null);
    return;
  }
  let relatorio;
  try {
    relatorio = await pc.getStats();
  } catch (e) {
    return;
  }
  const porId = new Map();
  relatorio.forEach((r) => porId.set(r.id, r));

  let par = null;
  relatorio.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) par = porId.get(r.selectedCandidatePairId) || par;
  });
  if (!par) {
    relatorio.forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
        if (!par || (r.bytesReceived || 0) > (par.bytesReceived || 0)) par = r;
      }
    });
  }
  if (par) {
    $('rede').textContent = descreverRede(porId.get(par.localCandidateId), porId.get(par.remoteCandidateId));
  } else {
    $('rede').textContent = 'Procurando caminho na rede (' + pc.iceConnectionState + ')';
  }

  let entrada = null;
  let saida = null;
  let fonte = null;
  relatorio.forEach((r) => {
    const audio = r.kind === 'audio' || r.mediaType === 'audio';
    if (r.type === 'inbound-rtp' && audio) entrada = r;
    if (r.type === 'outbound-rtp' && audio) saida = r;
    if (r.type === 'media-source' && audio) fonte = r;
  });

  mostrarNivel('nivelEnviado', fonte && typeof fonte.audioLevel === 'number' ? fonte.audioLevel : null);
  mostrarNivel('nivelRecebido', entrada && typeof entrada.audioLevel === 'number' ? entrada.audioLevel : null);

  const enviados = saida ? saida.packetsSent || 0 : 0;
  $('infoEnviado').textContent = enviados + ' pacotes' + (fonte && typeof fonte.audioLevel !== 'number' ? ', nível não informado' : '');

  const atraso = descreverAtraso(par, entrada);
  $('atraso').textContent = atraso;

  if (entrada) {
    const recebidos = entrada.packetsReceived || 0;
    const perdidos = Math.max(0, entrada.packetsLost || 0);
    const perda = recebidos + perdidos > 0 ? Math.round((perdidos / (recebidos + perdidos)) * 100) : 0;
    const parado = pacotesAnteriores >= 0 && recebidos === pacotesAnteriores;
    acompanharRecebimento(recebidos);
    $('infoRecebido').textContent = recebidos + ' pacotes, perda de ' + perda + '%' + (parado ? ', recebimento parado' : '');
    if (leituras % LEITURAS_POR_MEDICAO === 0 && conectado()) {
      registrar('Medição: ' + atraso + ', perda de ' + perda + '%, volume ' + volume + '%.');
    }
  } else {
    $('infoRecebido').textContent = 'Sem dados';
  }
}

function textoRegistro() {
  const opcoes = [...$('microfone').options].map((o) => o.dataset.original || o.textContent).join('; ');
  return [
    'Registro do teste de conversa',
    'Data: ' + new Date().toLocaleString('pt-BR'),
    'Navegador: ' + navigator.userAgent,
    'Papel: ' + (papel === 'anfitriao' ? 'criou a sala' : 'entrou na sala'),
    'Status: ' + $('status').textContent,
    'Rede: ' + $('rede').textContent,
    'Endereços: ' + $('enderecos').textContent,
    'Microfone em uso: ' + $('micAtual').textContent,
    'Microfones disponíveis: ' + (opcoes || 'nenhum'),
    'Áudio enviado: ' + $('infoEnviado').textContent,
    'Áudio recebido: ' + $('infoRecebido').textContent,
    'Atraso: ' + $('atraso').textContent,
    'Volume: ' + descreverVolume(),
    'Tela ligada: ' + $('telaLigada').textContent,
    'Sessão de áudio: ' + (navigator.audioSession ? navigator.audioSession.type : 'não disponível'),
    '',
    'Eventos:',
    ...eventos,
  ].join('\n');
}

// naInicial: a nota e a caixa de cópia da tela inicial, para o registro salvo.
async function copiar(texto, confirmacao, naInicial) {
  const idNota = naInicial ? 'notaInicio' : 'nota';
  try {
    await navigator.clipboard.writeText(texto);
    mostrarNota(confirmacao, idNota);
  } catch (e) {
    const area = $(naInicial ? 'areaCopiaInicio' : 'areaCopia');
    area.value = texto;
    area.hidden = false;
    area.focus();
    area.select();
    mostrarNota('Não foi possível copiar automaticamente. Selecione o texto abaixo e copie.', idNota);
  }
}

async function compartilharRegistro(texto, naInicial) {
  if (navigator.share) {
    try {
      await navigator.share({ text: texto });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copiar(texto, 'Registro copiado. Cole o texto numa conversa do WhatsApp.', naInicial);
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------
// Pedidos feitos logo no toque: o Safari pode recusar fora dele.
function prepararNoToque() {
  manterTelaLigada();
  pedirModoLigacao();
  if (volume > 100) prepararContextoAudio();
}

async function criarSala() {
  avisoInicio('');
  iniciarRegistroSalvo();
  bloquearBotoes(true);
  papel = 'anfitriao';
  prepararNoToque();
  if (!(await prepararMicrofone())) {
    liberarTela();
    bloquearBotoes(false);
    return;
  }
  codigo = gerarCodigo();
  registrar('Sala criada neste celular.');
  peer = new Peer(PREFIXO + codigo, OPCOES_PEER);
  ligarEventosPeer();
  $('codigoSala').textContent = formatarCodigo(codigo);
  $('convite').hidden = false;
  definirStatus('Conectando ao servidor de encontro.', 'espera');
  mostrarTela('conversa');
  iniciarAcompanhamento();
}

async function entrarSala() {
  avisoInicio('');
  const valor = $('campoCodigo').value;
  const doLink = valor.match(/sala=([0-9a-z-]+)/i); // aceita o link inteiro colado no campo
  const digitado = normalizarCodigo(doLink ? doLink[1] : valor);
  if (!codigoValido(digitado)) {
    avisoInicio('Código inválido. O código tem 10 letras e números.');
    return;
  }
  iniciarRegistroSalvo();
  bloquearBotoes(true);
  papel = 'convidado';
  codigo = digitado;
  jaChamou = false;
  prepararNoToque();
  if (!(await prepararMicrofone())) {
    liberarTela();
    bloquearBotoes(false);
    return;
  }
  registrar('Entrando na sala ' + formatarCodigo(codigo) + '.');
  peer = new Peer(OPCOES_PEER);
  ligarEventosPeer();
  $('convite').hidden = true;
  definirStatus('Conectando ao servidor de encontro.', 'espera');
  mostrarTela('conversa');
  iniciarAcompanhamento();
}

function iniciarAcompanhamento() {
  manterTelaLigada();
  clearInterval(timerStats);
  timerStats = setInterval(lerStats, 2000);
  lerStats();
}

function encerrarTudo() {
  clearInterval(timerStats);
  clearTimeout(timerReconexao);
  clearTimeout(timerConexao);
  if (chamada) chamada.close();
  if (peer && !peer.destroyed) peer.destroy();
  if (streamLocal) streamLocal.getTracks().forEach((t) => t.stop());
  desmontarAmplificador();
  if (contextoAudio) contextoAudio.close().catch(() => {});
  liberarTela();
  salvarRegistro();
}

function ligarTrava() {
  const botao = $('destravar');
  let timer = null;
  const cancelar = () => {
    clearTimeout(timer);
    botao.classList.remove('pressionando');
  };
  botao.addEventListener('pointerdown', (evento) => {
    evento.preventDefault();
    botao.classList.add('pressionando');
    timer = setTimeout(() => {
      botao.classList.remove('pressionando');
      $('trava').hidden = true;
      registrar('Tela destravada.');
    }, 1500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((tipo) => botao.addEventListener(tipo, cancelar));
  botao.addEventListener('contextmenu', (evento) => evento.preventDefault());
}

function iniciar() {
  const doLink = normalizarCodigo(new URLSearchParams(location.hash.slice(1)).get('sala'));
  if (codigoValido(doLink)) {
    $('campoCodigo').value = formatarCodigo(doLink);
    document.body.classList.add('convidado');
    $('entrar').classList.add('principal');
    $('criar').classList.remove('principal');
  }
  if (typeof Peer === 'undefined') {
    avisoInicio('A página não foi carregada corretamente. Recarregue a página.');
    bloquearBotoes(true);
  }

  $('criar').addEventListener('click', criarSala);
  $('entrar').addEventListener('click', entrarSala);
  $('campoCodigo').addEventListener('keydown', (evento) => { if (evento.key === 'Enter') entrarSala(); });

  $('enviarLink').addEventListener('click', async () => {
    const url = linkDaSala();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Conversa local', url });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    copiar(url, 'Link copiado.');
  });

  $('silenciar').addEventListener('click', () => {
    silenciado = !silenciado;
    aplicarSilencio();
    registrar(silenciado ? 'Microfone silenciado.' : 'Microfone ativado.');
  });

  $('travar').addEventListener('click', () => {
    $('trava').hidden = false;
    registrar('Tela travada.');
  });
  ligarTrava();

  $('ativarAudio').addEventListener('click', tocarAudio);
  $('entrarNovamente').addEventListener('click', () => {
    if (!peer || peer.destroyed || !peer.open) {
      definirStatus(AVISO_SEM_INTERNET, 'alerta');
      return;
    }
    $('voltar').hidden = true;
    chamar();
  });
  $('voltar').addEventListener('click', () => {
    encerrarTudo();
    location.reload();
  });
  $('encerrar').addEventListener('click', () => {
    if (!window.confirm('Encerrar a conversa?')) return;
    encerrarTudo();
    location.reload();
  });

  $('microfone').addEventListener('change', () => {
    microfoneEscolhido = $('microfone').value;
    trocarMicrofone(microfoneEscolhido);
  });
  $('reativar').addEventListener('click', () => trocarMicrofone(microfoneEscolhido || undefined));
  $('enviarRegistro').addEventListener('click', () => {
    compartilharRegistro(juntarRegistros(textoRegistro(), lerSalvo(CHAVE_REGISTRO_ANTERIOR)));
  });

  // Registro da última conversa, para enviar depois de fechar a página.
  $('enviarUltimoRegistro').hidden = !lerSalvo(CHAVE_REGISTRO);
  $('enviarUltimoRegistro').addEventListener('click', () => {
    compartilharRegistro(juntarRegistros(lerSalvo(CHAVE_REGISTRO), lerSalvo(CHAVE_REGISTRO_ANTERIOR)), true);
  });

  $('volumeMenos').addEventListener('click', () => mudarVolume(-1));
  $('volumeMais').addEventListener('click', () => mudarVolume(1));
  aplicarVolume();

  document.addEventListener('visibilitychange', () => {
    if (!peer) return;
    if (document.visibilityState === 'hidden') {
      registrar('Tela apagada ou página em segundo plano.');
      return;
    }
    registrar('Página visível novamente.');
    manterTelaLigada();
    if (audioRemoto.srcObject) tocarAudio();
    if (contextoAudio && contextoAudio.state !== 'running') contextoAudio.resume().catch(() => {});
    setTimeout(conferirMicrofone, 1000);
    reconectarServidorAgora();
    setTimeout(reentrarSePerdeu, 2000);
  });

  document.addEventListener('pointerdown', () => {
    if (peer && (!wakeLock || wakeLock.released)) manterTelaLigada();
    if (amplificador && contextoAudio && contextoAudio.state !== 'running') contextoAudio.resume().catch(() => {});
  });

  window.addEventListener('pagehide', () => {
    salvarRegistro();
    if (peer && !peer.destroyed) peer.destroy();
  });
}

iniciar();
