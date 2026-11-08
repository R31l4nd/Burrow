package io.github.r31l4nd.burrow

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.HttpAuthHandler
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import io.github.r31l4nd.burrow.wg.wgtunnel.Tunnel
import io.github.r31l4nd.burrow.wg.wgtunnel.Wgtunnel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.URL
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.SocketFactory

/**
 * The app's own WireGuard (phase 13): wireguard-go in the app's process
 * (android/wg), no VPN service, so it works next to another VPN and carries
 * only Burrow's traffic. Away from home (Burrow not reachable directly) it
 * comes up by itself and the chosen addresses go through it: Burrow, app
 * tabs, and the direct route's hosts.
 *
 * The configuration (its private key) is sealed with a key in the Android
 * Keystore and never leaves the phone. The tunnel is reached through a proxy
 * on 127.0.0.1 that asks for a secret made at every start; only this app
 * answers it (and only when the proxy itself asks).
 */
class WireGuard(private val context: Context) {
    private val sp = context.getSharedPreferences("burrow-wg", Context.MODE_PRIVATE)
    private val file = File(context.filesDir, "wireguard.sealed")
    private val main = Handler(Looper.getMainLooper())

    @Volatile private var tunnel: Tunnel? = null
    private val user = "burrow"
    @Volatile private var secret = ""
    @Volatile var lastError: String? = null
        private set

    // ---- what is set up

    val configured: Boolean get() = file.exists()

    /** Burrow itself through the tunnel when away (on by default). */
    var viaBurrow: Boolean
        get() = sp.getBoolean("burrow", true)
        set(v) = sp.edit().putBoolean("burrow", v).apply()

    /** Other host names through it when away: app tabs and direct-route hosts. */
    var hosts: Set<String>
        get() = sp.getStringSet("hosts", emptySet())?.toSet() ?: emptySet()
        set(v) = sp.edit().putStringSet("hosts", v.map { it.lowercase() }.toSet()).apply()

    /** Checks and keeps a wg-quick configuration; returns what is wrong, or null. */
    fun save(conf: String): String? {
        val problem = Wgtunnel.check(conf)
        if (problem.isNotEmpty()) return problem
        stop()
        file.writeBytes(Sealed.seal(conf.toByteArray()))
        lastError = null
        return null
    }

    fun remove() {
        stop()
        file.delete()
    }

    private fun conf(): String? = if (file.exists()) runCatching { String(Sealed.open(file.readBytes())) }.getOrNull() else null

