'use strict';
/* Editor de figurinhas. Roda no WebView do app (window.Android existe) ou num navegador comum
   (aí o botão final baixa o .webp em vez de mandar ao WhatsApp). */

const $ = (s) => document.querySelector(s);
const temApp = typeof window.Android !== 'undefined';

// Regras do WhatsApp: 512×512, estática até 100 KB, animada até 500 KB e 10 s.
const LADO = 512;
const LIMITE_ESTATICA = 99 * 1000;
const LIMITE_ANIMADA = 495 * 1000;
const MAX_SEG = 10;
const MAX_LADO_QUADRO = 768; // quadros de GIF maiores que isso são reduzidos ao abrir (economiza memória)

const est = {
  tela: 'inicio',
  midia: null, // { tipo: 'imagem' | 'video' | 'animada', el?, quadros?, url?, w, h, duracao }
  zoom: 1, x: 0, y: 0, // posição da mídia dentro do quadrado de 512
  cantos: false,
  inicio: 0, dur: 3, t0: 0,
  resultado: null, // { blob, bandeja, animada, info, url }
  ultimoPacote: null,
  fila: null, // GIFs da galeria, um de cada vez: { ids: [...], pos }
};

/* ---------- utilidades ---------- */

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
const limitar = (v, a, b) => Math.min(b, Math.max(a, v));
const segundos = (s) => s.toFixed(1).replace('.', ',') + ' s';

function el(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto != null) e.textContent = texto;
  return e;
}

function novaTela(lado = LADO) {
  const c = document.createElement('canvas');
  c.width = c.height = lado;
  return c;
}

function paraBlob(canvas, tipo, q) {
  return new Promise((ok, erro) =>
    canvas.toBlob((b) => (b ? ok(b) : erro(new Error('Não consegui gerar a imagem.'))), tipo, q));
}

function paraBase64(blob) {
  return new Promise((ok, erro) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => erro(r.error);
    r.readAsDataURL(blob);
  });
}

/* ---------- telas, avisos e janela de espera ---------- */

function mostrar(id) {
  document.querySelectorAll('.tela').forEach((t) => t.classList.toggle('ativa', t.id === id));
  est.tela = id;
  window.scrollTo(0, 0);
  if (id === 'editor') iniciarDesenho(); else pararDesenho();
}

function ocupado(texto, frac = 0) {
  $('#ocupado').hidden = texto == null;
  if (texto == null) return;
  $('#ocupadoTexto').textContent = texto;
  $('#ocupadoBarra').style.width = Math.round(frac * 100) + '%';
}

let fecharDialogo = null;
function perguntar(texto, sim = 'OK', nao = 'Cancelar') {
  return new Promise((ok) => {
    $('#dialogoTexto').textContent = texto;
    $('#dialogoSim').textContent = sim;
    $('#dialogoNao').hidden = !nao;
    if (nao) $('#dialogoNao').textContent = nao;
    $('#dialogo').hidden = false;
    $('#dialogoSim').focus();
    fecharDialogo = (v) => { $('#dialogo').hidden = true; fecharDialogo = null; ok(v); };
  });
}
$('#dialogoSim').onclick = () => fecharDialogo && fecharDialogo(true);
$('#dialogoNao').onclick = () => fecharDialogo && fecharDialogo(false);
const aviso = (texto) => perguntar(texto, 'Entendi', null);

/** Pede um texto (ex.: nome do pacote). Devolve o texto ou null se cancelar. */
async function pedirTexto(texto, valor) {
  const campo = $('#dialogoCampo');
  campo.hidden = false;
  campo.value = valor;
  const resposta = perguntar(texto, 'Salvar', 'Cancelar');
  setTimeout(() => { campo.focus(); campo.select(); }, 50);
  const ok = await resposta;
  campo.hidden = true;
  return ok ? campo.value.trim() : null;
}
$('#dialogoCampo').onkeydown = (e) => { if (e.key === 'Enter' && fecharDialogo) fecharDialogo(true); };

// Botão "voltar" do Android: devolve true se a página tratou.
window.voltar = () => {
  if (fecharDialogo) { fecharDialogo(false); return true; }
  if (!$('#ocupado').hidden) return true;
  if (est.tela === 'previa') { mostrar('editor'); return true; }
  if (est.tela === 'editor') { pararFila(); fecharMidia(); mostrar('inicio'); return true; }
  return false;
};
document.querySelectorAll('[data-voltar]').forEach((b) => { b.onclick = () => window.voltar(); });

/* ---------- abrir foto, GIF ou vídeo ---------- */

async function detectarTipo(blob, mime = '') {
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const s = (i, n) => String.fromCharCode(...b.slice(i, i + n));
  if (s(0, 3) === 'GIF') return 'gif';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'webp';
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'imagem';
  if (s(4, 4) === 'ftyp') return /^(avif|avis|heic|heix|mif1|msf1)/.test(s(8, 4)) ? 'imagem' : 'video';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video'; // webm/mkv
  if (mime.startsWith('video/')) return 'video';
  return 'imagem';
}

async function abrirBlob(blob, mime) {
  ocupado('Abrindo…', 0);
  est.fundoOriginal = null;
  try {
    fecharMidia();
    const tipo = await detectarTipo(blob, mime || blob.type || '');
    est.midia = tipo === 'video' ? await abrirVideo(blob) : await abrirImagem(blob, tipo);
    prepararEditor();
    mostrar('editor');
    ocupado(null);
    return true;
  } catch (e) {
    console.error(e);
    fecharMidia();
    ocupado(null);
    await aviso('Não consegui abrir esse arquivo.\n' + (e.message || ''));
    return false;
  }
}

