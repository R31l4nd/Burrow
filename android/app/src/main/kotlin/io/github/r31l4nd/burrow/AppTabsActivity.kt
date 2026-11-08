package io.github.r31l4nd.burrow

import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.annotation.VisibleForTesting
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Web apps (Radarr, Sonarr, ...) as tabs. Each app gets its own WebView
 * profile, so its own cookie jar: signing in to one never touches another
 * or Burrow, and each stays signed in. Tabs live as long as this screen; the
 * cookies (and so the sign-ins) persist.
 */
class AppTabsActivity : AppCompatActivity() {
    /**
     * [web] is made anew when the renderer went (A3-AND-02); [home] is the
     * address the tab opened with; [error] what its page could not load, said
     * over it with Retry (A3-AND-11).
     */
    private class Tab(val id: Long, val origin: String, val name: String, val home: String, var web: WebView, val chip: LinearLayout, val label: TextView, val close: ImageButton) {
        var error: String? = null
    }

    private val tabs = mutableListOf<Tab>()
    private var current: Tab? = null
    private lateinit var content: FrameLayout
    private lateinit var strip: LinearLayout
    private lateinit var chooser: WebSetup.FileChooser
    private val app get() = application as BurrowApp

    @VisibleForTesting
    fun currentWebView(): WebView? = current?.web

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Insets.secure(window)
        chooser = WebSetup.FileChooser(this)
        val p = Style.palette(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(p.bg)
        }
        // The bar: back to Burrow, the open apps as tabs (each with a close button), reload.
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(p.raised)
            setPadding(Style.dp(this@AppTabsActivity, 4f), 0, Style.dp(this@AppTabsActivity, 4f), 0)
        }
        bar.addView(Style.iconButton(this, R.drawable.ic_back, getString(R.string.back_to_burrow), p.text).apply { setOnClickListener { toBurrow() } })
        strip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        bar.addView(
            HorizontalScrollView(this).apply {
                isHorizontalScrollBarEnabled = false
                // No grey focus box over the tabs when the screen opens.
                isFocusable = false
                defaultFocusHighlightEnabled = false
                addView(strip)
            },
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        // Shown while the tab in front goes through the app's own WireGuard
        // (away from home): a slow page or one that cannot reach home is
        // then easy to place.
        tunnelIcon = Style.iconButton(this, R.drawable.ic_tunnel, getString(R.string.through_tunnel), p.accent).apply {
            visibility = View.GONE
            setOnClickListener { android.widget.Toast.makeText(this@AppTabsActivity, R.string.through_tunnel, android.widget.Toast.LENGTH_LONG).show() }
        }
        bar.addView(tunnelIcon)
        bar.addView(Style.iconButton(this, R.drawable.ic_reload, getString(R.string.reload), p.text).apply { setOnClickListener { current?.web?.reload() } })
        root.addView(bar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Style.dp(this, 56f)))
        root.addView(View(this).apply { setBackgroundColor(p.border) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Style.dp(this, 1f)))
        content = FrameLayout(this)
        // The app's own downloads: a thin bar over the top of the page while
        // they run (the notification has the details and Stop).
        downloadBar = android.widget.ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            visibility = View.GONE
            max = 100
            progressTintList = android.content.res.ColorStateList.valueOf(p.accent)
            indeterminateTintList = android.content.res.ColorStateList.valueOf(p.accent)
            contentDescription = getString(R.string.downloads_channel)
            elevation = Style.dp(this@AppTabsActivity, 2f).toFloat()
        }
        val pageArea = FrameLayout(this)
        pageArea.addView(content, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        // A page that could not be loaded: why, in words, with Retry; the WebView's own grey page said
        // nothing about the tunnel and had no way to try again (A3-AND-11).
        errorBox = Style.screen(this, R.string.tab_failed_title).apply {
            visibility = View.GONE
            addView(Style.centered(Style.text(this@AppTabsActivity, "", 14f, p.dim)).apply { id = R.id.error_text }, Style.row(this@AppTabsActivity, 8f))
            addView(Style.button(this@AppTabsActivity, getString(R.string.retry), primary = true).apply { setOnClickListener { current?.let { it.error = null; showError(); it.web.reload() } } }, Style.row(this@AppTabsActivity, 24f))
        }
        pageArea.addView(errorBox, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        pageArea.addView(downloadBar, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, Style.dp(this, 4f), Gravity.TOP))
        root.addView(pageArea, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        Insets.apply(window, root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // A video full screen: back to the page first.
                if (fullScreen != null) return hideFullScreen()
                val w = current?.web
                if (w != null && w.canGoBack()) w.goBack() else toBurrow()
            }
        })
        open(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        open(intent)
    }

    override fun onStart() {
        super.onStart()
        // The app tabs are part of Burrow: locked means back to Burrow's lock.
        if (!app.unlocked) toBurrow()
        // Away from home, the app's WireGuard for the tabs set to use it
        // (it goes down in the background, to save the battery).
        if (app.wireguard.configured) app.wireguard.decide(Prefs(this).origin) {}
    }

    override fun onDestroy() {
        tabs.forEach { it.web.destroy() }
        openIds.clear()
        super.onDestroy()
    }

    private fun toBurrow() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
    }

    private fun open(intent: Intent?) {
        val id = intent?.getLongExtra(EXTRA_ID, 0) ?: 0
        val url = intent?.getStringExtra(EXTRA_URL) ?: return
        val name = intent.getStringExtra(EXTRA_NAME) ?: url
        if (id <= 0) return
        // An app's number is the server's: a tab of another server with the same number goes first.
        val origin = Prefs(this).origin ?: ""
        tabs.filter { it.id == id && it.origin != origin }.forEach { close(it, leave = false) }
        val tab = tabs.find { it.id == id } ?: newTab(id, origin, name, url)
        select(tab)
    }

    private var sharedSaid = false

    /** A tab's WebView: its own profile (cookie jar), its clients; made again when the renderer went. */
    private fun webFor(id: Long, origin: String): WebView {
        val web = WebView(this)
        // Before anything else touches this WebView: its own cookie jar, of this server's app.
        val profile = AppProfiles.name(origin, id)
        val cookies: CookieManager = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            ProfileStore.getInstance().getOrCreateProfile(profile)
            WebViewCompat.setProfile(web, profile)
            WebViewCompat.getProfile(web).cookieManager
        } else {
            // Said once: the tabs share one cookie store here, not the separation they have elsewhere (AUDIT2 AND-20).
            if (!sharedSaid) {
                sharedSaid = true
                android.widget.Toast.makeText(this, R.string.tabs_shared, android.widget.Toast.LENGTH_LONG).show()
            }
            CookieManager.getInstance()
        }
        WebSetup.configure(web)
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(web, false)
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): android.webkit.WebResourceResponse? =
                WebSetup.loopbackRefused(request)

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                val tab = tabs.find { it.web === view } ?: return
                if (tab.error == null) return
                tab.error = null
                if (tab === current) showError()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) failed(view, request.url, "${getString(reasonFor(error.errorCode))}\n(${error.description})")
            }

            // A certificate the phone does not trust: refused, as before (never "proceed anyway"),
            // and now said, for the page itself.
            override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
                handler.cancel()
                val page = view.url ?: tabs.find { it.web === view }?.home
                if (page == null || Origins.of(error.url) == Origins.of(page)) failed(view, Uri.parse(error.url), getString(R.string.reason_tls))
            }

            // The tunnel's proxy turned the page down (a name its DNS does not know, A3-AND-01): why.
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: android.webkit.WebResourceResponse) {
                if (!request.isForMainFrame || response.statusCode != 502) return
                val refused = app.wireguard.lastRefusal ?: return
                if (app.wireguard.proxyFor(request.url.host, null) != null) failed(view, request.url, getString(R.string.wg_refused, refused))
            }

            // All of the app's WebViews share one renderer. Its loss not handled here, Android ends the
            // whole app with it: direct sessions, port forwards and the tunnel too (A3-AND-02).
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                renew(view)
                return true
            }

            // The app's WireGuard proxy asks who we are: only it gets an answer.
            override fun onReceivedHttpAuthRequest(view: WebView, handler: android.webkit.HttpAuthHandler, host: String?, realm: String?) {
                if ((application as BurrowApp).wireguard.answer(handler, host, realm)) return
                askLogin(handler, host, realm)
            }

            // Web pages stay in the tab (logins may hop between hosts);
            // other schemes (mailto:, intent:, magnet:) go to their apps.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme?.lowercase()
                // Never to the phone's loopback, also not by a redirect (see WebSetup.toLoopback).
                if (WebSetup.toLoopback(request.url)) return true
                if (scheme == "https" || scheme == "http") return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url).addCategory(Intent.CATEGORY_BROWSABLE))
                } catch (e: Exception) {
                    // Nothing handles it.
                }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams) =
                chooser.show(this@AppTabsActivity, callback, params)

            // A video's full screen button (Jellyfin and the like) did nothing (A3-AND-11).
            override fun onShowCustomView(view: View, callback: CustomViewCallback) = showFullScreen(view, callback)

            override fun onHideCustomView() = hideFullScreen()
        }
        // A download the page offers: asked first (an app can offer one
        // without the person meaning to), then the app's own download.
        web.setDownloadListener { dl, userAgent, disposition, mime, length -> askDownload(dl, userAgent, disposition, mime, length, cookies) }
        return web
    }

    private fun newTab(id: Long, origin: String, name: String, url: String): Tab {
        val web = webFor(id, origin)
        lateinit var tab: Tab
        val p = Style.palette(this)
        val label = Style.text(this, name, 14f, p.text).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            maxWidth = Style.dp(this@AppTabsActivity, 160f)
        }
        val close = Style.iconButton(this, R.drawable.ic_close, getString(R.string.close_tab_named, name), p.dim).apply {
            minimumWidth = Style.dp(this@AppTabsActivity, 36f)
            minimumHeight = Style.dp(this@AppTabsActivity, 36f)
            setOnClickListener { close(tab) }
        }
        val chip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Style.dp(this@AppTabsActivity, 14f), 0, 0, 0)
            addView(label)
            addView(close, LinearLayout.LayoutParams(Style.dp(this@AppTabsActivity, 36f), Style.dp(this@AppTabsActivity, 36f)))
            setOnClickListener { select(tab) }
            contentDescription = name
        }
        tab = Tab(id, origin, name, url, web, chip, label, close)
        tabs.add(tab)
        openIds.add(id)
        strip.addView(chip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, Style.dp(this, 38f)).apply { marginEnd = Style.dp(this@AppTabsActivity, 6f) })
        content.addView(web, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        web.loadUrl(url)
        return tab
    }

    private var errorBox: android.widget.LinearLayout? = null

    /** The error over the page, for the tab in front (each tab keeps its own). */
    private fun showError() {
        val box = errorBox ?: return
        val text = current?.error
        box.visibility = if (text == null) View.GONE else View.VISIBLE
        if (text != null) box.findViewById<TextView>(R.id.error_text).text = text
    }

    /** The tab's page could not be loaded: said over it, with the tunnel when it went through it. */
    private fun failed(view: WebView, url: Uri, why: String) {
        val tab = tabs.find { it.web === view } ?: return
        val wg = app.wireguard
        val tunnel = if (wg.active && wg.proxyFor(url.host, null) != null) "\n\n" + getString(R.string.through_tunnel) else ""
        tab.error = "${url.host ?: url}\n\n$why$tunnel"
        if (tab === current) showError()
    }

    private fun reasonFor(code: Int): Int = when (code) {
        WebViewClient.ERROR_CONNECT -> R.string.tab_reason_connect
        WebViewClient.ERROR_HOST_LOOKUP -> R.string.reason_lookup
        WebViewClient.ERROR_TIMEOUT -> R.string.reason_timeout
        WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> R.string.reason_tls
        else -> R.string.reason_other
    }

    /** What failed is shown (for the device test). */
    @VisibleForTesting
    fun errorShown(): Boolean = errorBox?.visibility == View.VISIBLE

    @VisibleForTesting
    fun errorText(): String = errorBox?.findViewById<TextView>(R.id.error_text)?.text?.toString() ?: ""

    // A video full screen: its view over everything, the bars hidden.
    private var fullScreen: Pair<View, WebChromeClient.CustomViewCallback>? = null

    private fun showFullScreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (fullScreen != null) return callback.onCustomViewHidden()
        fullScreen = view to callback
        view.setBackgroundColor(android.graphics.Color.BLACK)
        (window.decorView as FrameLayout).addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun hideFullScreen() {
        val (view, callback) = fullScreen ?: return
        fullScreen = null
        (window.decorView as FrameLayout).removeView(view)
        androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        callback.onCustomViewHidden()
    }

    /**
     * The renderer went (memory, a crash in a heavy app): a WebView cannot be
     * used after that. The tab gets a new one at the address it was at; the
     * other tabs, Burrow and the direct route's sessions stay.
     */
    private fun renew(dead: WebView) {
        val tab = tabs.find { it.web === dead }
        tab?.error = null
        val at = content.indexOfChild(dead)
        val last = dead.url
        content.removeView(dead)
        dead.destroy()
        if (tab == null || isFinishing || isDestroyed) return
        val url = last?.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: tab.home
        val web = webFor(tab.id, tab.origin)
        tab.web = web
        content.addView(web, if (at >= 0) at else content.childCount, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        web.loadUrl(url)
        (current ?: tab).let { select(it) }
        if (current === tab) web.requestFocus()
    }

    // An app behind Basic or Digest auth: its sign-in asked here, said with the host it is for. The
    // WebView's default cancelled it, so such apps could not be used in a tab (AUDIT2 AND-19).
    private fun askLogin(handler: android.webkit.HttpAuthHandler, host: String?, realm: String?) {
        val p = Style.palette(this)
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        realm?.takeIf { it.isNotBlank() }?.let { form.addView(Style.text(this, it, 15f, p.dim)) }
        val user = Style.input(this).apply { hint = getString(R.string.auth_user); inputType = android.text.InputType.TYPE_CLASS_TEXT; isSingleLine = true }
        val pass = Style.input(this).apply {
            hint = getString(R.string.auth_password)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSingleLine = true
        }
        form.addView(user, Style.row(this, if (form.childCount > 0) 12f else 0f))
        form.addView(pass, Style.row(this, 10f))
        var answered = false
        asking = Style.ask(this, getString(R.string.auth_title, host ?: "?"), form, getString(R.string.auth_sign_in), onDismiss = { if (!answered) handler.cancel() }) {
            answered = true
            handler.proceed(user.text.toString(), pass.text.toString())
        }.also { it.show() }
    }

    // In Burrow's own look, as the page's questions (decision 23).
    private fun askDownload(url: String, userAgent: String?, disposition: String?, mime: String?, length: Long, cookies: CookieManager) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return
        val name = FileNames.forDownload(url, disposition, mime)
        val size = if (length > 0) android.text.format.Formatter.formatShortFileSize(this, length) else ""
        val body = Style.askText(this, name, size, getString(R.string.download_ask_where), firstBold = true)
        asking = Style.ask(this, getString(R.string.download_ask_title), body, getString(R.string.download_save)) {
            val wg = app.wireguard
            // Sent on to another host (a CDN, a pre-signed address): followed, without this tab's cookie (A3-AND-11).
            Downloads.start(this, url, name, "file", Downloads.Target.Public, { cookies.getCookie(url) }, { wg.proxyFor(Uri.parse(url).host, null) }, userAgent, otherHost = { u -> wg.proxyFor(u.host, null) })
        }.also { it.show() }
    }

    @VisibleForTesting
    var asking: android.app.Dialog? = null
        private set

    private var downloadBar: android.widget.ProgressBar? = null
    private val downloadsChanged: () -> Unit = { runOnUiThread { showDownloads() } }

    private fun showDownloads() {
        val bar = downloadBar ?: return
        val list = Downloads.running()
        bar.visibility = if (list.isEmpty()) View.GONE else View.VISIBLE
        val pct = Downloads.percent(list)
        bar.isIndeterminate = pct == null
        if (pct != null) bar.progress = pct
    }

    private var tunnelIcon: View? = null
    private val tunnelCheck = object : Runnable {
        override fun run() {
            showTunnel()
            window.decorView.postDelayed(this, 5_000)
        }
    }

    /** Whether the tab in front goes through the app's WireGuard now. */
    @androidx.annotation.VisibleForTesting
    fun throughTunnel(): Boolean {
        val host = current?.web?.url?.let { Uri.parse(it).host } ?: return false
        val wg = (application as BurrowApp).wireguard
        return wg.active && wg.proxyFor(host, null) != null
    }

    /** The tunnel sign is shown in the bar. */
    @VisibleForTesting
    fun tunnelShown(): Boolean = tunnelIcon?.visibility == View.VISIBLE

    private fun showTunnel() {
        tunnelIcon?.visibility = if (throughTunnel()) View.VISIBLE else View.GONE
    }

    override fun onResume() {
        super.onResume()
        window.decorView.post(tunnelCheck)
        Downloads.listeners.add(downloadsChanged)
        showDownloads()
    }

    override fun onPause() {
        window.decorView.removeCallbacks(tunnelCheck)
        Downloads.listeners.remove(downloadsChanged)
        super.onPause()
    }

    private fun select(tab: Tab) {
        current = tab
        window.decorView.post { showTunnel() }
        for (t in tabs) {
            t.web.visibility = if (t === tab) View.VISIBLE else View.GONE
            val on = t === tab
            val p = Style.palette(this)
            t.chip.background = Style.shape(this, if (on) p.accent else p.sunken, if (on) null else p.border, 19f)
            t.label.setTextColor(if (on) p.accentText else p.text)
            t.label.setTypeface(null, if (on) Typeface.BOLD else Typeface.NORMAL)
            t.close.setColorFilter(if (on) p.accentText else p.dim)
        }
        title = tab.name
        showError()
    }

    /** [leave]: the last one gone, back to Burrow (not when another tab is about to open). */
    private fun close(tab: Tab, leave: Boolean = true) {
        tabs.remove(tab)
        openIds.remove(tab.id)
        strip.removeView(tab.chip)
        content.removeView(tab.web)
        tab.web.destroy()
        if (!leave) return
        val next = tabs.lastOrNull()
        if (next != null) {
            select(next)
        } else {
            // The last one: nothing left here, back to Burrow.
            toBurrow()
            finish()
        }
    }

    companion object {
        /** The apps open as tabs now, for Burrow's Apps page (Bridge "openApps"). */
        val openIds: MutableSet<Long> = java.util.Collections.synchronizedSet(LinkedHashSet())
        const val EXTRA_ID = "id"
        const val EXTRA_NAME = "name"
        const val EXTRA_URL = "url"
    }
}
