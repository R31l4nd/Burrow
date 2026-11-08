package io.github.r31l4nd.burrow

import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Files the app holds for the page, by a random token: shared into Burrow
 * from another app, or opened in another app (and maybe edited there). The
 * page reads them in pieces to upload them. LOCAL: a file of the phone's
 * own folders (PhoneFolders), held while the page shows it (a picture).
 */
class HeldFiles {
    enum class Kind { SHARED, OPENED, LOCAL }

    class Held(
        val token: String,
        val kind: Kind,
        val name: String,
        val mime: String,
        @Volatile var size: Long,
        val open: Opener,
        val hostId: Long? = null,
        val path: String? = null,
        val local: java.io.File? = null,
        @Volatile var stamp: Long = 0,
    )

    /** How to read a held file: a seekable channel when possible, else a stream. */
    interface Opener {
        fun channel(): FileChannel?
        fun stream(): InputStream
    }

    private val items = ConcurrentHashMap<String, Held>()
    private val random = SecureRandom()

    fun newToken(): String {
        val b = ByteArray(16)
        random.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    fun add(h: Held): Held {
        items[h.token] = h
        return h
    }

    operator fun get(token: String): Held? = items[token]

    fun list(kind: Kind): List<Held> = items.values.filter { it.kind == kind }

    fun remove(token: String): Held? = items.remove(token)?.also { h -> h.local?.parentFile?.deleteRecursively() }

    /** All of them gone: another server must not see what was shared to or opened from the old one. */
    fun clear() {
        for (t in items.keys.toList()) remove(t)
    }

    /** Up to [length] bytes from [offset]; empty at the end. At most 1 MiB. */
    fun read(token: String, offset: Long, length: Int): ByteArray {
        val h = items[token] ?: throw IllegalArgumentException("unknown file")
        require(offset >= 0 && length in 0..MAX_READ) { "bad range" }
        val ch = try {
            h.open.channel()
        } catch (e: Exception) {
            null
        }
        if (ch != null) {
            try {
                ch.use {
                    val buf = ByteBuffer.allocate(length)
                    var at = offset
                    while (buf.hasRemaining()) {
                        val n = it.read(buf, at)
                        if (n <= 0) break
                        at += n
                    }
                    return buf.array().copyOf(buf.position())
                }
            } catch (e: java.io.IOException) {
                // A pipe behind a file descriptor: "Illegal seek". Stream it.
            }
        }
        // Not seekable (some providers hand out pipes): skip ahead each time.
        h.open.stream().use { s ->
            var skipped = 0L
            while (skipped < offset) {
                val n = s.skip(offset - skipped)
                if (n <= 0) {
                    if (s.read() == -1) return ByteArray(0)
                    skipped++
                } else {
                    skipped += n
                }
            }
            val out = ByteArray(length)
            var got = 0
            while (got < length) {
                val n = s.read(out, got, length - got)
                if (n <= 0) break
                got += n
            }
            return out.copyOf(got)
        }
    }

    companion object {
        const val MAX_READ = 1 shl 20

        /**
         * A stream another app shares (SEND), read with this app's rights:
         * only a content:// URI of another app's provider. A file:// path or
         * this app's own provider made Burrow read its own private files
         * (shared prefs, the cookie database) and offer them for upload
         * (A3-AND-07). [authority] may carry a user ("10@..."), [own] is the
         * app's package (its providers are named after it).
         */
        fun acceptsShared(scheme: String?, authority: String?, own: String): Boolean {
            if (!scheme.equals("content", ignoreCase = true)) return false
            val a = authority?.substringAfter('@')?.lowercase()
            if (a.isNullOrEmpty()) return false
            return a != own && !a.startsWith("$own.")
        }

        fun fileOpener(f: java.io.File) = object : Opener {
            override fun channel(): FileChannel = java.io.FileInputStream(f).channel
            override fun stream(): InputStream = java.io.FileInputStream(f)
        }
    }
}