async function abrirImagem(blob, tipo) {
  const mimes = { gif: 'image/gif', webp: 'image/webp', png: 'image/png' };
  if (mimes[tipo] && 'ImageDecoder' in window) {
    const quadros = await decodificarAnimada(blob, mimes[tipo]);
    if (quadros && quadros.length > 1) {
      const ultimo = quadros[quadros.length - 1];
      return {
        tipo: 'animada', quadros,
        w: quadros[0].bmp.width, h: quadros[0].bmp.height,
        duracao: (ultimo.t + ultimo.ms) / 1000,
      };
    }
    if (quadros) quadros.forEach((q) => q.bmp.close());
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('Formato de imagem não suportado (fotos HEIC do iPhone não abrem).');
  }
  return { tipo: 'imagem', el: img, url, w: img.naturalWidth, h: img.naturalHeight, duracao: 0 };
}

/** Lê todos os quadros de um GIF / WebP / PNG animado. Retorna null se não for animado. */
async function decodificarAnimada(blob, mime) {
  let dec;
  try {
    dec = new ImageDecoder({ data: blob.stream(), type: mime });
    await dec.tracks.ready;
    const trilha = dec.tracks.selectedTrack;
    if (!trilha || !trilha.animated) return null;
    await dec.completed;
    const n = Math.min(trilha.frameCount, 600);
    const quadros = [];
    let t = 0;
    for (let i = 0; i < n && t < 60000; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      let ms = image.duration ? image.duration / 1000 : 100;
      if (ms < 20) ms = 100; // GIFs com atraso ~0 rodam a 10 quadros/s nos navegadores
      const k = Math.min(1, MAX_LADO_QUADRO / Math.max(image.displayWidth, image.displayHeight));
      const bmp = k < 1
        ? await createImageBitmap(image, {
          resizeWidth: Math.round(image.displayWidth * k),
          resizeHeight: Math.round(image.displayHeight * k),
          resizeQuality: 'high',
        })
        : await createImageBitmap(image);
      image.close();
      quadros.push({ bmp, t, ms });
      t += ms;
      if (i % 5 === 0) ocupado('Abrindo…', i / n);
    }
    return quadros;
  } catch (e) {
    console.warn('ImageDecoder falhou', e);
    return null;
  } finally {
    if (dec) dec.close();
  }
}

async function abrirVideo(blob) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.loop = false;
  v.className = 'video-oculto'; // na página (quase invisível) para o navegador entregar cada quadro
  v.src = url;
  document.body.append(v);
  try {
    await new Promise((ok, erro) => {
      v.onloadeddata = ok;
      v.onerror = () => erro(new Error('Formato de vídeo não suportado.'));
    });
  } catch (e) {
    URL.revokeObjectURL(url);
    v.remove();
    throw e;
  }
  let duracao = v.duration;
  if (!isFinite(duracao)) { // alguns webm não informam a duração
    v.currentTime = 1e7;
    await new Promise((ok) => { v.onseeked = ok; setTimeout(ok, 3000); });
    duracao = isFinite(v.duration) ? v.duration : v.currentTime || MAX_SEG;
    v.currentTime = 0;
  }
  return { tipo: 'video', el: v, url, w: v.videoWidth, h: v.videoHeight, duracao };
}

function fecharMidia() {
  pararDesenho();
  const m = est.midia;
  if (!m) return;
  if (m.el && m.tipo === 'video') { m.el.pause(); m.el.removeAttribute('src'); m.el.load(); m.el.remove(); }
  if (m.url) URL.revokeObjectURL(m.url);
  if (m.quadros) m.quadros.forEach((q) => q.bmp.close());
  est.midia = null;
}

/* ---------- editor: enquadrar, zoom e trecho ---------- */

const tela = $('#tela');
const ctxTela = tela.getContext('2d');

const escalaInteira = () => Math.min(LADO / est.midia.w, LADO / est.midia.h);
const escalaPreencher = () => Math.max(LADO / est.midia.w, LADO / est.midia.h);
const zoomMin = () => escalaInteira() * 0.25;
const zoomMax = () => escalaPreencher() * 6;

function definirZoom(z, cx = LADO / 2, cy = LADO / 2) {
  z = limitar(z, zoomMin(), zoomMax());
  const k = z / est.zoom; // mantém o ponto (cx, cy) parado
  est.x = cx - (cx - est.x) * k;
  est.y = cy - (cy - est.y) * k;
  est.zoom = z;
  const a = Math.log(zoomMin()), b = Math.log(zoomMax());
  $('#zoom').value = Math.round(1000 * (Math.log(z) - a) / (b - a));
}

function enquadrar(modo) {
  const m = est.midia;
  const z = modo === 'inteira' ? escalaInteira() : escalaPreencher();
  est.zoom = z;
  est.x = (LADO - m.w * z) / 2;
  est.y = (LADO - m.h * z) / 2;
  definirZoom(z);
  $('#btInteira').classList.toggle('ativo', modo === 'inteira');
  $('#btPreencher').classList.toggle('ativo', modo === 'preencher');
}

function desmarcarModo() {
  $('#btInteira').classList.remove('ativo');
  $('#btPreencher').classList.remove('ativo');
}

