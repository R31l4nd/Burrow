package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginsTest {
    @Test
    fun normalizesWhatPeopleType() {
        assertEquals("https://burrow.example.com", Origins.normalize("burrow.example.com"))
        assertEquals("https://burrow.example.com", Origins.normalize(" https://Burrow.example.com/#/hosts "))
        assertEquals("https://burrow.example.com:8443", Origins.normalize("https://burrow.example.com:8443/x"))
        assertEquals("https://burrow.example.com", Origins.normalize("https://burrow.example.com:443"))
    }

    @Test
    fun refusesAnythingButHttps() {
        assertNull(Origins.normalize("http://burrow.example.com"))
        assertNull(Origins.normalize("https://user:pw@burrow.example.com"))
        assertNull(Origins.normalize(""))
        assertNull(Origins.normalize("javascript:alert(1)"))
    }

    @Test
    fun comparesOrigins() {
        val o = "https://burrow.example.com"
        assertTrue(Origins.same("https://burrow.example.com/api/files/1/raw?path=/x&download=1", o))
        assertFalse(Origins.same("https://burrow.example.com.evil.net/", o))
        assertFalse(Origins.same("http://burrow.example.com/", o))
        assertFalse(Origins.same("https://radarr.example.com/", o))
        assertFalse(Origins.same("not a url", o))
    }

    @Test
    fun knowsThePhonesOwnLoopback() {
        for (h in listOf("localhost", "a.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1", "LOCALHOST")) assertTrue(h, Origins.isLoopback(h))
        for (h in listOf("burrow.example.com", "10.0.0.1", "localhost.example.com", null)) assertFalse("$h", Origins.isLoopback(h))
    }

    /** The other spellings that reach the phone itself (A3-AND-14); none of them looked up by name. */
    @Test
    fun knowsEverySpellingOfThePhonesOwnLoopback() {
        for (h in listOf(
            "0.0.0.0", "0", "[::]", "::", "[::ffff:7f00:1]", "::ffff:127.0.0.1", "[0:0:0:0:0:0:0:1]", "0000::0001", "::127.0.0.1",
            "127.1", "2130706433", "0x7f.1", "0177.0.0.1", "localhost.", "a.localhost.", "[::1%25eth0]", "::ffff:0.0.0.0",
        )) assertTrue(h, Origins.isLoopback(h))
        for (h in listOf(
            "10.0.0.1", "128.0.0.1", "::2", "fe80::1", "[fd00::1]", "::ffff:10.0.0.1", "1.2.3.4.5", "999.0.0.1", "nas", "0x7g.0.0.1",
            "::1::", "1:2:3:4:5:6:7:8:9", "", "[]", "127.0.0.1.example.com",
        )) assertFalse(h, Origins.isLoopback(h))
    }

    /** A page load to the phone's loopback is stopped, but for Burrow's own origin when that is there (AUDIT2 AND-03). */
    @Test
    fun pageLoadsToTheLoopbackAreStopped() {
        assertEquals(true, WebSetup.toLoopback("127.0.0.1", "http://127.0.0.1:41000/"))
        assertEquals(true, WebSetup.toLoopback("localhost", "http://localhost/", allow = "https://burrow.example.com"))
        assertEquals("another port of the loopback than Burrow's", true, WebSetup.toLoopback("127.0.0.1", "https://127.0.0.1:9000/x", allow = "https://127.0.0.1:8443"))
        assertEquals("Burrow itself on the loopback (a test)", false, WebSetup.toLoopback("127.0.0.1", "https://127.0.0.1:8443/api", allow = "https://127.0.0.1:8443"))
        assertEquals(false, WebSetup.toLoopback("burrow.example.com", "https://burrow.example.com/"))
        assertEquals(false, WebSetup.toLoopback(null, "about:blank"))
    }
}
