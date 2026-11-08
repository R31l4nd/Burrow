package io.github.r31l4nd.burrow

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * The home screen widget's own key (2.12.0): EC P-256 in the Android
 * Keystore, usable without a fingerprint, so the widget can ask from the
 * background once the app's sign-in has run out. Burrow lets it read the
 * widget's counts and nothing else (server/src/android/widget.ts); the
 * sign-in key (DeviceKey) still needs the fingerprint for every signature.
 */
object WidgetKey {
    private const val ALIAS = "burrow-widget"

    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** Its public half as base64 SPKI, made the first time. */
    fun publicKey(): String {
        val s = store()
        if (!s.containsAlias(ALIAS)) {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
        }
        return Base64.encodeToString(store().getCertificate(ALIAS).publicKey.encoded, Base64.NO_WRAP)
    }

    /** The header Burrow reads: "<deviceId>.<ms>.<signature>", or null without a key. */
    fun header(origin: String, deviceId: Long, now: Long): String? {
        val key = store().getKey(ALIAS, null) as? PrivateKey ?: return null
        val sig = Signature.getInstance("SHA256withECDSA").apply {
            initSign(key)
            update(message(origin, deviceId, now).toByteArray(Charsets.UTF_8))
        }.sign()
        return "$deviceId.$now.${Base64.encodeToString(sig, Base64.NO_WRAP)}"
    }

    /** What it signs, as Burrow builds it (widgetMessage): its phone, the moment, and which Burrow. */
    fun message(origin: String, deviceId: Long, now: Long): String = listOf("burrow-widget", origin, deviceId.toString(), now.toString()).joinToString("\n")
}