function prepararEditor() {
  const m = est.midia;
  est.cantos = $('#cantos').checked;
  enquadrar('inteira');
  const animado = m.tipo !== 'imagem';
  $('#trecho').hidden = !animado;
  if (animado) {
    const maxDur = Math.min(MAX_SEG, m.duracao);
    const minDur = Math.min(0.5, maxDur);
    est.inicio = 0;
    est.dur = Math.min(m.tipo === 'video' ? 3 : 6, maxDur);
    const d = $('#duracao');
    d.min = minDur;
    d.max = maxDur.toFixed(1);
    d.value = est.dur;
    // O começo pode ir até quase o fim; se passar, a duração encolhe sozinha.
    $('#comeco').max = Math.max(0, m.duracao - minDur).toFixed(1);
    $('#comeco').value = 0;
    if (m.tipo === 'video') m.el.currentTime = 0;
  }
  est.t0 = performance.now();
  atualizarTrecho();
  atualizarBotaoFundo();
}

/* ---------- remover fundo (só fotos; o recorte é feito pelo Android, com o ML Kit) ---------- */

function atualizarBotaoFundo() {
  const b = $('#btFundo');
  b.hidden = !(temApp && window.Android.removerFundo && est.midia && est.midia.tipo === 'imagem');
  b.textContent = est.fundoOriginal ? 'Voltar o fundo' : 'Remover fundo';
}

$('#btFundo').onclick = async () => {
  if (est.fundoOriginal) {
    const original = est.fundoOriginal;
    await abrirBlob(original, original.type);
    return;
  }
  const m = est.midia;
  if (!m || m.tipo !== 'imagem') return;
  ocupado('Removendo o fundo…', 0.4);
  try {
    const original = await (await fetch(m.url)).blob();
    // Foto reduzida (o recorte fica bom e rápido assim) e já virada do jeito certo.
    const k = Math.min(1, 1280 / Math.max(m.w, m.h));
    const c = document.createElement('canvas');
    c.width = Math.round(m.w * k);
    c.height = Math.round(m.h * k);
    c.getContext('2d').drawImage(m.el, 0, 0, c.width, c.height);
    const png = await paraBase64(await new Promise((ok) => c.toBlob(ok, 'image/png')));
    const r = await new Promise((ok) => {
      const limite = setTimeout(() => ok({ ok: false, erro: 'O recorte demorou demais. Tente de novo.' }), 60000);
      window.aoRemoverFundo = (res) => { clearTimeout(limite); ok(res); };
      window.Android.removerFundo(png);
    });
    window.aoRemoverFundo = null;
    if (!r.ok) {
      ocupado(null);
      await aviso(r.erro);
      return;
    }
    const bytes = Uint8Array.from(atob(r.png), (ch) => ch.charCodeAt(0));
    if (await abrirBlob(new Blob([bytes], { type: 'image/png' }), 'image/png')) {
      est.fundoOriginal = original;
      atualizarBotaoFundo();
    }
  } catch (e) {
    console.error(e);
    ocupado(null);
    await aviso('Não consegui remover o fundo.\n' + (e.message || ''));
  }
};

function atualizarTrecho() {
  $('#txtInicio').textContent = segundos(est.inicio);
  $('#txtDur').textContent = segundos(est.dur);
}

$('#btInteira').onclick = () => enquadrar('inteira');
$('#btPreencher').onclick = () => enquadrar('preencher');
$('#cantos').onchange = (e) => { est.cantos = e.target.checked; };
$('#zoom').oninput = (e) => {
  const a = Math.log(zoomMin()), b = Math.log(zoomMax());
  definirZoom(Math.exp(a + (b - a) * e.target.value / 1000));
  desmarcarModo();
};
$('#comeco').oninput = (e) => {
  est.inicio = +e.target.value;
  const resta = Math.floor((est.midia.duracao - est.inicio) * 10) / 10;
  if (est.dur > resta) { est.dur = Math.max(+$('#duracao').min, resta); $('#duracao').value = est.dur; }
  est.t0 = performance.now();
  if (est.midia.tipo === 'video') est.midia.el.currentTime = est.inicio;
  atualizarTrecho();
};
$('#duracao').oninput = (e) => {
  est.dur = +e.target.value;
  const max = Math.max(0, Math.floor((est.midia.duracao - est.dur) * 10) / 10);
  if (est.inicio > max) {
    est.inicio = max;
    $('#comeco').value = max;
    if (est.midia.tipo === 'video') est.midia.el.currentTime = est.inicio;
  }
  est.t0 = performance.now();
  atualizarTrecho();
};

// Arrastar com um dedo, pinça com dois, roda do mouse no PC.
const ponteiros = new Map();
tela.addEventListener('pointerdown', (e) => {
  tela.setPointerCapture(e.pointerId);
  ponteiros.set(e.pointerId, { x: e.clientX, y: e.clientY });
});
tela.addEventListener('pointermove', (e) => {
  if (!ponteiros.has(e.pointerId) || !est.midia) return;
  const antes = [...ponteiros.values()].map((p) => ({ ...p }));
  ponteiros.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const depois = [...ponteiros.values()];
  const k = LADO / tela.clientWidth;
  if (depois.length === 1) {
    est.x += (depois[0].x - antes[0].x) * k;
    est.y += (depois[0].y - antes[0].y) * k;
  } else {
    const [a0, b0] = antes, [a1, b1] = depois;
    const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y), d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y);
    const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }, m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
    est.x += (m1.x - m0.x) * k;
    est.y += (m1.y - m0.y) * k;
    const r = tela.getBoundingClientRect();
    if (d0 > 0) definirZoom(est.zoom * d1 / d0, (m1.x - r.left) * k, (m1.y - r.top) * k);
  }
  desmarcarModo();
});
const soltar = (e) => ponteiros.delete(e.pointerId);
tela.addEventListener('pointerup', soltar);
tela.addEventListener('pointercancel', soltar);
tela.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = tela.getBoundingClientRect(), k = LADO / tela.clientWidth;
  definirZoom(est.zoom * Math.exp(-e.deltaY * 0.0015), (e.clientX - r.left) * k, (e.clientY - r.top) * k);
  desmarcarModo();
}, { passive: false });

