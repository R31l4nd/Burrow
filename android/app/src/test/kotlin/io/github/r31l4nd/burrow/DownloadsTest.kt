package io.github.r31l4nd.burrow

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread
import kotlin.random.Random

/** The app's own downloads: the bytes, Stop, Retry that goes on where it broke off, and what the phone is told. */
class DownloadsTest {
    private val dir: File = Files.createTempDirectory("downloads").toFile()
    private val body = Random.nextBytes(300_000)

    /** Android's side, written down: what the downloads asked of it. */
    private inner class FakeSide : Downloads.Side {
        val events: MutableList<String> = Collections.synchronizedList(mutableListOf())
        val busy = AtomicInteger()
        val clock = AtomicLong()
        var step = 0L
        val public = mutableMapOf<Int, ByteArrayOutputStream>()

        override fun open(item: Downloads.Item, append: Boolean): OutputStream = when (val t = item.target) {
            is Downloads.Target.Private -> FileOutputStream(t.file, append)
            else -> public.getOrPut(item.id) { ByteArrayOutputStream() }.also { if (!append) it.reset() }
        }

        override fun completed(item: Downloads.Item) {
            events += "completed ${item.id}"
        }

        override fun dropPartial(item: Downloads.Item) {
            events += "drop ${item.id}"
            (item.target as? Downloads.Target.Private)?.file?.delete()
        }

        override fun busy(delta: Int, name: String) {
            busy.addAndGet(delta)
        }

        override fun cancel(id: Int) {
            events += "cancel $id"
        }

        override fun finished(item: Downloads.Item) {
            events += "finished ${item.id} ${item.state}"
        }

        override fun refresh() {}

        override fun now(): Long = clock.addAndGet(step)

        override fun execute(work: () -> Unit) {
            thread(isDaemon = true) { work() }
        }
    }

    private val side = FakeSide()

    /** One request as the server saw it: its first line and headers. */
    private class Request(val line: String, val headers: Map<String, String>)

    private val requests: MutableList<Request> = Collections.synchronizedList(mutableListOf())
    private var server: ServerSocket? = null

    /** A plain HTTP/1.1 server whose answers [answer] writes raw (status line, headers, body; it may also break off). */
    private fun serve(answer: (Request, OutputStream) -> Unit): String {
        val s = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        server = s
        thread(isDaemon = true) {
            while (!s.isClosed) {
                val c: Socket = runCatching { s.accept() }.getOrNull() ?: break
                thread(isDaemon = true) {
                    c.use {
                        val input = c.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                        val line = input.readLine() ?: return@use
                        val headers = mutableMapOf<String, String>()
                        while (true) {
                            val h = input.readLine() ?: break
                            if (h.isEmpty()) break
                            headers[h.substringBefore(':').trim().lowercase()] = h.substringAfter(':').trim()
                        }
                        val r = Request(line, headers)
                        requests += r
                        runCatching { answer(r, c.getOutputStream()) }
                    }
                }
            }
        }
        return "http://127.0.0.1:${s.localPort}"
    }

    private fun OutputStream.head(status: String, vararg headers: String) {
        write(("HTTP/1.1 $status\r\nConnection: close\r\n" + headers.joinToString("") { "$it\r\n" } + "\r\n").toByteArray())
    }

    private fun start(url: String, kind: String = "file", target: Downloads.Target = Downloads.Target.Private(File(dir, "f.bin")), onDone: ((Downloads.Item) -> Unit)? = null) =
        Downloads.start(side, url, "f.bin", kind, target, { "burrow_session=s" }, { null }, "BurrowApp/2", onDone = onDone)

    private fun Downloads.Item.waitFor() = assertTrue("the attempt ends", attempt.await(10, TimeUnit.SECONDS))

    @After
    fun cleanUp() {
        server?.close()
        Downloads.list().forEach { it.stop = true }
        Downloads.list().forEach { runCatching { it.attempt.await(5, TimeUnit.SECONDS) } }
        Downloads.clear(side)
        dir.deleteRecursively()
    }

