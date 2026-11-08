package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Test

class TunnelAuthorityTest {
    @Test
    fun `an IPv6 address goes in brackets, a name or IPv4 as it is (AUDIT2 AND-16)`() {
        assertEquals("nas.lan:443", WireGuard.authority("nas.lan", 443))
        assertEquals("10.0.0.5:8096", WireGuard.authority("10.0.0.5", 8096))
        assertEquals("[fd00::5]:443", WireGuard.authority("fd00::5", 443))
        assertEquals("[fd00::5]:443", WireGuard.authority("[fd00::5]", 443))
    }

    /** The proxy's secret goes only to the proxy: 127.0.0.1, its realm, a tunnel running (A3-AND-13). */
    @Test
    fun theSecretGoesOnlyToTheTunnelsOwnProxy() {
        assertEquals(true, WireGuard.answersProxy(true, "127.0.0.1", WireGuard.REALM))
        assertEquals("no tunnel", false, WireGuard.answersProxy(false, "127.0.0.1", WireGuard.REALM))
        assertEquals("a site in the proxy's realm", false, WireGuard.answersProxy(true, "evil.example", WireGuard.REALM))
        assertEquals("another realm", false, WireGuard.answersProxy(true, "127.0.0.1", "some site"))
        assertEquals("another loopback spelling", false, WireGuard.answersProxy(true, "localhost", WireGuard.REALM))
        assertEquals(false, WireGuard.answersProxy(true, "127.0.0.2", WireGuard.REALM))
        assertEquals(false, WireGuard.answersProxy(true, null, null))
    }
}