/** Desenha a mídia no quadrado de 512 (o ctx já deve estar na escala certa). */
function desenhar(ctx, fonte) {
  const m = est.midia;
  const w = m.w * est.zoom, h = m.h * est.zoom;
  ctx.clearRect(0, 0, LADO, LADO);
  ctx.save();
  if (est.cantos) {
    // arredonda os cantos da parte visível da imagem (não do quadrado inteiro)
    const x0 = Math.max(0, est.x), y0 = Math.max(0, est.y);
    const x1 = Math.min(LADO, est.x + w), y1 = Math.min(LADO, est.y + h);
    if (x1 > x0 && y1 > y0) {
      ctx.beginPath();
      ctx.roundRect(x0, y0, x1 - x0, y1 - y0, Math.min(56, (x1 - x0) * 0.14, (y1 - y0) * 0.14));
      ctx.clip();
    }
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(fonte, est.x, est.y, w, h);
  ctx.restore();
}

function indiceNoTempo(lista, tMs) {
  let lo = 0, hi = lista.length - 1;
  while (lo < hi) {
    const meio = (lo + hi + 1) >> 1;
    if (lista[meio].t <= tMs) lo = meio; else hi = meio - 1;
  }
  return lo;
}

/** O quadro que aparece agora na prévia do editor (repete o trecho escolhido). */
function fonteAgora(agora) {
  const m = est.midia;
  if (m.tipo === 'imagem') return m.el;
  if (m.tipo === 'video') {
    const v = m.el;
    if (v.currentTime < est.inicio - 0.05 || v.currentTime >= est.inicio + est.dur || v.ended) v.currentTime = est.inicio;
    if (v.paused) v.play().catch(() => {});
    return v;
  }
  const tMs = est.inicio * 1000 + ((agora - est.t0) % (est.dur * 1000));
  return m.quadros[indiceNoTempo(m.quadros, tMs)].bmp;
}

let rafId = 0;
function iniciarDesenho() {
  pararDesenho();
  const passo = (agora) => {
    if (est.midia) {
      const px = Math.round(tela.clientWidth * (window.devicePixelRatio || 1));
      if (px > 0 && tela.width !== px) { tela.width = px; tela.height = px; }
      ctxTela.setTransform(tela.width / LADO, 0, 0, tela.width / LADO, 0, 0);
      desenhar(ctxTela, fonteAgora(agora));
    }
    rafId = requestAnimationFrame(passo);
  };
  rafId = requestAnimationFrame(passo);
}
function pararDesenho() {
  cancelAnimationFrame(rafId);
  rafId = 0;
  if (est.midia && est.midia.tipo === 'video') est.midia.el.pause();
}

/* ---------- gerar a figurinha ---------- */

const telaCod = novaTela();
const ctxCod = telaCod.getContext('2d');

async function webpDe(fonte, q) {
  ctxCod.clearRect(0, 0, LADO, LADO);
  ctxCod.drawImage(fonte, 0, 0, LADO, LADO);
  const b = await paraBlob(telaCod, 'image/webp', q);
  if (b.type !== 'image/webp') throw new Error('Este navegador não consegue gerar a figurinha. Use o app no Android.');
  return new Uint8Array(await b.arrayBuffer());
}

async function gerarBandeja(fonte) {
  const c = novaTela(96);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(fonte, 0, 0, 96, 96);
  return paraBlob(c, 'image/png');
}

/** fonte: a mídia original; ou, com jaEnquadrada, um quadro de 512×512 pronto. */
async function gerarEstatica(fonte, jaEnquadrada = false) {
  ocupado('Montando a figurinha…', 0.3);
  const c = novaTela();
  if (jaEnquadrada) c.getContext('2d').drawImage(fonte, 0, 0);
  else desenhar(c.getContext('2d'), fonte);
  let bytes;
  for (const q of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]) {
    bytes = await webpDe(c, q);
    if (bytes.length <= LIMITE_ESTATICA) break;
  }
  if (bytes.length > LIMITE_ESTATICA) throw new Error('A imagem ficou grande demais mesmo comprimida.');
  const blob = new Blob([bytes], { type: 'image/webp' });
  return {
    blob, animada: false, bandeja: await gerarBandeja(c),
    info: `Figurinha parada · ${Math.round(blob.size / 1000)} KB de 100 KB`,
  };
}

function quadroDoVideo(v, t) {
  return new Promise((ok) => {
    v.pause();
    t = Math.min(t, Math.max(0, v.duration - 0.02));
    if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) { ok(v); return; }
    const pronto = () => { clearTimeout(limite); v.removeEventListener('seeked', pronto); ok(v); };
    const limite = setTimeout(pronto, 3000);
    v.addEventListener('seeked', pronto);
    v.currentTime = t;
  });
}

/**
 * Captura n quadros do trecho do vídeo, já enquadrados. Toca em 2× e pega cada quadro quando ele
 * aparece (buscar quadro a quadro é lento: cada busca decodifica desde o último quadro-chave).
 */
