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
        val animado: Boolean,
        var versao: Long,
        /** Última versão que o WhatsApp confirmou ter recebido (0 = nunca). */
        var versaoNoWhatsApp: Long,
        val figurinhas: MutableList<String>,
    ) {
        val nome get() = Creditos.nomeDoPacote(animado, id.substringAfterLast('-').toIntOrNull() ?: 1)
        val emoji get() = if (animado) "😂" else "🙂"
        val precisaAtualizar get() = versao != versaoNoWhatsApp

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
                o.getString("id"), o.getBoolean("animado"), o.getLong("versao"),
                o.optLong("versaoNoWhatsApp", 0), MutableList(figs.length()) { figs.getString(it) },
            )
        }
    }

    private fun gravar(ctx: Context, lista: List<Pacote>) {
        val arr = JSONArray()
        lista.forEach { p ->
            arr.put(
                JSONObject().put("id", p.id).put("animado", p.animado).put("versao", p.versao)
                    .put("versaoNoWhatsApp", p.versaoNoWhatsApp).put("figurinhas", JSONArray(p.figurinhas))
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
        File(dir, "$base.webp").writeBytes(Creditos.comExif(webp, p.id, p.nome, p.emoji))
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
        // A versão começa no relógio para nunca repetir a de um pacote apagado com o mesmo id.
        return Pacote("$prefixo-$n", animado, System.currentTimeMillis(), 0, mutableListOf())
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

    /** O WhatsApp confirmou que recebeu o pacote nesta versão. */
    fun marcarNoWhatsApp(ctx: Context, id: String) = synchronized(trava) {
        val lista = lerSemTrava(ctx)
        val p = lista.firstOrNull { it.id == id } ?: return@synchronized
        p.versaoNoWhatsApp = p.versao
        gravar(ctx, lista)
    }

    /**
     * Figurinhas feitas antes da assinatura do JV: grava o nome do pacote e o autor dentro delas.
     * Sobe a versão para o WhatsApp oferecer "Atualizar" (e trocar o nome antigo do pacote).
     */
    fun assinarAntigas(ctx: Context) = synchronized(trava) {
        val lista = lerSemTrava(ctx)
        var mudou = false
        for (p in lista) {
            var mudouPacote = false
            for (nome in p.figurinhas) {
                val arquivo = File(File(pasta(ctx), p.id), nome)
                if (!arquivo.exists()) continue
                val bytes = arquivo.readBytes()
                if (Creditos.temExif(bytes)) continue
                arquivo.writeBytes(Creditos.comExif(bytes, p.id, p.nome, p.emoji))
                mudouPacote = true
            }
            if (mudouPacote) {
                p.versao++
                mudou = true
            }
        }
        if (mudou) {
            gravar(ctx, lista)
            avisarWhatsApp(ctx)
        }
    }

    /** O README do WhatsApp pede para mudar o image_data_version a cada mudança; isto avisa quem estiver lendo. */
    private fun avisarWhatsApp(ctx: Context) {
        ctx.contentResolver.notifyChange(Uri.parse("content://${BuildConfig.AUTORIDADE}/metadata"), null)
    }
}
