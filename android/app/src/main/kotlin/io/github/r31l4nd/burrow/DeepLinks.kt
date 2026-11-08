package io.github.r31l4nd.burrow

import android.net.Uri

/**
 * Links into the app from elsewhere, such as a push notification in the
 * ntfy app: burrow://open?to=/logs?t=3:web&at=... opens that page of Burrow.
 * Only a path inside Burrow is accepted, never another site.
 *
 * A link never acts by itself: it only opens a page. Where the page would
 * act on what the link carries (connect to a host, analyse logs, run a
 * snippet), Burrow's page asks first and names what it would do; the app
 * hands every link to the page and starts nothing on its own (A3-AND-05).
 */
object DeepLinks {
    /** The class of the app's own, not exported, entry for host shortcuts (AndroidManifest.xml). */
    const val SHORTCUT_ENTRY = "io.github.r31l4nd.burrow.HostShortcut"

    /**
     * "#/hosts?connect=12" for a host shortcut, but only when it came through
     * [SHORTCUT_ENTRY]: Burrow's main screen is exported (the launcher, share
     * and links need it), so any app could send it CONNECT with a host id.
     */
    fun pageForConnect(hostId: Long, viaShortcut: Boolean): String? =
        if (viaShortcut && hostId > 0) "#/hosts?connect=$hostId" else null

    private val PAGE = Regex("^/[A-Za-z0-9/_\\-?=&%:.,+~]*$")

    /** "#/logs?..." for a burrow://open link, or null for anything else. */
    fun pageFor(link: String?): String? {
        link ?: return null
        val uri = runCatching { Uri.parse(link) }.getOrNull() ?: return null
        if (uri.scheme != "burrow" || uri.host != "open") return null
        return pageForPath(uri.getQueryParameter("to"))
    }

    /** The checks on the path itself (plain Kotlin, for unit tests). */
    fun pageForPath(to: String?): String? {
        to ?: return null
        if (!PAGE.matches(to) || to.startsWith("//")) return null
        return "#$to"
    }
}
