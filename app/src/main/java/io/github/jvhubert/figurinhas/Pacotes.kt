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
        /** Nome escolhido para o tipo de pacote (os seguintes ganham " 2", " 3"...). */
        val nomeBase: String,
        var versao: Long,
        /** Última versão que o WhatsApp confirmou ter recebido (0 = nunca). */
        var versaoNoWhatsApp: Long,
        val figurinhas: MutableList<String>,
        /** Pacote de brinde: nome fixo (não segue o "Renomear") e não recebe figurinhas novas. */
        val nomeFixo: String? = null,
        /** Brinde: emoji e texto de acessibilidade de cada figurinha (arquivo -> emoji, texto). */
        val info: MutableMap<String, Pair<String, String>> = mutableMapOf(),
    ) {
        val nome get() = nomeFixo
            ?: (nomeBase + (id.substringAfterLast('-').toIntOrNull()?.takeIf { it > 1 }?.let { " $it" } ?: ""))
        val brinde get() = nomeFixo != null
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

    private fun prefsNomes(ctx: Context) = ctx.getSharedPreferences("nomes", Context.MODE_PRIVATE)

    fun nomeBase(ctx: Context, animado: Boolean): String =
        prefsNomes(ctx).getString(if (animado) "animadas" else "fotos", null) ?: Creditos.nomePadrao(animado)

    fun ler(ctx: Context): List<Pacote> = synchronized(trava) { lerSemTrava(ctx) }

    private fun lerSemTrava(ctx: Context): MutableList<Pacote> {
        val arquivo = indice(ctx)
        if (!arquivo.exists()) return mutableListOf()
        val arr = JSONObject(arquivo.readText()).getJSONArray("pacotes")
        val nomes = mapOf(false to nomeBase(ctx, false), true to nomeBase(ctx, true))
        return MutableList(arr.length()) { i ->
            val o = arr.getJSONObject(i)
            val figs = o.getJSONArray("figurinhas")
            val animado = o.getBoolean("animado")
            val info = mutableMapOf<String, Pair<String, String>>()
            o.optJSONObject("info")?.let { inf ->
                inf.keys().forEach { k -> inf.getJSONObject(k).let { info[k] = it.getString("emoji") to it.getString("texto") } }
            }
            Pacote(
                o.getString("id"), animado, nomes.getValue(animado), o.getLong("versao"),
                o.optLong("versaoNoWhatsApp", 0), MutableList(figs.length()) { figs.getString(it) },
                o.optString("nomeFixo").ifEmpty { null }, info,
            )
        }
    }

    private fun gravar(ctx: Context, lista: List<Pacote>) {
        val arr = JSONArray()
        lista.forEach { p ->
            val o = JSONObject().put("id", p.id).put("animado", p.animado).put("versao", p.versao)
                .put("versaoNoWhatsApp", p.versaoNoWhatsApp).put("figurinhas", JSONArray(p.figurinhas))
            if (p.nomeFixo != null) o.put("nomeFixo", p.nomeFixo)
            if (p.info.isNotEmpty()) {
                val inf = JSONObject()
                p.info.forEach { (k, v) -> inf.put(k, JSONObject().put("emoji", v.first).put("texto", v.second)) }
                o.put("info", inf)
            }
            arr.put(o)
        }
        val tmp = File(pasta(ctx), "pacotes.json.tmp")
        tmp.writeText(JSONObject().put("pacotes", arr).toString())
        tmp.renameTo(indice(ctx))
    }

    fun adicionar(ctx: Context, webp: ByteArray, bandeja: ByteArray, animado: Boolean): Pacote = synchronized(trava) {
        val lista = lerSemTrava(ctx)
        val p = lista.lastOrNull { it.animado == animado && !it.brinde && it.figurinhas.size < MAX_POR_PACOTE }
            ?: novoPacote(ctx, lista, animado).also { lista.add(it) }
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

    private fun novoPacote(ctx: Context, lista: List<Pacote>, animado: Boolean): Pacote {
        check(lista.size < MAX_PACOTES) { "Já são $MAX_PACOTES pacotes cheios. Apague algumas figurinhas antes." }
        val prefixo = if (animado) "animadas" else "fotos"
        val n = (1..99).first { k -> lista.none { it.id == "$prefixo-$k" } }
        // A versão começa no relógio para nunca repetir a de um pacote apagado com o mesmo id.
        return Pacote("$prefixo-$n", animado, nomeBase(ctx, animado), System.currentTimeMillis(), 0, mutableListOf())
    }

    /**
     * Pacotes de brinde que vêm dentro do app (assets/brinde, gerados no PC por ferramentas/gerar-brinde.mjs).
     * Instala uma vez por versão do brinde: se a pessoa apagar um pacote, ele não volta.
     * true se instalou algo (a tela precisa recarregar a coleção).
     */
    fun instalarBrinde(ctx: Context): Boolean = synchronized(trava) {
        val prefs = ctx.getSharedPreferences("brinde", Context.MODE_PRIVATE)
        val indiceBrinde = try {
            JSONObject(ctx.assets.open("brinde/brinde.json").bufferedReader().use { it.readText() })
        } catch (_: Exception) {
            return@synchronized false
        }
        val versaoBrinde = indiceBrinde.getInt("versao")
        if (prefs.getInt("versao", 0) >= versaoBrinde) return@synchronized false

        val lista = lerSemTrava(ctx)
        var instalou = false
        val arr = indiceBrinde.getJSONArray("pacotes")
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val id = o.getString("id")
            if (lista.any { it.id == id } || lista.size >= MAX_PACOTES) continue
            val p = Pacote(id, true, nomeBase(ctx, true), System.currentTimeMillis(), 0, mutableListOf(), o.getString("nome"))
            val dir = File(pasta(ctx), id).apply { mkdirs() }
            val figs = o.getJSONArray("figurinhas")
            for (k in 0 until figs.length()) {
                val f = figs.getJSONObject(k)
                val arquivo = f.getString("arquivo")
                val miniatura = arquivo.removeSuffix(".webp") + ".png"
                val webp = ctx.assets.open("brinde/$id/$arquivo").use { it.readBytes() }
                File(dir, arquivo).writeBytes(Creditos.comExif(webp, p.id, p.nome, p.emoji))
                ctx.assets.open("brinde/$id/$miniatura").use { ent -> File(dir, miniatura).outputStream().use { ent.copyTo(it) } }
                p.figurinhas.add(arquivo)
                p.info[arquivo] = f.getString("emoji") to f.getString("texto")
            }
            lista.add(p)
            instalou = true
        }
        if (instalou) {
            gravar(ctx, lista)
            avisarWhatsApp(ctx)
        }
        prefs.edit().putInt("versao", versaoBrinde).commit()
        instalou
    }

    fun apagar(ctx: Context, id: String, arquivo: String) = synchronized(trava) {
        val lista = lerSemTrava(ctx)
        val p = lista.firstOrNull { it.id == id } ?: return@synchronized
        if (!p.figurinhas.remove(arquivo)) return@synchronized
        p.info.remove(arquivo)
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
     * Figurinhas sem assinatura (ou com nome antigo de pacote): grava o nome do pacote e o autor atuais.
     * Sobe a versão para o WhatsApp oferecer "Atualizar" (e trocar o nome antigo do pacote).
     */
    fun assinarAntigas(ctx: Context) = synchronized(trava) { assinarSemTrava(ctx) }

    /** Troca o nome dos pacotes de um tipo (fotos ou animadas) e regrava a assinatura das figurinhas. */
    fun renomear(ctx: Context, animado: Boolean, nome: String) = synchronized(trava) {
        val limpo = nome.trim().replace(Regex("\\s+"), " ").take(40)
        require(limpo.isNotEmpty()) { "O nome não pode ficar vazio." }
        prefsNomes(ctx).edit().putString(if (animado) "animadas" else "fotos", limpo).commit()
        assinarSemTrava(ctx)
    }

    private fun assinarSemTrava(ctx: Context) {
        val lista = lerSemTrava(ctx)
        var mudou = false
        for (p in lista) {
            var mudouPacote = false
            for (nome in p.figurinhas) {
                val arquivo = File(File(pasta(ctx), p.id), nome)
                if (!arquivo.exists()) continue
                val bytes = arquivo.readBytes()
                if (Creditos.assinaturaEmDia(bytes, p.id, p.nome, p.emoji)) continue
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
