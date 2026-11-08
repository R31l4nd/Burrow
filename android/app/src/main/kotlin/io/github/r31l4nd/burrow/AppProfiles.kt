package io.github.r31l4nd.burrow

import java.security.MessageDigest

/**
 * The WebView profile (cookies, storage) of an app tab: per server and app.
 * By the app's number alone, app 1 of another server opened in the first
 * server's app 1, signed in as it was there (AUDIT2 AND-15).
 */
object AppProfiles {
    const val PREFIX = "app-"

    fun name(origin: String, appId: Long): String {
        val server = MessageDigest.getInstance("SHA-256").digest(origin.toByteArray()).take(6).joinToString("") { "%02x".format(it) }
        return "$PREFIX$server-$appId"
    }
}