    @Test
    fun downloadsAFileWithTheCookie() {
        val url = serve { _, out ->
            out.head("200 OK", "Content-Length: ${body.size}", "ETag: \"v1\"")
            out.write(body)
        }
        var done: Downloads.Item? = null
        val item = start("$url/api/files/download", onDone = { done = it })
        item.waitFor()
        assertEquals(Downloads.State.DONE, item.state)
        assertArrayEquals(body, File(dir, "f.bin").readBytes())
        assertEquals(body.size.toLong(), item.total)
        assertEquals(body.size.toLong(), item.done)
        assertEquals(item, done)
        assertEquals("burrow_session=s", requests.single().headers["cookie"])
        assertEquals("BurrowApp/2", requests.single().headers["user-agent"])
        assertNull("no range asked for a new download", requests.single().headers["range"])
        assertEquals("the keep-alive count is back", 0, side.busy.get())
        assertTrue(side.events.containsAll(listOf("completed ${item.id}", "finished ${item.id} DONE")))
        assertEquals("100%", 100, Downloads.percent(listOf(item)))
    }

    /** An error answer is a failed download with Retry, not a file. */
    @Test
    fun anErrorAnswerFails() {
        val url = serve { _, out -> out.head("404 Not Found", "Content-Length: 0") }
        val item = start("$url/x")
        item.waitFor()
        assertEquals(Downloads.State.FAILED, item.state)
        assertEquals("HTTP 404", item.error)
        assertTrue(side.events.contains("finished ${item.id} FAILED"))
        assertFalse(side.events.contains("completed ${item.id}"))
        assertEquals(0, side.busy.get())
        val json = Downloads.json().let { a -> (0 until a.length()).map { a.getJSONObject(it) }.single { it.getInt("id") == item.id } }
        assertEquals("failed", json.getString("state"))
        assertEquals("HTTP 404", json.getString("error"))
    }

    /** Broken off half way: Retry asks for the rest of the same version (Range, If-Range) and adds it to the part. */
    @Test
    fun retryGoesOnWhereItBrokeOff() {
        val half = body.size / 2
        val url = serve { r, out ->
            val range = r.headers["range"]
            if (range == null) {
                out.head("200 OK", "Content-Length: ${body.size}", "ETag: \"v1\"")
                out.write(body, 0, half)
                out.flush()
            } else {
                val from = range.removePrefix("bytes=").removeSuffix("-").toInt()
                out.head("206 Partial Content", "Content-Length: ${body.size - from}", "Content-Range: bytes $from-${body.size - 1}/${body.size}", "ETag: \"v1\"")
                out.write(body, from, body.size - from)
            }
        }
        val item = start("$url/big")
        item.waitFor()
        assertEquals(Downloads.State.FAILED, item.state)
        val got = item.done
        assertTrue("a part arrived: $got", got in 1..half.toLong())
        Downloads.retry(side, item.id)
        item.waitFor()
        assertEquals(item.error, Downloads.State.DONE, item.state)
        assertEquals("bytes=$got-", requests[1].headers["range"])
        assertEquals("\"v1\"", requests[1].headers["if-range"])
        assertArrayEquals(body, File(dir, "f.bin").readBytes())
    }

    /** The server sends it whole again (no ranges, or the file changed): it starts over, not added to the part. */
    @Test
    fun aWholeAnswerToARetryStartsOver() {
        val second = Random.nextBytes(1000)
        val url = serve { r, out ->
            if (r.headers["range"] == null) {
                out.head("200 OK", "Content-Length: ${body.size}", "Last-Modified: Mon, 05 Oct 2026 10:00:00 GMT", "ETag: W/\"weak\"")
                out.write(body, 0, 70_000)
            } else {
                out.head("200 OK", "Content-Length: ${second.size}")
                out.write(second)
            }
        }
        val item = start("$url/f")
        item.waitFor()
        assertEquals(Downloads.State.FAILED, item.state)
        assertEquals("a weak ETag is no use for a range: Last-Modified instead", "Mon, 05 Oct 2026 10:00:00 GMT", item.validator)
        Downloads.retry(side, item.id)
        item.waitFor()
        assertEquals(Downloads.State.DONE, item.state)
        assertEquals("Mon, 05 Oct 2026 10:00:00 GMT", requests[1].headers["if-range"])
        assertArrayEquals(second, File(dir, "f.bin").readBytes())
        assertNull("no validator in the new answer", item.validator)
    }

