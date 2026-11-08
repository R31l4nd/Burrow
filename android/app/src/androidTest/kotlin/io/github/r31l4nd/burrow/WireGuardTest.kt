package io.github.r31l4nd.burrow

import android.net.http.SslError
import android.util.Base64
import android.webkit.HttpAuthHandler
import android.webkit.SslErrorHandler
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import io.github.r31l4nd.burrow.wg.wgtunnel.Wgtunnel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The app's own WireGuard against a real server (android/test/wg-server.sh,
 * its page only on the tunnel's side): the WebView reaches it through the
 * tunnel's proxy, answering the proxy's question itself, and only for the
 * addresses chosen; another app without the secret gets nowhere.
 */
@RunWith(AndroidJUnit4::class)
@org.junit.FixMethodOrder(org.junit.runners.MethodSorters.NAME_ASCENDING)
class WireGuardTest : WebTestBase() {
    private val conf: String
        get() = String(Base64.decode(InstrumentationRegistry.getArguments().getString("wgConf")!!, Base64.DEFAULT))

    private fun override(config: ProxyConfig?) {
        val done = CountDownLatch(1)
        instr.runOnMainSync {
            val c = ProxyController.getInstance()
            if (config == null) c.clearProxyOverride({ it.run() }) { done.countDown() } else c.setProxyOverride(config, { it.run() }) { done.countDown() }
        }
        assertTrue("proxy override applied", done.await(10, TimeUnit.SECONDS))
    }

