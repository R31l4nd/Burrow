package io.github.r31l4nd.burrow

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.Gravity
import android.view.View
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.annotation.VisibleForTesting
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.IntentCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File

/**
 * Burrow itself in a WebView: locked behind the fingerprint, no screenshots
 * (FLAG_SECURE), edge to edge with the keyboard pushing the page up, and
 * the bridge to the phone for the page on the server's origin only.
 */
class MainActivity : AppCompatActivity() {
    private var rootView: FrameLayout? = null
    private var statusBar: View? = null

    /** The status bar strip's colour now (for the device test). */
    @androidx.annotation.VisibleForTesting
    fun topColor(): Int? = (statusBar?.background as? android.graphics.drawable.ColorDrawable)?.color

    /** The page's top colour (its "chrome" call): the status bar's strip follows. */
    fun paintTop(color: Int) {
        statusBar?.let { Insets.paintStatusBar(window, it, color) }
    }

    /** Burrow's theme changed on the page (black for OLED, say): the bars around it follow. */
    fun refreshBackground() {
        rootView?.setBackgroundColor(Style.palette(this).bg)
    }

    private val sso = SsoFlow()

    private lateinit var origin: String
    private lateinit var web: TermWebView
    private lateinit var lock: LockGate
    private lateinit var errorView: View
    private lateinit var bridge: Bridge
    private val shake by lazy { Shake(this) { shaken() } }
    private lateinit var chooser: WebSetup.FileChooser
    private lateinit var qr: QrScan
    private lateinit var folders: FolderPick
    private lateinit var allFilesAsk: AllFilesAsk
    private val app get() = application as BurrowApp

    @get:VisibleForTesting
    val webView: WebView get() = web

    /** The lock's cover (for the device test's picture of it). */
    @VisibleForTesting
    fun lockCover(): View = lock.cover

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Insets.secure(window)
        origin = Prefs(this).origin ?: run {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        chooser = WebSetup.FileChooser(this)
        qr = QrScan(this)
        folders = FolderPick(this)
        allFilesAsk = AllFilesAsk(this)
        Shortcuts.ensureDirect(this)

        val root = FrameLayout(this)
        rootView = root
        root.setBackgroundColor(Style.palette(this).bg)
        web = TermWebView(this)
        WebSetup.configure(web)
        CookieManager.getInstance().setAcceptCookie(true)
        root.addView(web, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        errorView = messageView(root)
        lock = LockGate(this, root, R.string.change_server to { changeServer() }) { web }
        // The strip behind the status bar: the page's title bar colour (dark
        // on a phone) once it says so; the rail's until then.
        val bar = View(this)
        statusBar = bar
        root.addView(bar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, 0, android.view.Gravity.TOP))
        setContentView(root)
        Insets.applyWithStatusBar(window, root, bar)
        Insets.paintStatusBar(window, bar, Style.palette(this).side)

        web.webViewClient = Client()
        web.webChromeClient = object : WebSetup.OwnPageChrome(this) {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams) =
                chooser.show(this@MainActivity, callback, params)
        }
        web.setDownloadListener { url, userAgent, disposition, _, _ -> download(url, userAgent, disposition) }