    /** Another part than asked for is refused, not written into the file. */
    @Test
    fun anotherPartThanAskedFails() {
        val url = serve { r, out ->
            if (r.headers["range"] == null) {
                out.head("200 OK", "Content-Length: ${body.size}", "ETag: \"v1\"")
                out.write(body, 0, 70_000)
            } else {
                out.head("206 Partial Content", "Content-Length: 10", "Content-Range: bytes 0-9/${body.size}")
                out.write(body, 0, 10)
            }
        }
        val item = start("$url/f")
        item.waitFor()
        Downloads.retry(side, item.id)
        item.waitFor()
        assertEquals(Downloads.State.FAILED, item.state)
        assertEquals("the server sent another part than asked", item.error)
    }

    /** Without anything that says which version it was, a retry does not ask for a part: it starts over. */
    @Test
    fun withoutAValidatorARetryStartsOver() {
        val url = serve { r, out ->
            if (requests.size == 1) {
                out.head("200 OK", "Content-Length: ${body.size}")
                out.write(body, 0, 70_000)
            } else {
                out.head("200 OK", "Content-Length: ${body.size}")
                out.write(body)
            }
        }
        val item = start("$url/f")
        item.waitFor()
        Downloads.retry(side, item.id)
        item.waitFor()
        assertNull(requests[1].headers["range"])
        assertArrayEquals(body, File(dir, "f.bin").readBytes())
    }

    /** Stopped while running: gone from the list with its half file and notification; no "failed". */
    @Test
    fun stopEndsItAndDropsTheHalfFile() {
        val more = CountDownLatch(1)
        val url = serve { _, out ->
            out.head("200 OK", "Content-Length: ${body.size}")
            out.write(body, 0, 100_000)
            out.flush()
            more.await(10, TimeUnit.SECONDS)
            out.write(body, 100_000, body.size - 100_000)
        }
        val item = start("$url/f")
        val deadline = System.currentTimeMillis() + 10_000
        while (item.done == 0L && System.currentTimeMillis() < deadline) Thread.sleep(10)
        Downloads.stop(side, item.id)
        more.countDown()
        item.waitFor()
        assertEquals(Downloads.State.STOPPED, item.state)
        assertNull(item.error)
        assertNull(Downloads.find(item.id))
        assertFalse(File(dir, "f.bin").exists())
        assertTrue(side.events.containsAll(listOf("drop ${item.id}", "cancel ${item.id}")))
        assertFalse(side.events.any { it.startsWith("finished ${item.id}") })
        assertEquals(0, side.busy.get())
    }

    /** Stop on a failed one lets it go; Stop or Retry for one the app no longer knows only takes its notification away. */
    @Test
    fun stopAndRetryOfWhatIsNotRunning() {
        val url = serve { _, out -> out.head("500 Oops", "Content-Length: 0") }
        val item = start("$url/f")
        item.waitFor()
        Downloads.retry(side, 99_999)
        Downloads.stop(side, 99_998)
        assertTrue(side.events.containsAll(listOf("cancel 99999", "cancel 99998")))
        Downloads.stop(side, item.id)
        assertNull(Downloads.find(item.id))
        assertTrue(side.events.contains("drop ${item.id}"))
        // Done is not retried.
        val ok = serve { _, out -> out.head("200 OK", "Content-Length: 1"); out.write(1) }
        val d = start("$ok/g")
        d.waitFor()
        val before = requests.size
        Downloads.retry(side, d.id)
        Thread.sleep(100)
        assertEquals(before, requests.size)
    }

    /** One app update at a time: a new one takes the place of a failed one; an update done gets no notification (the installer comes). */
    @Test
    fun oneUpdateAtATime() {
        var status = "404 Not Found"
        val url = serve { _, out ->
            out.head(status, "Content-Length: ${if (status.startsWith("200")) 3 else 0}")
            if (status.startsWith("200")) out.write(byteArrayOf(1, 2, 3))
        }
        val failed = start("$url/api/android/burrow.apk", kind = "update")
        failed.waitFor()
        assertNull(Downloads.runningUpdate())
        status = "200 OK"
        val next = start("$url/api/android/burrow.apk", kind = "update")
        assertNull("the failed one is gone", Downloads.find(failed.id))
        next.waitFor()
        assertEquals(Downloads.State.DONE, next.state)
        assertFalse(side.events.contains("finished ${next.id} DONE"))
        // A done one leaves the list when the next starts.
        val another = start("$url/x")
        assertNull(Downloads.find(next.id))
        another.waitFor()
    }

