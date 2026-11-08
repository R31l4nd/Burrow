package io.github.r31l4nd.burrow

/**
 * Where the sign-in key lives: two Keystore entries, so a new key is made
 * beside the one in use and takes its place only when the pairing went
 * through. Made in its place, a wrong or expired code (or no network) left
 * the phone without the key it was signed in with (AUDIT2 AND-07).
 */
class KeySlots(private val ops: Ops, private val names: Names) {
    interface Ops {
        fun exists(alias: String): Boolean
        fun delete(alias: String)
        /** Makes the key; returns its public half. */
        fun generate(alias: String): String
    }

    interface Names {
        var current: String?
        var staged: String?
    }

    /** The key in use. */
    fun current(): String = names.current ?: A

    /** A new key beside the one in use; returns its public half. */
    fun stage(): String {
        val s = if (current() == A) B else A
        ops.delete(s)
        names.staged = s
        return ops.generate(s)
    }

    /** The pairing went through: the new key is the one in use, the old one goes. */
    fun commit() {
        val s = names.staged ?: return
        val old = current()
        names.current = s
        names.staged = null
        if (old != s) ops.delete(old)
    }

    /** Both gone (another server, forgotten, or void after new fingerprints). */
    fun forget() {
        ops.delete(A)
        ops.delete(B)
        names.current = null
        names.staged = null
    }

    companion object {
        const val A = "burrow-device"
        const val B = "burrow-device-2"
    }
}