async function capturarVideo(v, n, fps) {
  const c = novaTela(), ctx = c.getContext('2d');
  const capt = [];
  const alvo = (k) => est.inicio + k / fps;
  let k = 0;
  // O quadro atual vale para o alvo k (e os seguintes que ele cobrir). createImageBitmap copia o canvas na hora.
  const guardar = () => {
    desenhar(ctx, v);
    capt.push({ bmp: createImageBitmap(c), t: k * 1000 / fps });
  };
  await quadroDoVideo(v, est.inicio);
  if ('requestVideoFrameCallback' in v) {
    await new Promise((ok) => {
      let acabou = false, vigia = 0;
      const terminar = () => {
        if (acabou) return;
        acabou = true;
        clearTimeout(vigia);
        v.pause();
        v.playbackRate = 1;
        ok();
      };
      const vigiar = () => { clearTimeout(vigia); vigia = setTimeout(terminar, 3000); };
      const cada = (agora, meta) => {
        if (acabou) return;
        vigiar();
        if (k < n && alvo(k) <= meta.mediaTime + 0.02) {
          guardar();
          while (k < n && alvo(k) <= meta.mediaTime + 0.02) k++;
          ocupado('Separando os quadros…', 0.4 * k / n);
        }
        if (k >= n || v.ended || meta.mediaTime >= est.inicio + est.dur) terminar();
        else v.requestVideoFrameCallback(cada);
      };
      v.requestVideoFrameCallback(cada);
      vigiar();
      v.playbackRate = 2;
      v.play().catch(terminar);
    });
  }
  // Reserva (navegador sem requestVideoFrameCallback, ou o vídeo travou): busca quadro a quadro.
  for (; k < n; k++) {
    await quadroDoVideo(v, alvo(k));
    guardar();
    ocupado('Separando os quadros…', 0.4 * (k + 1) / n);
  }
  for (const q of capt) q.bmp = await q.bmp;
  return capt;
}

/** Captura os quadros de um GIF / WebP animado no trecho, sem repetir quadros iguais. */
async function capturarAnimada(m, n, fps) {
  const c = novaTela(), ctx = c.getContext('2d');
  const capt = [];
  let anterior = -1;
  for (let i = 0; i < n; i++) {
    const t = i * 1000 / fps;
    const idx = indiceNoTempo(m.quadros, est.inicio * 1000 + t);
    if (idx === anterior) continue;
    anterior = idx;
    desenhar(ctx, m.quadros[idx].bmp);
    capt.push({ bmp: await createImageBitmap(c), t });
    ocupado('Separando os quadros…', 0.4 * (i + 1) / n);
  }
  return capt;
}

/** Escolhe os quadros para uma taxa (quadros/s), juntando quadros repetidos num só mais longo. */
function selecionar(capt, fps, durMs) {
  const passo = 1000 / fps;
  const saida = [];
  for (let k = 0; k * passo < durMs - 0.5; k++) {
    const i = indiceNoTempo(capt, k * passo);
    if (saida.length && saida[saida.length - 1].i === i) continue;
    saida.push({ i, bmp: capt[i].bmp, ini: Math.round(k * passo) });
  }
  saida.forEach((q, j) => {
    const fim = j + 1 < saida.length ? saida[j + 1].ini : Math.round(durMs);
    q.ms = Math.max(10, fim - q.ini);
  });
  return saida;
}

async function montarNoLimite(quadros, q, limite, aoProgresso) {
  const partes = [];
  let total = 64;
  for (let j = 0; j < quadros.length; j++) {
    const bytes = await webpDe(quadros[j].bmp, q);
    total += bytes.length + 32;
    if (total > limite) return null; // já passou: desiste cedo desta tentativa
    partes.push({ bytes, ms: quadros[j].ms });
    aoProgresso((j + 1) / quadros.length);
  }
  const blob = FigWebP.montar(partes, LADO, LADO);
  return blob.size <= limite ? blob : null;
}

async function gerarAnimada() {
  const m = est.midia;
  const durMs = Math.round(est.dur * 1000);
  const fpsFonte = m.tipo === 'video' ? 30 : m.quadros.length / Math.max(0.1, m.duracao);
  const fpsMax = limitar(Math.round(fpsFonte), 1, 15);

  // 1) separa os quadros do trecho, já enquadrados em 512×512
  const n = Math.max(1, Math.round(est.dur * fpsMax));
  const capt = m.tipo === 'video' ? await capturarVideo(m.el, n, fpsMax) : await capturarAnimada(m, n, fpsMax);

  try {
    if (capt.length < 2) return await gerarEstatica(capt[0].bmp, true);

    // 2) procura a melhor combinação de quadros/s e qualidade que cabe em 500 KB
    const amostra = [0, 0.25, 0.5, 0.75, 1].map((f) => capt[Math.round(f * (capt.length - 1))].bmp);
    const medias = new Map();
    const tamanhoMedio = async (q) => {
      if (!medias.has(q)) {
        let s = 0;
        for (const b of amostra) s += (await webpDe(b, q)).length;
        medias.set(q, s / amostra.length);
      }
      return medias.get(q);
    };
    const combos = [[15, 0.8], [15, 0.65], [15, 0.5], [12, 0.5], [10, 0.5], [10, 0.38], [8, 0.38],
      [8, 0.28], [6, 0.28], [6, 0.2], [5, 0.15], [4, 0.1]]
      .map(([f, q]) => [Math.min(f, fpsMax), q])
      .filter(([f, q], i, a) => a.findIndex(([f2, q2]) => f2 === f && q2 === q) === i);

    for (let ci = 0; ci < combos.length; ci++) {
      const [fps, q] = combos[ci];
      const quadros = selecionar(capt, fps, durMs);
      const ultimo = ci === combos.length - 1;
      ocupado('Comprimindo…', 0.4);
      if (!ultimo && quadros.length * await tamanhoMedio(q) > LIMITE_ANIMADA * 0.92) continue;
      const blob = await montarNoLimite(quadros, q, LIMITE_ANIMADA, (f) => ocupado('Comprimindo…', 0.4 + 0.6 * f));
      if (!blob) continue;
      const fpsReal = Math.round(quadros.length / est.dur);
      return {
        blob, animada: true, bandeja: await gerarBandeja(capt[0].bmp),
        info: `Animada · ${segundos(est.dur)} · ${fpsReal} quadros por segundo · ${Math.round(blob.size / 1000)} KB de 500 KB`,
      };
    }
    // Sugere uma duração que cabe, estimada a 8 quadros/s (ainda fica fluido).
    const porSegundo = 8 * await tamanhoMedio(0.28);
    const sugestao = Math.floor((LIMITE_ANIMADA * 0.9 / porSegundo) * 2) / 2;
    throw new Error('Mesmo bem comprimida, a figurinha passou de 500 KB.' + (sugestao >= 0.5 && sugestao < est.dur
      ? ` Diminua a duração para até ${segundos(sugestao)} e tente de novo.`
      : ' Diminua a duração e tente de novo.'));
  } finally {
    capt.forEach((q) => q.bmp.close());
  }
}

