package io.github.r31l4nd.burrow

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * What a screen owns while it lives. Work started on it can finish after it
 * ended (a connection made while the screen was left): such a result is
 * closed at once instead of kept with no one to end it, and a wait for the
 * person (a fingerprint) ends with the screen (audit AN-07).
 */
class Lifetime {
    private var ended = false
    private val waits = mutableSetOf<CountDownLatch>()

    val isEnded: Boolean get() = synchronized(this) { ended }

    /** Keeps `value` (by `put`) while alive; once ended, `close`s it instead. True when kept. */
    fun <T> keep(value: T, close: (T) -> Unit, put: (T) -> Unit): Boolean {
        val keepIt = synchronized(this) {
            if (!ended) put(value)
            !ended
        }
        if (!keepIt) close(value)
        return keepIt
    }

    /** Waits for `latch` at most `timeoutMs`; false when the time ran out or the screen ended meanwhile. */
    fun await(latch: CountDownLatch, timeoutMs: Long): Boolean {
        synchronized(this) {
            if (ended) return false
            waits += latch
        }
        try {
            return latch.await(timeoutMs, TimeUnit.MILLISECONDS) && !isEnded
        } finally {
            synchronized(this) { waits -= latch }
        }
    }

    /** The screen is gone: from now on nothing is kept, and every wait ends. */
    fun end() {
        val pending = synchronized(this) {
            ended = true
            waits.toList()
        }
        pending.forEach { it.countDown() }
    }
}
