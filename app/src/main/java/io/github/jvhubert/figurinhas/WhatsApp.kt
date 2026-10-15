package io.github.jvhubert.figurinhas

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

/** Conversa com o WhatsApp do jeito do exemplo oficial (WhitelistCheck.java e AddStickerPackActivity.java). */
object WhatsApp {
    private val apps = listOf("com.whatsapp", "com.whatsapp.w4b")

    private fun instalado(ctx: Context, app: String) = try {
        ctx.packageManager.getApplicationInfo(app, 0).enabled
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    fun algumInstalado(ctx: Context) = apps.any { instalado(ctx, it) }

    /** true se o pacote já está em todos os WhatsApps instalados (normal e Business). */
    fun adicionado(ctx: Context, id: String): Boolean {
        val instalados = apps.filter { instalado(ctx, it) }
        return instalados.isNotEmpty() && instalados.all { consultar(ctx, it, id) }
    }

    private fun consultar(ctx: Context, app: String, id: String): Boolean = try {
        val autoridade = "$app.provider.sticker_whitelist_check"
        if (ctx.packageManager.resolveContentProvider(autoridade, PackageManager.GET_META_DATA) == null) {
            false
        } else {
            val uri = Uri.Builder().scheme("content").authority(autoridade).appendPath("is_whitelisted")
                .appendQueryParameter("authority", BuildConfig.AUTORIDADE)
                .appendQueryParameter("identifier", id)
                .build()
            ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
                c.moveToFirst() && c.getInt(c.getColumnIndexOrThrow("result")) == 1
            } ?: false
        }
    } catch (_: Exception) {
        false
    }

    fun intentAdicionar(p: Pacotes.Pacote) = Intent("com.whatsapp.intent.action.ENABLE_STICKER_PACK")
        .putExtra("sticker_pack_id", p.id)
        .putExtra("sticker_pack_authority", BuildConfig.AUTORIDADE)
        .putExtra("sticker_pack_name", p.nome)
}