async function gerar() {
  if (!est.midia) return;
  pararDesenho();
  try {
    const m = est.midia;
    const r = m.tipo === 'imagem' ? await gerarEstatica(m.el) : await gerarAnimada();
    if (est.resultado && est.resultado.url) URL.revokeObjectURL(est.resultado.url);
    est.resultado = r;
    mostrarPrevia();
    ocupado(null);
  } catch (e) {
    console.error(e);
    ocupado(null);
    await aviso(e.message || 'Algo deu errado ao montar a figurinha.');
    iniciarDesenho();
  }
}
$('#btPronto').onclick = gerar;

/* ---------- prévia e envio ao WhatsApp ---------- */

function mostrarPrevia() {
  const r = est.resultado;
  r.url = URL.createObjectURL(r.blob);
  document.querySelectorAll('#previa img.fig').forEach((i) => { i.src = r.url; });
  $('#infoFig').textContent = r.info;
  $('#btAdicionar').textContent = temApp ? 'Adicionar ao WhatsApp' : 'Baixar a figurinha (.webp)';
  $('#btAdicionar').hidden = false;
  $('#feito').hidden = true;
  mostrar('previa');
}

function baixarArquivo(blob, nome) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function textoPronto(p) {
  let t = `Pronto! Ela está no pacote "${p.nome}", na aba de figurinhas do WhatsApp.`;
  if (p.total < 3) t += ' Enquanto o pacote tiver menos de 3 figurinhas, ela aparece repetida.';
  return t;
}

// O WhatsApp não puxa figurinha nova sozinho: o pacote mostra "Atualizar" e é preciso tocar.
function textoAtualizar(p) {
  return `A figurinha foi salva no pacote "${p.nome}". Falta só o WhatsApp atualizar o pacote:\n` +
    '1. No WhatsApp, abra uma conversa e toque no ícone de figurinhas.\n' +
    `2. Ache o pacote "${p.nome}": ele mostra a opção Atualizar.\n` +
    '3. Toque em Atualizar.\n' +
    'Ou toque em "Atualizar no WhatsApp" na tela inicial do app.';
}

function concluir(texto) {
  $('#btAdicionar').hidden = true;
  $('#feito').hidden = false;
  $('#feitoTexto').textContent = texto;
  const faltam = est.fila ? est.fila.ids.length - est.fila.pos - 1 : 0;
  $('#btProximo').hidden = faltam <= 0;
  $('#btProximo').textContent = `Próximo GIF (faltam ${faltam})`;
  $('#btParar').hidden = faltam <= 0;
  $('#btOutra').hidden = faltam > 0;
}

$('#btAdicionar').onclick = async () => {
  const r = est.resultado;
  if (!r) return;
  if (!temApp) { baixarArquivo(r.blob, 'figurinha.webp'); return; }
  ocupado('Salvando…', 0.6);
  try {
    const [webp, bandeja] = await Promise.all([paraBase64(r.blob), paraBase64(r.bandeja)]);
    const res = JSON.parse(window.Android.salvarFigurinha(webp, bandeja, r.animada));
    ocupado(null);
    if (!res.ok) { aviso(res.erro); return; }
    est.ultimoPacote = res;
    if (est.fila) window.Android.marcarGifsVistos(est.fila.ids[est.fila.pos]);
    carregarColecao();
    if (!res.temWhatsApp) concluir('A figurinha ficou salva no app, mas não achei o WhatsApp neste celular.');
    // Pacote novo: o WhatsApp pergunta se pode adicionar. Pacote que já está lá: pergunta se quer atualizar.
    else window.Android.adicionarAoWhatsApp(res.pacote);
  } catch (e) {
    ocupado(null);
    aviso('Não consegui salvar: ' + e.message);
  }
};

window.aoAdicionar = (r) => {
  carregarColecao();
  const p = est.ultimoPacote;
  const naPrevia = est.tela === 'previa' && $('#feito').hidden;
  let texto;
  if (r.ok) texto = r.atualizacao ? `Pronto! O pacote "${p.nome}" foi atualizado no WhatsApp.` : textoPronto(p);
  else if (r.atualizacao) texto = textoAtualizar(p);
  else if (r.erro) { aviso('O WhatsApp recusou o pacote:\n' + r.erro); return; }
  else texto = 'A figurinha ficou salva no app. Para mandar ao WhatsApp depois, toque em "Adicionar ao WhatsApp" na tela inicial.';
  if (naPrevia) concluir(texto); else aviso(texto);
};

