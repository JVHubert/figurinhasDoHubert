package io.github.jvhubert.figurinhas

import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/** O que a tela (HTML/JS) pode pedir ao Android, como window.Android.xxx(). */
class Ponte(private val a: MainActivity) {

    @JavascriptInterface
    fun pronto() = a.paginaCarregou()

    @JavascriptInterface
    fun versao(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun escolherDaGaleria() = a.escolherDaGaleria()

    @JavascriptInterface
    fun baixarLink(url: String) = a.baixarLink(url)

    @JavascriptInterface
    fun cancelarLink() = a.cancelarLink()

    @JavascriptInterface
    fun salvarFigurinha(webp: String, bandeja: String, animada: Boolean): String = try {
        val p = Pacotes.adicionar(
            a, Base64.decode(webp, Base64.DEFAULT), Base64.decode(bandeja, Base64.DEFAULT), animada,
        )
        JSONObject().put("ok", true).put("pacote", p.id).put("nome", p.nome)
            .put("total", p.figurinhas.size)
            .put("temWhatsApp", WhatsApp.algumInstalado(a))
            .toString()
    } catch (e: Exception) {
        JSONObject().put("ok", false).put("erro", e.message ?: "Não consegui salvar a figurinha.").toString()
    }

    @JavascriptInterface
    fun adicionarAoWhatsApp(id: String) {
        Pacotes.ler(a).firstOrNull { it.id == id }?.let { a.abrirWhatsApp(it) }
    }

    @JavascriptInterface
    fun listar(): String {
        val lista = JSONArray()
        for (p in Pacotes.ler(a)) {
            val figs = JSONArray()
            p.figurinhas.forEach { figs.put(JSONObject().put("arquivo", it).put("url", "/figurinhas/${p.id}/$it")) }
            lista.put(
                JSONObject().put("id", p.id).put("nome", p.nome).put("animado", p.animado)
                    .put("figurinhas", figs).put("noWhatsApp", WhatsApp.adicionado(a, p.id))
                    .put("precisaAtualizar", p.precisaAtualizar)
            )
        }
        return lista.toString()
    }

    @JavascriptInterface
    fun apagar(id: String, arquivo: String) = Pacotes.apagar(a, id, arquivo)

    /** GIFs novos da galeria: {"permissao": bool, "gifs": ["i12", "v34", ...]}. */
    @JavascriptInterface
    fun gifsDaGaleria(): String {
        val json = JSONObject().put("permissao", Galeria.temPermissao(a))
        if (Galeria.temPermissao(a)) {
            val lista = try { Galeria.novos(a) } catch (_: Exception) { emptyList() }
            json.put("gifs", JSONArray(lista.map { it.id }))
        }
        return json.toString()
    }

    @JavascriptInterface
    fun pedirPermissaoGaleria() = a.pedirPermissaoGaleria()

    @JavascriptInterface
    fun abrirGif(id: String) = a.abrirGif(id)

    /** ids separados por vírgula: não oferecer de novo. */
    @JavascriptInterface
    fun marcarGifsVistos(ids: String) = Galeria.marcarVistos(a, ids.split(',').filter { it.isNotBlank() })
}
