package io.github.r31l4nd.burrow

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SsoFlowTest {
    @Test
    fun theProviderStaysInTheAppOnlyDuringASignIn() {
        var t = 0L
        val f = SsoFlow { t }
        assertFalse("another site, no sign-in", f.keepInApp("/", false))
        assertTrue(f.keepInApp("/api/auth/oidc/start", true))
        assertTrue("the provider's page", f.keepInApp("/authorize", false))
        assertTrue(f.keepInApp("/api/auth/oidc/callback", true))
        assertFalse("after the callback", f.keepInApp("/x", false))
        f.keepInApp("/api/auth/oidc/start", true)
        t += 11 * 60_000L
        assertFalse("after ten minutes", f.keepInApp("/authorize", false))
    }

    /** Review 2026-10-24: a sign-in given up (back to Burrow) kept every other site in the app for ten minutes. */
    @Test
    fun aSignInGivenUpEndsWhenBurrowIsBackInFront() {
        val f = SsoFlow { 0L }
        f.keepInApp("/api/auth/oidc/start", true)
        assertTrue(f.keepInApp("/authorize", false))
        assertTrue("back on Burrow's sign-in page", f.keepInApp("/", true))
        assertFalse("another site: the browser again", f.keepInApp("/somewhere", false))
    }
}
