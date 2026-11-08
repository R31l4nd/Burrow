package io.github.r31l4nd.burrow

/** A file name that is safe to use as the last part of a path here. */
object FileNames {
    fun safe(name: String?, fallback: String = "file"): String {
        val base = (name ?: "").substringAfterLast('/').substringAfterLast('\\')
        val clean = base.filter { it >= ' ' && it != '\u007f' && it !in "<>:\"|?*" }.trim()
        val cut = if (clean.length > 120) {
            val ext = clean.substringAfterLast('.', "").take(10)
            clean.take(120 - ext.length - 1) + if (ext.isEmpty()) "" else ".$ext"
        } else {
            clean
        }
        return if (cut.isEmpty() || cut.all { it == '.' }) fallback else cut
    }

    fun extension(name: String): String = name.substringAfterLast('.', "").lowercase()

    /**
     * The name to save a download under: the server's Content-Disposition read here first
     * (filename*, then filename), then Android's guess from the address and type, made safe.
     * URLUtil.guessFileName does not read filename* (RFC 5987): Burrow's file downloads were
     * saved as "raw.bin" after the address (report 1fb877).
     */
    fun forDownload(url: String, disposition: String?, mime: String?): String =
        safe(fromDisposition(disposition) ?: android.webkit.URLUtil.guessFileName(url, disposition, mime))

    /** The file name a Content-Disposition header gives (RFC 6266): filename* (RFC 5987) wins over filename; null when neither is usable. */
    fun fromDisposition(disposition: String?): String? {
        if (disposition == null) return null
        val params = parameters(disposition)
        params["filename*"]?.let { star -> extended(star)?.let { return it } }
        return params["filename"]?.takeIf { it.isNotBlank() }
    }

    /** name=value pairs after the type, split on ';' outside quotes, quoted values unescaped; names in lower case. */
    private fun parameters(header: String): Map<String, String> {
        val parts = mutableListOf<String>()
        val cur = StringBuilder()
        var quoted = false
        var i = 0
        while (i < header.length) {
            val c = header[i]
            when {
                quoted && c == '\\' && i + 1 < header.length -> { cur.append(c).append(header[i + 1]); i++ }
                c == '"' -> { quoted = !quoted; cur.append(c) }
                c == ';' && !quoted -> { parts.add(cur.toString()); cur.clear() }
                else -> cur.append(c)
            }
            i++
        }
        parts.add(cur.toString())
        val out = mutableMapOf<String, String>()
        for (part in parts.drop(1)) {
            val eq = part.indexOf('=')
            if (eq < 0) continue
            val key = part.substring(0, eq).trim().lowercase()
            var value = part.substring(eq + 1).trim()
            if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1).replace(Regex("""\\(.)"""), "$1")
            }
            out.putIfAbsent(key, value)
        }
        return out
    }

    /** An RFC 5987 value: charset'language'percent-encoded bytes, in UTF-8 or ISO-8859-1. */
    private fun extended(value: String): String? {
        val first = value.indexOf('\'')
        val second = if (first < 0) -1 else value.indexOf('\'', first + 1)
        if (second < 0) return null
        val charset = when (value.substring(0, first).trim().uppercase()) {
            "UTF-8" -> Charsets.UTF_8
            "ISO-8859-1" -> Charsets.ISO_8859_1
            else -> return null
        }
        val encoded = value.substring(second + 1)
        val bytes = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < encoded.length) {
            val c = encoded[i]
            if (c == '%') {
                if (i + 2 >= encoded.length) return null
                val hi = encoded[i + 1].digitToIntOrNull(16) ?: return null
                val lo = encoded[i + 2].digitToIntOrNull(16) ?: return null
                bytes.write(hi * 16 + lo)
                i += 3
            } else {
                if (c.code > 0x7e || c.code < 0x21) return null
                bytes.write(c.code)
                i++
            }
        }
        return try {
            charset.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString().takeIf { it.isNotBlank() }
        } catch (_: java.nio.charset.CharacterCodingException) {
            null
        }
    }
}
