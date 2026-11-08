package io.github.r31l4nd.burrow

import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.random.Random

class HttpTest {
    private val headers = mutableMapOf<String, String?>()
    private var server: HttpServer? = null

    /** A server answering [status] with [body] and [extra] headers; it notes the Cookie and User-Agent it got. */
    private fun serve(status: Int, body: ByteArray, extra: Map<String, String> = emptyMap()): String {
        val s = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        s.createContext("/") { x ->
            headers["Cookie"] = x.requestHeaders.getFirst("Cookie")
            headers["User-Agent"] = x.requestHeaders.getFirst("User-Agent")
            extra.forEach { (k, v) -> x.responseHeaders.add(k, v) }
            x.sendResponseHeaders(status, if (body.isEmpty()) -1 else body.size.toLong())
            if (body.isNotEmpty()) x.responseBody.use { it.write(body) }
            x.close()
        }
        s.start()
        server = s
        return "http://127.0.0.1:${s.address.port}"
    }

    @After
    fun stop() {
        server?.stop(0)
    }

    /** The update's SHA-256, read in pieces: the same as over the whole file at once (A3-AND-21). */
    @Test
    fun hashesAFileInPieces() {
        val f = File.createTempFile("burrow", ".bin")
        try {
            f.writeText("abc")
            assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Http.sha256(f))
            val bytes = Random.nextBytes(3 * 1024 * 1024 + 17)
            f.writeBytes(bytes)
            assertEquals(MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }, Http.sha256(f))
        } finally {
            f.delete()
        }
    }

    /** A file fetched with the page's cookie and user agent, under the name asked for (made safe). */
    @Test
    fun fetchesWithTheCookieUnderTheNameAskedFor() {
        val body = Random.nextBytes(200_000)
        val base = serve(200, body)
        val dir = Files.createTempDirectory("burrow").toFile()
        try {
            val f = Http.toFile("$base/api/files/download?path=/x", "burrow_session=s", "BurrowApp/1", File(dir, "open/tok"), "../../notes?.txt")
            assertEquals(File(dir, "open/tok/notes.txt"), f)
            assertArrayEquals(body, f.readBytes())
            assertEquals("burrow_session=s", headers["Cookie"])
            assertEquals("BurrowApp/1", headers["User-Agent"])
        } finally {
            dir.deleteRecursively()
        }
    }

    /** Without a name of its own, the server's Content-Disposition names it; nothing is sent without a cookie. */
    @Test
    fun namesItAfterTheServersDisposition() {
        val base = serve(200, "hi".toByteArray(), mapOf("Content-Disposition" to "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt"))
        val out = ByteArrayOutputStream()
        val got = Http.get("$base/raw.bin", null, null, null) { out }
        assertEquals("r\u00e9sum\u00e9.txt", got.name)
        assertEquals(2L, got.size)
        assertEquals("application/octet-stream", got.mime)
        assertEquals("hi", out.toString(Charsets.UTF_8))
        assertNull(headers["Cookie"])
    }

    /** An error answer is an error, not an empty file. */
    @Test
    fun anErrorAnswerFails() {
        val base = serve(404, "not here".toByteArray())
        val dir = Files.createTempDirectory("burrow").toFile()
        try {
            val e = runCatching { Http.toFile("$base/x", "c=1", null, dir, "x.txt") }.exceptionOrNull()
            assertEquals("HTTP 404", e?.message)
            assertFalse(File(dir, "x.txt").exists())
        } finally {
            dir.deleteRecursively()
        }
    }
}