$('#btOutra').onclick = () => { pararFila(); fecharMidia(); mostrar('inicio'); };
$('#btProximo').onclick = () => { est.fila.pos++; fecharMidia(); abrirGifDaFila(); };
$('#btParar').onclick = () => { pararFila(); fecharMidia(); mostrar('inicio'); };

/* ---------- GIFs da galeria: convite e fila "um de cada vez" ---------- */

function gifsDaGaleria() {
  try { return JSON.parse(window.Android.gifsDaGaleria()); } catch { return { permissao: false }; }
}

function naoPerguntarGaleria() {
  try { return localStorage.getItem('conviteGaleria') === 'nao'; } catch { return false; }
}

function atualizarConvite() {
  if (!temApp || est.fila) { $('#convite').hidden = true; $('#btTodosGifs').hidden = true; return; }
  const g = gifsDaGaleria();
  if (!g.permissao) {
    $('#btTodosGifs').hidden = true;
    $('#convite').hidden = naoPerguntarGaleria();
    $('#conviteTexto').textContent = 'Tem GIFs salvos no celular? O app procura na galeria e transforma em figurinhas, um de cada vez.';
    $('#btConvite').textContent = 'Procurar GIFs na galeria';
    $('#btConvite').onclick = () => window.Android.pedirPermissaoGaleria();
    $('#btConviteNao').onclick = () => {
      try { localStorage.setItem('conviteGaleria', 'nao'); } catch { /* sem armazenamento */ }
      $('#convite').hidden = true;
    };
    return;
  }
  const todos = (g.gifs || []).map((x) => x.id);
  const ids = (g.gifs || []).filter((x) => !x.visto).map((x) => x.id);
  const n = ids.length;
  // Botão fixo: rever todos os GIFs da galeria, mesmo depois de passar por eles.
  $('#btTodosGifs').hidden = todos.length === 0;
  $('#btTodosGifs').textContent = todos.length === 1 ? 'Ver o GIF da galeria' : `Ver os ${todos.length} GIFs da galeria`;
  $('#btTodosGifs').onclick = () => { est.fila = { ids: todos, pos: 0 }; $('#convite').hidden = true; $('#btTodosGifs').hidden = true; abrirGifDaFila(); };
  $('#convite').hidden = n === 0;
  if (n === 0) return;
  $('#conviteTexto').textContent = n === 1
    ? 'Achei 1 GIF novo na sua galeria. Quer transformar em figurinha?'
    : `Achei ${n} GIFs novos na sua galeria. Quer transformar em figurinhas, um de cada vez?`;
  $('#btConvite').textContent = n === 1 ? 'Transformar em figurinha' : 'Começar pelo mais novo';
  $('#btConvite').onclick = () => { est.fila = { ids, pos: 0 }; $('#convite').hidden = true; abrirGifDaFila(); };
  $('#btConviteNao').onclick = async () => {
    const pergunta = n === 1 ? 'Ignorar este GIF?' : `Ignorar estes ${n} GIFs?`;
    if (await perguntar(pergunta + ' O app só vai avisar de novo quando aparecer GIF novo.', 'Ignorar', 'Voltar')) {
      window.Android.marcarGifsVistos(ids.join(','));
      $('#convite').hidden = true;
    }
  };
}

window.aoPermissaoGaleria = (ok) => {
  if (!ok) {
    aviso('Sem permissão para ver a galeria. Se mudar de ideia: Configurações > Aplicativos > Figurinhas > Permissões > Fotos e vídeos.');
    return;
  }
  atualizarConvite();
  if ($('#convite').hidden) aviso('Não achei GIFs na galeria agora. Quando aparecer algum, o app avisa aqui.');
};

function abrirGifDaFila() {
  const f = est.fila;
  if (!f || f.pos >= f.ids.length) {
    pararFila();
    mostrar('inicio');
    aviso('Pronto, acabaram os GIFs.');
    return;
  }
  window.Android.abrirGif(f.ids[f.pos]);
}

function pararFila() {
  est.fila = null;
  $('#barraFila').hidden = true;
  atualizarConvite();
}

function atualizarBarraFila() {
  const f = est.fila;
  $('#barraFila').hidden = !f;
  if (!f) return;
  $('#filaTexto').textContent = `GIF ${f.pos + 1} de ${f.ids.length}`;
  $('#btAnterior').disabled = f.pos === 0;
}

$('#btAnterior').onclick = () => {
  if (!est.fila || est.fila.pos === 0) return;
  est.fila.pos--;
  fecharMidia();
  abrirGifDaFila();
};

$('#btPular').onclick = () => {
  if (!est.fila) return;
  window.Android.marcarGifsVistos(est.fila.ids[est.fila.pos]);
  est.fila.pos++;
  fecharMidia();
  abrirGifDaFila();
};

/* ---------- tela inicial: galeria, link e coleção ---------- */

$('#btGaleria').onclick = () => {
  if (temApp) window.Android.escolherDaGaleria();
  else $('#arquivo').click();
};
$('#arquivo').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) abrirBlob(f, f.type);
};

function mostrarStatus(texto, frac) {
  $('#status').hidden = false;
  $('#statusTexto').textContent = texto;
  $('#statusBarra').style.width = Math.round(limitar(frac, 0, 1) * 100) + '%';
}
const esconderStatus = () => { $('#status').hidden = true; };