    /** What the settings show: never the private key. */
    fun summary(): JSONObject {
        val c = conf()
        val o = JSONObject()
            .put("configured", c != null)
            .put("active", tunnel != null)
            .put("viaBurrow", viaBurrow)
            .put("hosts", JSONArray(hosts.sorted()))
            .put("error", lastError ?: JSONObject.NULL)
            .put("proxyOverride", WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS))
        tunnel?.let { o.put("lastHandshake", it.lastHandshake()) }
        if (c != null) for ((k, v) in WgConf.shown(c)) o.put(k, v)
        return o
    }

    // ---- running

    val active: Boolean get() = tunnel != null

    /**
     * Why the tunnel's proxy last turned a request down, or null: a name its
     * own DNS did not find (the phone's DNS is never asked, A3-AND-01), an
     * address outside AllowedIPs. The error screens say it.
     */
    val lastRefusal: String? get() = runCatching { tunnel?.lastRefusal() }.getOrNull()?.takeIf { it.isNotEmpty() }

    /** Brings the tunnel up (if set up and not up yet); false when it cannot. */
    // The proxy's port, kept when the tunnel starts: asking a tunnel that was
    // stopped meanwhile (on another thread) for it crashed the app.
    @Volatile
    private var proxyPort = 0

    /** How many times a tunnel started: a new one means a page loaded before it needs loading again. */
    @Volatile
    var starts = 0
        private set

    /** Whether some screen of the app is seen now (BurrowApp tells). */
    @Volatile
    var inSight: () -> Boolean = { true }

    /** Direct sessions and forwards going through the tunnel now: "home" leaves it up for them. */
    private val users = TunnelUsers()
    fun use(id: String) = users.use(id)
    fun done(id: String) = users.done(id)

    @Synchronized
    fun start(): Boolean {
        if (tunnel != null) return true
        val c = conf() ?: return false
        secret = ByteArray(24).also { SecureRandom().nextBytes(it) }.let { Base64.encodeToString(it, Base64.NO_WRAP or Base64.URL_SAFE) }
        // No keepalives (WgConf.withoutKeepalive): a terminal has its own heartbeat.
        val quiet = WgConf.withoutKeepalive(c)
        return runCatching { Wgtunnel.start(quiet, user, secret) }.fold(
            {
                tunnel = it
                proxyPort = it.port().toInt()
                starts++
                lastError = null
                true
            },
            {
                lastError = it.message ?: it.toString()
                false
            },
        )
    }

    /**
     * Down, from the main thread: on the deciding thread, in turn. stop() waits for a start()
     * still resolving the endpoint's name, which blocked the screen for the DNS timeout.
     */
    fun stopSoon() = decider.execute { stop() }

    @Synchronized
    fun stop() {
        tunnel?.stop()
        tunnel = null
        main.post { clearProxy() }
    }

    // What the WebViews were last told: the same again is not told again.
    // Setting a proxy, even the same one, makes the WebView drop its open
    // connections (a terminal's among them), and coming back to the app
    // decides again each time.
    private var applied: String? = null

    /** The WebViews' traffic for these hosts through the tunnel (on the main thread). */
    fun applyProxy(origin: String?, done: () -> Unit = {}) {
        if (tunnel == null) return clearProxy(done)
        val port = proxyPort
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return done()
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS)) return done()
        val targets = proxyTargets(hosts, viaBurrow, origin?.let { Uri.parse(it).host })
        if (targets.isEmpty()) return clearProxy(done)
        val key = "$port ${targets.sorted().joinToString(",")}"
        if (key == applied) return done()
        applied = key
        val b = ProxyConfig.Builder().addProxyRule("127.0.0.1:$port").setReverseBypassEnabled(true)
        for (h in targets) b.addBypassRule(h)
        ProxyController.getInstance().setProxyOverride(b.build(), { it.run() }) { done() }
    }

    private fun clearProxy(done: () -> Unit = {}) {
        applied = null
        if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) ProxyController.getInstance().clearProxyOverride({ it.run() }) { done() } else done()
    }

    /**
     * The proxy asks who we are (407): answer with the secret, only when it
     * is the proxy on 127.0.0.1 asking in its own realm. A site that asks in
     * that realm gets nothing.
     */
    fun answer(handler: HttpAuthHandler, host: String?, realm: String?): Boolean {
        val (u, s) = credentialsFor(host, realm) ?: return false
        handler.proceed(u, s)
        return true
    }

    /** The user and secret for this question, or null when it is not the tunnel's proxy asking. */
    fun credentialsFor(host: String?, realm: String?): Pair<String, String>? =
        if (!answersProxy(tunnel != null, host, realm)) null else user to secret

    /**
     * The app's own downloads (an update, "Open with", a file to Downloads)
     * the way the page goes: through the tunnel when it carries this host,
     * else null (straight). Away from home they failed ("failed to connect
     * ... after 15000ms") while the page worked.
     */
    fun proxyFor(host: String?, origin: String?): java.net.Proxy? {
        if (tunnel == null || !routes(host, origin?.let { Uri.parse(it).host }, hosts, viaBurrow)) return null
        ensureProxyAuth()
        return java.net.Proxy(java.net.Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxyPort))
    }

    // The proxy asks who we are (407) on those downloads too: the secret,
    // only for the tunnel's proxy on this phone, in its own realm.
    @Volatile
    private var authSet = false

    private fun ensureProxyAuth() {
        if (authSet) return
        authSet = true
        java.net.Authenticator.setDefault(object : java.net.Authenticator() {
            override fun getPasswordAuthentication(): java.net.PasswordAuthentication? {
                if (!localProxyAsks(requestorType == RequestorType.PROXY, requestingSite, requestingHost)) return null
                val (u, s) = credentialsFor("127.0.0.1", requestingPrompt) ?: return null
                return java.net.PasswordAuthentication(u, s.toCharArray())
            }
        })
    }

    /** Whether this host goes through the tunnel now (for the direct route). */
    fun carries(host: String): Boolean = tunnel != null && host.lowercase() in hosts

    /** Sockets that reach their address through the tunnel (CONNECT on the proxy). */
    fun socketFactory(): SocketFactory? {
        if (tunnel == null) return null
        val port = proxyPort
        val auth = "Basic " + Base64.encodeToString("$user:$secret".toByteArray(), Base64.NO_WRAP)
        return object : SocketFactory() {
            override fun createSocket() = TunnelSocket(port, auth)
            override fun createSocket(host: String, p: Int) = TunnelSocket(port, auth).apply { connect(InetSocketAddress.createUnresolved(host, p)) }
            override fun createSocket(host: String, p: Int, la: java.net.InetAddress?, lp: Int) = createSocket(host, p)
            override fun createSocket(host: java.net.InetAddress, p: Int) = createSocket(host.hostAddress!!, p)
            override fun createSocket(a: java.net.InetAddress, p: Int, la: java.net.InetAddress?, lp: Int) = createSocket(a.hostAddress!!, p)
        }
    }

    // ---- away from home: is Burrow reachable directly?

    /** Burrow answers without the tunnel (off the main thread; a short wait). */
    fun reachableDirectly(origin: String): Boolean = reachable(origin)

    /**
     * At home: tunnel down. Away: tunnel up and the chosen addresses through
     * it. Calls back on the main thread with whether the tunnel is in use.
     */
    // One decision at a time, in order: two network changes in a row made
    // two threads start and stop the tunnel under each other. A decision that
    // a newer one overtook does nothing but answer with the state as it is.
    private val decider = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val decisions = java.util.concurrent.atomic.AtomicInteger()

    fun decide(origin: String?, then: (Boolean) -> Unit) {
        val mine = decisions.incrementAndGet()
        decider.execute {
            if (mine != decisions.get()) {
                main.post { then(active) }
                return@execute
            }
            val away = configured && origin != null && !reachableDirectly(origin)
            // Up already, on what may be another network now: its socket made anew (roaming).
            if (away) tunnel?.let { runCatching { it.rebind() } }
            val up = away && start()
            if (stopAtHome(away, tunnel != null, users.any(), KeepAlive.wanted())) stop()
            main.post { if (up) applyProxy(origin) { then(active) } else then(false) }
        }
    }

    /**
     * Decides again when the phone changes network (home Wi-Fi, mobile data),
     * and once more when the new network is validated and a little later: a
     * Wi-Fi that has just connected often cannot reach Burrow for a few
     * seconds yet (DNS), which kept the tunnel up at home.
     */
    /** A change of network is noticed now (watchNetwork took). */
    @androidx.annotation.VisibleForTesting
    @Volatile
    var watching = false
        private set

    fun watchNetwork(origin: () -> String?, changed: (Boolean) -> Unit): () -> Unit {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        var last: Network? = null
        var validated = false
        // Out of sight and down (the battery rule): a network change does not bring it up again.
        val again = Runnable { if (configured && decideOnNetworkChange(inSight(), active)) decide(origin(), changed) }
        fun soon() {
            main.removeCallbacks(again)
            main.post(again)
            main.postDelayed(again, 5_000)
            main.postDelayed(again, 15_000)
        }
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (network == last) return
                last = network
                validated = false
                soon()
            }

            override fun onCapabilitiesChanged(network: Network, caps: android.net.NetworkCapabilities) {
                val now = caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                if (network == last && now && !validated) {
                    validated = true
                    soon()
                }
            }
        }
        // Needs ACCESS_NETWORK_STATE: without it this failed without a word
        // and a change of network went unnoticed.
        watching = runCatching { cm.registerDefaultNetworkCallback(cb) }.isSuccess
        return {
            main.removeCallbacks(again)
            runCatching { cm.unregisterNetworkCallback(cb) }
            watching = false
        }
    }

    companion object {
        const val REALM = "burrow-wireguard"

        /**
         * Who gets the proxy's secret: only the tunnel's own proxy, i.e. a
         * question from exactly 127.0.0.1 in exactly its realm while a tunnel
         * runs. A site asking in that realm, or another loopback spelling,
         * gets nothing (A3-AND-13: the decision itself, tested).
         */
        fun answersProxy(active: Boolean, host: String?, realm: String?): Boolean = active && realm == REALM && host == "127.0.0.1"

        /** host:port for a CONNECT line: an IPv6 address in brackets, or the proxy cannot split it (AUDIT2 AND-16). */
        fun authority(host: String, port: Int): String = if (host.contains(':')) "[${host.trim('[', ']')}]:$port" else "$host:$port"

        /**
         * Whether a request for [host] goes through the tunnel (the app's own
         * downloads): one of the chosen hosts, or Burrow's own ([burrowHost])
         * when Burrow goes through it too. Any case; anything else straight.
         */
        fun routes(host: String?, burrowHost: String?, hosts: Set<String>, viaBurrow: Boolean): Boolean {
            val h = host?.lowercase() ?: return false
            return h in hosts || (viaBurrow && h == burrowHost?.lowercase())
        }

        /** The hosts the WebViews send through the tunnel's proxy: the chosen ones, and Burrow's when it goes through it too. */
        fun proxyTargets(hosts: Set<String>, viaBurrow: Boolean, burrowHost: String?): Set<String> =
            hosts + listOfNotNull(if (viaBurrow) burrowHost else null)

        /**
         * A question for a password the app's own requests may answer with the
         * proxy's secret: the proxy (not a site) asking, from this phone itself.
         * The realm is checked after (credentialsFor).
         */
        fun localProxyAsks(proxy: Boolean, site: java.net.InetAddress?, host: String?): Boolean =
            proxy && (site?.isLoopbackAddress == true || host == "127.0.0.1" || host == "localhost")

        /**
         * Burrow itself answers at [origin]: its own /healthz, not a proxy's 403 or a login page
         * (followed redirects counted as "home", review 2026-10-24); false when nothing answers in a short wait.
         */
        fun reachable(origin: String, timeoutMs: Int = 2500): Boolean = runCatching {
            val c = URL("$origin/healthz").openConnection() as HttpURLConnection
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.instanceFollowRedirects = false
            try {
                val code = c.responseCode
                // The first KB is enough (readNBytes is API 33).
                val body = (if (code >= 400) c.errorStream else c.inputStream)?.use { s ->
                    val buf = ByteArray(1024)
                    var n = 0
                    while (n < buf.size) {
                        val r = s.read(buf, n, buf.size - n)
                        if (r < 0) break
                        n += r
                    }
                    String(buf, 0, n)
                } ?: ""
                isBurrowHealth(code, body)
            } finally {
                c.disconnect()
            }
        }.getOrDefault(false)

        /** Burrow's /healthz answer: {"ok": true} (200), or {"ok": false} with its data disk full (503). */
        fun isBurrowHealth(code: Int, body: String): Boolean = (code == 200 || code == 503) && Regex("\"ok\"\\s*:\\s*(true|false)").containsMatchIn(body)

        /** A network change decides again only while the app is seen, or when the tunnel is up for a transfer or a kept session. */
        fun decideOnNetworkChange(inSight: Boolean, active: Boolean): Boolean = inSight || active

        /** At home the tunnel goes down, unless a direct session or forward runs through it, or one is kept open. */
        fun stopAtHome(away: Boolean, up: Boolean, inUse: Boolean, kept: Boolean): Boolean = !away && up && !inUse && !kept
    }

    /** A socket whose connect() goes through the tunnel's proxy (CONNECT). */
    internal class TunnelSocket(private val proxyPort: Int, private val auth: String) : Socket() {
        override fun connect(endpoint: SocketAddress, timeout: Int) {
            val target = endpoint as InetSocketAddress
            super.connect(InetSocketAddress("127.0.0.1", proxyPort), timeout)
            val at = authority(target.hostString, target.port)
            val out: OutputStream = getOutputStream()
            out.write("CONNECT $at HTTP/1.1\r\nHost: $at\r\nProxy-Authorization: $auth\r\n\r\n".toByteArray())
            out.flush()
            val input: InputStream = getInputStream()
            val status = readLine(input)
            while (readLine(input).isNotEmpty()) Unit
            if (!status.contains(" 200 ")) {
                close()
                throw java.io.IOException("WireGuard: $at not reachable (${status.trim()})")
            }
        }

        override fun connect(endpoint: SocketAddress) = connect(endpoint, 20_000)

        private fun readLine(input: InputStream): String {
            val sb = StringBuilder()
            while (true) {
                val b = input.read()
                if (b < 0 || b == '\n'.code) break
                if (b != '\r'.code) sb.append(b.toChar())
                if (sb.length > 8192) break
            }
            return sb.toString()
        }
    }

    /** AES-GCM with a key in the Android Keystore (no fingerprint: the tunnel comes up by itself). */
    private object Sealed {
        private const val ALIAS = "burrow-wireguard"

        private fun key(): SecretKey {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
            val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            g.init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            return g.generateKey()
        }

        fun seal(plain: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
            return c.iv + c.doFinal(plain)
        }

        fun open(sealed: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12)) }
            return c.doFinal(sealed, 12, sealed.size - 12)
        }
    }
}

