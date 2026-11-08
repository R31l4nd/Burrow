package io.github.r31l4nd.burrow

import androidx.biometric.BiometricManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BiometricsTest {
    @Test
    fun aSensorThatFailsDoesNotTakeTheLockAway() {
        for (s in listOf(BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE, BiometricManager.BIOMETRIC_STATUS_UNKNOWN, BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED, BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED)) {
            assertTrue("status $s with a screen lock", Biometrics.lockable(s, deviceSecure = true))
        }
        assertTrue(Biometrics.lockable(BiometricManager.BIOMETRIC_SUCCESS, deviceSecure = true))
        // No screen lock at all: nothing to lock with.
        assertFalse(Biometrics.lockable(BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED, deviceSecure = false))
    }

    /** Review 2026-10-24: on Android 10 a phone without a fingerprint could never use the direct route. */
    @Test
    fun theDirectKeyOpensWithWhatThePhoneHas() {
        val strong = BiometricManager.Authenticators.BIOMETRIC_STRONG
        val weak = BiometricManager.Authenticators.BIOMETRIC_WEAK
        val lock = BiometricManager.Authenticators.DEVICE_CREDENTIAL
        assertEquals(strong or lock, Biometrics.keyAuthenticators(30, strongBiometric = false))
        assertEquals(strong, Biometrics.keyAuthenticators(29, strongBiometric = true))
        assertEquals(weak or lock, Biometrics.keyAuthenticators(29, strongBiometric = false))
    }
}
