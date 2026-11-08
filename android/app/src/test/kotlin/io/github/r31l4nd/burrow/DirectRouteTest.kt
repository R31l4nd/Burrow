package io.github.r31l4nd.burrow

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator

class DirectRouteTest {
    private fun p256(): ECPublicKey =
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().public as ECPublicKey

    @Test
    fun encodesThePhoneKeyAsOpenSsh() {
        repeat(20) {
            // Coordinates with leading zero bytes are the easy ones to get wrong.
            val k = p256()
            val blob = SshWire.ecdsaP256Blob(k.w.affineX, k.w.affineY)
            assertEquals(4 + 19 + 4 + 8 + 4 + 65, blob.size)
            assertEquals("ecdsa-sha2-nistp256", SshWire.keyType(blob))
            assertEquals(4.toByte(), blob[4 + 19 + 4 + 8 + 4])
            assertTrue(SshWire.openSshLine(blob).startsWith("ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABB"))
        }
    }

    @Test
    fun fingerprintsLikeOpenSsh() {
        // ssh-keygen -lf for this ed25519 test key.
        val blob = Base64.getDecoder().decode("AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl")
        assertEquals("ssh-ed25519", SshWire.keyType(blob))
        assertTrue(SshWire.fingerprint(blob).matches(Regex("SHA256:[A-Za-z0-9+/]{43}")))
    }

    @Test
    fun judgesHostKeysLikeBurrow() {
        val ed = Base64.getDecoder().decode("AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl")
        val edB64 = Base64.getEncoder().encodeToString(ed)
        val other = ed.copyOf().also { it[it.size - 1] = (it.last() + 1).toByte() }
        assertTrue(HostKeys.judge(ed, emptyList()) is HostKeys.Verdict.Unknown)
        assertEquals(HostKeys.Verdict.Trusted, HostKeys.judge(ed, listOf(HostKeys.Known("ssh-ed25519", edB64))))
        assertTrue(HostKeys.judge(other, listOf(HostKeys.Known("ssh-ed25519", edB64))) is HostKeys.Verdict.Changed)
        // Burrow knows only an RSA key: an ed25519 key is not "new", it is a change.
        assertTrue(HostKeys.judge(ed, listOf(HostKeys.Known("ssh-rsa", "AAAA"))) is HostKeys.Verdict.Changed)
        assertEquals(listOf("rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ssh-ed25519"), HostKeys.preferredAlgorithms(listOf(HostKeys.Known("ssh-rsa", ""), HostKeys.Known("ssh-ed25519", ""))))
    }

    @Test
    fun aKeyTrustedOnThePhoneGoesOnceBurrowKnowsTheHost() {
        val ed = Base64.getDecoder().decode("AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl")
        val here = listOf(HostKeys.Known("ssh-ed25519", Base64.getEncoder().encodeToString(ed)))
        // Burrow never connected: the key trusted here stands.
        assertEquals(HostKeys.Verdict.Trusted, HostKeys.judge(ed, HostKeys.known(emptyList(), here)))
        // Burrow now trusts only the host's RSA key: the old ed25519 one is a change, not trusted.
        assertTrue(HostKeys.judge(ed, HostKeys.known(listOf(HostKeys.Known("ssh-rsa", "AAAA")), here)) is HostKeys.Verdict.Changed)
    }

    @Test
    fun sealsTheCache() {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val plain = "{\"hosts\":[]}".toByteArray()
        val a = Sealed.seal(key, plain)
        val b = Sealed.seal(key, plain)
        assertTrue("fresh nonce each time", !a.contentEquals(b))
        assertArrayEquals(plain, Sealed.open(key, a))
        a[a.size - 1] = (a.last() + 1).toByte()
        try {
            Sealed.open(key, a)
            throw AssertionError("tampering went unnoticed")
        } catch (e: AEADBadTagException) {
            // As it should.
        }
    }

    /** A host key Burrow does not know, met straight on another network: the tunnel is tried next (A3-AND-06). */
    @Test
    fun aForeignHostKeyStraightTriesTheTunnel() {
        assertTrue(DirectPath.tryTunnelAfter(hostKeyMismatch = true, wentThroughTunnel = false, carried = true))
        // Through the tunnel already, or a host the tunnel does not carry: the key's verdict stands.
        assertTrue(!DirectPath.tryTunnelAfter(hostKeyMismatch = true, wentThroughTunnel = true, carried = true))
        assertTrue(!DirectPath.tryTunnelAfter(hostKeyMismatch = true, wentThroughTunnel = false, carried = false))
        // The right key, or another failure: nothing to try again.
        assertTrue(!DirectPath.tryTunnelAfter(hostKeyMismatch = false, wentThroughTunnel = false, carried = true))
    }
}
