package io.github.r31l4nd.burrow

import java.util.Base64

/**
 * The direct route checks host keys exactly as Burrow does (server
 * ssh/knownhosts.ts): the keys Burrow trusts come with the cache; a key of
 * the same type that differs, or any key when Burrow knows only others, is a
 * hard stop. A host Burrow never connected to can be trusted here, once.
 */
object HostKeys {
    sealed class Verdict {
        object Trusted : Verdict()
        data class Unknown(val keyType: String, val fingerprint: String) : Verdict()
        data class Changed(val keyType: String, val fingerprint: String) : Verdict()
    }

    data class Known(val keyType: String, val keyB64: String)

    fun judge(blob: ByteArray, known: List<Known>): Verdict {
        val type = SshWire.keyType(blob)
        val fp = SshWire.fingerprint(blob)
        if (known.isEmpty()) return Verdict.Unknown(type, fp)
        val same = known.firstOrNull { it.keyType == type }
        return if (same != null && same.keyB64 == Base64.getEncoder().encodeToString(blob)) Verdict.Trusted else Verdict.Changed(type, fp)
    }

    /**
     * The keys to judge by. A key trusted on the phone stands only while
     * Burrow knows none of the host: once Burrow does, its list is the whole
     * truth, and a key the phone kept (maybe of an algorithm the host no
     * longer has) is not accepted beside it (AUDIT2 AND-04).
     */
    fun known(fromBurrow: List<Known>, here: List<Known>): List<Known> = fromBurrow.ifEmpty { here }

    /** Host key algorithms to ask for first, so the server shows the key we know. */
    fun preferredAlgorithms(known: List<Known>): List<String> = known.flatMap {
        if (it.keyType == "ssh-rsa") listOf("rsa-sha2-512", "rsa-sha2-256", "ssh-rsa") else listOf(it.keyType)
    }.distinct()
}
