package io.github.r31l4nd.burrow

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

/** SSH wire format bits the direct route needs, kept free of Android so they can be tested. */
object SshWire {
    private fun string(out: ByteArrayOutputStream, b: ByteArray) {
        out.write(byteArrayOf((b.size ushr 24).toByte(), (b.size ushr 16).toByte(), (b.size ushr 8).toByte(), b.size.toByte()))
        out.write(b)
    }

    private fun fixed32(n: BigInteger): ByteArray {
        val raw = n.toByteArray().let { if (it.size > 32 && it[0] == 0.toByte()) it.copyOfRange(it.size - 32, it.size) else it }
        require(raw.size <= 32) { "not a P-256 coordinate" }
        return ByteArray(32 - raw.size) + raw
    }

    /** The public key blob of an ecdsa-sha2-nistp256 key (RFC 5656). */
    fun ecdsaP256Blob(x: BigInteger, y: BigInteger): ByteArray {
        val out = ByteArrayOutputStream()
        string(out, "ecdsa-sha2-nistp256".toByteArray())
        string(out, "nistp256".toByteArray())
        string(out, byteArrayOf(4) + fixed32(x) + fixed32(y))
        return out.toByteArray()
    }

    fun openSshLine(blob: ByteArray): String = "ecdsa-sha2-nistp256 " + Base64.getEncoder().encodeToString(blob)

    /** The key type named at the start of a blob ("ssh-ed25519", ...). */
    fun keyType(blob: ByteArray): String {
        if (blob.size < 4) return "unknown"
        val len = ((blob[0].toInt() and 255) shl 24) or ((blob[1].toInt() and 255) shl 16) or ((blob[2].toInt() and 255) shl 8) or (blob[3].toInt() and 255)
        if (len < 0 || len > 64 || 4 + len > blob.size) return "unknown"
        return String(blob, 4, len, Charsets.US_ASCII)
    }

    /** OpenSSH-style fingerprint, as Burrow shows it: SHA256:<base64 without padding>. */
    fun fingerprint(blob: ByteArray): String =
        "SHA256:" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(blob)).trimEnd('=')
}
