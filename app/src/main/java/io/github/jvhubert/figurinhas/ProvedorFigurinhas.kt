package io.github.jvhubert.figurinhas

import android.content.ContentProvider
import android.content.ContentValues
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File

/**
 * O WhatsApp consulta este provedor para ler os pacotes. Endereços e colunas iguais aos do
 * exemplo oficial (github.com/WhatsApp/stickers, StickerContentProvider.java):
 *   metadata, metadata/<pacote>, stickers/<pacote>, stickers_asset/<pacote>/<arquivo>
 */
class ProvedorFigurinhas : ContentProvider() {

    override fun onCreate() = true

    private fun pacotes() = Pacotes.ler(context!!).filter { it.figurinhas.isNotEmpty() }

    override fun query(
        uri: Uri, projection: Array<out String>?, selection: String?,
        selectionArgs: Array<out String>?, sortOrder: String?,
    ): Cursor {
        val s = uri.pathSegments
        val cursor = when {
            s.size == 1 && s[0] == "metadata" -> cursorPacotes(pacotes())
            s.size == 2 && s[0] == "metadata" -> cursorPacotes(pacotes().filter { it.id == s[1] })
            s.size == 2 && s[0] == "stickers" -> cursorFigurinhas(pacotes().firstOrNull { it.id == s[1] })
            else -> throw IllegalArgumentException("URI desconhecida: $uri")
        }
        cursor.setNotificationUri(context!!.contentResolver, uri)
        return cursor
    }

    private fun cursorPacotes(lista: List<Pacotes.Pacote>) = MatrixCursor(
        arrayOf(
            "sticker_pack_identifier", "sticker_pack_name", "sticker_pack_publisher", "sticker_pack_icon",
            "android_play_store_link", "ios_app_download_link", "sticker_pack_publisher_email",
            "sticker_pack_publisher_website", "sticker_pack_privacy_policy_website",
            "sticker_pack_license_agreement_website", "image_data_version",
            "whatsapp_will_not_cache_stickers", "animated_sticker_pack",
        )
    ).apply {
        lista.forEach { p ->
            addRow(
                arrayOf<Any>(
                    p.id, p.nome, Creditos.PUBLICADOR, p.bandeja(), "", "", "", Creditos.SITE, "", "",
                    p.versao.toString(), 0, if (p.animado) 1 else 0,
                )
            )
        }
    }

    private fun cursorFigurinhas(p: Pacotes.Pacote?) = MatrixCursor(
        arrayOf("sticker_file_name", "sticker_emoji", "sticker_accessibility_text")
    ).apply {
        // O WhatsApp exige pelo menos 1 emoji por figurinha.
        p?.listaParaWhatsApp()?.forEach { addRow(arrayOf<Any?>(it, p.emoji, null)) }
    }

    override fun openAssetFile(uri: Uri, mode: String): AssetFileDescriptor? {
        val s = uri.pathSegments
        if (s.size != 3 || s[0] != "stickers_asset") return null
        val p = pacotes().firstOrNull { it.id == s[1] } ?: return null
        val nome = s[2]
        if (nome != p.bandeja() && nome !in p.listaParaWhatsApp()) return null
        val arquivo = File(File(Pacotes.pasta(context!!), p.id), Pacotes.arquivoReal(nome))
        if (!arquivo.exists()) return null
        return AssetFileDescriptor(
            ParcelFileDescriptor.open(arquivo, ParcelFileDescriptor.MODE_READ_ONLY),
            0, AssetFileDescriptor.UNKNOWN_LENGTH,
        )
    }

    override fun getType(uri: Uri): String {
        val s = uri.pathSegments
        val aut = BuildConfig.AUTORIDADE
        return when {
            s.size == 1 && s[0] == "metadata" -> "vnd.android.cursor.dir/vnd.$aut.metadata"
            s.size == 2 && s[0] == "metadata" -> "vnd.android.cursor.item/vnd.$aut.metadata"
            s.size == 2 && s[0] == "stickers" -> "vnd.android.cursor.dir/vnd.$aut.stickers"
            s.lastOrNull()?.endsWith(".png") == true -> "image/png"
            else -> "image/webp"
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    override fun update(
        uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?,
    ): Int = throw UnsupportedOperationException()
}
