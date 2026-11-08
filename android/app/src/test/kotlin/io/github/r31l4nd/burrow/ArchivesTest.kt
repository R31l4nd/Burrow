package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Archives of the phone as folders and unpacked (report 99d993): zip, jar, apk, tar, tar.gz; never a name out of the folder. */
class ArchivesTest {
    private fun zip(vararg files: Pair<String, String>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            for ((name, text) in files) {
                z.putNextEntry(ZipEntry(name))
                z.write(text.toByteArray())
                z.closeEntry()
            }
        }
        return out.toByteArray()
    }

    /** A tar header block, ustar, of [type] and [size]. */
    private fun header(name: String, size: Int, type: Char, prefix: String = ""): ByteArray {
        val h = ByteArray(512)
        name.toByteArray().copyInto(h, 0)
        "0000644".toByteArray().copyInto(h, 100)
        String.format("%011o", size).toByteArray().copyInto(h, 124)
        String.format("%011o", 1_700_000_000L).toByteArray().copyInto(h, 136)
        h[156] = type.code.toByte()
        "ustar".toByteArray().copyInto(h, 257)
        prefix.toByteArray().copyInto(h, 345)
        // The checksum is not checked here; a real tar's is right.
        return h
    }

    private fun block(data: ByteArray): ByteArray = data + ByteArray((512 - data.size % 512) % 512)

    private fun tar(): ByteArray {
        val out = ByteArrayOutputStream()
        fun file(name: String, text: String, prefix: String = "") {
            out.write(header(name, text.length, '0', prefix))
            out.write(block(text.toByteArray()))
        }
        out.write(header("top/", 0, '5'))
        file("top/a.txt", "alpha")
        file("deep/b.txt", "beta", prefix = "top")
        // A GNU long name, then a pax path: both name the entry after them.
        val long = "top/" + "n".repeat(120) + ".txt"
        out.write(header("././@LongLink", long.length, 'L'))
        out.write(block(long.toByteArray()))
        file("short", "long one")
        val rec = "path=top/pax.txt\n"
        val pax = "${rec.length + 3} $rec"
        out.write(header("PaxHeader", pax.length, 'x'))
        out.write(block(pax.toByteArray()))
        file("ignored", "pax one")
        // A link and an escape: left out.
        out.write(header("top/link", 0, '2'))
        file("../../.bashrc", "evil")
        out.write(ByteArray(1024))
        return out.toByteArray()
    }

    @Test
    fun knowsWhatIsAnArchiveAndWhatItUnpacksInto() {
        assertEquals(Archives.Kind.ZIP, Archives.kind("app.APK"))
        assertEquals(Archives.Kind.ZIP, Archives.kind("lib.jar"))
        assertEquals(Archives.Kind.TGZ, Archives.kind("backup.tar.gz"))
        assertEquals(Archives.Kind.TGZ, Archives.kind("x.tgz"))
        assertEquals(Archives.Kind.TAR, Archives.kind("x.tar"))
        assertNull(Archives.kind("x.7z"))
        assertNull(Archives.kind("notes.txt"))
        assertEquals("backup", Archives.folderName("backup.tar.gz"))
        assertEquals("bikkel(1)", Archives.folderName("bikkel(1).apk"))
        assertEquals(".zip", Archives.folderName(".zip"))
    }

    @Test
    fun neverANameOutOfTheFolder() {
        assertEquals("a/b.txt", Archives.clean("./a//b.txt"))
        assertEquals("a/b.txt", Archives.clean("a\\b.txt"))
        assertEquals("etc/passwd", Archives.clean("/etc/passwd"))
        assertNull(Archives.clean("../x"))
        assertNull(Archives.clean("a/../../x"))
        assertNull(Archives.clean("a/\u0000b"))
        assertNull(Archives.clean("/"))
    }

    @Test
    fun aZipAsFoldersAndUnpacked() {
        val z = zip("docs/readme.md" to "hello", "docs/img/p.png" to "PNG", "top.txt" to "t", "../../evil.sh" to "rm")
        val (all, cut) = Archives.list(ByteArrayInputStream(z), Archives.Kind.ZIP)
        assertFalse(cut)
        // Folders only implied by a path are there; the escape is not.
        assertEquals(listOf("docs", "docs/readme.md", "docs/img", "docs/img/p.png", "top.txt"), all.map { it.path })
        assertEquals(listOf("docs", "top.txt"), Archives.inside(all, "").map { it.path })
        assertEquals(listOf("docs/img", "docs/readme.md"), Archives.inside(all, "docs").map { it.path })
        val got = mutableMapOf<String, ByteArrayOutputStream>()
        var bytes = 0L
        val n = Archives.copyOut(ByteArrayInputStream(z), Archives.Kind.ZIP, { e -> if (e.path.startsWith("docs/")) ByteArrayOutputStream().also { got[e.path] = it } else null }) { bytes = it }
        assertEquals(2, n)
        assertEquals("hello", got["docs/readme.md"].toString())
        assertEquals("PNG", got["docs/img/p.png"].toString())
        assertEquals(8L, bytes)
    }

    @Test
    fun aTarAndATarGzWithLongNamesAndPaxPaths() {
        val t = tar()
        val gz = ByteArrayOutputStream().also { o -> GZIPOutputStream(o).use { it.write(t) } }.toByteArray()
        for ((data, kind) in listOf(t to Archives.Kind.TAR, gz to Archives.Kind.TGZ)) {
            val (all, _) = Archives.list(ByteArrayInputStream(data), kind)
            val names = all.map { it.path }
            assertEquals(listOf("top", "top/a.txt", "top/deep", "top/deep/b.txt", "top/" + "n".repeat(120) + ".txt", "top/pax.txt"), names)
            assertTrue(all.first { it.path == "top/a.txt" }.mtime == 1_700_000_000_000L)
            val got = mutableMapOf<String, String>()
            Archives.copyOut(ByteArrayInputStream(data), kind, { e -> object : ByteArrayOutputStream() {
                override fun close() {
                    got[e.path] = toString()
                }
            } })
            assertEquals("alpha", got["top/a.txt"])
            assertEquals("beta", got["top/deep/b.txt"])
            assertEquals("long one", got["top/" + "n".repeat(120) + ".txt"])
            assertEquals("pax one", got["top/pax.txt"])
            assertFalse(got.keys.any { it.contains("bashrc") || it.endsWith("link") })
        }
    }

    @Test
    fun aHugeListIsCut() {
        val z = zip(*Array(30) { "f$it.txt" to "x" })
        val (all, cut) = Archives.list(ByteArrayInputStream(z), Archives.Kind.ZIP, max = 10)
        assertEquals(10, all.size)
        assertTrue(cut)
    }
}
