package io.github.r31l4nd.burrow

/**
 * Work that waits for a gate (Burrow unlocked): run at once while it is open,
 * else kept until it opens. Called on one thread (the main one).
 */
class WhenOpen {
    private var isOpen = false
    private val waiting = ArrayList<() -> Unit>()

    fun run(f: () -> Unit) {
        if (isOpen) f() else waiting.add(f)
    }

    fun open() {
        isOpen = true
        val now = waiting.toList()
        waiting.clear()
        for (f in now) f()
    }

    fun close() {
        isOpen = false
    }
}
