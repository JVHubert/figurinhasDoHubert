'use strict';
/* Monta um WebP animado a partir de quadros WebP estáticos gerados pelo canvas.
   Formato do contêiner: developers.google.com/speed/webp/docs/riff_container
   RIFF 'WEBP' > VP8X (tamanho e flags) > ANIM (fundo e repetição) > ANMF por quadro (ALPH? + VP8/VP8L). */
const FigWebP = (() => {
  const txt = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

  function lerChunks(b) {
    if (b.length < 12 || txt(b, 0) !== 'RIFF' || txt(b, 8) !== 'WEBP') throw new Error('Não é um arquivo WebP');
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const lista = [];
    for (let p = 12; p + 8 <= b.length;) {
      const tam = dv.getUint32(p + 4, true);
      lista.push({ id: txt(b, p), dados: b.subarray(p + 8, p + 8 + tam) });
      p += 8 + tam + (tam & 1);
    }
    return lista;
  }

  function chunk(id, dados) {
    const out = new Uint8Array(8 + dados.length + (dados.length & 1));
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, dados.length, true);
    out.set(dados, 8);
    return out;
  }

  const u24 = (arr, pos, v) => { arr[pos] = v & 255; arr[pos + 1] = (v >> 8) & 255; arr[pos + 2] = (v >> 16) & 255; };
  const l24 = (arr, pos) => arr[pos] | (arr[pos + 1] << 8) | (arr[pos + 2] << 16);

  function juntar(partes) {
    const out = new Uint8Array(partes.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of partes) { out.set(p, o); o += p.length; }
    return out;
  }

  /** quadros: [{ bytes: Uint8Array (WebP estático), ms: duração }], todos do tamanho da figurinha. */
  function montar(quadros, largura, altura) {
    const vp8x = new Uint8Array(10);
    vp8x[0] = 0x10 | 0x02; // tem transparência + é animado
    u24(vp8x, 4, largura - 1);
    u24(vp8x, 7, altura - 1);
    const anim = new Uint8Array(6); // fundo transparente e repetição infinita (tudo zero)
    const partes = [chunk('VP8X', vp8x), chunk('ANIM', anim)];
    for (const q of quadros) {
      const imagem = lerChunks(q.bytes).filter((c) => c.id === 'ALPH' || c.id === 'VP8 ' || c.id === 'VP8L');
      if (!imagem.some((c) => c.id !== 'ALPH')) throw new Error('Quadro WebP sem imagem');
      const cab = new Uint8Array(16); // x e y ficam 0
      u24(cab, 6, largura - 1);
      u24(cab, 9, altura - 1);
      u24(cab, 12, Math.max(10, Math.round(q.ms)));
      cab[15] = 0x02; // substitui o quadro anterior (sem misturar), sem descarte
      partes.push(chunk('ANMF', juntar([cab, ...imagem.map((c) => chunk(c.id, c.dados))])));
    }
    const corpo = juntar(partes);
    const riff = new Uint8Array(12);
    riff.set([82, 73, 70, 70]); // RIFF
    new DataView(riff.buffer).setUint32(4, corpo.length + 4, true);
    riff.set([87, 69, 66, 80], 8); // WEBP
    return new Blob([riff, corpo], { type: 'image/webp' });
  }

  /** Para conferir um arquivo: tamanho, quadros e durações. */
  function info(b) {
    const cs = lerChunks(b);
    const vp8x = cs.find((c) => c.id === 'VP8X');
    const duracoes = cs.filter((c) => c.id === 'ANMF').map((c) => l24(c.dados, 12));
    return {
      animada: duracoes.length > 0,
      quadros: duracoes.length,
      duracoes,
      largura: vp8x ? l24(vp8x.dados, 4) + 1 : null,
      altura: vp8x ? l24(vp8x.dados, 7) + 1 : null,
    };
  }

  return { montar, info, lerChunks };
})();
