package io.github.jvhubert.figurinhas

import android.content.Context
import android.util.Log
import android.webkit.MimeTypeMap
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Baixa o arquivo de um link, nesta ordem:
 * 1. link direto de imagem ou vídeo (GIF, MP4, JPG...);
 * 2. yt-dlp (YouTube, Instagram, TikTok, X e centenas de sites);
 * 3. a imagem ou o vídeo de capa da página (og:video / og:image).
 */
class Baixador(private val ctx: Context) {
    private val fila = Executors.newSingleThreadExecutor()
    private val prefs = ctx.getSharedPreferences("baixador", Context.MODE_PRIVATE)
    @Volatile private var pronto = false
    @Volatile private var cancelado = false
    @Volatile private var processo: String? = null

    private class Direto(val arquivo: File?, val mime: String, val html: String?)

    /** Prepara o Python do yt-dlp e atualiza o yt-dlp a cada 3 dias (os sites mudam muito). */
    fun preparar() = fila.execute {
        try {
            YoutubeDL.init(ctx)
            pronto = true
            if (System.currentTimeMillis() - prefs.getLong("atualizado", 0) > 3 * DIA) atualizar()
        } catch (e: Exception) {
            Log.e(TAG, "yt-dlp não iniciou", e)
        }
    }

    private fun atualizar() {
        try {
            YoutubeDL.updateYoutubeDL(ctx, YoutubeDL.UpdateChannel.STABLE)
            prefs.edit().putLong("atualizado", System.currentTimeMillis()).apply()
        } catch (e: Exception) {
            Log.w(TAG, "não atualizou o yt-dlp", e)
        }
    }

    fun cancelar() {
        cancelado = true
        processo?.let { YoutubeDL.destroyProcessById(it) }
    }

    fun baixar(url: String, progresso: (Int, String) -> Unit, fim: (String) -> Unit) = fila.execute {
        cancelado = false
        val resposta = try {
            val (arquivo, mime) = obter(url, progresso)
            JSONObject().put("ok", true).put("url", "/midia/${arquivo.name}").put("mime", mime)
        } catch (e: Exception) {
            Log.w(TAG, "falhou: $url", e)
            JSONObject().put("ok", false).put("erro", e.message ?: "Não consegui baixar desse link.")
        }
        if (!cancelado) fim(resposta.toString())
    }

    private fun pasta() = File(ctx.cacheDir, "midia").apply { mkdirs() }

    private fun obter(url: String, progresso: (Int, String) -> Unit): Pair<File, String> {
        pasta().listFiles()?.forEach { it.delete() }
        progresso(0, "Abrindo o link…")
        val d = direto(url, progresso)
        d.arquivo?.let { return it to d.mime }

        var erro: Exception? = null
        if (pronto && !cancelado) {
            try {
                return ytdlp(url, progresso)
            } catch (e: Exception) {
                erro = e
            }
            // Site mudou? Atualiza o yt-dlp (no máximo 1 vez por hora) e tenta de novo.
            if (!cancelado && System.currentTimeMillis() - prefs.getLong("atualizado", 0) > HORA) {
                progresso(0, "Atualizando o baixador…")
                atualizar()
                try {
                    return ytdlp(url, progresso)
                } catch (e: Exception) {
                    erro = e
                }
            }
        }
        check(!cancelado) { "Cancelado." }

        val capa = d.html?.let { capaDaPagina(it, url) }
        if (capa != null) {
            val d2 = direto(capa, progresso)
            d2.arquivo?.let { return it to d2.mime }
        }
        throw Exception(mensagem(erro))
    }

    private fun abrir(endereco: String) = (URL(endereco).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15_000
        readTimeout = 30_000
        instanceFollowRedirects = true
        setRequestProperty("User-Agent", NAVEGADOR)
        setRequestProperty("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8")
    }

    private fun direto(endereco: String, progresso: (Int, String) -> Unit): Direto = try {
        var con = abrir(endereco)
        // O HttpURLConnection não segue redirecionamento de http para https sozinho.
        var saltos = 0
        while (con.responseCode in 300..399 && saltos++ < 5) {
            val proximo = con.getHeaderField("Location") ?: break
            val atual = con.url
            con.disconnect()
            con = abrir(URL(atual, proximo).toString())
        }
        try {
            val mime = (con.contentType ?: "").substringBefore(';').trim().lowercase()
            when {
                con.responseCode !in 200..299 -> Direto(null, "", null)
                mime.startsWith("image/") || mime.startsWith("video/") -> {
                    val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "bin"
                    val arquivo = File(pasta(), "link-${System.currentTimeMillis()}.$ext")
                    con.inputStream.use { ent ->
                        arquivo.outputStream().use { sai -> copiar(ent, sai, con.contentLengthLong, progresso) }
                    }
                    Direto(arquivo, mime, null)
                }
                mime.contains("html") -> Direto(null, mime, con.inputStream.use { lerTexto(it, 2_000_000) })
                else -> Direto(null, mime, null)
            }
        } finally {
            con.disconnect()
        }
    } catch (e: Exception) {
        if (cancelado) throw e
        Log.w(TAG, "download direto falhou: $endereco", e)
        Direto(null, "", null)
    }

