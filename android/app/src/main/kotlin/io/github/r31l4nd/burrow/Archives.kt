package io.github.r31l4nd.burrow

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.ZipInputStream

/**
 * Archives of the phone shown as folders, and unpacked (report 99d993: "as
 * Material Files"): zip and what is a zip (jar, apk), tar and tar.gz, with
 * Java's own zip and gzip and a small tar reader, no library. Read as a
 * stream (a folder granted through Android's picker has no random access):
 * once for the list, again for what is taken out.
 *
 * A name in an archive is never trusted: "..", an absolute path, a part
 * Android's names refuse, or a link, and the entry is left out (a zip
 * naming "../../.bashrc" wrote outside the folder, "zip slip").
 */
object Archives {
    enum class Kind { ZIP, TAR, TGZ }

    /** An entry: its clean path inside the archive ("docs/a.txt"), a folder or not. */
    data class Entry(val path: String, val dir: Boolean, val size: Long, val mtime: Long)

    /** More entries than this: the list is cut (the page says so). */
    const val MAX_ENTRIES = 20_000

    /** What an archive of this name is, or null: not one shown as a folder. */
    fun kind(name: String): Kind? {
        val n = name.lowercase()
        return when {
            n.endsWith(".zip") || n.endsWith(".jar") || n.endsWith(".apk") -> Kind.ZIP
            n.endsWith(".tar.gz") || n.endsWith(".tgz") -> Kind.TGZ
            n.endsWith(".tar") -> Kind.TAR
            else -> null
        }
    }

    /** The folder an archive unpacks into: its name without what makes it an archive. */
    fun folderName(name: String): String {
        val n = name.lowercase()
        val cut = listOf(".tar.gz", ".tgz", ".tar", ".zip", ".jar", ".apk").firstOrNull { n.endsWith(it) && n.length > it.length }
        return if (cut == null) name else name.dropLast(cut.length)
    }

    /** A name inside an archive made safe, or null when it may not be used. */
    fun clean(raw: String): String? {
        val parts = raw.replace('\\', '/').split('/').filter { it.isNotEmpty() && it != "." }
        if (parts.isEmpty() || parts.any { it == ".." || !PhonePaths.nameOk(it) }) return null
        return parts.joinToString("/")
    }

    /**
     * Every entry, folders that are only implied by a file's path among
     * them; [cut]: more than [max] (the rest left out).
     */
    fun list(input: InputStream, kind: Kind, max: Int = MAX_ENTRIES): Pair<List<Entry>, Boolean> {
        val out = LinkedHashMap<String, Entry>()
        var cut = false
        val buf = ByteArray(64 * 1024)
        walk(input, kind) { found, data ->
            if (out.size >= max) {
                cut = true
                return@walk false
            }
            // A zip written as a stream says a file's size only after its data: counted then.
            val e = if (!found.dir && found.size < 0) found.copy(size = generateSequence { data.read(buf) }.takeWhile { it >= 0 }.sumOf { it.toLong() }) else found
            // The folders above it, made when the archive does not list them itself.
            val parts = e.path.split('/')
            for (i in 1 until parts.size) {
                val dir = parts.take(i).joinToString("/")
                if (dir !in out) out[dir] = Entry(dir, true, 0, 0)
            }
            if (!e.dir || e.path !in out) out[e.path] = e
            true
        }
        return out.values.toList() to cut
    }

    /** The entries right inside [dir] ("" the top), folders first, then by name. */
    fun inside(all: List<Entry>, dir: String): List<Entry> {
        val prefix = if (dir.isEmpty()) "" else "$dir/"
        return all.filter { it.path.startsWith(prefix) && it.path.length > prefix.length && '/' !in it.path.substring(prefix.length) }
            .sortedWith(compareBy<Entry>({ !it.dir }, { it.path.substringAfterLast('/').lowercase() }))
    }

    /**
     * Each file entry [take] wants (it gives where to write it, or null to
     * skip), copied out; [progress] hears the bytes done so far. The count
     * of files written.
     */
    fun copyOut(input: InputStream, kind: Kind, take: (Entry) -> OutputStream?, progress: (Long) -> Unit = {}): Int {
        var done = 0L
        var files = 0
        val buf = ByteArray(64 * 1024)
        walk(input, kind) { e, data ->
            if (e.dir) return@walk true
            val sink = take(e) ?: return@walk true
            sink.use { o ->
                while (true) {
                    val n = data.read(buf)
                    if (n < 0) break
                    o.write(buf, 0, n)
                    done += n
                    progress(done)
                }
            }
            files++
            true
        }
        return files
    }

