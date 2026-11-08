package io.github.r31l4nd.burrow

/**
 * Work that started before a reset may not land after it: [begin] notes the
 * generation, [commit] runs only when no [reset] came since, both under one
 * lock shared by every user of the same data.
 */
class Fence {
    private var generation = 0L

    @Synchronized
    fun begin(): Long = generation

    @Synchronized
    fun commit(at: Long, write: () -> Unit): Boolean {
        if (at != generation) return false
        write()
        return true
    }

    @Synchronized
    fun <T> locked(f: () -> T): T = f()

    @Synchronized
    fun reset(clear: () -> Unit) {
        generation++
        clear()
    }
}
