package io.github.r31l4nd.burrow

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.annotation.VisibleForTesting
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.Charset
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch

/**
 * The direct route (phase 5): Burrow's terminal page, bundled in the app
 * (web/direct.html), with SSH done by the app itself (DirectSsh) for when
 * Burrow cannot be reached. The page is served from the app's own asset
 * origin and gets a bridge (`BurrowDirect`) only there; it cannot reach the
 * network at all (its CSP says connect-src 'none').
 */
class DirectActivity : AppCompatActivity() {
    private lateinit var web: TermWebView
    // Of the WebView in use: made again with it (renew).
    private var selectionMenu: SelectionMenu? = null
    private val selection: SelectionMenu get() = selectionMenu ?: SelectionMenu(web) { name, data -> emit(name, data) }.also { selectionMenu = it }
    private lateinit var lock: LockGate
    private val store by lazy { DirectStore(this) }
    private val sessions = ConcurrentHashMap<String, Pair<DirectSsh, Charset>>()
    private val backlogs = ConcurrentHashMap<String, DirectBacklog>()
    private val life = Lifetime()
    // Port forwards, with the host's name; they end with this screen.
    private val forwards = ConcurrentHashMap<String, Pair<Forward, String>>()
    private val main = Handler(Looper.getMainLooper())
    private var proxy: JavaScriptReplyProxy? = null
    // Keystrokes and sizes go out one after the other, in the order typed:
    // on a pool, two quick keys could overtake each other.
    private val typing = java.util.concurrent.Executors.newSingleThreadExecutor()

    @get:VisibleForTesting
    val webView: WebView get() = web