    @Test
    fun w1_theWebViewGoesThroughTheTunnel() {
        assertTrue(WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE))
        assertTrue(WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS))
        assertEquals("", Wgtunnel.check(conf))
        val tunnel = Wgtunnel.start(conf, "burrow", "s3cret")
        try {
            // Only 10.99.0.1 through the tunnel; everything else as usual.
            override(ProxyConfig.Builder().addProxyRule("127.0.0.1:${tunnel.port()}").addBypassRule("10.99.0.1").setReverseBypassEnabled(true).build())
            var asked = 0
            var web: WebView? = null
            instr.runOnMainSync {
                web = WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    // Every load over the network (a cached page asks no proxy).
                    settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
                    webViewClient = object : WebViewClient() {
                        override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) {
                            asked++
                            if (realm == "burrow-wireguard") handler.proceed("burrow", "s3cret") else handler.cancel()
                        }

                        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) = handler.cancel()
                    }
                    loadUrl("http://10.99.0.1:8080/?w1")
                }
            }
            waitJs({ web!! }, "document.body && document.body.innerText.includes('hello through the tunnel')")
            assertTrue("the app answered the proxy's question", asked >= 1)

            // Another app on the phone, without the secret: 407, nothing forwarded.
            Socket("127.0.0.1", tunnel.port().toInt()).use { s ->
                s.getOutputStream().write("CONNECT 10.99.0.1:8080 HTTP/1.1\r\nHost: 10.99.0.1:8080\r\n\r\n".toByteArray())
                val status = s.getInputStream().bufferedReader().readLine()
                assertTrue("without the secret: $status", status.contains("407"))
            }
            assertTrue("a handshake happened", tunnel.lastHandshake() > 0)
        } finally {
            override(null)
            tunnel.stop()
        }
    }

    /** The app's side: sealed configuration, home or away, what goes through. */
    @Test
    fun w2_awayTheChosenAddressesGoThroughTheTunnel() {
        val wg = app.wireguard
        wg.remove()
        assertTrue(wg.save("[Interface]\nPrivateKey = nonsense\n") != null)
        assertEquals(null, wg.save(conf))
        // Sealed on disk: the private key is not readable in the file.
        val key = conf.lines().first { it.startsWith("PrivateKey") }.substringAfter('=').trim()
        val sealed = java.io.File(ctx.filesDir, "wireguard.sealed").readBytes()
        assertTrue("the configuration is sealed", !String(sealed, Charsets.ISO_8859_1).contains(key))
        assertTrue("the summary has no key", !wg.summary().toString().contains(key))
        wg.viaBurrow = false
        wg.hosts = setOf("10.99.0.1")
        try {
            // At home (Burrow answers directly): no tunnel.
            val origin = InstrumentationRegistry.getArguments().getString("origin")!!
            decide(origin, expectUp = false)
            // Away (Burrow does not answer directly): up, and the chosen address goes through.
            decide("https://10.99.0.1:9", expectUp = true)
            var web: WebView? = null
            instr.runOnMainSync {
                web = WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    // Every load over the network (a cached page asks no proxy).
                    settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
                    webViewClient = object : WebViewClient() {
                        override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) {
                            if (!wg.answer(handler, host, realm)) handler.cancel()
                        }
                    }
                    loadUrl("http://10.99.0.1:8080/?w2")
                }
            }
            waitJs({ web!! }, "document.body && document.body.innerText.includes('hello through the tunnel')")

            // The direct route's SSH: a socket through the tunnel.
            assertTrue(wg.carries("10.99.0.1"))
            wg.socketFactory()!!.createSocket("10.99.0.1", 8080).use { s ->
                s.getOutputStream().write("GET / HTTP/1.0\r\nHost: 10.99.0.1\r\n\r\n".toByteArray())
                assertTrue(s.getInputStream().bufferedReader().readText().contains("hello through the tunnel"))
            }

            // The app's own downloads (an update, "Open with") the same way:
            // away from home they went straight and failed.
            val proxy = wg.proxyFor("10.99.0.1", null)
            assertTrue("a download to a carried address goes through the tunnel", proxy != null)
            assertEquals("an address not carried goes straight", null, wg.proxyFor("example.org", null))
            val got = Http.toFile("http://10.99.0.1:8080/?download", null, null, java.io.File(ctx.cacheDir, "wgtest"), "page.html", proxy)
            assertTrue(got.readText().contains("hello through the tunnel"))

            // An app tab through the tunnel says so in its bar (Burrow itself
            // unreachable, as away from home, so opening it keeps the tunnel up).
            val prefs = Prefs(ctx)
            val before = prefs.origin
            prefs.origin = "https://10.99.0.1:9"
            // Open (no lock in this test): the tabs stay in front instead of
            // giving way to Burrow's lock.
            instr.runOnMainSync { app.unlocked = true }
            try {
                val intent = android.content.Intent(ctx, AppTabsActivity::class.java)
                    .putExtra(AppTabsActivity.EXTRA_ID, 99_001L)
                    .putExtra(AppTabsActivity.EXTRA_NAME, "Tunnel app")
                    .putExtra(AppTabsActivity.EXTRA_URL, "http://10.99.0.1:8080/?tab")
                androidx.test.core.app.ActivityScenario.launch<AppTabsActivity>(intent).use { scenario ->
                    lateinit var a: AppTabsActivity
                    scenario.onActivity { a = it }
                    waitJs({ a.currentWebView()!! }, "document.body && document.body.innerText.includes('hello through the tunnel')")
                    // Burrow's Apps page learns it is open (Bridge "openApps"; report 050019).
                    org.junit.Assert.assertTrue("the open tab is listed", AppTabsActivity.openIds.contains(99_001L))
                    var through = false
                    waitUntil("the tab knows it goes through the tunnel") {
                        instr.runOnMainSync { through = a.throughTunnel() }
                        through
                    }
                    waitUntil("the tunnel sign shown", 10_000) {
                        var shown = false
                        instr.runOnMainSync { shown = a.tunnelShown() }
                        shown
                    }

                    // Another app's server on the phone's loopback, asking in the
                    // tunnel's realm as the proxy does: the tab never goes there,
                    // and so never hands it the proxy's secret.
                    val asked = java.util.concurrent.atomic.AtomicInteger()
                    val secretSent = java.util.concurrent.atomic.AtomicBoolean()
                    val lure = java.net.ServerSocket(0, 5, java.net.InetAddress.getByName("127.0.0.1"))
                    val server = Thread {
                        while (!lure.isClosed) {
                            val sock = runCatching { lure.accept() }.getOrNull() ?: break
                            sock.use { c ->
                                val head = c.getInputStream().bufferedReader().let { r -> generateSequence { r.readLine()?.takeIf { it.isNotEmpty() } }.toList() }
                                asked.incrementAndGet()
                                if (head.any { it.startsWith("Authorization:", ignoreCase = true) }) secretSent.set(true)
                                c.getOutputStream().write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"${WireGuard.REALM}\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                            }
                        }
                    }.apply { start() }
                    try {
                        instr.runOnMainSync { a.currentWebView()!!.loadUrl("http://127.0.0.1:${lure.localPort}/") }
                        Thread.sleep(3_000)
                        assertEquals("the phone's loopback is not asked at all", 0, asked.get())
                        assertTrue(!secretSent.get())
                        // Nor by way of a page that redirects there (AUDIT2 AND-03).
                        instr.runOnMainSync { a.currentWebView()!!.loadUrl("http://10.99.0.1:8080/cgi-bin/lure?${lure.localPort}") }
                        Thread.sleep(4_000)
                        assertEquals("a redirect to the phone's loopback is not followed", 0, asked.get())
                        assertTrue(!secretSent.get())
                    } finally {
                        lure.close()
                        server.join(2_000)
                    }
                }
                // The tabs gone: none listed as open any more.
                org.junit.Assert.assertTrue("no tab listed after the tabs closed", AppTabsActivity.openIds.isEmpty())
            } finally {
                prefs.origin = before
                instr.runOnMainSync { app.unlocked = false }
            }

            // The direct route's cache the same way (it went straight and failed away from home).
            val store = DirectStore(ctx)
            assertTrue("the cache synced through the tunnel", store.sync("http://10.99.0.1:8080", "burrow=x", wg.proxyFor("10.99.0.1", null)))
            assertEquals("through the tunnel", store.cache()!!.getString("from"))
            store.clear()

            // A site asking in the tunnel's realm gets nothing; only the proxy does.
            assertEquals(null, wg.credentialsFor("evil.example", WireGuard.REALM))
            assertEquals(null, wg.credentialsFor("127.0.0.1", "some site"))
            assertTrue(wg.credentialsFor("127.0.0.1", WireGuard.REALM) != null)
        } finally {
            wg.stop()
            wg.remove()
        }
    }

    /**
     * The battery: out of sight, the tunnel goes down after a while (2 s
     * here, a minute in the app), but not during a transfer or while a
     * direct session is kept open (with its notification); Stop there ends it.
     */
    @Test
    fun w3_outOfSightTheTunnelGoesDown() {
        val wg = app.wireguard
        wg.remove()
        assertEquals(null, wg.save(conf))
        wg.hosts = setOf("10.99.0.1")
        app.tunnelIdleMs = 2000
        val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
        fun onScreenThenAway() {
            androidx.test.core.app.ActivityScenario.launch<SetupActivity>(android.content.Intent(ctx, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_CHANGE, true))
            Thread.sleep(1000)
            shell("input keyevent KEYCODE_HOME")
        }
        try {
            // Plain: down after the wait.
            decide("https://10.99.0.1:9", expectUp = true)
            onScreenThenAway()
            waitUntil("the tunnel down", 10_000) { !wg.active }
            // Back again: a new start, which the page counts as a change
            // (MainActivity tells the page, which reconnects; it had lost its
            // connections and needed a reload by hand).
            val before = wg.starts
            decide("https://10.99.0.1:9", expectUp = true)
            assertTrue("a start counted after the tunnel went down", wg.starts > before)
            onScreenThenAway()
            waitUntil("the tunnel down again", 10_000) { !wg.active }

            // A transfer running: stays up; once it ends, down.
            decide("https://10.99.0.1:9", expectUp = true)
            TransferService.set(ctx, "test", 1, "test")
            onScreenThenAway()
            Thread.sleep(5000)
            assertTrue("up during a transfer", wg.active)
            TransferService.set(ctx, "test", 0, "")
            waitUntil("the tunnel down after the transfer", 10_000) { !wg.active }

            // A direct session kept open: stays up, with its notification;
            // Stop in the notification ends it, and the tunnel goes down.
            decide("https://10.99.0.1:9", expectUp = true)
            KeepAlive.set(ctx, "s1", true)
            onScreenThenAway()
            Thread.sleep(5000)
            assertTrue("up while kept open", wg.active)
            waitUntil("the keep-open notification", 5_000) { nm.activeNotifications.any { it.id == 2 } }
            ctx.startService(android.content.Intent(ctx, KeepAliveService::class.java).setAction(KeepAliveService.ACTION_STOP))
            waitUntil("the tunnel down after Stop", 10_000) { !wg.active }
            assertTrue("no keep-open left", !KeepAlive.wanted())
        } finally {
            KeepAlive.clear(ctx)
            TransferService.set(ctx, "test", 0, "")
            app.tunnelIdleMs = BurrowApp.TUNNEL_IDLE_MS
            wg.stop()
            wg.remove()
        }
    }

    /**
     * Network changes in quick succession (Wi-Fi drops, mobile data, Wi-Fi
     * back): many decisions at once, from several threads, home and away in
     * turn. The app stays up, every caller gets an answer, and the tunnel
     * ends as the last decision says; the proxy still works then.
     */
    @Test
    fun w4_quickNetworkChangesDoNotCrash() {
        val wg = app.wireguard
        wg.remove()
        assertEquals(null, wg.save(conf))
        wg.viaBurrow = false
        wg.hosts = setOf("10.99.0.1")
        val home = InstrumentationRegistry.getArguments().getString("origin")!!
        val away = "https://10.99.0.1:9"
        // A change of network is noticed at all (without ACCESS_NETWORK_STATE
        // the watch failed without a word).
        var stopWatching: (() -> Unit)? = null
        instr.runOnMainSync { stopWatching = wg.watchNetwork({ home }) {} }
        assertTrue("the network is watched", wg.watching)
        instr.runOnMainSync { stopWatching!!() }
        try {
            val answers = CountDownLatch(40)
            val pool = java.util.concurrent.Executors.newFixedThreadPool(4)
            repeat(40) { i -> pool.execute { wg.decide(if (i % 2 == 0) away else home) { answers.countDown() } } }
            assertTrue("every decision answered", answers.await(120, TimeUnit.SECONDS))
            pool.shutdown()
            // The last word: away. Up, and through the tunnel.
            decide(away, expectUp = true)
            wg.socketFactory()!!.createSocket("10.99.0.1", 8080).use { s ->
                s.getOutputStream().write("GET / HTTP/1.0\r\nHost: 10.99.0.1\r\n\r\n".toByteArray())
                assertTrue(s.getInputStream().bufferedReader().readText().contains("hello through the tunnel"))
            }
            // And home again: down.
            decide(home, expectUp = false)
        } finally {
            wg.stop()
            wg.remove()
        }
    }

    private fun decide(origin: String, expectUp: Boolean) {
        val done = CountDownLatch(1)
        var up: Boolean? = null
        app.wireguard.decide(origin) {
            up = it
            done.countDown()
        }
        assertTrue(done.await(20, TimeUnit.SECONDS))
        assertEquals("tunnel for $origin", expectUp, up)
        assertEquals(expectUp, app.wireguard.active)
    }
}
