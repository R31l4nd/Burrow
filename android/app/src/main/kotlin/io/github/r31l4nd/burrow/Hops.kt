package io.github.r31l4nd.burrow

import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * A request of the app's own (a download, a file to share or open) that
 * follows redirects itself. HttpURLConnection follows them with the Cookie
 * set on the first request, so a redirect to another host would carry
 * Burrow's session cookie there (AUDIT2 AND-02). Burrow's own requests stay
 * on its server; an app tab's download may go on to another host (a CDN, a
 * pre-signed storage address), without the tab's cookie (A3-AND-11).
 */
object Hops {
    const val MAX = 5

    /**
     * Where a redirect leads. To another server only when [otherHosts] (an app
     * tab's download), never to another scheme than the web's, and from
     * another server never to this phone itself (its loopback).
     */
    fun next(from: URL, location: String?, otherHosts: Boolean = false, first: String? = Origins.of(from.toString())): URL {
        require(!location.isNullOrEmpty()) { "a redirect without a location" }
        val to = URL(from, location)
        require(to.protocol == "https" || to.protocol == "http") { "redirected to something not on the web" }
        val elsewhere = Origins.of(to.toString()) != first
        require(!elsewhere || otherHosts) { "redirected to another server" }
        require(!elsewhere || !Origins.isLoopback(to.host)) { "redirected to this phone itself" }
        return to
    }

    /**
     * The connection that answered, redirects followed; [prepare] sets the
     * headers again on every hop, told whether the hop is on the first
     * server (only there the cookie goes). [otherHost]: another server may
     * be followed (an app tab's download), and this gives the way to it
     * (through the app's WireGuard or straight); null: refused.
     */
    fun open(url: String, proxy: Proxy?, otherHost: ((URL) -> Proxy?)? = null, prepare: (HttpURLConnection, Boolean) -> Unit): HttpURLConnection {
        var at = URL(url)
        val first = Origins.of(url)
        repeat(MAX + 1) {
            val same = Origins.of(at.toString()) == first
            val way = if (same) proxy else otherHost?.invoke(at)
            val c = (if (way != null) at.openConnection(way) else at.openConnection()) as HttpURLConnection
            c.instanceFollowRedirects = false
            prepare(c, same)
            val code = c.responseCode
            if (code !in 300..399 || code == 304) return c
            val location = c.getHeaderField("Location")
            c.disconnect()
            at = next(at, location, otherHosts = otherHost != null, first = first)
        }
        error("too many redirects")
    }
}
