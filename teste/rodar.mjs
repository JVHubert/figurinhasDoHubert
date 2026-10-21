// Testa o editor no Chrome sem janela: gera figurinhas de foto, vídeo e GIF, salva em teste/saida/
// e tira prints em largura de celular. Uso: node teste/rodar.mjs [pasta-com-terra.gif]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const aqui = dirname(fileURLToPath(import.meta.url));
const web = join(aqui, '..', 'app', 'src', 'main', 'assets', 'web');
const saida = join(aqui, 'saida');
const amostras = process.argv[2] || join(aqui, 'amostras');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
// PORTA=8790 node teste/rodar.mjs ... se a 8765 estiver ocupada por outro programa.
const PORTA = +(process.env.PORTA || 8765), DEPURACAO = 9333;
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.gif': 'image/gif',
  '.webp': 'image/webp', '.png': 'image/png' };

await rm(saida, { recursive: true, force: true });
await mkdir(saida, { recursive: true });

// servidor: / = editor, /amostras/ = arquivos de teste, /saida/ = resultados
const servidor = createServer(async (req, res) => {
  const caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [base, resto] = caminho.startsWith('/amostras/') ? [amostras, caminho.slice(10)]
    : caminho.startsWith('/saida/') ? [saida, caminho.slice(7)] : [web, caminho.slice(1) || 'index.html'];
  try {
    const dados = await readFile(join(base, resto));
    res.writeHead(200, { 'content-type': TIPOS[extname(resto)] || 'application/octet-stream' });
    res.end(dados);
  } catch { res.writeHead(404); res.end(); }
}).listen(PORTA);

const perfil = join(tmpdir(), 'figurinhas-teste-chrome');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEPURACAO}`, `--user-data-dir=${perfil}`,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--hide-scrollbars', 'about:blank']);

async function alvo() {
  for (let i = 0; i < 50; i++) {
    try {
      const lista = await (await fetch(`http://127.0.0.1:${DEPURACAO}/json/list`)).json();
      const p = lista.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* ainda abrindo */ }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  throw new Error('Chrome não abriu');
}

