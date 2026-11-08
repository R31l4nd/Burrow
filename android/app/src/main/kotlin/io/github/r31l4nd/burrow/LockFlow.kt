package io.github.r31l4nd.burrow

/**
 * When the fingerprint lock covers a screen and asks (LockGate is its
 * views): plain Kotlin, for the JVM tests.
 *
 * Covered at once when the screen starts locked; the prompt waits for the
 * screen to be up (onResume) and comes once per return to the app, or when
 * the person taps Unlock after a cancel; never two prompts at a time. A
 * phone without a screen lock has nothing to lock with: open.
 */
class LockFlow(
    private val unlocked: () -> Boolean,
    private val unlock: () -> Unit,
    private val canLock: () -> Boolean,
    /** The prompt, calling back whether it went through. */
    private val prompt: ((Boolean) -> Unit) -> Unit,
    private val cover: (Boolean) -> Unit,
) {
    private var prompting = false
    private var askOnResume = false

    fun onStart() {
        if (!unlocked() && canLock()) cover(true)
        askOnResume = true
    }

    fun onResume() {
        if (askOnResume) {
            askOnResume = false
            guard()
        }
    }

    fun guard() {
        if (unlocked() || !canLock()) {
            unlock()
            cover(false)
            return
        }
        cover(true)
        if (prompting) return
        prompting = true
        prompt { ok ->
            prompting = false
            if (ok) {
                unlock()
                cover(false)
            }
        }
    }

    companion object {
        /** Out of sight longer than this, the lock comes back. */
        const val LOCK_AFTER_MS = 5 * 60_000L

        /** Coming back in sight at [now] after going out of it at [hiddenAt]: locked again once that was long enough ago. */
        fun relocks(unlocked: Boolean, now: Long, hiddenAt: Long): Boolean = unlocked && now - hiddenAt > LOCK_AFTER_MS
    }
}
