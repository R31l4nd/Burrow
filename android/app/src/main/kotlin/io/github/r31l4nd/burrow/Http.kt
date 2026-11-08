package io.github.r31l4nd.burrow

import android.webkit.MimeTypeMap
import java.io.File
import java.io.OutputStream

/** Fetching a file with the WebView's cookie, to a local file. */
object Http {
    class Fetched(val name: String, val mime: String, val size: Long)

    // No MimeTypeMap (null) outside Android, as in the JVM tests: then a plain byte stream.
    fun mimeOf(name: String): String =
        MimeTypeMap.getSingleton()?.getMimeTypeFromExtension(FileNames.extension(name)) ?: "application/octet-stream"

    fun get(url: String, cookie: String?, userAgent: String?, nameHint: String?, proxy: java.net.Proxy? = null, sink: (Fetched) -> OutputStream): Fetched {
        // Through the app's WireGuard when it carries this host (WireGuard.proxyFor).
        val c = Hops.open(url, proxy) { c, _ ->
            c.connectTimeout = 15_000
            c.readTimeout = 60_000
            if (cookie != null) c.setRequestProperty("Cookie", cookie)
            if (userAgent != null) c.setRequestProperty("User-Agent", userAgent)
        }
        try {
            if (c.responseCode !in 200..299) error("HTTP ${c.responseCode}")
            val name = nameHint?.let { FileNames.safe(it) } ?: FileNames.forDownload(url, c.getHeaderField("Content-Disposition"), c.contentType)
            val f = Fetched(name, mimeOf(name), c.contentLengthLong)
            c.inputStream.use { input -> sink(f).use { out -> input.copyTo(out, 64 * 1024) } }
            return f
        } finally {
            c.disconnect()
        }
    }

    /** A file's SHA-256 in hex, read in pieces (the app's update is some 28 MB: not all in memory, A3-AND-21). */
    fun sha256(file: File): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    fun toFile(url: String, cookie: String?, userAgent: String?, dir: File, nameHint: String, proxy: java.net.Proxy? = null): File {
        dir.mkdirs()
        var target: File? = null
        get(url, cookie, userAgent, nameHint, proxy) { f -> File(dir, f.name).also { target = it }.outputStream() }
        return target!!
    }
}