    /** Through the archive, entry by entry, its data readable while [each] runs; [each] false stops. */
    private fun walk(input: InputStream, kind: Kind, each: (Entry, InputStream) -> Boolean) {
        when (kind) {
            Kind.ZIP -> ZipInputStream(input).use { z ->
                while (true) {
                    val ze = z.nextEntry ?: break
                    val path = clean(ze.name) ?: continue
                    // Its size as the zip says it before the data: -1 when it does not (list() counts it).
                    if (!each(Entry(path, ze.isDirectory, if (ze.isDirectory) 0 else ze.size, maxOf(ze.time, 0)), z)) break
                }
            }
            Kind.TAR -> tar(input, each)
            Kind.TGZ -> GZIPInputStream(input).use { tar(it, each) }
        }
    }

    /**
     * A tar (ustar, GNU long names, pax paths): 512-byte headers, each
     * file's data padded to 512. Links, devices and the like are left out.
     */
    private fun tar(input: InputStream, each: (Entry, InputStream) -> Boolean) {
        val header = ByteArray(512)
        var longName: String? = null
        var paxPath: String? = null
        input.use { s ->
            while (true) {
                if (!readFully(s, header)) return
                // Two empty blocks end it; one is enough to stop.
                if (header.all { it.toInt() == 0 }) return
                val size = octal(header, 124, 12)
                val type = header[156].toInt().toChar()
                val name = longName ?: paxPath ?: run {
                    val n = field(header, 0, 100)
                    val prefix = if (String(header, 257, 5, Charsets.US_ASCII) == "ustar") field(header, 345, 155) else ""
                    if (prefix.isEmpty()) n else "$prefix/$n"
                }
                val body = Bounded(s, size)
                when (type) {
                    'L' -> {
                        longName = String(body.readBytes(), Charsets.UTF_8).trimEnd('\u0000')
                        skipPad(s, size)
                        continue
                    }
                    'x' -> {
                        paxPath = pax(String(body.readBytes(), Charsets.UTF_8))["path"]
                        skipPad(s, size)
                        continue
                    }
                }
                longName = null
                paxPath = null
                val path = clean(name)
                val keep = path != null && (type == '0' || type == '\u0000' || type == '7' || type == '5')
                if (keep && !each(Entry(path!!, type == '5', size, octal(header, 136, 12) * 1000), body)) return
                body.skipRest()
                skipPad(s, size)
            }
        }
    }

    private fun field(b: ByteArray, at: Int, len: Int): String {
        var end = at
        while (end < at + len && b[end].toInt() != 0) end++
        return String(b, at, end - at, Charsets.UTF_8)
    }

    private fun octal(b: ByteArray, at: Int, len: Int): Long {
        // Base-256 for big sizes (GNU): the high bit of the first byte.
        if (b[at].toInt() and 0x80 != 0) {
            var v = 0L
            for (i in at + 1 until at + len) v = (v shl 8) or (b[i].toLong() and 0xff)
            return v
        }
        val s = field(b, at, len).trim()
        return if (s.isEmpty()) 0 else s.toLongOrNull(8) ?: throw IOException("not a tar")
    }

    /** pax records: "len key=value\n". */
    private fun pax(text: String): Map<String, String> =
        text.split('\n').mapNotNull { r ->
            val kv = r.substringAfter(' ', "")
            val eq = kv.indexOf('=')
            if (eq <= 0) null else kv.substring(0, eq) to kv.substring(eq + 1)
        }.toMap()

    private fun readFully(s: InputStream, b: ByteArray): Boolean {
        var off = 0
        while (off < b.size) {
            val n = s.read(b, off, b.size - off)
            if (n < 0) {
                if (off == 0) return false
                throw EOFException("tar cut short")
            }
            off += n
        }
        return true
    }

    private fun skipPad(s: InputStream, size: Long) {
        var pad = (512 - size % 512) % 512
        while (pad > 0) {
            val n = s.skip(pad)
            if (n <= 0) {
                if (s.read() < 0) return
                pad--
            } else pad -= n
        }
    }

    /** One entry's data: never more than its size, never the next header. */
    private class Bounded(private val s: InputStream, private var left: Long) : InputStream() {
        override fun read(): Int {
            if (left <= 0) return -1
            val c = s.read()
            if (c >= 0) left--
            return c
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = s.read(b, off, minOf(len.toLong(), left).toInt())
            if (n < 0) throw EOFException("tar cut short")
            left -= n
            return n
        }

        fun skipRest() {
            val buf = ByteArray(8192)
            while (left > 0) if (read(buf, 0, buf.size) < 0) return
        }

        // Its own end only: the archive's stream stays open for the next entry.
        override fun close() = Unit
    }
}
