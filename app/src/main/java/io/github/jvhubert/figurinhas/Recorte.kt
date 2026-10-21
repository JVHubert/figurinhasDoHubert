package io.github.jvhubert.figurinhas

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * Remove o fundo de uma foto, como o WhatsApp faz: o ML Kit (Google, roda no próprio celular)
 * acha o que está em destaque (pessoa, bicho ou objeto) e devolve só isso, com fundo transparente.
 * O modelo vem pelo Google Play Services e é baixado uma vez; [preparar] pede esse download cedo.
 */
object Recorte {
    private val segmentador by lazy {
        SubjectSegmentation.getClient(SubjectSegmenterOptions.Builder().enableForegroundBitmap().build())
    }
    private val fila = Executors.newSingleThreadExecutor()

    /** Pede ao Google Play Services para baixar o modelo de recorte (se ainda não tiver). */
    fun preparar(ctx: Context) {
        try {
            ModuleInstall.getClient(ctx)
                .installModules(ModuleInstallRequest.newBuilder().addApi(segmentador).build())
        } catch (_: Exception) {
        }
    }

    /** png: a foto (já virada e reduzida pela tela). Responde com o recorte em PNG, justo no que sobrou. */
    fun remover(ctx: Context, png: ByteArray, pronto: (Result<ByteArray>) -> Unit) {
        val foto = BitmapFactory.decodeByteArray(png, 0, png.size)
            ?: return pronto(Result.failure(Exception("Não consegui ler a foto.")))
        segmentador.process(InputImage.fromBitmap(foto, 0))
            .addOnSuccessListener(fila) { r ->
                val recorte = r.foregroundBitmap?.let { justo(it) }
                if (recorte == null) {
                    pronto(Result.failure(Exception("Não achei uma pessoa, bicho ou objeto em destaque nessa foto.")))
                } else {
                    val saida = ByteArrayOutputStream()
                    recorte.compress(Bitmap.CompressFormat.PNG, 100, saida)
                    pronto(Result.success(saida.toByteArray()))
                }
            }
            .addOnFailureListener(fila) { e ->
                if (e is MlKitException && e.errorCode == MlKitException.UNAVAILABLE) {
                    preparar(ctx)
                    pronto(Result.failure(Exception(
                        "O Google ainda está baixando o recorte de fundo para o celular (só acontece na primeira vez). " +
                            "Espere um minuto, com internet, e tente de novo."
                    )))
                } else {
                    pronto(Result.failure(Exception("Não consegui remover o fundo. " + (e.message ?: ""))))
                }
            }
    }

    /** Corta as bordas transparentes, deixando uma pequena folga. null se não sobrou nada. */
    private fun justo(b: Bitmap): Bitmap? {
        val w = b.width
        val h = b.height
        val px = IntArray(w * h)
        b.getPixels(px, 0, w, 0, 0, w, h)
        var x0 = w; var y0 = h; var x1 = -1; var y1 = -1
        for (y in 0 until h) {
            val linha = y * w
            for (x in 0 until w) {
                if ((px[linha + x] ushr 24) > 16) {
                    if (x < x0) x0 = x
                    if (x > x1) x1 = x
                    if (y < y0) y0 = y
                    if (y > y1) y1 = y
                }
            }
        }
        if (x1 < 0 || (x1 - x0 + 1) * (y1 - y0 + 1) < w * h / 400) return null
        val folga = maxOf(x1 - x0, y1 - y0) / 25
        x0 = maxOf(0, x0 - folga); y0 = maxOf(0, y0 - folga)
        x1 = minOf(w - 1, x1 + folga); y1 = minOf(h - 1, y1 + folga)
        return Bitmap.createBitmap(b, x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    }
}
