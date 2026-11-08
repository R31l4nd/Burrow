package io.github.r31l4nd.burrow

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * The app's sign-in key: EC P-256 in the Android Keystore, never leaves the
 * phone, and every signature needs a fresh fingerprint (or the screen lock
 * on Android 11+). Burrow's server keeps the public half (auth/devices.ts).
 */
object DeviceKey {
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private val ops = object : KeySlots.Ops {
        override fun exists(alias: String) = store().containsAlias(alias)
        override fun delete(alias: String) {
            val s = store()
            if (s.containsAlias(alias)) s.deleteEntry(alias)
        }
        override fun generate(alias: String): String {
            val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                    } else {
                        @Suppress("DEPRECATION")
                        setUserAuthenticationValidityDurationSeconds(-1)
                    }
                }
                .build()
            val kp = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
            return Base64.encodeToString(kp.public.encoded, Base64.NO_WRAP)
        }
    }

    private fun slots(prefs: Prefs) = KeySlots(ops, object : KeySlots.Names {
        override var current: String?
            get() = prefs.deviceKeyAlias
            set(v) {
                prefs.deviceKeyAlias = v
            }
        override var staged: String?
            get() = prefs.stagedKeyAlias
            set(v) {
                prefs.stagedKeyAlias = v
            }
    })

    /** A new key beside the one in use (it takes over at commit); returns its public key as base64 SPKI. */
    fun create(prefs: Prefs): String = slots(prefs).stage()

    /** The pairing went through: the new key is the one in use. */
    fun commit(prefs: Prefs) = slots(prefs).commit()

    /** A signature object to unlock with the fingerprint prompt, or null without a key. */
    fun signature(prefs: Prefs): Signature? {
        val key = store().getKey(slots(prefs).current(), null) as? PrivateKey ?: return null
        return Signature.getInstance("SHA256withECDSA").apply { initSign(key) }
    }

    fun exists(prefs: Prefs): Boolean = store().containsAlias(slots(prefs).current())

    fun delete(prefs: Prefs) = slots(prefs).forget()
}
