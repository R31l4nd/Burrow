package io.github.r31l4nd.burrow

import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/** The app's WireGuard: what goes through it, who gets the proxy's secret, and the CONNECT through its proxy. */
class WireGuardRulesTest {
    private val closers = mutableListOf<() -> Unit>()

    @After
    fun close() = closers.forEach { runCatching { it() } }

    @Test
    fun onlyTheChosenHostsAndBurrowGoThroughTheTunnel() {
        val hosts = setOf("nas.lan", "10.0.0.5")
        assertTrue(WireGuard.routes("NAS.lan", null, hosts, viaBurrow = false))
        assertTrue(WireGuard.routes("10.0.0.5", "burrow.example.com", hosts, viaBurrow = true))
        assertTrue("Burrow's own, while Burrow goes through it", WireGuard.routes("burrow.example.com", "Burrow.Example.com", hosts, viaBurrow = true))
        assertFalse("Burrow's own, but Burrow goes straight", WireGuard.routes("burrow.example.com", "burrow.example.com", hosts, viaBurrow = false))
        assertFalse("anything else straight", WireGuard.routes("example.org", "burrow.example.com", hosts, viaBurrow = true))
        assertFalse(WireGuard.routes(null, "burrow.example.com", hosts, viaBurrow = true))
        assertFalse("no Burrow host known", WireGuard.routes("burrow.example.com", null, emptySet(), viaBurrow = true))
    }

    /** Review 2026-10-24: a proxy's 403 or a login page counted as "Burrow answers here", and no tunnel came up away from home. */
    @Test
    fun onlyBurrowsOwnHealthAnswerMeansHome() {
        assertTrue(WireGuard.isBurrowHealth(200, "{\"ok\":true}"))
        assertTrue(WireGuard.isBurrowHealth(200, "{\"ok\":true,\"hints\":[\"trust_proxy\"]}"))
        assertTrue("its disk full, Burrow all the same", WireGuard.isBurrowHealth(503, "{\"ok\":false,\"hints\":[\"disk_full\"]}"))
        assertFalse("a proxy refusing outsiders", WireGuard.isBurrowHealth(403, "<html>403 Forbidden</html>"))
        assertFalse("a login page", WireGuard.isBurrowHealth(200, "<html><form>Sign in</form></html>"))
        assertFalse("a redirect to one", WireGuard.isBurrowHealth(302, ""))
        assertFalse(WireGuard.isBurrowHealth(404, "{\"ok\":true}"))
    }

    @Test
    fun whatGoesThroughTheTunnelIsCountedById() {
        val u = TunnelUsers()
        assertFalse(u.any())
        u.use("session-1")
        u.use("forward-1")
        u.done("session-1")
        assertTrue("the forward still runs", u.any())
        u.done("forward-1")
        u.done("never-there")
        assertFalse(u.any())
    }

    /** Review 2026-10-24: a network change in the background started the tunnel again, and "home" stopped it under live sessions. */
    @Test
    fun theTunnelFollowsTheNetworkOnlyWhenSeenOrInUse() {
        assertTrue(WireGuard.decideOnNetworkChange(inSight = true, active = false))
        assertTrue("up for a transfer or a kept session: routed anew", WireGuard.decideOnNetworkChange(inSight = false, active = true))
        assertFalse("out of sight, down: stays down (the battery)", WireGuard.decideOnNetworkChange(inSight = false, active = false))
        assertTrue(WireGuard.stopAtHome(away = false, up = true, inUse = false, kept = false))
        assertFalse("a direct session or forward through it", WireGuard.stopAtHome(away = false, up = true, inUse = true, kept = false))
        assertFalse("a session kept open on purpose", WireGuard.stopAtHome(away = false, up = true, inUse = false, kept = true))
        assertFalse(WireGuard.stopAtHome(away = true, up = true, inUse = false, kept = false))
        assertFalse(WireGuard.stopAtHome(away = false, up = false, inUse = false, kept = false))
    }

