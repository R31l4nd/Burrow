package io.github.r31l4nd.burrow

import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import javax.crypto.KeyGenerator

/** The direct route's offline data: sealed on disk, the phone's own additions, and the fetch from Burrow. */
class DirectStoreTest {
    private val dir: File = Files.createTempDirectory("direct").toFile()
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val store = DirectStore(dir) { key }
    private var server: HttpServer? = null
    private val cookies = mutableListOf<String?>()

    @After
    fun cleanUp() {
        server?.stop(0)
        dir.deleteRecursively()
    }

    private fun serve(handle: (com.sun.net.httpserver.HttpExchange) -> Unit): String {
        val s = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        s.createContext("/") { x ->
            cookies += x.requestHeaders.getFirst("Cookie")
            handle(x)
            x.close()
        }
        s.start()
        server = s
        return "http://127.0.0.1:${s.address.port}"
    }

    private fun answer(x: com.sun.net.httpserver.HttpExchange, status: Int, body: String) {
        val b = body.toByteArray()
        x.sendResponseHeaders(status, if (b.isEmpty()) -1 else b.size.toLong())
        if (b.isNotEmpty()) x.responseBody.use { it.write(b) }
    }

    /** What the phone trusts and typed is kept sealed: not readable on disk, and not with another key. */
    @Test
    fun keepsTheLocalDataSealed() {
        store.trustHere(7, "AAAAkey1")
        store.trustHere(7, "AAAAkey2")
        store.record(7, "ls -la")
        assertEquals(listOf("AAAAkey1", "AAAAkey2"), store.trustedHere(7))
        assertEquals(emptyList<String>(), store.trustedHere(8))
        val onDisk = File(dir, "direct-local.bin").readBytes()
        assertFalse("not in the clear", String(onDisk, Charsets.ISO_8859_1).contains("AAAAkey1"))
        // A new store on the same folder reads it back; one with another key reads nothing.
        assertEquals(listOf("ls -la"), DirectStore(dir) { key }.recorded(7))
        val other = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        assertEquals(emptyList<String>(), DirectStore(dir) { other }.recorded(7))
        assertEquals("{}", DirectStore(dir) { other }.local().toString())
    }

    /** History: newest first, a command again moves to the top, blank and huge ones are not kept, at most 300. */
    @Test
    fun recordsHistoryNewestFirst() {
        store.record(1, "a")
        store.record(1, "b")
        store.record(1, "a")
        store.record(1, "   ")
        store.record(1, "x".repeat(2001))
        assertEquals(listOf("a", "b"), store.recorded(1))
        assertEquals(emptyList<String>(), store.recorded(2))
        repeat(310) { store.record(3, "cmd $it") }
        val h = store.recorded(3)
        assertEquals(300, h.size)
        assertEquals("cmd 309", h.first())
        assertEquals("cmd 10", h.last())
    }

    /** The cache from Burrow, fetched with the session cookie and kept sealed. */
    @Test
    fun syncsTheCacheWithTheCookie() {
        val base = serve { x -> answer(x, 200, """{"hosts":[{"id":4,"name":"nas"}]}""") }
        assertNull(store.cache())
        assertTrue(store.sync(base, "burrow_session=s"))
        assertEquals(listOf<String?>("burrow_session=s"), cookies)
        assertEquals("nas", store.cache()!!.getJSONArray("hosts").getJSONObject(0).getString("name"))
        assertFalse(String(File(dir, "direct-cache.bin").readBytes(), Charsets.ISO_8859_1).contains("nas"))
    }

    /** No cookie, an error, a body that is not JSON: false, and the cache as it was. */
    @Test
    fun aFailedSyncKeepsTheOldCache() {
        var status = 200
        var body = """{"hosts":[]}"""
        val base = serve { x -> answer(x, status, body) }
        assertTrue(store.sync(base, "c=1"))
        assertFalse("no cookie: not even asked", store.sync(base, null))
        assertFalse(store.sync(base, ""))
        assertEquals(1, cookies.size)
        status = 503
        assertFalse(store.sync(base, "c=1"))
        status = 200
        body = "<html>"
        assertFalse(store.sync(base, "c=1"))
        assertEquals("""{"hosts":[]}""", store.cache().toString())
        server!!.stop(0)
        assertFalse("Burrow away", store.sync(base, "c=1"))
    }

    /** A redirect is not followed: the session cookie would go along (AUDIT2 AND-02). */
    @Test
    fun doesNotFollowARedirect() {
        val base = serve { x ->
            if (x.requestURI.path == "/api/android/cache") {
                x.responseHeaders.add("Location", "/elsewhere")
                answer(x, 302, "")
            } else {
                answer(x, 200, "{}")
            }
        }
        assertFalse(store.sync(base, "c=1"))
        assertEquals(1, cookies.size)
        assertNull(store.cache())
    }

    /** Cleared (unpaired, another server) while a fetch was on its way: what it brings is not kept (AUDIT2 AND-06). */
    @Test
    fun aSyncThatEndsAfterAClearIsNotKept() {
        store.trustHere(1, "k")
        val base = serve { x ->
            store.clear()
            answer(x, 200, """{"hosts":[{"id":1}]}""")
        }
        assertFalse(store.sync(base, "c=1"))
        assertNull(store.cache())
        assertEquals(emptyList<String>(), store.trustedHere(1))
        assertFalse(File(dir, "direct-local.bin").exists())
    }

    /** Not put in place: an error, not the old file kept without a word (A3-AND-21). */
    @Test
    fun aWriteThatCannotBePutInPlaceFails() {
        // A folder where the file should go: the rename cannot replace it.
        File(dir, "direct-local.bin").mkdirs()
        val e = runCatching { store.record(1, "ls") }.exceptionOrNull()
        assertEquals("could not save direct-local.bin", e?.message)
        assertFalse(File(dir, "direct-local.bin.tmp").exists())
    }

    @Test
    fun aDamagedFileReadsAsNothing() {
        File(dir, "direct-cache.bin").writeBytes(ByteArray(40) { 1 })
        assertNull(store.cache())
        File(dir, "direct-cache.bin").writeBytes(Sealed.seal(key, "not json".toByteArray()))
        assertNull(store.cache())
        File(dir, "direct-cache.bin").writeBytes(Sealed.seal(key, JSONObject().put("hosts", 1).toString().toByteArray()))
        assertEquals(1, store.cache()!!.getInt("hosts"))
    }
}
