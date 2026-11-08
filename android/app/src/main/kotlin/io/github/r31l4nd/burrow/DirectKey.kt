package io.github.r31l4nd.burrow

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * The direct route's SSH key: EC P-256 (ecdsa-sha2-nistp256) in the Android
 * Keystore. It never leaves the phone, and it works only for 30 seconds
 * after a fingerprint (or the screen lock on Android 11+): the app asks for
 * one right before logging in to a host.
 */
object DirectKey {
    private const val ALIAS = "burrow-ssh"
    const val VALID_SECONDS = 30

    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun create() {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setUserAuthenticationParameters(VALID_SECONDS, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                } else {
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds(VALID_SECONDS)
                }
            }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
    }

    /**
     * Void for good: Android drops a key bound to the screen lock when that lock is removed or a
     * fingerprint added. Its certificate stays, so the old public key was still reported and every
     * host refused the login (review 2026-10-24). Not void, only not unlocked in the last seconds:
     * that is the normal case here.
     */
    private fun voided(s: KeyStore): Boolean = runCatching {
        java.security.Signature.getInstance("SHA256withECDSA").initSign(s.getKey(ALIAS, null) as PrivateKey)
        false
    }.getOrElse { it is android.security.keystore.KeyPermanentlyInvalidatedException }

    /** The public key, made on first use, and made anew when the old one is void (the person adds it to the hosts again). */
    fun publicKey(): ECPublicKey {
        val s = store()
        if (s.containsAlias(ALIAS) && voided(s)) s.deleteEntry(ALIAS)
        if (!s.containsAlias(ALIAS)) create()
        return store().getCertificate(ALIAS).publicKey as ECPublicKey
    }

    fun privateKey(): PrivateKey = store().getKey(ALIAS, null) as PrivateKey

    fun openSshLine(): String {
        val w = publicKey().w
        return SshWire.openSshLine(SshWire.ecdsaP256Blob(w.affineX, w.affineY))
    }

    fun exists(): Boolean = store().containsAlias(ALIAS)

    fun delete() {
        val s = store()
        if (s.containsAlias(ALIAS)) s.deleteEntry(ALIAS)
    }
}