    @Test
    fun theWebViewsProxyTheChosenHostsAndBurrow() {
        assertEquals(setOf("nas.lan", "burrow.example.com"), WireGuard.proxyTargets(setOf("nas.lan"), true, "burrow.example.com"))
        assertEquals(setOf("nas.lan"), WireGuard.proxyTargets(setOf("nas.lan"), false, "burrow.example.com"))
        assertEquals(emptySet<String>(), WireGuard.proxyTargets(emptySet(), true, null))
    }

    /** The app's own requests answer only a proxy on this phone itself; a site never gets a password from them. */
    @Test
    fun theSecretIsOfferedOnlyToAProxyOnThePhone() {
        assertTrue(WireGuard.localProxyAsks(true, InetAddress.getByName("127.0.0.1"), "127.0.0.1"))
        assertTrue(WireGuard.localProxyAsks(true, null, "localhost"))
        assertTrue(WireGuard.localProxyAsks(true, InetAddress.getByName("::1"), null))
        assertFalse("a site asking", WireGuard.localProxyAsks(false, InetAddress.getByName("127.0.0.1"), "127.0.0.1"))
        assertFalse("a proxy elsewhere", WireGuard.localProxyAsks(true, InetAddress.getByName("192.0.2.1"), "proxy.example"))
        assertFalse(WireGuard.localProxyAsks(true, null, null))
    }

    /** At home or away: Burrow's own /healthz answer is Burrow reachable; another answer, silence or no server is not. */
    @Test
    fun burrowIsReachableWhenItAnswers() {
        var status = 200
        val s = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        s.createContext("/healthz") { x ->
            if (status == 0) Thread.sleep(2_000)
            val body = (if (status == 200) "{\"ok\":true}" else "<html>no</html>").toByteArray()
            x.sendResponseHeaders(maxOf(status, 200), body.size.toLong())
            x.responseBody.write(body)
            x.close()
        }
        s.executor = java.util.concurrent.Executors.newCachedThreadPool()
        s.start()
        closers += { s.stop(0) }
        val origin = "http://127.0.0.1:${s.address.port}"
        assertTrue(WireGuard.reachable(origin))
        status = 401
        assertFalse("a proxy's own sign-in in front of it", WireGuard.reachable(origin))
        status = 502
        assertFalse("a proxy in front, Burrow behind it gone", WireGuard.reachable(origin))
        status = 0
        assertFalse("no answer in time", WireGuard.reachable(origin, timeoutMs = 300))
        s.stop(0)
        assertFalse("nothing there", WireGuard.reachable(origin, timeoutMs = 300))
    }

    private val conf = """
        [Interface]
        PrivateKey = cHJpdmF0ZSBrZXkgcHJpdmF0ZSBrZXkgcHJpdmF0ZSA=
        Address = 10.99.0.2/32, fd99::2/128 # the phone
        DNS = 10.99.0.1
        # Endpoint = old.example:51820
        [Peer]
        PublicKey = cHVibGljIGtleSBwdWJsaWMga2V5IHB1YmxpYyBrZXk=
        allowedips=10.99.0.0/24
        Endpoint = vpn.example.com:51820
        PersistentKeepalive = 25
        [Peer]
        AllowedIPs = 192.168.1.0/24
          persistentkeepalive=10
    """.trimIndent()

    /** The settings show the addresses, endpoint and routes, never a key; a commented-out line is not read. */
    @Test
    fun theSettingsShowNoKeys() {
        val shown = WgConf.shown(conf)
        assertEquals("10.99.0.2/32, fd99::2/128", shown["address"])
        assertEquals("vpn.example.com:51820", shown["endpoint"])
        assertEquals("10.99.0.0/24, 192.168.1.0/24", shown["allowedIps"])
        assertFalse(shown.values.any { it.contains("cHJpdmF0ZS") || it.contains("cHVibGlj") })
        assertEquals(listOf("10.99.0.1"), WgConf.values(conf, "dns"))
        assertEquals(emptyList<String>(), WgConf.values("", "Address"))
    }

