package io.github.r31l4nd.burrow

import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** AES-256-GCM with a random nonce in front: how the direct route's cache is kept on disk. */
object Sealed {
    private const val NONCE = 12

    fun seal(key: SecretKey, plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        // The provider picks a fresh random nonce (the Keystore insists on it).
        c.init(Cipher.ENCRYPT_MODE, key)
        val iv = c.iv
        require(iv.size == NONCE) { "unexpected nonce size" }
        return iv + c.doFinal(plain)
    }

    fun open(key: SecretKey, sealed: ByteArray): ByteArray {
        require(sealed.size > NONCE) { "too short" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, NONCE))
        return c.doFinal(sealed, NONCE, sealed.size - NONCE)
    }
}