    /** What the check after the download says counts: an update whose hash does not match is failed (Bridge's installUpdate). */
    @Test
    fun theCheckAfterwardsCanFailIt() {
        val url = serve { _, out -> out.head("200 OK", "Content-Length: 3"); out.write(byteArrayOf(1, 2, 3)) }
        val item = start("$url/f", kind = "update", onDone = { it.state = Downloads.State.FAILED; it.error = "not the update Burrow named" })
        item.waitFor()
        assertTrue(side.events.contains("finished ${item.id} FAILED"))
    }

    /** A file for Downloads/Burrow is never resumed into a part that was dropped: without its place (uri) it starts over. */
    @Test
    fun aPublicFileWithoutItsPlaceStartsOver() {
        val url = serve { r, out ->
            if (requests.size == 1) {
                out.head("200 OK", "Content-Length: ${body.size}", "ETag: \"v\"")
                out.write(body, 0, 70_000)
            } else {
                out.head("200 OK", "Content-Length: ${body.size}")
                out.write(body)
            }
        }
        val item = start("$url/f", target = Downloads.Target.Public)
        item.waitFor()
        Downloads.retry(side, item.id)
        item.waitFor()
        assertNull(requests[1].headers["range"])
        assertArrayEquals(body, side.public[item.id]!!.toByteArray())
    }

    /** The page and the notification are told at the start and the end, not at every piece; a clock that moves gives a rate. */
    @Test
    fun progressIsToldNowAndThen() {
        val told = AtomicInteger()
        val listener: () -> Unit = { told.incrementAndGet() }
        Downloads.listeners.add(listener)
        try {
            val url = serve { _, out ->
                out.head("200 OK", "Content-Length: ${body.size}")
                for (i in 0 until body.size step 10_000) {
                    out.write(body, i, minOf(10_000, body.size - i))
                    out.flush()
                }
            }
            val item = start("$url/f")
            item.waitFor()
            assertTrue("at the start and the end, not per piece: ${told.get()}", told.get() in 2..3)
            side.step = 1_000
            told.set(0)
            val timed = start("$url/g")
            timed.waitFor()
            assertTrue("with time passing, along the way too: ${told.get()}", told.get() > 3)
            assertTrue(timed.rate > 0)
        } finally {
            Downloads.listeners.remove(listener)
        }
    }

    @Test
    fun percentAndTimeLeft() {
        fun item(done: Long, total: Long, rate: Double = 0.0) = Downloads.Item(1, "u", "n", "file", Downloads.Target.Public, { null }, { null }, null, null).also {
            it.done = done
            it.total = total
            it.rate = rate
        }
        assertEquals(25, Downloads.percent(listOf(item(10, 100), item(40, 100))))
        assertNull("a size not known", Downloads.percent(listOf(item(10, 100), item(5, -1))))
        assertNull(Downloads.percent(emptyList()))
        assertEquals(9L, item(10, 100, rate = 10.0).secondsLeft())
        assertNull("no rate yet", item(10, 100, rate = 0.5).secondsLeft())
        assertNull("no size", item(10, -1, rate = 50.0).secondsLeft())
        // The notification's "12 MB of 120 MB, 2 min left": the slowest decides, minutes rounded up.
        val p = Downloads.progress(listOf(item(10, 100, rate = 10.0), item(0, 7000, rate = 100.0)))
        assertEquals(10L, p.done)
        assertEquals(7100L, p.total)
        assertEquals(70L, p.secondsLeft)
        assertEquals(2L, p.minutesLeft)
        val unknown = Downloads.progress(listOf(item(5, -1)))
        assertEquals(-1L, unknown.total)
        assertNull(unknown.secondsLeft)
        assertNull(unknown.minutesLeft)
    }
}