    private fun ytdlp(url: String, progresso: (Int, String) -> Unit): Pair<File, String> {
        val marca = "link-${System.currentTimeMillis()}"
        val req = YoutubeDLRequest(url)
            .addOption("-o", File(pasta(), "$marca.%(ext)s").absolutePath)
            .addOption("--no-playlist")
            .addOption("--playlist-items", "1")
            // Sem ffmpeg no app: pega um arquivo único (sem juntar áudio), evitando m3u8 (.ts não abre no WebView).
            .addOption("-f", "bv*[protocol!*=m3u8]/b[protocol!*=m3u8]/bv*/b")
            // Figurinha é 512×512: 480p em H.264 basta e baixa rápido.
            .addOption("-S", "res:480,vcodec:h264")
            .addOption("--max-filesize", "200M")
            .addOption("--no-part")
            .addOption("--no-mtime")
        processo = marca
        try {
            progresso(0, "Baixando…")
            YoutubeDL.execute(req, marca, false) { pct, _, _ ->
                progresso(pct.toInt().coerceIn(0, 100), "Baixando…")
            }
        } finally {
            processo = null
        }
        val arquivo = pasta().listFiles { a -> a.name.startsWith(marca) }?.maxByOrNull { it.length() }
            ?: throw Exception("O download terminou sem arquivo.")
        val ext = arquivo.extension.lowercase()
        return arquivo to (MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "")
    }

    private fun copiar(ent: InputStream, sai: OutputStream, total: Long, progresso: (Int, String) -> Unit) {
        val buf = ByteArray(64 * 1024)
        var lidos = 0L
        var ultimo = -1
        while (true) {
            check(!cancelado) { "Cancelado." }
            val n = ent.read(buf)
            if (n < 0) break
            sai.write(buf, 0, n)
            lidos += n
            check(lidos <= LIMITE) { "O arquivo é grande demais (mais de 200 MB)." }
            if (total > 0) {
                val p = (lidos * 100 / total).toInt()
                if (p != ultimo) {
                    ultimo = p
                    progresso(p, "Baixando…")
                }
            }
        }
    }

    private fun lerTexto(ent: InputStream, max: Int): String {
        val sai = java.io.ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (sai.size() < max) {
            val n = ent.read(buf)
            if (n < 0) break
            sai.write(buf, 0, n)
        }
        return sai.toString("UTF-8")
    }

    /** Procura og:video / og:image na página (Giphy, Tenor, Pinterest e muitos outros têm). */
    private fun capaDaPagina(html: String, base: String): String? {
        val metas = Regex("<meta\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(html).map { it.value }.toList()
        fun atributo(tag: String, nome: String) =
            Regex("\\b$nome\\s*=\\s*[\"']([^\"']*)[\"']", RegexOption.IGNORE_CASE).find(tag)?.groupValues?.get(1)

        val valores = metas.mapNotNull { tag ->
            val chave = (atributo(tag, "property") ?: atributo(tag, "name"))?.lowercase() ?: return@mapNotNull null
            val conteudo = atributo(tag, "content") ?: return@mapNotNull null
            chave to conteudo.replace("&amp;", "&")
        }.toMap()
        val preferidos = listOf(
            "og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream",
            "og:image:secure_url", "og:image", "twitter:image",
        )
        val achado = preferidos.firstNotNullOfOrNull { valores[it]?.takeIf { v -> v.isNotBlank() } } ?: return null
        return try {
            URL(URL(base), achado).toString()
        } catch (_: Exception) {
            null
        }
    }

    private fun mensagem(e: Exception?): String {
        val t = e?.message ?: ""
        return when {
            Regex("login|log in|sign in|private|cookies|rate.?limit", RegexOption.IGNORE_CASE).containsMatchIn(t) ->
                "Esse post pede login ou é privado. Salve o vídeo no celular e compartilhe o arquivo com o app."
            t.contains("Unsupported URL", true) ->
                "Esse site não é suportado. Tente o link direto do GIF ou do vídeo."
            t.contains("larger than max-filesize", true) ->
                "O vídeo é grande demais. Escolha um vídeo mais curto."
            else -> {
                val detalhe = t.lines().lastOrNull { it.isNotBlank() }?.take(160)
                "Não consegui baixar desse link." + (detalhe?.let { "\n($it)" } ?: "")
            }
        }
    }

    companion object {
        private const val TAG = "Figurinhas"
        private const val HORA = 60 * 60 * 1000L
        private const val DIA = 24 * HORA
        private const val LIMITE = 200L * 1024 * 1024
        private const val NAVEGADOR =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"
    }
}
