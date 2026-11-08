package io.github.r31l4nd.burrow

import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress

class HopsTest {
    private val servers = mutableListOf<HttpServer>()
    private val cookies = mutableMapOf<String, String?>()

    private fun server(name: String, at: String = "127.0.0.1", handle: (HttpServer, com.sun.net.httpserver.HttpExchange) -> Unit): HttpServer =
        HttpServer.create(InetSocketAddress(at, 0), 0).also { s ->
            s.createContext("/") { x ->
                cookies[name + x.requestURI.path] = x.requestHeaders.getFirst("Cookie")
                handle(s, x)
                x.close()
            }
            s.start()
            servers += s
        }

    private fun base(s: HttpServer) = "http://${s.address.address.hostAddress}:${s.address.port}"

    /** An address of this machine that is not the loopback: "another host" for a redirect. */
    private fun lan(): String {
        val a = java.net.NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }.firstOrNull { it is java.net.Inet4Address }
        org.junit.Assume.assumeTrue("a network address besides the loopback", a != null)
        return a!!.hostAddress!!
    }

    @After
    fun stop() = servers.forEach { it.stop(0) }

    @Test
    fun aRedirectToAnotherServerIsRefusedAndGetsNoCookie() {
        val other = server("other") { _, x -> x.sendResponseHeaders(200, -1) }
        val burrow = server("burrow") { _, x ->
            x.responseHeaders.add("Location", base(other) + "/steal")
            x.sendResponseHeaders(302, -1)
        }
        val e = runCatching { Hops.open(base(burrow) + "/api/files/download", null) { c, _ -> c.setRequestProperty("Cookie", "burrow_session=s") } }.exceptionOrNull()
        assertTrue(e?.message, e?.message == "redirected to another server")
        assertEquals("burrow_session=s", cookies["burrow/api/files/download"])
        assertNull(cookies["other/steal"])
        assertTrue("other/steal" !in cookies)
    }

    @Test
    fun aRedirectOnTheSameServerIsFollowed() {
        val burrow = server("burrow") { _, x ->
            if (x.requestURI.path == "/a") {
                x.responseHeaders.add("Location", "/b")
                x.sendResponseHeaders(302, -1)
            } else {
                x.sendResponseHeaders(200, -1)
            }
        }
        val c = Hops.open(base(burrow) + "/a", null) { c, _ -> c.setRequestProperty("Cookie", "k=v") }
        assertEquals(200, c.responseCode)
        c.disconnect()
        assertEquals("k=v", cookies["burrow/b"])
    }

    /**
     * An app tab's download that a server sends on to another host (a CDN, a
     * pre-signed storage address): followed, without the tab's cookie past
     * the first host. Refused before, so such downloads failed (A3-AND-11).
     */
    @Test
    fun anAppTabsDownloadFollowsAnotherHostWithoutItsCookie() {
        val cdn = server("cdn", at = lan()) { _, x -> x.sendResponseHeaders(200, -1) }
        val app = server("app") { _, x ->
            x.responseHeaders.add("Location", base(cdn) + "/signed/file.bin")
            x.sendResponseHeaders(302, -1)
        }
        val proxies = mutableListOf<String>()
        val c = Hops.open(base(app) + "/download", null, otherHost = { proxies += it.host; null }) { c, same -> if (same) c.setRequestProperty("Cookie", "app_session=s") }
        assertEquals(200, c.responseCode)
        c.disconnect()
        assertEquals("app_session=s", cookies["app/download"])
        assertTrue("cdn/signed/file.bin" in cookies)
        assertNull("the app's cookie stays with the app", cookies["cdn/signed/file.bin"])
        assertEquals("the other host's way asked for it", listOf(cdn.address.address.hostAddress), proxies)
    }

    /** Not even then to this phone itself: a redirect from another host to the loopback is refused. */
    @Test
    fun aRedirectToThePhoneItselfIsRefused() {
        val local = server("local") { _, x -> x.sendResponseHeaders(200, -1) }
        val app = server("app", at = lan()) { _, x ->
            x.responseHeaders.add("Location", base(local) + "/x")
            x.sendResponseHeaders(302, -1)
        }
        val e = runCatching { Hops.open(base(app) + "/download", null, otherHost = { null }) { _, _ -> } }.exceptionOrNull()
        assertEquals("redirected to this phone itself", e?.message)
        assertTrue("local/x" !in cookies)
    }
}