/** A wg-quick configuration read as text: what the settings show, and what the tunnel is started with. */
object WgConf {
    /** The values of [key] in any section, comments and spaces left out, the key in any case. */
    fun values(conf: String, key: String): List<String> =
        conf.lines().map { it.substringBefore('#').trim() }.filter { it.substringBefore('=').trim().equals(key, true) }.map { it.substringAfter('=').trim() }

    /** What the settings show of it: never the keys. */
    fun shown(conf: String): Map<String, String> = mapOf(
        "address" to values(conf, "Address").joinToString(", "),
        "endpoint" to values(conf, "Endpoint").joinToString(", "),
        "allowedIps" to values(conf, "AllowedIPs").joinToString(", "),
    )

    /**
     * Without keepalives: they wake the radio every so many seconds. The app
     * makes its own traffic when it needs the tunnel, and the handshake is
     * redone on the next packet.
     */
    fun withoutKeepalive(conf: String): String =
        conf.lines().filterNot { it.trim().startsWith("PersistentKeepalive", ignoreCase = true) }.joinToString("\n")
}

/** Ids of what goes through the tunnel now (direct sessions, forwards), from any thread. */
class TunnelUsers {
    private val ids = HashSet<String>()

    @Synchronized
    fun use(id: String) {
        ids.add(id)
    }

    @Synchronized
    fun done(id: String) {
        ids.remove(id)
    }

    @Synchronized
    fun any(): Boolean = ids.isNotEmpty()
}
