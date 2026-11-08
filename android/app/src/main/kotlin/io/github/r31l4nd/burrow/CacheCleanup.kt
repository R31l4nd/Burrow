package io.github.r31l4nd.burrow

import java.io.File

/**
 * Copies made to share or open a file (cache/share, cache/open) that nothing
 * took away: removed once older than a day, at the app's start. Kept for
 * ever before, after a failure or the process going (AUDIT2 AND-21).
 */
object CacheCleanup {
    const val MAX_AGE_MS = 24 * 3600_000L

    /** Removes what under [dir] was last changed before [now] - [maxAgeMs]; returns how many files went. */
    fun old(dir: File, now: Long = System.currentTimeMillis(), maxAgeMs: Long = MAX_AGE_MS): Int {
        if (!dir.isDirectory) return 0
        var gone = 0
        dir.walkBottomUp().filter { it != dir }.forEach { f ->
            if (f.isFile && now - f.lastModified() > maxAgeMs && f.delete()) gone++
            else if (f.isDirectory && f.list()?.isEmpty() == true) f.delete()
        }
        return gone
    }
}
