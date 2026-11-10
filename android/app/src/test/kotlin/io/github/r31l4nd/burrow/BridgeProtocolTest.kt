package io.github.r31l4nd.burrow

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class BridgeProtocolTest {
    @Test
    fun parsesRequests() {
        val r = BridgeProtocol.parse("""{"id":7,"method":"read","params":{"token":"t","offset":0,"length":10}}""")!!
        assertEquals(7L, r.id)
        assertEquals("read", r.method)
        assertEquals("t", r.params.getString("token"))
        assertEquals(0, BridgeProtocol.parse("""{"id":1,"method":"info"}""")!!.params.length())
    }

    @Test
    fun ignoresGarbage() {
        assertNull(BridgeProtocol.parse("nope"))
        assertNull(BridgeProtocol.parse("""{"method":"info"}"""))
        assertNull(BridgeProtocol.parse("""{"id":1,"method":"../x"}"""))
    }

    @Test
    fun answers() {
        assertEquals(JSONObject("""{"id":3,"result":{"a":1}}""").toString(), JSONObject(BridgeProtocol.result(3, BridgeProtocol.obj("a" to 1))).toString())
        assertEquals("boom", JSONObject(BridgeProtocol.error(3, "boom")).getString("error"))
        assertEquals("fileChanged", JSONObject(BridgeProtocol.event("fileChanged", null)).getString("event"))
    }

    /** Only the page's main frame on exactly the bridge's origin (A3-AND-13). */
    @Test
    fun takesMessagesOnlyFromThePagesMainFrame() {
        val o = "https://burrow.example.com"
        assertEquals(true, BridgeProtocol.fromPage(true, "https://burrow.example.com", o))
        assertEquals(true, BridgeProtocol.fromPage(true, "https://burrow.example.com:443", o))
        assertEquals(true, BridgeProtocol.fromPage(true, "https://BURROW.example.com/", o))
        assertEquals("a frame inside the page", false, BridgeProtocol.fromPage(false, "https://burrow.example.com", o))
        assertEquals("plain http", false, BridgeProtocol.fromPage(true, "http://burrow.example.com", o))
        assertEquals("another port", false, BridgeProtocol.fromPage(true, "https://burrow.example.com:8443", o))
        assertEquals("a sibling", false, BridgeProtocol.fromPage(true, "https://evil.burrow.example.com", o))
        assertEquals("a look-alike", false, BridgeProtocol.fromPage(true, "https://burrow.example.com.evil.example", o))
        assertEquals("no origin", false, BridgeProtocol.fromPage(true, "null", o))
        assertEquals("nothing", false, BridgeProtocol.fromPage(true, "", o))
        // The direct route's own asset origin.
        assertEquals(true, BridgeProtocol.fromPage(true, "https://appassets.androidplatform.net", DirectActivity.ORIGIN))
        assertEquals(false, BridgeProtocol.fromPage(true, "https://appassets.androidplatform.net.evil.example", DirectActivity.ORIGIN))
    }

    @Test
    fun answersCarryNullAndArrays() {
        JSONObject(BridgeProtocol.result(4, null)).let { assertEquals(4L, it.getLong("id")); assertTrue(it.isNull("result")) }
        assertEquals(JSONObject.NULL, JSONObject(BridgeProtocol.event("pushEndpoint", null)).get("data"))
        BridgeProtocol.obj("a" to null, "b" to "x").let { assertTrue(it.isNull("a")); assertEquals("x", it.getString("b")) }
        assertEquals("""[1,"two"]""", BridgeProtocol.array(listOf(1, "two")).toString())
        assertEquals("params that are not an object: none", 0, BridgeProtocol.parse("""{"id":1,"method":"info","params":3}""")!!.params.length())
        assertNull("a method name too long", BridgeProtocol.parse("""{"id":1,"method":"${"a".repeat(41)}"}"""))
    }

    /** The tunnel's other hosts: names and addresses only; a URL, a path, a space or nothing is left out. */
    @Test
    fun tunnelHostsAreNamesAndAddressesOnly() {
        val hosts = BridgeRules.tunnelHosts(JSONArray(listOf(" nas.lan ", "10.0.0.5", "[fd00::1]", "fd00::2", "https://x.example", "a/b", "a b", "", "x".repeat(254), "nas.lan")))
        assertEquals(setOf("nas.lan", "10.0.0.5", "[fd00::1]", "fd00::2"), hosts)
    }

    @Test
    fun theTopColourIsAHexColourOrNothing() {
        assertEquals("#112233", BridgeRules.topColor("#123"))
        assertEquals("#a0B1c2", BridgeRules.topColor("#a0B1c2"))
        for (bad in listOf("", "red", "#12", "#1234", "#12345g", "rgb(0,0,0)", "#123456;background:url(x)", " #123")) assertNull(bad, BridgeRules.topColor(bad))
    }

    /** Only Burrow's three settings are kept, as strings, each cut at 2000 characters. */
    @Test
    fun uiPrefsKeepOnlyTheKnownSettings() {
        val kept = JSONObject(BridgeRules.uiPrefs(JSONObject().put("burrow.locale", "nl").put("burrow.terminal", "t".repeat(3000)).put("evil", "x")))
        assertEquals(setOf("burrow.locale", "burrow.terminal"), kept.keys().asSequence().toSet())
        assertEquals("nl", kept.getString("burrow.locale"))
        assertEquals(2000, kept.getString("burrow.terminal").length)
        assertEquals("{}", BridgeRules.uiPrefs(null))
    }

    /** Files are fetched, shared and saved only from exactly the server the bridge was made for. */
    @Test
    fun filesComeOnlyFromThisServer() {
        val o = "https://burrow.example.com"
        assertEquals("$o/api/files/download?x=1", BridgeRules.sameOrigin("$o/api/files/download?x=1", o))
        for (bad in listOf("https://evil.example/api", "http://burrow.example.com/api", "https://burrow.example.com:8443/api", "https://burrow.example.com.evil.example/", "file:///data/x", "nonsense")) {
            assertEquals(bad, "not this server", assertThrows(IllegalArgumentException::class.java) { BridgeRules.sameOrigin(bad, o) }.message)
        }
    }

    @Test
    fun anAppTabOpensOnlyAWebAddress() {
        assertEquals("http://nas.lan:8080/", BridgeRules.appUrl("http://nas.lan:8080/"))
        assertEquals("https://x.example", BridgeRules.appUrl("https://x.example"))
        for (bad in listOf("intent://x#Intent;end", "file:///sdcard/x", "javascript:alert(1)", "content://x", "HTTPS://x")) {
            assertThrows(bad, IllegalArgumentException::class.java) { BridgeRules.appUrl(bad) }
        }
    }

    /** One path more than allowed is passed on, so the hold is refused as a whole instead of cut short. */
    @Test
    fun holdingTakesAtMostOneMoreThanAllowed() {
        assertEquals(listOf("/a", "/b"), BridgeRules.holdPaths(JSONArray(listOf("/a", "/b"))))
        assertEquals(PhoneFolders.MAX_HOLD + 1, BridgeRules.holdPaths(JSONArray(List(PhoneFolders.MAX_HOLD + 50) { "/f$it" })).size)
        assertEquals(HeldFiles.Kind.SHARED, BridgeRules.holdKind("upload"))
        assertEquals(HeldFiles.Kind.LOCAL, BridgeRules.holdKind("view"))
        assertEquals(HeldFiles.Kind.LOCAL, BridgeRules.holdKind(""))
    }

    @Test
    fun shortcutsAndSavedText() {
        assertEquals(listOf(3L to "nas", 9L to "pi"), BridgeRules.shortcutHosts(JSONArray("""[{"id":3,"name":"nas"},{"id":9,"name":"pi"}]""")))
        assertEquals("log", BridgeRules.savedText("log"))
        assertEquals("too large to save", assertThrows(IllegalArgumentException::class.java) { BridgeRules.savedText("x".repeat(BridgeRules.MAX_SAVED_TEXT + 1)) }.message)
    }

    /** The update is installed only when its SHA-256 is the one Burrow named. */
    @Test
    fun theUpdateMustMatchItsHash() {
        val f = File.createTempFile("burrow", ".apk")
        try {
            f.writeText("abc")
            assertTrue(BridgeRules.updateMatches(f, "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"))
            assertFalse(BridgeRules.updateMatches(f, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ae"))
            assertFalse(BridgeRules.updateMatches(f, ""))
        } finally {
            f.delete()
        }
    }

    /** Review 2026-10-24: a second tap on Update deleted the download the installer had open. */
    @Test
    fun aCheckedUpdateIsHandedOverAgainForTheSameRelease() {
        val dir = java.nio.file.Files.createTempDirectory("burrow-update").toFile()
        try {
            val apk = File(dir, "burrow.apk")
            assertFalse("nothing downloaded", BridgeRules.readyUpdate(apk, "AB12"))
            apk.writeText("apk")
            assertFalse("downloaded, not checked", BridgeRules.readyUpdate(apk, "ab12"))
            BridgeRules.markChecked(apk, "AB12")
            assertTrue(BridgeRules.readyUpdate(apk, "ab12"))
            assertFalse("another release", BridgeRules.readyUpdate(apk, "cd34"))
        } finally {
            dir.deleteRecursively()
        }
    }

    // Audit 2026-11-09: the app's question read Endpoint lines more strictly than the tunnel does,
    // so a second peer behind a comment or a no-break space was configured but not shown.
    @Test
    fun wgEndpointReadsTheConfigAsTheTunnelDoes() {
        val conf = "[Interface]\nPrivateKey = x\n[Peer]\nEndpoint = home.example:51820\nAllowedIPs = 10.0.0.0/24\n[Peer]\nEndpoint = 203.0.113.9:51820 # backup\nAllowedIPs = 0.0.0.0/0\n[Peer]\nendpoint\u00a0= 198.51.100.7:51820\n"
        val shown = BridgeRules.wgEndpoint(conf)!!
        assertTrue(shown, shown.contains("home.example:51820"))
        assertTrue(shown, shown.contains("203.0.113.9:51820"))
        assertTrue(shown, shown.contains("198.51.100.7:51820"))
        assertFalse(shown, shown.contains("backup"))
        // A peer whose endpoint says nothing is said, not left out.
        assertTrue(BridgeRules.wgEndpoint("[Peer]\nEndpoint =   # none\n")!!.contains("?"))
    }

    @Test
    fun aShareOfNothingIsRefused() {
        assertThrows(IllegalArgumentException::class.java) { BridgeRules.sharePaths(JSONArray()) }
        assertEquals(listOf("/a"), BridgeRules.sharePaths(JSONArray(listOf("/a"))))
    }
}
