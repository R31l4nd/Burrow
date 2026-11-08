package io.github.r31l4nd.burrow

/**
 * Single sign-on in the app: Burrow sends the WebView to the provider's
 * sign-in page, which is another site. Normally other sites open in the
 * browser; during a sign-in they stay in the WebView (otherwise the
 * session would end up in the browser), until Burrow's own page is back
 * (its callback, or the person gave up) or ten minutes later.
 */
class SsoFlow(private val now: () -> Long = System::currentTimeMillis) {
    private var until = 0L

    /** For a navigation: true to keep it in the WebView. */
    fun keepInApp(path: String?, sameOrigin: Boolean): Boolean {
        if (sameOrigin) {
            // Any other page of Burrow's own: the sign-in is over, done or given up (back out of the provider).
            until = if (path?.startsWith("/api/auth/oidc/start") == true) now() + TEN_MINUTES else 0L
            return true
        }
        return now() < until
    }

    private companion object {
        const val TEN_MINUTES = 10 * 60_000L
    }
}