const ws = new WebSocket(await alvo());
await new Promise((ok) => ws.addEventListener('open', ok));
let seq = 0;
const esperando = new Map();
const eventos = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && esperando.has(d.id)) { esperando.get(d.id)(d); esperando.delete(d.id); }
  if (d.method === 'Runtime.consoleAPICalled' && process.env.DEBUG) console.log('  [página] ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  if (d.method === 'Runtime.consoleAPICalled') eventos.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  if (d.method === 'Runtime.exceptionThrown') eventos.push('EXCEÇÃO: ' + JSON.stringify(d.params.exceptionDetails).slice(0, 400));
  if (d.method === 'Page.loadEventFired' && esperando.has('load')) { esperando.get('load')(); esperando.delete('load'); }
});
const cdp = (method, params = {}) => new Promise((ok, erro) => {
  const id = ++seq;
  esperando.set(id, (d) => (d.error ? erro(new Error(method + ': ' + d.error.message)) : ok(d.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
async function avaliar(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function abrir(url) {
  const carregou = new Promise((ok) => esperando.set('load', ok));
  await cdp('Page.navigate', { url });
  await carregou;
}
async function print(nome) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(saida, nome + '.png'), Buffer.from(r.data, 'base64'));
}
async function printPaginaInteira(nome) {
  const { cssContentSize } = await cdp('Page.getLayoutMetrics');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: Math.ceil(cssContentSize.height), deviceScaleFactor: 2, mobile: true });
  await print(nome);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });

// Funções auxiliares dentro da página: fontes sintéticas e coleta do resultado.
const auxiliares = (process.env.DEBUG ? `
{ const orig = HTMLCanvasElement.prototype.toBlob; let n = 0;
  HTMLCanvasElement.prototype.toBlob = function (cb, tipo, q) { const id = ++n, t = performance.now();
    const vigia = setTimeout(() => console.log('toBlob ' + id + ' SEM RESPOSTA após 5 s', tipo, q), 5000);
    return orig.call(this, (b) => { clearTimeout(vigia); if (performance.now() - t > 300) console.log('toBlob ' + id + ' lento', Math.round(performance.now() - t), 'ms'); cb(b); }, tipo, q); };
  setInterval(() => console.log('toBlob chamados: ' + n), 10000); }` : '') + `
window.T = {
  async foto() { // "foto" com ruído: difícil de comprimir, testa o limite de 100 KB
    const c = new OffscreenCanvas(1600, 1200), x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1600, 1200); g.addColorStop(0, '#f4a261'); g.addColorStop(1, '#264653');
    x.fillStyle = g; x.fillRect(0, 0, 1600, 1200);
    for (let i = 0; i < 60; i++) { x.fillStyle = 'hsl(' + (i * 37 % 360) + ',70%,55%)'; x.beginPath(); x.arc((i * 263) % 1600, (i * 151) % 1200, 40 + i % 90, 0, 7); x.fill(); }
    const d = x.getImageData(0, 0, 1600, 1200); for (let i = 0; i < d.data.length; i += 4) { const r = (Math.random() - .5) * 60; d.data[i] += r; d.data[i+1] += r; d.data[i+2] += r; }
    x.putImageData(d, 0, 0);
    x.fillStyle = '#fff'; x.font = 'bold 160px sans-serif'; x.fillText('Oi JV!', 480, 650);
    return c.convertToBlob({ type: 'image/png' });
  },
  async video(seg, ruido) { // grava um vídeo webm de um canvas animado
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 4e6 });
    const partes = []; rec.ondataavailable = (e) => partes.push(e.data);
    const t0 = performance.now(); let raf;
    const passo = () => { const t = (performance.now() - t0) / 1000;
      x.fillStyle = '#123'; x.fillRect(0, 0, 640, 360);
      x.fillStyle = '#e76f51'; x.beginPath(); x.arc(320 + 220 * Math.sin(t * 2), 180 + 90 * Math.cos(t * 3), 60, 0, 7); x.fill();
      x.fillStyle = '#fff'; x.font = 'bold 48px sans-serif'; x.fillText(t.toFixed(1) + ' s', 30, 70);
      if (ruido) for (let i = 0; i < 4000; i++) { x.fillStyle = Math.random() < .5 ? '#000' : '#fff'; x.fillRect(Math.random() * 640, Math.random() * 360, 3, 3); }
      raf = requestAnimationFrame(passo); };
    passo(); rec.start(250);
    await new Promise((ok) => setTimeout(ok, seg * 1000));
    rec.stop(); cancelAnimationFrame(raf);
    await new Promise((ok) => rec.onstop = ok);
    return new Blob(partes, { type: 'video/webm' });
  },
  async resultado() {
    const r = Fig.est.resultado;
    const bytes = new Uint8Array(await r.blob.arrayBuffer());
    let b64 = ''; for (let i = 0; i < bytes.length; i += 32768) b64 += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const dec = new ImageDecoder({ data: bytes, type: 'image/webp' }); await dec.tracks.ready; await dec.completed;
    const q = await dec.decode({ frameIndex: 0 });
    const out = { tamanho: bytes.length, animada: r.animada, info: r.info, b64: btoa(b64),
      quadrosChrome: dec.tracks.selectedTrack.frameCount, larguraChrome: q.image.displayWidth, alturaChrome: q.image.displayHeight,
      riff: FigWebP.info(bytes), bandejaKB: r.bandeja.size / 1000 };
    q.image.close(); dec.close(); return out;
  },
  erroVisivel() { return document.querySelector('#dialogo').hidden ? null : document.querySelector('#dialogoTexto').textContent; },
};`;

const SO = process.env.SO; // roda só um cenário: SO=video-ruido-10s node teste/rodar.mjs
async function cenario(nome, preparo, ajuste = '') {
  if (SO && SO !== nome) return { nome, pulado: true };
  const inicio = Date.now();
  console.log('>> ' + nome);
  await avaliar(`(async () => { ${preparo} })()`);
  const erroAbrir = await avaliar('T.erroVisivel()');
  if (erroAbrir) return { nome, erro: erroAbrir };
  await avaliar(`(async () => { ${ajuste} })()`);
  await new Promise((ok) => setTimeout(ok, 400));
  await print(nome + '-editor');
  // gerar() espera o "Entendi" quando dá erro: então espera ele terminar OU um aviso aparecer.
  await avaliar(`(async () => { let fim = false; Fig.gerar().then(() => { fim = true; });
    while (!fim && !T.erroVisivel()) await new Promise((ok) => setTimeout(ok, 100)); })()`);
  const erro = await avaliar('T.erroVisivel()');
  if (erro) {
    await avaliar(`document.querySelector('#dialogoSim').click()`);
    console.log('<< ' + nome + ' (aviso) ' + (Date.now() - inicio) / 1000 + ' s');
    return { nome, segundos: (Date.now() - inicio) / 1000, aviso: erro };
  }
  const r = await avaliar('T.resultado()');
  await writeFile(join(saida, nome + '.webp'), Buffer.from(r.b64, 'base64'));
  await new Promise((ok) => setTimeout(ok, 300));
  await printPaginaInteira(nome + '-previa');
  delete r.b64;
  console.log('<< ' + nome + ' ' + (Date.now() - inicio) / 1000 + ' s');
  r.riff.duracoes = r.riff.duracoes.length ? `${r.riff.duracoes.length} quadros, soma ${r.riff.duracoes.reduce((a, b) => a + b, 0)} ms, min ${Math.min(...r.riff.duracoes)} ms` : '-';
  return { nome, segundos: (Date.now() - inicio) / 1000, ...r };
}

const resultados = [];
try {
  await abrir(`http://127.0.0.1:${PORTA}/index.html`);
  await avaliar(auxiliares);
  await print('inicio-navegador');

  resultados.push(await cenario('foto', `await Fig.abrirBlob(await T.foto(), 'image/png')`, `Fig.enquadrar('preencher')`));
  resultados.push(await cenario('foto-cantos', `Fig.mostrar('inicio'); await Fig.abrirBlob(await T.foto(), 'image/png')`,
    `document.querySelector('#cantos').click()`));
  resultados.push(await cenario('video', `Fig.mostrar('inicio'); await Fig.abrirBlob(await T.video(5, false), 'video/webm')`,
    `Fig.enquadrar('preencher'); const d = document.querySelector('#duracao'); d.value = 4; d.dispatchEvent(new Event('input'))`));
  resultados.push(await cenario('video-ruido-10s', `document.querySelector('#cantos').click(); Fig.mostrar('inicio'); await Fig.abrirBlob(await T.video(11, true), 'video/webm')`,
    `Fig.enquadrar('preencher'); const d = document.querySelector('#duracao'); d.value = 10; d.dispatchEvent(new Event('input'))`));
  resultados.push(await cenario('video-10s', `document.querySelector('#cantos').checked = false; Fig.mostrar('inicio'); await Fig.abrirBlob(await T.video(11, false), 'video/webm')`,
    `Fig.enquadrar('inteira'); const d = document.querySelector('#duracao'); d.value = 10; d.dispatchEvent(new Event('input'))`));
  if (existsSync(join(amostras, 'terra.gif'))) {
    resultados.push(await cenario('gif', `Fig.mostrar('inicio'); await Fig.abrirBlob(await (await fetch('/amostras/terra.gif')).blob())`));
  }

  // "Começa em" num GIF curto: o começo precisa andar mesmo com a duração no máximo.
  if (existsSync(join(amostras, 'terra.gif'))) {
    await avaliar(`(async () => { Fig.mostrar('inicio'); await Fig.abrirBlob(await (await fetch('/amostras/terra.gif')).blob()); })()`);
    // Arrasta o controle de verdade (mouse), como o dedo faria, de 0 até 80% da largura.
    const antes = await avaliar(`(() => { const i = document.querySelector('#comeco'); i.scrollIntoView({ block: 'center' });
      const r = i.getBoundingClientRect(); return { max: i.max, dur: Fig.est.dur, total: Fig.est.midia.duracao, x: r.left, y: r.top + r.height / 2, w: r.width }; })()`);
    const mouse = (type, x) => cdp('Input.dispatchMouseEvent', { type, x, y: antes.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await mouse('mousePressed', antes.x + 8);
    for (let k = 1; k <= 10; k++) await mouse('mouseMoved', antes.x + 8 + (antes.w * 0.8 - 8) * k / 10);
    await mouse('mouseReleased', antes.x + antes.w * 0.8);
    resultados.push({ nome: 'comeca-em', antes, depois: await avaliar(`({ inicio: Fig.est.inicio, dur: Fig.est.dur,
      txt: document.querySelector('#txtInicio').textContent + ' / ' + document.querySelector('#txtDur').textContent })`) });
  }

  // Tela inicial com coleção, convite de GIFs e fluxo "Adicionar/Atualizar" com um Android de mentira.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.vistos = [];
    window.Android = {
      versao: () => '1.0.teste', pronto() {}, escolherDaGaleria() {}, baixarLink() {}, cancelarLink() {},
      listar: () => JSON.stringify([
        { id: 'fotos-1', nome: 'Figurinhas do Hubert', nomeBase: 'Figurinhas do Hubert', animado: false, noWhatsApp: true, precisaAtualizar: false,
          figurinhas: ['foto', 'foto-cantos', 'foto', 'foto-cantos', 'foto'].map((n, i) => ({ arquivo: 'f' + i, url: '/saida/' + n + '.webp' })) },
        { id: 'animadas-1', nome: 'Gifs do Hubert', nomeBase: 'Gifs do Hubert', animado: true, noWhatsApp: true, precisaAtualizar: true,
          figurinhas: ['video', 'gif'].map((n, i) => ({ arquivo: 'a' + i, url: '/saida/' + n + '.webp' })) } ]),
      gifsDaGaleria: () => JSON.stringify({ permissao: true, gifs: [{ id: 'i1', visto: false }, { id: 'i2', visto: false }, { id: 'i3', visto: true }] }),
      renomearPacote(animado, nome) { window.renomeado = [animado, nome]; return ''; },
      abrirGif() { setTimeout(() => window.aoReceberArquivo({ url: '/amostras/terra.gif', mime: 'image/gif' }), 50); },
      marcarGifsVistos(ids) { window.vistos.push(ids); },
      salvarFigurinha: () => JSON.stringify({ ok: true, pacote: 'animadas-1', nome: 'Animadas do JV', total: 3, temWhatsApp: true }),
      adicionarAoWhatsApp() { setTimeout(() => window.aoAdicionar({ ok: false, erro: '', atualizacao: true }), 300); },
      apagar() {},
    };` });
  await abrir(`http://127.0.0.1:${PORTA}/index.html`);
  await avaliar(auxiliares);
  await new Promise((ok) => setTimeout(ok, 800));
  await printPaginaInteira('inicio-app');
  const botaoTodos = await avaliar(`document.querySelector('#btTodosGifs').hidden ? 'escondido' : document.querySelector('#btTodosGifs').textContent`);
  // Renomear o pacote de GIFs
  await avaliar(`document.querySelectorAll('.cab-pacote .bt')[1].click()`);
  await new Promise((ok) => setTimeout(ok, 200));
  await print('renomear');
  await avaliar(`(() => { document.querySelector('#dialogoCampo').value = 'Memes da família'; document.querySelector('#dialogoSim').click(); })()`);
  await new Promise((ok) => setTimeout(ok, 200));
  const renomeado = await avaliar('window.renomeado');
  await avaliar(`document.querySelector('#dialogoSim').click()`);
  await avaliar(`document.querySelector('#btConvite').click()`);
  await new Promise((ok) => setTimeout(ok, 2500));
  await print('fila-editor');
  const barra = await avaliar(`document.querySelector('#barraFila').hidden ? 'escondida' : document.querySelector('#filaTexto').textContent + ' / anterior desligado: ' + document.querySelector('#btAnterior').disabled`);
  await avaliar(`document.querySelector('#btPular').click()`);
  await new Promise((ok) => setTimeout(ok, 2500));
  const barra2 = await avaliar(`document.querySelector('#filaTexto').textContent + ' / anterior desligado: ' + document.querySelector('#btAnterior').disabled`);
  await avaliar(`document.querySelector('#btAnterior').click()`);
  await new Promise((ok) => setTimeout(ok, 2500));
  const barra3 = await avaliar(`document.querySelector('#filaTexto').textContent`);
  await avaliar('Fig.gerar()');
  await avaliar(`document.querySelector('#btAdicionar').click()`);
  await new Promise((ok) => setTimeout(ok, 1500));
  await printPaginaInteira('fila-concluido');
  resultados.push({ nome: 'fila-e-atualizar', botaoTodos, renomeado, barra, barra2, barra3, vistos: await avaliar('window.vistos'),
    proximo: await avaliar(`document.querySelector('#btProximo').hidden ? 'escondido' : document.querySelector('#btProximo').textContent`),
    telaFinal: await avaliar(`document.querySelector('#feitoTexto').textContent`) });
} catch (e) {
  resultados.push({ erroGeral: e.message });
} finally {
  console.log(JSON.stringify(resultados, null, 1));
  if (eventos.length) console.log('Console da página:\n' + eventos.slice(0, 30).join('\n'));
  ws.close();
  chrome.kill();
  servidor.close();
}
