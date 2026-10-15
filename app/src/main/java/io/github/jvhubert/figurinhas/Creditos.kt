package io.github.jvhubert.figurinhas

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/** Assinatura do Hubert (JV) nos pacotes e dentro de cada figurinha (quem recebe vê ao tocar nela). */
object Creditos {
    const val AUTOR = "Hubert"
    const val LINK_CURTO = "tinyurl.com/figsjv"
    const val SITE = "https://jvhubert.github.io/figurinhas/"
    const val PUBLICADOR = "$AUTOR · faça as suas: $LINK_CURTO"

    fun nomeDoPacote(animado: Boolean, n: Int) =
        (if (animado) "Gifs do $AUTOR" else "Figurinhas do $AUTOR") + if (n > 1) " $n" else ""

    /**
     * Grava no WebP o bloco EXIF que o WhatsApp lê (nome do pacote e autor), no mesmo formato
     * usado pelas figurinhas que circulam no WhatsApp: TIFF com a etiqueta 0x5741 contendo um JSON.
     */
    fun comExif(webp: ByteArray, idPacote: String, nomePacote: String, emoji: String): ByteArray =
        trocarExif(webp, exif(idPacote, nomePacote, emoji))

    /** true se a figurinha já tem exatamente a assinatura atual (nome do pacote e autor de agora). */
    fun assinaturaEmDia(webp: ByteArray, idPacote: String, nomePacote: String, emoji: String): Boolean {
        val atual = lerChunks(webp).firstOrNull { it.first == "EXIF" }?.second ?: return false
        return atual.contentEquals(exif(idPacote, nomePacote, emoji))
    }

    private fun exif(idPacote: String, nomePacote: String, emoji: String): ByteArray {
        val json = JSONObject()
            .put("sticker-pack-id", "${BuildConfig.AUTORIDADE}.$idPacote")
            .put("sticker-pack-name", nomePacote)
            .put("sticker-pack-publisher", PUBLICADOR)
            .put("emojis", JSONArray().put(emoji))
            .toString().toByteArray(Charsets.UTF_8)
        val cab = byteArrayOf(
            0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF little-endian, IFD no byte 8
            0x01, 0x00, // 1 etiqueta
            0x41, 0x57, 0x07, 0x00, // etiqueta 0x5741, tipo "indefinido"
            0, 0, 0, 0, // tamanho do JSON (preenchido abaixo)
            0x16, 0x00, 0x00, 0x00, // o JSON começa no byte 22
        )
        escrever32(cab, 14, json.size)
        return cab + json
    }

    private fun trocarExif(webp: ByteArray, exif: ByteArray): ByteArray {
        val chunks = lerChunks(webp).filter { it.first != "EXIF" }.toMutableList()
        var i = chunks.indexOfFirst { it.first == "VP8X" }
        if (i < 0) {
            // WebP simples (sem VP8X): cria o cabeçalho estendido. Toda figurinha tem 512×512.
            val vp8x = ByteArray(10)
            if (chunks.any { it.first == "ALPH" || it.first == "VP8L" }) vp8x[0] = 0x10
            escrever24(vp8x, 4, 511)
            escrever24(vp8x, 7, 511)
            chunks.add(0, "VP8X" to vp8x)
            i = 0
        }
        val vp8x = chunks[i].second.copyOf()
        vp8x[0] = (vp8x[0].toInt() or 0x08).toByte() // avisa que tem EXIF
        chunks[i] = "VP8X" to vp8x
        chunks.add("EXIF" to exif)

        val corpo = ByteArrayOutputStream()
        corpo.write("WEBP".toByteArray(Charsets.US_ASCII))
        for ((id, dados) in chunks) {
            corpo.write(id.toByteArray(Charsets.US_ASCII))
            val tam = ByteArray(4).also { escrever32(it, 0, dados.size) }
            corpo.write(tam)
            corpo.write(dados)
            if (dados.size % 2 == 1) corpo.write(0)
        }
        val tudo = corpo.toByteArray()
        val riff = "RIFF".toByteArray(Charsets.US_ASCII) + ByteArray(4).also { escrever32(it, 0, tudo.size) }
        return riff + tudo
    }

    private fun lerChunks(b: ByteArray): List<Pair<String, ByteArray>> {
        require(b.size >= 12 && String(b, 0, 4, Charsets.US_ASCII) == "RIFF" && String(b, 8, 4, Charsets.US_ASCII) == "WEBP") {
            "Não é um WebP"
        }
        val lista = mutableListOf<Pair<String, ByteArray>>()
        var p = 12
        while (p + 8 <= b.size) {
            val tam = (b[p + 4].toInt() and 255) or ((b[p + 5].toInt() and 255) shl 8) or
                ((b[p + 6].toInt() and 255) shl 16) or ((b[p + 7].toInt() and 255) shl 24)
            lista.add(String(b, p, 4, Charsets.US_ASCII) to b.copyOfRange(p + 8, minOf(b.size, p + 8 + tam)))
            p += 8 + tam + (tam and 1)
        }
        return lista
    }

    private fun escrever32(b: ByteArray, pos: Int, v: Int) {
        for (k in 0..3) b[pos + k] = (v shr (8 * k)).toByte()
    }

    private fun escrever24(b: ByteArray, pos: Int, v: Int) {
        for (k in 0..2) b[pos + k] = (v shr (8 * k)).toByte()
    }
}
