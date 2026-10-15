package io.github.jvhubert.figurinhas

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore

/**
 * Acha os GIFs da galeria para o convite "transformar em figurinhas":
 * arquivos .gif e os GIFs que o WhatsApp salva (ele guarda como vídeo MP4 na pasta "WhatsApp Animated Gifs").
 * Lembra quais já foram oferecidos, para convidar só com os novos.
 */
object Galeria {
    class Gif(val id: String, val uri: Uri, val mime: String, val visto: Boolean)

    private const val PREFS = "galeria"
    private const val VISTOS = "vistos"

    fun permissoes(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
        )
        Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    /** true se pode ler a galeria (no Android 14, "Selecionar fotos" também conta). */
    fun temPermissao(ctx: Context): Boolean {
        fun ok(p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
        return when {
            Build.VERSION.SDK_INT >= 34 -> ok(Manifest.permission.READ_MEDIA_IMAGES) ||
                ok(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
            Build.VERSION.SDK_INT >= 33 -> ok(Manifest.permission.READ_MEDIA_IMAGES)
            else -> ok(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    /** Todos os GIFs, do mais novo para o mais antigo; "visto" = já foi oferecido. */
    fun todos(ctx: Context): List<Gif> {
        val vistos = vistos(ctx)
        val achados = mutableListOf<Pair<Long, Gif>>()
        val r = ctx.contentResolver
        val colunas = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_ADDED)

        val imagens = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        r.query(imagens, colunas, "${MediaStore.MediaColumns.MIME_TYPE} = ?", arrayOf("image/gif"), null)?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                achados.add(c.getLong(1) to Gif("i$id", ContentUris.withAppendedId(imagens, id), "image/gif", "i$id" in vistos))
            }
        }

        val videos = MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        if (Build.VERSION.SDK_INT >= 29) r.query(
            videos, colunas, "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?", arrayOf("%Animated Gifs%"), null,
        )?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                achados.add(c.getLong(1) to Gif("v$id", ContentUris.withAppendedId(videos, id), "video/mp4", "v$id" in vistos))
            }
        }

        return achados.sortedByDescending { it.first }.map { it.second }
    }

    fun uriDe(id: String): Uri? {
        val n = id.drop(1).toLongOrNull() ?: return null
        return when (id.firstOrNull()) {
            'i' -> ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, n)
            'v' -> ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, n)
            else -> null
        }
    }

    private fun vistos(ctx: Context): Set<String> =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(VISTOS, emptySet()) ?: emptySet()

    fun marcarVistos(ctx: Context, ids: Collection<String>) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().putStringSet(VISTOS, vistos(ctx) + ids).apply()
    }
}
