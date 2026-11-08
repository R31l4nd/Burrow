package io.github.r31l4nd.burrow

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.channels.FileChannel

class HeldFilesTest {
    private val bytes = ByteArray(3 * 1024 * 1024 + 17) { (it % 251).toByte() }

    private fun temp(): File = File.createTempFile("held", ".bin").apply {
        deleteOnExit()
        writeBytes(bytes)
    }

    private fun readAll(h: HeldFiles, token: String, chunk: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        var at = 0L
        while (true) {
            val b = h.read(token, at, chunk)
            if (b.isEmpty()) break
            out.write(b)
            at += b.size
        }
        return out.toByteArray()
    }

    @Test
    fun readsAFileInPieces() {
        val h = HeldFiles()
        val f = temp()
        val t = h.add(HeldFiles.Held(h.newToken(), HeldFiles.Kind.SHARED, "x.bin", "application/octet-stream", f.length(), HeldFiles.fileOpener(f))).token
        assertArrayEquals(bytes, readAll(h, t, HeldFiles.MAX_READ))
        assertEquals(17, h.read(t, 3L * 1024 * 1024, 100).size)
    }

    @Test
    fun readsStreamsThatCannotSeek() {
        val h = HeldFiles()
        val opener = object : HeldFiles.Opener {
            override fun channel(): FileChannel? = null
            override fun stream() = ByteArrayInputStream(bytes)
        }
        val t = h.add(HeldFiles.Held(h.newToken(), HeldFiles.Kind.SHARED, "x", "x", bytes.size.toLong(), opener)).token
        assertArrayEquals(bytes, readAll(h, t, 700_000))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesHugeReads() {
        val h = HeldFiles()
        val f = temp()
        val t = h.add(HeldFiles.Held(h.newToken(), HeldFiles.Kind.SHARED, "x", "x", f.length(), HeldFiles.fileOpener(f))).token
        h.read(t, 0, HeldFiles.MAX_READ + 1)
    }

    @Test
    fun releasingDeletesLocalCopies() {
        val h = HeldFiles()
        val dir = File(System.getProperty("java.io.tmpdir"), "held-" + h.newToken()).apply { mkdirs() }
        val f = File(dir, "a.txt").apply { writeText("hi") }
        val t = h.add(HeldFiles.Held(h.newToken(), HeldFiles.Kind.OPENED, "a.txt", "text/plain", 2, HeldFiles.fileOpener(f), local = f)).token
        h.remove(t)
        assertNull(h[t])
        assertEquals(false, dir.exists())
    }

    @Test
    fun anotherServerFindsNothingHeld() {
        val h = HeldFiles()
        val f = temp()
        h.add(HeldFiles.Held(h.newToken(), HeldFiles.Kind.SHARED, "x.bin", "application/octet-stream", f.length(), HeldFiles.fileOpener(f)))
        h.add(HeldFiles.Held(h.newToken(), HeldFiles.Kind.OPENED, "y.bin", "application/octet-stream", f.length(), HeldFiles.fileOpener(f)))
        h.clear()
        assertEquals(0, h.list(HeldFiles.Kind.SHARED).size + h.list(HeldFiles.Kind.OPENED).size)
    }

    /** What another app shares is read only from its own provider: never a file:// path, never this app's own files (A3-AND-07). */
    @Test
    fun sharedOnlyFromAnotherAppsProvider() {
        val own = "io.github.r31l4nd.burrow"
        assertTrue(HeldFiles.acceptsShared("content", "com.android.providers.media.documents", own))
        assertTrue(HeldFiles.acceptsShared("content", "media", own))
        assertTrue(HeldFiles.acceptsShared("CONTENT", "org.example.app.fileprovider", own))
        // Burrow's own files: shared prefs, the cookie database, the sealed WireGuard file.
        assertFalse(HeldFiles.acceptsShared("file", "", own))
        assertFalse(HeldFiles.acceptsShared("file", null, own))
        assertFalse(HeldFiles.acceptsShared("content", "$own.files", own))
        assertFalse(HeldFiles.acceptsShared("content", "10@$own.files", own))
        assertFalse(HeldFiles.acceptsShared("content", "$own.androidx-startup", own))
        assertFalse(HeldFiles.acceptsShared("content", own, own))
        assertFalse(HeldFiles.acceptsShared("content", "", own))
        assertFalse(HeldFiles.acceptsShared(null, "media", own))
        // Another app whose name only starts like Burrow's is another app.
        assertTrue(HeldFiles.acceptsShared("content", "io.github.r31l4nd.burrowfan.files", own))
        // The debug build is its own package, its own files refused the same way.
        assertFalse(HeldFiles.acceptsShared("content", "$own.debug.files", "$own.debug"))
    }
}