        bridge = Bridge(this, web, origin)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "BurrowAndroid", setOf(origin), bridge)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            // An open dialog closes first (the page answers true); then the
            // page's history, then out of the app.
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.__burrowBack && window.__burrowBack()) === true") { closed ->
                    if (closed == "true") return@evaluateJavascript
                    if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
                }
            }
        })

        val first = origin + "/" + (hashFor(intent) ?: "")
        val wg = app.wireguard
        if (wg.configured) {
            // Away from home: first the tunnel, then the page through it.
            wg.decide(origin) { up ->
                // Decided after this screen went (closed while it was deciding): nothing to load or watch
                // any more, or a destroyed WebView was loaded and a watcher kept it (AUDIT2 AND-09).
                if (isDestroyed) return@decide
                viaTunnel = up
                loadedWith = wg.starts
                web.loadUrl(first)
                watch()
            }
        } else {
            web.loadUrl(first)
        }
    }

    // Whether the page goes through the app's WireGuard now, and which start
    // of the tunnel it was loaded with.
    private var viaTunnel = false
    private var loadedWith = 0
    private var stopWatching: () -> Unit = {}
    private var watching = false

    /** The network watched for the tunnel's decision, once; also when the first configuration came after this screen opened (AUDIT2 AND-10). */
    private fun watch() {
        if (watching || isDestroyed) return
        watching = true
        stopWatching = app.wireguard.watchNetwork({ origin }) { now -> tunnelChanged(now) }
    }

    private fun unwatch() {
        stopWatching()
        stopWatching = {}
        watching = false
    }

    /** The settings changed (a configuration, the addresses): decide again. */
    /** The camera reads a QR code (Settings -> Android -> WireGuard). */
    fun scanQr(done: (String?) -> Unit) = qr.scan(done)

    /** Android's folder picker (the Files page's "Add a folder of this phone"). */
    fun pickFolder(start: Uri?, done: (Uri?) -> Unit) = folders.pick(start, done)

    /** Android's "All files access" screen; done(whether the app has it now). */
    fun askAllFiles(done: (Boolean) -> Unit) = allFilesAsk.ask(done)

    fun recheckTunnel() {
        val wg = app.wireguard
        if (!wg.configured) {
            unwatch()
            wg.stopSoon()
            return tunnelChanged(false)
        }
        wg.decide(origin) { up ->
            if (isDestroyed) return@decide
            if (up) wg.applyProxy(origin)
            tunnelChanged(up)
            watch()
        }
    }

    /**
     * Home or away, or the tunnel up again after it went down in the
     * background (the battery rule in BurrowApp): the page lost its
     * connections then. A page that is there is told and reconnects them; it
     * is never reloaded, which took unsaved work in an editor or a form
     * (A3-AND-03). Only the error screen loads again.
     */
    @VisibleForTesting
    fun tunnelChanged(up: Boolean) {
        val action = TunnelChange.decide(up, viaTunnel, app.wireguard.starts, loadedWith, pageShown = errorView.visibility != View.VISIBLE)
        if (action == TunnelChange.Action.NONE) return
        viaTunnel = up
        loadedWith = app.wireguard.starts
        if (action == TunnelChange.Action.RELOAD) web.reload() else bridge.emit("resumed", null)
    }

    // The volume keys, while a terminal takes them: to the page, not the volume.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Locked: no key reaches the page behind the cover (A3-AND-08).
        val key = if (::web.isInitialized && !lock.covered) TerminalMode.volumeKey(web, event) else null
        if (key != null) {
            if (key.isNotEmpty()) bridge.emit("volumeKey", key)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        hashFor(intent)?.let { web.loadUrl("$origin/$it") }
    }

    override fun onStart() {
        super.onStart()
        if (::web.isInitialized) lock.onStart()
    }

    override fun onResume() {
        super.onResume()
        if (!::web.isInitialized) return
        lock.onResume()
        bridge.checkChanged()
        listenForShake()
        // Back in front: the page checks its live connections (a terminal's
        // may look open and be gone after a while in the background).
        bridge.emit("resumed", null)
        // Back from the background, perhaps home or away now.
        if (app.wireguard.configured) app.wireguard.decide(origin) { if (!isDestroyed) tunnelChanged(it) }
    }

    override fun onPause() {
        shake.stop()
        super.onPause()
    }

    /** A shake of the phone: the page opens its problem report on what is on the screen. */
    fun shaken() = bridge.emit("shake", null)

    /** Listening for a shake while in front, when the person has it on. */
    fun listenForShake() {
        if (Prefs(this).shakeReport) shake.start() else shake.stop()
    }

    override fun onDestroy() {
        unwatch()
        if (::bridge.isInitialized) bridge.dispose()
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    private fun messageView(root: FrameLayout): View {
        val p = Style.palette(this)
        val box = Style.screen(this, R.string.unreachable_title).apply { visibility = View.GONE }
        box.addView(Style.centered(Style.text(this, "", 14f, p.dim)).apply { id = R.id.error_text }, Style.row(this, 8f))
        box.addView(Style.button(this, getString(R.string.retry), primary = true).apply { setOnClickListener { box.visibility = View.GONE; web.reload() } }, Style.row(this, 24f))
        // Burrow away (WireGuard off, server down): the phone's own SSH route.
        box.addView(Style.button(this, getString(R.string.direct_route), primary = false).apply { setOnClickListener { openDirect() } }, Style.row(this, 10f))
        box.addView(Style.button(this, getString(R.string.change_server), primary = false).apply { setOnClickListener { changeServer() } }, Style.row(this, 10f))
        root.addView(box, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        return box
    }

    /** The direct route, in its own task (A3-AND-04); for one host when [hostId] is given. */
    fun openDirect(hostId: Long? = null) {
        startActivity(Intent(this, DirectActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).apply { if (hostId != null) putExtra(DirectActivity.EXTRA_HOST, hostId) })
    }

    private fun changeServer() {
        startActivity(Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_CHANGE, true))
        finish()
    }

    // ---- intents: shared files, host shortcuts

    /** The page to open for an intent: "#/share", "#/hosts?connect=12", "#/logs?..." (a burrow:// link), or null. */
    private fun hashFor(intent: Intent?): String? {
        intent ?: return null
        return when (intent.action) {
            // Only from the app's own shortcut entry (not exported); from another app it opens nothing (A3-AND-05).
            Shortcuts.ACTION_CONNECT -> DeepLinks.pageForConnect(intent.getLongExtra(Shortcuts.EXTRA_HOST, 0), intent.component?.className == DeepLinks.SHORTCUT_ENTRY)
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> if (receiveShared(intent)) "#/share" else null
            Intent.ACTION_VIEW -> DeepLinks.pageFor(intent.dataString)
            else -> null
        }
    }

    private fun receiveShared(intent: Intent): Boolean {
        val uris = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            else -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
        }
        // A file the other app does not let us read (or whose size nobody knows) is left out and said,
        // not a crash of the app or a quiet gap (AUDIT2 AND-13).
        var skipped = 0
        for (uri in uris) {
            // Only another app's provider: never a file:// path or this app's own files (A3-AND-07).
            if (!HeldFiles.acceptsShared(uri.scheme, uri.authority, packageName)) {
                skipped++
                continue
            }
            val ok = runCatching {
                var name = "file"
                var size = -1L
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        c.getString(0)?.let { name = it }
                        if (!c.isNull(1)) size = c.getLong(1)
                    }
                }
                if (size < 0) size = contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1
                if (size < 0) return@runCatching false
                val opener = object : HeldFiles.Opener {
                    // The descriptor closed with the channel (a FileInputStream of a descriptor does not own it, audit 2026-11-05).
                    override fun channel() = contentResolver.openFileDescriptor(uri, "r")?.let { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).channel }
                    override fun stream() = contentResolver.openInputStream(uri) ?: error("cannot read")
                }
                app.held.add(HeldFiles.Held(app.held.newToken(), HeldFiles.Kind.SHARED, FileNames.safe(name), contentResolver.getType(uri) ?: Http.mimeOf(name), size, opener))
                true
            }.getOrDefault(false)
            if (!ok) skipped++
        }
        if (skipped > 0) toast(resources.getQuantityString(R.plurals.share_skipped, skipped, skipped))
        // Text without a file (a link, a note): becomes a small text file.
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (uris.isEmpty() && !text.isNullOrEmpty()) {
            val token = app.held.newToken()
            val f = File(cacheDir, "share/$token/shared.txt").apply { parentFile?.mkdirs(); writeText(text) }
            app.held.add(HeldFiles.Held(token, HeldFiles.Kind.SHARED, f.name, "text/plain", f.length(), HeldFiles.fileOpener(f), local = f))
        }
        return app.held.list(HeldFiles.Kind.SHARED).isNotEmpty()
    }

    // ---- downloads (the page's download links) into Downloads

    private fun download(url: String, userAgent: String?, disposition: String?) {
        if (!Origins.same(url, origin)) return
        // Burrow's own Download button: asked already by pressing it; the
        // progress shows in the notification and in Burrow's busy pill.
        val name = FileNames.forDownload(url, disposition, null)
        Downloads.start(this, url, name, "file", Downloads.Target.Public, { CookieManager.getInstance().getCookie(url) }, { app.wireguard.proxyFor(Uri.parse(url).host, origin) }, userAgent)
        toast(getString(R.string.download_started, name))
    }

    fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    /** WebView's error, said for people; its own code stays below it, small. */
    private fun reasonFor(code: Int): Int = when (code) {
        WebViewClient.ERROR_CONNECT -> R.string.reason_connect
        WebViewClient.ERROR_HOST_LOOKUP -> R.string.reason_lookup
        WebViewClient.ERROR_TIMEOUT -> R.string.reason_timeout
        WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> R.string.reason_tls
        else -> R.string.reason_other
    }

    // The error screen's text is put together from translated pieces (origin, reason, the tunnel's word).
    @android.annotation.SuppressLint("SetTextI18n")
    private inner class Client : WebViewClient() {
        // Nothing from this phone's loopback but Burrow itself (see WebSetup.loopbackRefused).
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): android.webkit.WebResourceResponse? =
            WebSetup.loopbackRefused(request, allow = origin)

        // Burrow stays here; everything else opens in the phone's browser.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            // Nothing on the phone's loopback, also not by a redirect (WebSetup.toLoopback).
            if (WebSetup.toLoopback(request.url, allow = origin)) return true
            // Burrow's own pages, and the provider's during a single sign-on.
            if (sso.keepInApp(request.url.path, Origins.same(url, origin))) return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, request.url).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (e: Exception) {
                // No app for it: ignore the link.
            }
            return true
        }

        // The app's WireGuard proxy asks who we are: only it gets an answer.
        override fun onReceivedHttpAuthRequest(view: WebView, handler: android.webkit.HttpAuthHandler, host: String?, realm: String?) {
            if (!app.wireguard.answer(handler, host, realm)) super.onReceivedHttpAuthRequest(view, handler, host, realm)
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            errorView.visibility = View.GONE
        }

        // The proxy up and Burrow down (restarting, updating): its 502 page was all there was, without
        // Retry or the direct route (AUDIT2 AND-17).
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: android.webkit.WebResourceResponse) {
            if (!request.isForMainFrame || response.statusCode !in 502..504) return
            errorView.findViewById<TextView>(R.id.error_text).text = "$origin\n\n${getString(R.string.reason_proxy, response.statusCode)}"
            errorView.visibility = View.VISIBLE
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            val wg = app.wireguard
            val tunnel = when {
                !wg.configured -> ""
                wg.lastError != null -> "\n\n" + getString(R.string.wg_failed, wg.lastError)
                wg.active -> "\n\n" + getString(R.string.wg_through) + (wg.lastRefusal?.let { "\n" + getString(R.string.wg_refused, it) } ?: "")
                else -> ""
            }
            errorView.findViewById<TextView>(R.id.error_text).text = "$origin\n\n${getString(reasonFor(error.errorCode))}\n(${error.description})$tunnel"
            errorView.visibility = View.VISIBLE
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's process died (memory): start over rather than crash.
            recreate()
            return true
        }
    }
}
