package io.github.jvhubert.figurinhas

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Guarda as figurinhas em pacotes que o WhatsApp lê pelo [ProvedorFigurinhas].
 * Regras do WhatsApp: de 3 a 30 figurinhas por pacote, sem misturar estáticas e animadas,
 * e no máximo 10 pacotes por app.
 */
object Pacotes {
    const val MAX_POR_PACOTE = 30
    private const val MAX_PACOTES = 10
    private const val MIN_WHATSAPP = 3
    private val trava = Any()

    class Pacote(
        val id: String,
        val nome: String,
        val animado: Boolean,
        var versao: Long,
        val figurinhas: MutableList<String>,
    ) {
        /** Enquanto o pacote tem menos de 3, repete as que existem (o WhatsApp recusa pacote menor). */
        fun listaParaWhatsApp(): List<String> {
            val lista = figurinhas.toMutableList()
            var i = 0
            while (lista.size < MIN_WHATSAPP && figurinhas.isNotEmpty()) {
                lista.add("rep${lista.size}-" + figurinhas[i++ % figurinhas.size])
            }
            return lista
        }

        /** Ícone da bandeja: a miniatura da primeira figurinha. */
        fun bandeja() = figurinhas.first().removeSuffix(".webp") + ".png"
    }

    fun arquivoReal(nome: String) = nome.replace(Regex("^rep\\d+-"), "")

    fun pasta(ctx: Context) = File(ctx.filesDir, "figurinhas").apply { mkdirs() }

    private fun indice(ctx: Context) = File(pasta(ctx), "pacotes.json")

    fun ler(ctx: Context): List<Pacote> = synchronized(trava) { lerSemTrava(ctx) }

    private fun lerSemTrava(ctx: Context): MutableList<Pacote> {
        val arquivo = indice(ctx)
        if (!arquivo.exists()) return mutableListOf()
        val arr = JSONObject(arquivo.readText()).getJSONArray("pacotes")
        return MutableList(arr.length()) { i ->
            val o = arr.getJSONObject(i)
            val figs = o.getJSONArray("figurinhas")
            Pacote(
                o.getString("id"), o.getString("nome"), o.getBoolean("animado"), o.getLong("versao"),
                MutableList(figs.length()) { figs.getString(it) },
            )
        }
    }

    private fun gravar(ctx: Context, lista: List<Pacote>) {
        val arr = JSONArray()
        lista.forEach { p ->
            arr.put(
                JSONObject().put("id", p.id).put("nome", p.nome).put("animado", p.animado)
                    .put("versao", p.versao).put("figurinhas", JSONArray(p.figurinhas))
            )
        }
        val tmp = File(pasta(ctx), "pacotes.json.tmp")
        tmp.writeText(JSONObject().put("pacotes", arr).toString())
        tmp.renameTo(indice(ctx))
    }

    fun adicionar(ctx: Context, webp: ByteArray, bandeja: ByteArray, animado: Boolean): Pacote = synchronized(trava) {
        val lista = lerSemTrava(ctx)
        val p = lista.lastOrNull { it.animado == animado && it.figurinhas.size < MAX_POR_PACOTE }
            ?: novoPacote(lista, animado).also { lista.add(it) }
        val base = "f${System.currentTimeMillis()}"
        val dir = File(pasta(ctx), p.id).apply { mkdirs() }
        File(dir, "$base.webp").writeBytes(webp)
        File(dir, "$base.png").writeBytes(bandeja)
        p.figurinhas.add("$base.webp")
        p.versao++
        gravar(ctx, lista)
        avisarWhatsApp(ctx)
        p
    }

    private fun novoPacote(lista: List<Pacote>, animado: Boolean): Pacote {
        check(lista.size < MAX_PACOTES) { "Já são $MAX_PACOTES pacotes cheios. Apague algumas figurinhas antes." }
        val prefixo = if (animado) "animadas" else "fotos"
        val n = (1..99).first { k -> lista.none { it.id == "$prefixo-$k" } }
        val nome = (if (animado) "Minhas animadas" else "Minhas figurinhas") + if (n > 1) " $n" else ""
        // A versão começa no relógio para nunca repetir a de um pacote apagado com o mesmo id.
        return Pacote("$prefixo-$n", nome, animado, System.currentTimeMillis(), mutableListOf())
    }

    fun apagar(ctx: Context, id: String, arquivo: String) = synchronized(trava) {
        val lista = lerSemTrava(ctx)
        val p = lista.firstOrNull { it.id == id } ?: return@synchronized
        if (!p.figurinhas.remove(arquivo)) return@synchronized
        val dir = File(pasta(ctx), p.id)
        File(dir, arquivo).delete()
        File(dir, arquivo.removeSuffix(".webp") + ".png").delete()
        if (p.figurinhas.isEmpty()) {
            lista.remove(p)
            dir.deleteRecursively()
        } else {
            p.versao++
        }
        gravar(ctx, lista)
        avisarWhatsApp(ctx)
    }

    /** O README do WhatsApp pede para mudar o image_data_version a cada mudança; isto avisa quem estiver lendo. */
    private fun avisarWhatsApp(ctx: Context) {
        ctx.contentResolver.notifyChange(Uri.parse("content://${BuildConfig.AUTORIDADE}/metadata"), null)
    }
}
