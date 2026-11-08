package io.github.r31l4nd.burrow

import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.Signature

/** The fingerprint prompt, for the app lock and for the device key. */
object Biometrics {
    // Android 10 cannot combine a strong biometric with the screen lock.
    private val lockAuthenticators =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_WEAK or DEVICE_CREDENTIAL
    // A signature with the device key in the prompt itself (a CryptoObject): a strong biometric
    // alone on Android 10, which cannot pair one with the screen lock.
    private val signAuthenticators =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG

    /**
     * What unlocks the direct route's time-bound key. Android 10 cannot offer a strong biometric
     * and the screen lock together: a fingerprint when the phone has one, else the screen lock
     * (any unlock opens a time-bound key there). A phone without a fingerprint could never log in
     * (review 2026-10-24).
     */
    fun keyAuthenticators(sdk: Int, strongBiometric: Boolean): Int = when {
        sdk >= Build.VERSION_CODES.R -> BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        strongBiometric -> BIOMETRIC_STRONG
        else -> BIOMETRIC_WEAK or DEVICE_CREDENTIAL
    }

    /** False when the phone has no screen lock: then there is nothing to lock with. */
    fun canLock(a: FragmentActivity): Boolean = lockable(
        BiometricManager.from(a).canAuthenticate(lockAuthenticators),
        a.getSystemService(android.app.KeyguardManager::class.java)?.isDeviceSecure ?: true,
    )

    /**
     * Locked unless the phone truly has no screen lock. A sensor that is
     * busy, or a status the query cannot tell, used to read as "no lock" and
     * took the cover away (AUDIT2 AND-05): with a screen lock set, the prompt
     * still offers it.
     */
    fun lockable(status: Int, deviceSecure: Boolean): Boolean =
        status == BiometricManager.BIOMETRIC_SUCCESS || deviceSecure

    fun unlock(a: FragmentActivity, done: (Boolean) -> Unit) {
        val prompt = BiometricPrompt(a, ContextCompat.getMainExecutor(a), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(true)
            override fun onAuthenticationError(code: Int, msg: CharSequence) = done(false)
        })
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(a.getString(R.string.lock_prompt))
                .setSubtitle(a.getString(R.string.lock_subtitle))
                .setAllowedAuthenticators(lockAuthenticators)
                .build(),
        )
    }

    /**
     * A fingerprint (or the screen lock on Android 11+) that unlocks a
     * time-bound Keystore key for a moment: the direct route's SSH key.
     */
    fun confirm(a: FragmentActivity, title: String, subtitle: String, done: (Boolean) -> Unit) {
        val prompt = BiometricPrompt(a, ContextCompat.getMainExecutor(a), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(true)
            override fun onAuthenticationError(code: Int, msg: CharSequence) = done(false)
        })
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .apply {
                    val allowed = keyAuthenticators(Build.VERSION.SDK_INT, BiometricManager.from(a).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS)
                    setAllowedAuthenticators(allowed)
                    if (allowed and DEVICE_CREDENTIAL == 0) setNegativeButtonText(a.getString(R.string.cancel))
                }
                .build(),
        )
    }

    /** Signs [message] after the fingerprint; the callback gets the DER signature or an error. */
    fun sign(a: FragmentActivity, server: String, sig: Signature, message: ByteArray, done: (Result<ByteArray>) -> Unit) {
        val prompt = BiometricPrompt(a, ContextCompat.getMainExecutor(a), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                done(
                    runCatching {
                        val s = result.cryptoObject?.signature ?: error("no signature")
                        s.update(message)
                        s.sign()
                    },
                )
            }

            override fun onAuthenticationError(code: Int, msg: CharSequence) = done(Result.failure(Exception(msg.toString())))
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(a.getString(R.string.sign_title))
            .setSubtitle(a.getString(R.string.sign_subtitle, server))
            .setAllowedAuthenticators(signAuthenticators)
            .apply { if (signAuthenticators and DEVICE_CREDENTIAL == 0) setNegativeButtonText(a.getString(R.string.cancel)) }
            .build()
        prompt.authenticate(info, BiometricPrompt.CryptoObject(sig))
    }
}
