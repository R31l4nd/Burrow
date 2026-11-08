package io.github.r31l4nd.burrow

import android.content.Context

/** The little the app remembers: which server, and its paired device id there. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("burrow", Context.MODE_PRIVATE)

    var origin: String?
        get() = sp.getString("origin", null)
        set(v) = sp.edit().putString("origin", v).apply()

    var deviceId: Long?
        get() = sp.getLong("deviceId", 0).takeIf { it > 0 }
        set(v) = sp.edit().putLong("deviceId", v ?: 0).apply()

    /** The Keystore entry of the sign-in key in use, and one made for a pairing not yet through (KeySlots). */
    var deviceKeyAlias: String?
        get() = sp.getString("deviceKeyAlias", null)
        set(v) = sp.edit().putString("deviceKeyAlias", v).apply()

    var stagedKeyAlias: String?
        get() = sp.getString("stagedKeyAlias", null)
        set(v) = sp.edit().putString("stagedKeyAlias", v).apply()

    /** The main page's language, theme and terminal settings, for the direct route's page. */
    var uiPrefs: String
        get() = sp.getString("uiPrefs", "{}") ?: "{}"
        set(v) = sp.edit().putString("uiPrefs", v).apply()

    /** Screenshots of Burrow allowed (off by default: a terminal shows secrets). */
    var allowScreenshots: Boolean
        get() = sp.getBoolean("allowScreenshots", false)
        set(v) = sp.edit().putBoolean("allowScreenshots", v).apply()

    /** A shake of the phone reports a problem (on by default; Settings -> Android app). */
    var shakeReport: Boolean
        get() = sp.getBoolean("shakeReport", true)
        set(v) = sp.edit().putBoolean("shakeReport", v).apply()

    /** Device test only (debug builds): behave like a release build for FLAG_SECURE. */
    var simulateRelease: Boolean
        get() = sp.getBoolean("simulateRelease", false)
        set(v) = sp.edit().putBoolean("simulateRelease", v).apply()

    var askedNotifications: Boolean
        get() = sp.getBoolean("askedNotifications", false)
        set(v) = sp.edit().putBoolean("askedNotifications", v).apply()

    /** Where Burrow's push reaches this phone (UnifiedPush): {url, p256dh, auth}, or null. */
    var pushEndpoint: String?
        get() = sp.getString("pushEndpoint", null)
        set(v) = sp.edit().putString("pushEndpoint", v).apply()

    /** The widget away from home: "tunnel" (up for a moment to ask), "last" (what it knew), or "push" (sent when it changes). */
    var widgetAway: String
        get() = sp.getString("widgetAway", "tunnel") ?: "tunnel"
        set(v) = sp.edit().putString("widgetAway", v).apply()

    /** The widget's last numbers (WidgetNumbers JSON), and whether Burrow wanted a sign-in when last asked. */
    var widgetLast: String?
        get() = sp.getString("widgetLast", null)
        set(v) = sp.edit().putString("widgetLast", v).apply()

    var widgetSignIn: Boolean
        get() = sp.getBoolean("widgetSignIn", false)
        set(v) = sp.edit().putBoolean("widgetSignIn", v).apply()

    /** The phone's folders the person granted for Burrow's Files page (PhoneFolders): JSON, PhonePaths.encodeRoots. */
    var phoneRoots: String?
        get() = sp.getString("phoneRoots", null)
        set(v) = sp.edit().putString("phoneRoots", v).apply()

    /** "All files" for Burrow's Files page, switched on by the person (report 862305): off by default, and only with Android's permission too. */
    var allFiles: Boolean
        get() = sp.getBoolean("allFiles", false)
        set(v) = sp.edit().putBoolean("allFiles", v).apply()
}
