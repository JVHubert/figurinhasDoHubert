package io.github.jvhubert.figurinhas

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.MimeTypeMap
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Uma tela só: o WebView com o editor (assets/web). O Android faz o que o navegador não consegue:
 * abrir a galeria, receber o "Compartilhar", baixar links e entregar os pacotes ao WhatsApp.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var baixador: Baixador
    private val tarefas = Executors.newSingleThreadExecutor()
    private var paginaPronta = false
    private val pendentes = mutableListOf<String>()
    private var pacoteAdicionando: String? = null
    private var jaEstavaNoWhatsApp = false

    private val escolher = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) receberArquivo(uri)
    }

    /**
     * Volta do WhatsApp. Pacote novo: ok se foi adicionado. Pacote que já estava lá: o WhatsApp
     * pergunta se quer "Atualizar"; se a pessoa não confirmar, a página ensina a atualizar por lá.
     */
    private val adicionar = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val id = pacoteAdicionando
        val erro = r.data?.getStringExtra("validation_error") ?: ""
        val agoraNoWhatsApp = id != null && WhatsApp.adicionado(this, id)
        val ok = r.resultCode == RESULT_OK || (!jaEstavaNoWhatsApp && agoraNoWhatsApp)
        if (ok && id != null) Pacotes.marcarNoWhatsApp(this, id)
        chamarJs(
            "aoAdicionar",
            JSONObject().put("ok", ok).put("erro", erro).put("atualizacao", jaEstavaNoWhatsApp).toString(),
        )
    }

    private val pedirGaleria = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        chamarJs("aoPermissaoGaleria", Galeria.temPermissao(this).toString())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        baixador = Baixador(applicationContext)

        val raiz = FrameLayout(this).apply { setBackgroundColor(0xFF0F1216.toInt()) }
        web = WebView(this)
        raiz.addView(web, FrameLayout.LayoutParams(-1, -1))
        setContentView(raiz)
        // Android 15 desenha atrás das barras do sistema: afasta o conteúdo delas e do teclado.
        ViewCompat.setOnApplyWindowInsetsListener(raiz) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val carregador = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/midia/", WebViewAssetLoader.InternalStoragePathHandler(this, pastaMidia()))
            .addPathHandler("/figurinhas/", WebViewAssetLoader.InternalStoragePathHandler(this, Pacotes.pasta(this)))
            .build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                carregador.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: ActivityNotFoundException) {
                }
                return true
            }
        }
        web.webChromeClient = WebChromeClient()
        web.addJavascriptInterface(Ponte(this), "Android")
        web.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/web/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("String(!!(window.voltar && window.voltar()))") { r ->
                    if (r != "\"true\"") finish()
                }
            }
        })

        tratarIntent(intent)
        baixador.preparar()
        tarefas.execute {
            if (Pacotes.instalarBrinde(applicationContext)) chamarJs("aoBrindeInstalado")
            Pacotes.assinarAntigas(applicationContext)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        tratarIntent(intent)
    }

    /** "Compartilhar" de outro app: arquivo (galeria) ou texto com link (Instagram, YouTube...). */
    private fun tratarIntent(i: Intent?) {
        if (i?.action != Intent.ACTION_SEND) return
        val uri = IntentCompat.getParcelableExtra(i, Intent.EXTRA_STREAM, Uri::class.java)
        val texto = i.getStringExtra(Intent.EXTRA_TEXT)
        setIntent(Intent())
        if (uri != null) {
            receberArquivo(uri)
        } else if (texto != null) {
            val link = Regex("https?://\\S+").find(texto)?.value
            if (link != null) chamarJs("aoReceberLink", JSONObject.quote(link))
            else chamarJs("aoErro", JSONObject.quote("Não achei um link no que foi compartilhado."))
        }
    }

    private fun pastaMidia() = File(cacheDir, "midia").apply { mkdirs() }

    /** Copia o arquivo para o cache do app; a página lê de /midia/. */
    private fun receberArquivo(uri: Uri) {
        chamarJs("aoCarregando", JSONObject.quote("Abrindo o arquivo…"))
        tarefas.execute {
            try {
                val mime = contentResolver.getType(uri) ?: ""
                val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "bin"
                pastaMidia().listFiles()?.forEach { it.delete() }
                val arquivo = File(pastaMidia(), "entrada-${System.currentTimeMillis()}.$ext")
                contentResolver.openInputStream(uri)!!.use { ent -> arquivo.outputStream().use { ent.copyTo(it) } }
                chamarJs("aoReceberArquivo", JSONObject().put("url", "/midia/${arquivo.name}").put("mime", mime).toString())
            } catch (e: Exception) {
                chamarJs("aoErro", JSONObject.quote("Não consegui abrir esse arquivo."))
            }
        }
    }

    /** Chama window.<funcao>(args) na página; se ela ainda não carregou, guarda para depois. */
    fun chamarJs(funcao: String, vararg args: String) {
        val js = "window.$funcao && window.$funcao(${args.joinToString(",")})"
        runOnUiThread {
            if (paginaPronta) web.evaluateJavascript(js, null) else pendentes.add(js)
        }
    }

    fun paginaCarregou() = runOnUiThread {
        paginaPronta = true
        pendentes.forEach { web.evaluateJavascript(it, null) }
        pendentes.clear()
    }

    fun escolherDaGaleria() = runOnUiThread {
        escolher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
    }

    fun pedirPermissaoGaleria() = runOnUiThread { pedirGaleria.launch(Galeria.permissoes()) }

    fun abrirGif(id: String) {
        val uri = Galeria.uriDe(id)
        if (uri != null) receberArquivo(uri)
        else chamarJs("aoErro", JSONObject.quote("Não achei esse GIF."))
    }

    fun abrirWhatsApp(p: Pacotes.Pacote) = runOnUiThread {
        pacoteAdicionando = p.id
        jaEstavaNoWhatsApp = WhatsApp.adicionado(this, p.id)
        try {
            adicionar.launch(WhatsApp.intentAdicionar(p))
        } catch (_: ActivityNotFoundException) {
            chamarJs(
                "aoAdicionar",
                JSONObject().put("ok", false).put("erro", "Não achei o WhatsApp neste celular.").toString(),
            )
        }
    }

    fun baixarLink(url: String) = baixador.baixar(
        url,
        progresso = { pct, texto -> chamarJs("aoProgressoLink", pct.toString(), JSONObject.quote(texto)) },
        fim = { json -> chamarJs("aoBaixarLink", json) },
    )

    fun cancelarLink() = baixador.cancelar()

    override fun onDestroy() {
        tarefas.shutdown()
        web.destroy()
        super.onDestroy()
    }
}