function baixarLink(url) {
  url = url.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!temApp) {
    aviso('No navegador do PC não dá para baixar de links. Salve o arquivo e use "Escolher da galeria".');
    return;
  }
  $('#campoLink').value = url;
  mostrarStatus('Preparando o download…', 0);
  window.Android.baixarLink(url);
}

$('#formLink').onsubmit = (e) => {
  e.preventDefault();
  $('#campoLink').blur();
  baixarLink($('#campoLink').value);
};
$('#btCancelarLink').onclick = () => {
  if (temApp) window.Android.cancelarLink();
  esconderStatus();
};

async function abrirDoApp(url, mime) {
  ocupado('Abrindo…', 0);
  let abriu = false;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('o arquivo não foi encontrado');
    abriu = await abrirBlob(await resp.blob(), mime);
  } catch (e) {
    ocupado(null);
    await aviso('Não consegui abrir: ' + e.message);
  }
  if (!est.fila) return;
  if (abriu) {
    atualizarBarraFila();
  } else { // GIF com defeito: marca como visto e segue para o próximo
    window.Android.marcarGifsVistos(est.fila.ids[est.fila.pos]);
    est.fila.pos++;
    abrirGifDaFila();
  }
}

// Chamadas que o Android faz na página
window.aoCarregando = (texto) => ocupado(texto, 0);
window.aoErro = (texto) => { ocupado(null); esconderStatus(); pararFila(); aviso(texto); };
window.aoReceberArquivo = (r) => { esconderStatus(); $('#barraFila').hidden = true; abrirDoApp(r.url, r.mime); };
window.aoReceberLink = (url) => {
  if (fecharDialogo) fecharDialogo(false);
  pararFila();
  fecharMidia();
  mostrar('inicio');
  baixarLink(url);
};
window.aoProgressoLink = (pct, texto) => mostrarStatus(`${texto} ${pct > 0 ? pct + '%' : ''}`, pct / 100);
window.aoBaixarLink = (r) => {
  esconderStatus();
  if (!r.ok) { aviso(r.erro); return; }
  $('#campoLink').value = '';
  abrirDoApp(r.url, r.mime);
};

function carregarColecao() {
  if (!temApp) return;
  let pacotes = [];
  try { pacotes = JSON.parse(window.Android.listar()); } catch (e) { console.error(e); }
  $('#colecao').hidden = pacotes.length === 0;
  const cont = $('#pacotes');
  cont.replaceChildren();
  for (const p of pacotes) {
    const bloco = el('div', 'pacote');
    const cab = el('div', 'cab-pacote');
    const n = p.figurinhas.length;
    cab.append(el('h3', '', p.nome));
    if (p.brinde) {
      cab.append(el('span', 'contagem', 'Brinde'));
    } else {
      const renomear = el('button', 'bt discreto', 'Renomear');
      renomear.type = 'button';
      renomear.onclick = () => renomearPacote(p);
      cab.append(renomear);
    }
    cab.append(el('span', 'contagem', `${n} de 30${p.noWhatsApp ? ' · no WhatsApp' : ''}`));
    bloco.append(cab);
    const enviar = (rotulo) => {
      const b = el('button', 'bt pequeno', rotulo);
      b.type = 'button';
      b.onclick = () => {
        est.ultimoPacote = { pacote: p.id, nome: p.nome, total: n };
        window.Android.adicionarAoWhatsApp(p.id);
      };
      bloco.append(b);
    };
    if (!p.noWhatsApp) {
      enviar('Adicionar ao WhatsApp');
    } else if (p.precisaAtualizar) {
      bloco.append(el('p', 'aviso-pacote', 'Tem figurinha nova que o WhatsApp ainda não pegou.'));
      enviar('Atualizar no WhatsApp');
    }
    const grade = el('div', 'grade');
    for (const f of p.figurinhas) {
      const b = el('button', 'miniatura');
      b.type = 'button';
      b.setAttribute('aria-label', 'Apagar esta figurinha');
      const img = el('img');
      img.src = f.url;
      img.alt = '';
      img.loading = 'lazy';
      b.append(img);
      b.onclick = async () => {
        if (await perguntar('Apagar esta figurinha? Ela sai também do WhatsApp.', 'Apagar')) {
          window.Android.apagar(p.id, f.arquivo);
          carregarColecao();
        }
      };
      grade.append(b);
    }
    bloco.append(grade);
    cont.append(bloco);
  }
}

// O Android instalou os pacotes de brinde depois que a tela abriu: mostra eles.
window.aoBrindeInstalado = () => carregarColecao();

async function renomearPacote(p) {
  const tipo = p.animado ? 'dos GIFs' : 'das figurinhas';
  const nome = await pedirTexto(`Novo nome para o pacote ${tipo}:`, p.nomeBase || p.nome);
  if (!nome || nome === p.nomeBase) return;
  const erro = window.Android.renomearPacote(p.animado, nome);
  if (erro) { aviso(erro); return; }
  carregarColecao();
  if (p.noWhatsApp) aviso(`Nome trocado. Para o WhatsApp mostrar "${nome}", toque em "Atualizar no WhatsApp".`);
}

/* ---------- início ---------- */

if (temApp) {
  try { $('#versao').textContent = 'Versão ' + window.Android.versao(); } catch { /* sem versão */ }
  carregarColecao();
  atualizarConvite();
  window.Android.pronto();
  // Voltou para o app (do WhatsApp, da galeria...): pode ter GIF novo ou pacote atualizado.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && est.tela === 'inicio') { carregarColecao(); atualizarConvite(); }
  });
}

// Para os testes automáticos no navegador do PC.
window.Fig = { est, abrirBlob, gerar, enquadrar, definirZoom, mostrar, FigWebP };
