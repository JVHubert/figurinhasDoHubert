# Figurinhas

App Android que transforma foto, GIF ou vídeo (da galeria ou de um link) em figurinha de WhatsApp, **sem borda branca**, com recorte e prévia.

**Baixar o APK:** https://github.com/JVHubert/figurinhas/releases/download/ultima/figurinhas.apk

**Página pública (link curto tinyurl.com/figsjv):** https://jvhubert.github.io/figurinhas/ ([docs/index.html](docs/index.html))

## Como funciona

- A tela é HTML/JS ([app/src/main/assets/web](app/src/main/assets/web)) dentro de um WebView. Lá acontece tudo da figurinha:
  - abrir a mídia;
  - enquadrar em 512×512;
  - escolher o trecho do vídeo ou GIF;
  - gerar o WebP com o encoder do próprio Chrome;
  - montar o WebP animado ([webp.js](app/src/main/assets/web/webp.js));
  - comprimir até caber nos limites do WhatsApp: estática até 100 KB, animada até 500 KB e 10 s.
- A parte Android (Kotlin) faz só o que o navegador não consegue:
  - [ProvedorFigurinhas.kt](app/src/main/java/io/github/jvhubert/figurinhas/ProvedorFigurinhas.kt): o WhatsApp lê os pacotes por ele, no mesmo formato do exemplo oficial [WhatsApp/stickers](https://github.com/WhatsApp/stickers/tree/main/Android).
  - [Pacotes.kt](app/src/main/java/io/github/jvhubert/figurinhas/Pacotes.kt): guarda as figurinhas em pacotes de até 30. Os pacotes de fotos e de animadas ficam separados. A cada mudança, sobe o `image_data_version`.
  - [Baixador.kt](app/src/main/java/io/github/jvhubert/figurinhas/Baixador.kt): baixa de links, nesta ordem:
    1. link direto;
    2. [yt-dlp](https://github.com/yt-dlp/yt-dlp), pelo [youtubedl-android](https://github.com/yausername/youtubedl-android), que se atualiza sozinho a cada 3 dias;
    3. a imagem ou o vídeo de capa da página (`og:image` / `og:video`).
  - [MainActivity.kt](app/src/main/java/io/github/jvhubert/figurinhas/MainActivity.kt): cuida da galeria, do menu "Compartilhar" e do botão "Adicionar ao WhatsApp".

## Compilar

O GitHub Actions compila a cada push na `main` ([apk.yml](.github/workflows/apk.yml)) e publica o APK no release `ultima`. O APK é assinado com a chave dos secrets `CHAVE_B64` e `CHAVE_SENHA`. A mesma chave precisa ser usada sempre; sem ela, o app não atualiza por cima.

## Testar o editor no PC

```
node teste/rodar.mjs <pasta-com-terra.gif>
```

O script abre o editor no Chrome sem janela e gera figurinhas de foto, vídeo e GIF em `teste/saida/`, com prints em largura de celular.
