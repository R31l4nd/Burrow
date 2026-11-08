package io.github.r31l4nd.burrow

/**
 * A direct session's output until its page says it listens (attach): the
 * shell's first prompt, or an early end, came before the page knew the
 * session and was lost (AUDIT2 AND-08). Kept in order, at most [max]
 * characters (the oldest go first); after attach everything passes at once.
 */
class DirectBacklog(private val max: Int = 1 shl 20) {
    private val held = StringBuilder()
    private var attached = false
    private var ended: String? = null
    private var hasEnded = false

    /** The output to send now, or null when it is held for the page. */
    @Synchronized
    fun output(text: String): String? {
        if (attached) return text
        held.append(text)
        if (held.length > max) held.delete(0, held.length - max)
        return null
    }

    /** Whether the end goes out now (attached); else it waits for attach. */
    @Synchronized
    fun close(message: String?): Boolean {
        if (attached) return true
        hasEnded = true
        ended = message
        return false
    }

    /** The page listens: what was held, and the end if it came already (as Pair(true, message)). */
    @Synchronized
    fun attach(): Pair<String, Pair<Boolean, String?>> {
        attached = true
        val text = held.toString()
        held.setLength(0)
        return text to (hasEnded to ended)
    }
}