    // Stop in the keep-open notification: the page's switch says so too (it stayed on).
    private val keptCleared: () -> Unit = { runOnUiThread { emit("keepCleared", null) } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Insets.secure(window)
        KeepAlive.onCleared = keptCleared
        val root = FrameLayout(this)
        root.setBackgroundColor(Style.palette(this).bg)
        web = newWeb()
        root.addView(web, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        lock = LockGate(this, root) { web }
        setContentView(root)
        Insets.apply(window, root)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            // The page decides: out of a session, or back to Burrow.
            override fun handleOnBackPressed() = emit("back", null)
        })
        web.loadUrl(PAGE)
    }

    private val assets by lazy { WebViewAssetLoader.Builder().addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this)).build() }

    /** The page's WebView, with its clients and the bridge; made again when the renderer went (renew). */
    private fun newWeb(): TermWebView {
        val w = TermWebView(this)
        WebSetup.configure(w)
        w.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                // Only the bundled files; anything else is refused, not fetched.
                assets.shouldInterceptRequest(request.url) ?: WebResourceResponse("text/plain", "utf-8", 404, "Not here", emptyMap(), null)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = request.url.host != ASSET_HOST

            // All of the app's WebViews share one renderer. Its loss not handled here, Android ends the
            // whole app with it, and every session of this screen with it (A3-AND-02).
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                renew(view)
                return true
            }
        }
        // Without a chrome client, confirm() answers false without asking:
        // leaving a session would silently do nothing.
        w.webChromeClient = WebSetup.OwnPageChrome(this)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, "BurrowDirect", setOf(ORIGIN), Listener())
        }
        return w
    }

    // The session the page shows (it attached last), and the one a new page takes up again.
    @Volatile private var showing: String? = null
    @Volatile private var resume: String? = null

    /**
     * The renderer went: the sessions live here, not in the page, so they
     * stay. A new WebView loads the page again, which takes up the session it
     * showed (takeConnectTo's "resume"); its output meanwhile is held for it.
     */
    private fun renew(dead: WebView) {
        proxy = null
        val root = dead.parent as? FrameLayout
        val at = root?.indexOfChild(dead) ?: -1
        root?.removeView(dead)
        dead.destroy()
        if (root == null || isFinishing || isDestroyed) return
        resume = showing?.takeIf { sessions.containsKey(it) }
        resume?.let { backlogs[it] = DirectBacklog() }
        showing = null
        selectionMenu = null
        web = newWeb()
        root.addView(web, if (at >= 0) at else 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        lock.refresh()
        // The keyboard's focus to the new page (the dead one had it).
        if (!lock.covered) web.requestFocus()
        web.loadUrl(PAGE)
    }

    /**
     * Opened again while it runs (its own task, singleTask): for one host, the
     * page loads again to take it, unless it shows a session now (one at a
     * time; the new host waits until that one is left).
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getLongExtra(EXTRA_HOST, 0) > 0 && showing == null && ::web.isInitialized) web.loadUrl(PAGE)
    }

    // The volume keys, while a terminal takes them: to the page, not the volume.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Locked: no key reaches the page behind the cover (A3-AND-08).
        val key = if (::web.isInitialized && !lock.covered) TerminalMode.volumeKey(web, event) else null
        if (key != null) {
            if (key.isNotEmpty()) emit("volumeKey", key)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onStart() {
        super.onStart()
        lock.onStart()
    }

    override fun onResume() {
        super.onResume()
        lock.onResume()
    }

    override fun onDestroy() {
        // Not persistent by design: leaving the direct route ends its sessions,
        // and those still being made are closed when they arrive (Lifetime).
        life.end()
        if (KeepAlive.onCleared === keptCleared) KeepAlive.onCleared = null
        sessions.keys.forEach { KeepAlive.set(this, it, false) }
        (sessions.keys + forwards.keys).forEach { (application as BurrowApp).wireguard.done(it) }
        sessions.values.forEach { it.first.close() }
        sessions.clear()
        backlogs.clear()
        forwards.values.forEach { it.first.close() }
        forwards.clear()
        typing.shutdown()
        web.destroy()
        super.onDestroy()
    }

    private fun emit(name: String, data: Any?) {
        main.post { runCatching { WebSetup.send(proxy, BridgeProtocol.event(name, data)) } }
    }

    private fun cache(): JSONObject? = store.cache()

    private fun host(id: Long): JSONObject {
        val hosts = cache()?.optJSONArray("hosts") ?: throw IllegalStateException("no cache")
        for (i in 0 until hosts.length()) if (hosts.getJSONObject(i).getLong("id") == id) return hosts.getJSONObject(i)
        throw IllegalArgumentException("unknown host")
    }

    private fun known(h: JSONObject): List<HostKeys.Known> {
        val a = h.optJSONArray("hostKeys") ?: JSONArray()
        val fromBurrow = (0 until a.length()).map { a.getJSONObject(it).let { k -> HostKeys.Known(k.getString("keyType"), k.getString("keyB64")) } }
        val here = store.trustedHere(h.getLong("id")).map { HostKeys.Known(SshWire.keyType(Base64.getDecoder().decode(it)), it) }
        return HostKeys.known(fromBurrow, here)
    }

    /** Blocks the calling (background) thread until the user confirmed with a fingerprint. */
    private fun confirmOnMain(hostName: String): Boolean {
        val latch = CountDownLatch(1)
        var ok = false
        main.post {
            if (life.isEnded) return@post latch.countDown()
            Biometrics.confirm(this, getString(R.string.direct_confirm_title, hostName), getString(R.string.direct_confirm_subtitle)) {
                ok = it
                latch.countDown()
            }
        }
        // Not for ever: the screen left, or nobody answering in two minutes, is a no.
        return life.await(latch, 120_000) && ok
    }

    private inner class Listener : WebViewCompat.WebMessageListener {
        override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, reply: JavaScriptReplyProxy) {
            if (!BridgeProtocol.fromPage(isMainFrame, sourceOrigin.toString(), ORIGIN)) return
            val req = BridgeProtocol.parse(message.data ?: return) ?: return
            proxy = reply
            val answer: (Result<Any?>) -> Unit = { r ->
                main.post {
                    WebSetup.send(reply, r.fold({ BridgeProtocol.result(req.id, it) }, { BridgeProtocol.error(req.id, it.message ?: it.javaClass.simpleName) }))
                }
            }
            val work = { f: () -> Any? -> WebSetup.io.execute { answer(runCatching(f)) } }
            try {
                handle(req.method, req.params, answer, work)
            } catch (e: Exception) {
                answer(Result.failure(e))
            }
        }
    }

    private fun session(p: JSONObject) = sessions[p.getString("sessionId")] ?: throw IllegalStateException("session ended")

    private fun handle(method: String, p: JSONObject, answer: (Result<Any?>) -> Unit, work: (() -> Any?) -> Unit) {
        when (method) {
            "info" -> answer(Result.success(BridgeProtocol.obj("version" to BuildConfig.VERSION_NAME, "uiPrefs" to JSONObject(Prefs(this).uiPrefs), "selectionMenu" to true)))

            // Opened for one host (from its sheet in Burrow): which, once.
            "terminal" -> {
                TerminalMode.apply(this, web, p)
                answer(Result.success(null))
            }

            "selectionMenu" -> {
                selection.show(p)
                answer(Result.success(null))
            }

            "takeConnectTo" -> {
                val id = intent.getLongExtra(EXTRA_HOST, 0).takeIf { it > 0 }
                intent.removeExtra(EXTRA_HOST)
                // A page loaded again after its renderer went: the session it showed, to take up again.
                // With whether it is kept open now (the page started its switch off, the app kept it on).
                val back = resume?.let { r -> shown[r]?.let { JSONObject(it.toString()).put("keepOpen", KeepAlive.has(r)) } }
                resume = null
                answer(Result.success(BridgeProtocol.obj("hostId" to id, "resume" to back)))
            }

            "cache" -> work {
                val c = cache() ?: return@work null
                // What was typed here comes first in the suggestions.
                val hosts = c.optJSONArray("hosts") ?: JSONArray()
                for (i in 0 until hosts.length()) {
                    val h = hosts.getJSONObject(i)
                    val mine = store.recorded(h.getLong("id"))
                    if (mine.isEmpty()) continue
                    val merged = JSONArray()
                    mine.forEach { merged.put(BridgeProtocol.obj("command" to it, "count" to 1, "lastAt" to c.optString("generatedAt"))) }
                    val old = h.optJSONArray("history") ?: JSONArray()
                    for (j in 0 until old.length()) if (old.getJSONObject(j).getString("command") !in mine) merged.put(old.getJSONObject(j))
                    h.put("history", merged)
                }
                c
            }

            "connect" -> {
                val h = host(p.getLong("hostId"))
                val cols = p.getInt("cols").coerceIn(10, 500)
                val rows = p.getInt("rows").coerceIn(4, 200)
                work {
                    val id = UUID.randomUUID().toString()
                    // Held until the page says it listens ("attach"), so the first prompt is not lost.
                    backlogs[id] = DirectBacklog()
                    val charset = runCatching { Charset.forName(h.optString("encoding").ifEmpty { "UTF-8" }) }.getOrDefault(Charsets.UTF_8)
                    // Through the app's WireGuard when this host is set to and
                    // it cannot be reached straight (away from home).
                    val wg = (application as BurrowApp).wireguard
                    val address = h.getString("address")
                    val carried = wg.configured && address.lowercase() in wg.hosts
                    var viaWg = carried && !reachable(address, h.getInt("port")) && wg.start()
                    val open = { through: Boolean -> DirectSsh.connect(
                        id, address, h.getInt("port"), h.getString("username"), known(h), cols, rows, charset,
                        sockets = if (through) wg.socketFactory() else null,
                        authorize = { confirmOnMain(h.getString("name")) },
                        keep = p.optBoolean("keep", true),
                        // Through the backlog in use now: a page loaded again holds what came meanwhile (renew).
                        onOutput = { text -> backlogs[id]?.output(text)?.let { emit("output", BridgeProtocol.obj("sessionId" to id, "data" to it)) } },
                        onClosed = {
                            sessions.remove(id)
                            wg.done(id)
                            shown.remove(id)
                            KeepAlive.set(this, id, false)
                            if (backlogs[id]?.close(it) != false) {
                                backlogs.remove(id)
                                emit("closed", BridgeProtocol.obj("sessionId" to id, "message" to it))
                            }
                        },
                    ) }
                    var r = open(viaWg)
                    // Straight, another network's machine answered at this address: through the tunnel (A3-AND-06).
                    if (DirectPath.tryTunnelAfter(r is DirectSsh.Connected.HostKey, viaWg, carried) && wg.start()) {
                        viaWg = true
                        r = open(true)
                    }
                    if (r !is DirectSsh.Connected.Ok) backlogs.remove(id)
                    when (r) {
                        is DirectSsh.Connected.Ok -> {
                            if (!life.keep(r.ssh, { it.close() }) { sessions[id] = it to charset }) throw IllegalStateException("the direct screen was closed")
                            // Through the tunnel: a decision "at home" leaves it up while this runs (review 2026-10-24).
                            if (viaWg) wg.use(id)
                            shown[id] = BridgeProtocol.obj("sessionId" to id, "hostId" to h.getLong("id"), "viaWireGuard" to viaWg, "kept" to r.ssh.kept)
                            BridgeProtocol.obj("status" to "ok", "sessionId" to id, "viaWireGuard" to viaWg, "kept" to r.ssh.kept)
                        }
                        is DirectSsh.Connected.Forwarding -> BridgeProtocol.obj("status" to "error", "message" to "not a shell")
                        is DirectSsh.Connected.HostKey -> {
                            pendingKeys[h.getLong("id")] = r.keyB64
                            when (val v = r.verdict) {
                                is HostKeys.Verdict.Unknown -> BridgeProtocol.obj("status" to "unknown_host_key", "keyType" to v.keyType, "fingerprint" to v.fingerprint)
                                is HostKeys.Verdict.Changed -> BridgeProtocol.obj("status" to "host_key_changed", "keyType" to v.keyType, "fingerprint" to v.fingerprint)
                                else -> BridgeProtocol.obj("status" to "error", "message" to "host key")
                            }
                        }
                        is DirectSsh.Connected.Failed -> BridgeProtocol.obj("status" to r.status, "message" to r.message)
                    }
                }
            }

            // A port of the host (a web page on it) on the phone's 127.0.0.1,
            // over its own SSH connection (through WireGuard when set up so).
            "forward" -> {
                val h = host(p.getLong("hostId"))
                val targetHost = p.optString("targetHost").ifEmpty { "127.0.0.1" }
                require(targetHost.matches(Regex("^[A-Za-z0-9.:\\[\\]-]{1,253}$"))) { "not a host name" }
                val targetPort = p.getInt("targetPort").also { require(it in 1..65535) { "not a port" } }
                work {
                    val id = UUID.randomUUID().toString()
                    val wg = (application as BurrowApp).wireguard
                    val address = h.getString("address")
                    val carried = wg.configured && address.lowercase() in wg.hosts
                    var viaWg = carried && !reachable(address, h.getInt("port")) && wg.start()
                    val open = { through: Boolean -> DirectSsh.connect(
                        id, address, h.getInt("port"), h.getString("username"), known(h), 80, 24, Charsets.UTF_8,
                        sockets = if (through) wg.socketFactory() else null,
                        authorize = { confirmOnMain(h.getString("name")) },
                        onOutput = {},
                        onClosed = {},
                        forwardTo = targetHost to targetPort,
                    ) }
                    var r = open(viaWg)
                    if (DirectPath.tryTunnelAfter(r is DirectSsh.Connected.HostKey, viaWg, carried) && wg.start()) {
                        viaWg = true
                        r = open(true)
                    }
                    when (r) {
                        is DirectSsh.Connected.Forwarding -> {
                            if (!life.keep(r.forward, { it.close() }) { forwards[id] = it to h.getString("name") }) throw IllegalStateException("the direct screen was closed")
                            if (viaWg) wg.use(id)
                            BridgeProtocol.obj("status" to "ok", "forwardId" to id, "localPort" to r.forward.localPort, "viaWireGuard" to viaWg)
                        }
                        is DirectSsh.Connected.HostKey -> {
                            pendingKeys[h.getLong("id")] = r.keyB64
                            BridgeProtocol.obj("status" to "error", "message" to "Connect to this host once first, to trust its key.")
                        }
                        is DirectSsh.Connected.Failed -> BridgeProtocol.obj("status" to r.status, "message" to r.message)
                        is DirectSsh.Connected.Ok -> BridgeProtocol.obj("status" to "error", "message" to "not a forward")
                    }
                }
            }

            "forwards" -> answer(
                Result.success(
                    org.json.JSONArray(
                        forwards.map { (id, v) -> BridgeProtocol.obj("forwardId" to id, "hostName" to v.second, "localPort" to v.first.localPort, "targetHost" to v.first.target.first, "targetPort" to v.first.target.second) },
                    ),
                ),
            )

            "stopForward" -> {
                forwards.remove(p.getString("forwardId"))?.first?.close()
                (application as BurrowApp).wireguard.done(p.getString("forwardId"))
                answer(Result.success(null))
            }

            // Open a forwarded page in the phone's browser (this phone's 127.0.0.1 only).
            "openForward" -> {
                val f = forwards[p.getString("forwardId")]?.first ?: throw IllegalStateException("no such forward")
                val scheme = if (p.optBoolean("https")) "https" else "http"
                startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("$scheme://127.0.0.1:${f.localPort}/")))
                answer(Result.success(null))
            }

            // Only a key this screen was just shown, only for a host Burrow knows no key of.
            "trust" -> {
                val id = p.getLong("hostId")
                val h = host(id)
                val keyB64 = pendingKeys[id] ?: throw IllegalStateException("connect first")
                val blob = Base64.getDecoder().decode(keyB64)
                require(SshWire.fingerprint(blob) == p.getString("fingerprint")) { "fingerprint changed" }
                require(HostKeys.judge(blob, known(h)) is HostKeys.Verdict.Unknown) { "not an unknown key" }
                store.trustHere(id, keyB64)
                pendingKeys.remove(id)
                answer(Result.success(null))
            }

            // The page listens for this session now: what came before goes out, in order, then the rest as it comes.
            "attach" -> {
                val id = p.getString("sessionId")
                showing = id
                val b = backlogs[id]
                if (b != null) {
                    val (text, end) = b.attach()
                    if (text.isNotEmpty()) emit("output", BridgeProtocol.obj("sessionId" to id, "data" to text))
                    if (end.first) {
                        backlogs.remove(id)
                        emit("closed", BridgeProtocol.obj("sessionId" to id, "message" to end.second))
                    }
                }
                answer(Result.success(null))
            }

            "input" -> {
                val (ssh, charset) = session(p)
                val data = p.getString("data")
                typing.execute { answer(runCatching { ssh.input(data, charset) }) }
            }

            "resize" -> {
                val (ssh) = session(p)
                val cols = p.getInt("cols").coerceIn(10, 500)
                val rows = p.getInt("rows").coerceIn(4, 200)
                typing.execute { answer(runCatching { ssh.resize(cols, rows) }) }
            }

            "close" -> {
                val id = p.getString("sessionId")
                val s = sessions.remove(id)
                (application as BurrowApp).wireguard.done(id)
                backlogs.remove(id)
                shown.remove(id)
                if (showing == id) showing = null
                KeepAlive.set(this, id, false)
                // "end": the kept session on the host goes too; else only this connection.
                val end = p.optBoolean("end", false)
                work { s?.first?.let { if (end) it.end() else it.close() } }
            }

            // Kept open in the background: the tunnel stays up under it (a
            // notification says so), and SSH keepalives hold the line.
            "keepAlive" -> {
                val id = p.getString("sessionId")
                val (ssh) = session(p)
                val on = p.getBoolean("on")
                ssh.keepAlive(if (on) 30 else 0)
                KeepAlive.set(this, id, on)
                answer(Result.success(null))
            }

            "exec" -> {
                val (ssh) = session(p)
                val script = p.getString("script")
                val cwd = p.optString("cwd").ifEmpty { null }
                work { BridgeProtocol.obj("stdout" to ssh.exec(script, cwd)) }
            }

            "ls" -> {
                val (ssh) = session(p)
                val path = p.optString("path")
                val cwd = p.optString("cwd").ifEmpty { null }
                work {
                    val (dir, entries) = ssh.ls(path, cwd)
                    BridgeProtocol.obj("dir" to dir, "entries" to BridgeProtocol.array(entries.map { (name, isDir, link) -> BridgeProtocol.obj("name" to name, "dir" to isDir, "link" to link) }))
                }
            }

            "record" -> {
                val id = p.getLong("hostId")
                val cmd = p.getString("command")
                work { store.record(id, cmd) }
            }

            "backToBurrow" -> {
                // Burrow's own task (the direct route has its own, A3-AND-04).
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                finish()
                answer(Result.success(null))
            }

            else -> answer(Result.failure(IllegalArgumentException("unknown method $method")))
        }
    }

    private val pendingKeys = ConcurrentHashMap<Long, String>()

    // What a page needs to take a session up again (takeConnectTo's "resume").
    private val shown = ConcurrentHashMap<String, JSONObject>()

    companion object {
        private const val PAGE = "https://appassets.androidplatform.net/direct/direct.html"
        const val EXTRA_HOST = "hostId"
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$ASSET_HOST"
    }

    /** A TCP connection to the host works without the tunnel (a short wait). */
    private fun reachable(host: String, port: Int): Boolean = runCatching {
        java.net.Socket().use { it.connect(java.net.InetSocketAddress(host, port), 2000) }
        true
    }.getOrDefault(false)
}