    /** Started without keepalives, in any case and indentation; everything else as it was. */
    @Test
    fun theTunnelStartsWithoutKeepalives() {
        val quiet = WgConf.withoutKeepalive(conf)
        assertFalse(quiet.contains("keepalive", ignoreCase = true))
        assertEquals(conf.lines().size - 2, quiet.lines().size)
        assertTrue(quiet.contains("Endpoint = vpn.example.com:51820"))
    }

    /** A fake of the tunnel's proxy: takes the CONNECT and its headers, answers [reply], then echoes a byte (or hangs up, [echo] false). */
    private fun proxy(reply: String, seen: MutableList<String>, echo: Boolean = true): Int {
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        closers += { server.close() }
        thread(isDaemon = true) {
            runCatching {
                server.accept().use { s ->
                    val input = s.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                    while (true) {
                        val line = input.readLine() ?: break
                        if (line.isEmpty()) break
                        seen += line
                    }
                    s.getOutputStream().write(reply.toByteArray())
                    s.getOutputStream().flush()
                    if (!echo) return@use
                    val c = input.read()
                    if (c >= 0) s.getOutputStream().write(c)
                    s.getOutputStream().flush()
                    Thread.sleep(200)
                }
            }
        }
        return server.localPort
    }

    /** CONNECT host:port with the secret, the proxy's answer and headers read, then the bytes are the host's. */
    @Test
    fun aSocketConnectsThroughTheProxy() {
        val seen = mutableListOf<String>()
        val port = proxy("HTTP/1.1 200 Connection established\r\nVia: wg\r\n\r\n", seen)
        val sock = WireGuard.TunnelSocket(port, "Basic YnVycm93OnNlY3JldA==")
        closers += { sock.close() }
        sock.connect(InetSocketAddress.createUnresolved("nas.lan", 22))
        assertEquals(listOf("CONNECT nas.lan:22 HTTP/1.1", "Host: nas.lan:22", "Proxy-Authorization: Basic YnVycm93OnNlY3JldA=="), seen)
        sock.getOutputStream().write('x'.code)
        assertEquals("the proxy's own headers are not passed on as the host's bytes", 'x'.code, sock.getInputStream().read())
    }

    @Test
    fun anIpv6HostGoesInBrackets() {
        val seen = mutableListOf<String>()
        val port = proxy("HTTP/1.1 200 OK\r\n\r\n", seen)
        val sock = WireGuard.TunnelSocket(port, "Basic x")
        closers += { sock.close() }
        sock.connect(InetSocketAddress.createUnresolved("fd00::5", 443), 2_000)
        assertEquals("CONNECT [fd00::5]:443 HTTP/1.1", seen.first())
    }

    /** Refused by the proxy (a name its DNS did not find, an address outside AllowedIPs): an error naming it, the socket closed. */
    @Test
    fun aRefusalIsAnError() {
        val port = proxy("HTTP/1.1 502 Bad Gateway\r\nX-Reason: no such host\r\n\r\n", mutableListOf())
        val sock = WireGuard.TunnelSocket(port, "Basic x")
        val e = runCatching { sock.connect(InetSocketAddress.createUnresolved("gone.lan", 80)) }.exceptionOrNull()
        assertTrue(e is IOException)
        assertEquals("WireGuard: gone.lan:80 not reachable (HTTP/1.1 502 Bad Gateway)", e?.message)
        assertTrue(sock.isClosed)
    }

    /** A proxy that goes away mid-answer, or talks without end, is no connection. */
    @Test
    fun aBrokenAnswerIsAnError() {
        val port = proxy("HTTP/1.1 2", mutableListOf(), echo = false)
        val sock = WireGuard.TunnelSocket(port, "Basic x")
        closers += { sock.close() }
        assertTrue(runCatching { sock.connect(InetSocketAddress.createUnresolved("nas.lan", 22)) }.exceptionOrNull() is IOException)
        val port2 = proxy("x".repeat(20_000) + " 200 \r\n\r\n", mutableListOf())
        val sock2 = WireGuard.TunnelSocket(port2, "Basic x")
        closers += { sock2.close() }
        assertTrue("a status line cut at 8 KiB", runCatching { sock2.connect(InetSocketAddress.createUnresolved("nas.lan", 22)) }.exceptionOrNull() is IOException)
    }
}
