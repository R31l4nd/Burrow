package io.github.r31l4nd.burrow

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Burrow's own push: what reaches the phone is shown, and a tap opens only a page of Burrow's. */
class PushTest {
    @Test
    fun onlyAMessageEncryptedForThisPhone() {
        val json = """{"title":"Disk full","body":"nas: / at 97%"}""".toByteArray()
        assertEquals("Disk full", Push.message(true, json)!!.getString("title"))
        assertNull("not encrypted for this phone", Push.message(false, json))
        assertNull("not JSON", Push.message(true, "plain text".toByteArray()))
    }

    @Test
    fun aNoticeSaysWhatBurrowSent() {
        val n = Push.notice(JSONObject("""{"topic":"alerts","page":"/logs?t=3:web","title":"Container down","body":"web exited","priority":5}"""))
        assertEquals("#/logs?t=3:web", n.page)
        assertEquals("alerts:/logs?t=3:web", n.tag)
        assertEquals("Container down", n.title)
        assertEquals("web exited", n.body)
        assertTrue(n.high)
        assertFalse(Push.notice(JSONObject("""{"priority":3}""")).high)
        assertTrue(Push.notice(JSONObject("""{"priority":4}""")).high)
    }

    /** A page that is not Burrow's own (another site, a scheme) opens Burrow's start instead. */
    @Test
    fun aTapOpensOnlyBurrowsOwnPages() {
        for (bad in listOf("https://evil.example/", "//evil.example/x", "javascript:alert(1)", "logs")) {
            assertEquals(bad, "#/", Push.notice(JSONObject().put("page", bad)).page)
        }
        val plain = Push.notice(JSONObject())
        assertEquals("#/", plain.page)
        assertEquals("Burrow", plain.title)
        assertEquals("", plain.body)
        assertEquals(":", plain.tag)
        assertFalse(plain.high)
    }

    @Test
    fun theEndpointCarriesTheKeys() {
        val e = JSONObject(Push.endpoint("https://ntfy.example/up123", "BPub", "auth1"))
        assertEquals("https://ntfy.example/up123", e.getString("url"))
        assertEquals("BPub", e.getString("p256dh"))
        assertEquals("auth1", e.getString("auth"))
    }
}
