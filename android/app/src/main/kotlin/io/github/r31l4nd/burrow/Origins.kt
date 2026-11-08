package io.github.r31l4nd.burrow

import java.net.URI

/** The server's origin (scheme://host[:port]) and checks against it. */
object Origins {
    /**
     * "burrow.example.com", "https://burrow.example.com/" -> "https://burrow.example.com";
     * null for anything that is not https (the session cookie is Secure).
     */
    fun normalize(input: String): String? {
        var s = input.trim()
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "https://$s"
        val u = try {
            URI(s)
        } catch (e: Exception) {
            return null
        }
        if (u.scheme?.lowercase() != "https" || u.host.isNullOrEmpty() || u.userInfo != null) return null
        val port = if (u.port == -1 || u.port == 443) "" else ":${u.port}"
        return "https://${u.host.lowercase()}$port"
    }

    fun of(url: String): String? = try {
        val u = URI(url)
        val scheme = u.scheme?.lowercase() ?: return null
        val host = u.host?.lowercase() ?: return null
        val default = if (scheme == "https") 443 else if (scheme == "http") 80 else -1
        val port = if (u.port == -1 || u.port == default) "" else ":${u.port}"
        "$scheme://$host$port"
    } catch (e: Exception) {
        null
    }

    fun same(url: String, origin: String): Boolean = of(url) == origin

    /**
     * This phone itself: localhost, 127/8, ::1, and the other spellings that
     * reach it (0.0.0.0, ::, an IPv4-mapped 127.x, short or numeric IPv4
     * forms like 127.1 or 2130706433), A3-AND-14. Only literals are read;
     * nothing is looked up by name.
     */
    fun isLoopback(host: String?): Boolean {
        val h = host?.lowercase()?.trim()?.removePrefix("[")?.removeSuffix("]")?.substringBefore('%')?.trimEnd('.') ?: return false
        if (h == "localhost" || h.endsWith(".localhost")) return true
        if (h.contains(':')) return ipv6(h)?.let { loopback6(it) } ?: false
        return ipv4(h)?.let { it ushr 24 == 127L || it == 0L } ?: false
    }

    /** An IPv4 literal as browsers read it (1 to 4 parts, decimal, 0x hex or 0 octal), or null. */
    private fun ipv4(s: String): Long? {
        val parts = s.split('.')
        if (parts.isEmpty() || parts.size > 4) return null
        val n = parts.map { p ->
            when {
                p.isEmpty() -> return null
                p.startsWith("0x") -> p.substring(2).ifEmpty { "0" }.toLongOrNull(16)
                p.length > 1 && p.startsWith("0") -> p.substring(1).toLongOrNull(8)
                else -> if (p.all { it.isDigit() }) p.toLongOrNull() else null
            } ?: return null
        }
        // The last part fills what the others leave (127.1 is 127.0.0.1).
        var v = 0L
        for (i in 0 until n.size - 1) {
            if (n[i] > 255) return null
            v = v or (n[i] shl (8 * (3 - i)))
        }
        val last = n.last()
        if (last >= (1L shl (8 * (5 - n.size)))) return null
        return v or last
    }

    /** An IPv6 literal's 16 bytes (with an IPv4 tail), or null. */
    private fun ipv6(s: String): ByteArray? {
        if (s.count { it == ':' } < 2) return null
        val halves = s.split("::")
        if (halves.size > 2) return null
        fun groups(t: String): List<Int>? {
            if (t.isEmpty()) return emptyList()
            val out = mutableListOf<Int>()
            val g = t.split(':')
            for ((i, x) in g.withIndex()) {
                if (i == g.size - 1 && x.contains('.')) {
                    val v4 = ipv4(x)?.takeIf { x.split('.').size == 4 } ?: return null
                    out += ((v4 shr 16) and 0xffff).toInt()
                    out += (v4 and 0xffff).toInt()
                } else {
                    if (x.isEmpty() || x.length > 4) return null
                    out += x.toIntOrNull(16) ?: return null
                }
            }
            return out
        }
        val head = groups(halves[0]) ?: return null
        val tail = (if (halves.size == 2) groups(halves[1]) else emptyList()) ?: return null
        val all = if (halves.size == 2) {
            if (head.size + tail.size > 7) return null
            head + List(8 - head.size - tail.size) { 0 } + tail
        } else {
            head
        }
        if (all.size != 8) return null
        return ByteArray(16) { i -> (all[i / 2] shr (if (i % 2 == 0) 8 else 0)).toByte() }
    }

    private fun loopback6(b: ByteArray): Boolean {
        val zeros = (0 until 10).all { b[it] == 0.toByte() }
        if (!zeros) return false
        val rest = b.copyOfRange(10, 16)
        // ::, ::1
        if (rest.all { it == 0.toByte() } || (rest.copyOfRange(0, 5).all { it == 0.toByte() } && rest[5] == 1.toByte())) return true
        // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): the IPv4 rule.
        val mapped = rest[0] == 0xff.toByte() && rest[1] == 0xff.toByte()
        val compatible = rest[0] == 0.toByte() && rest[1] == 0.toByte()
        if (!mapped && !compatible) return false
        val first = rest[2].toInt() and 0xff
        return first == 127 || (mapped && rest.copyOfRange(2, 6).all { it == 0.toByte() })
    }
}
