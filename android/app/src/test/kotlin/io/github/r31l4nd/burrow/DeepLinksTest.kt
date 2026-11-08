package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeepLinksTest {
    @Test
    fun opensPagesInsideBurrowOnly() {
        assertEquals("#/logs?t=3:web&at=2026-09-27T10:00:00.000Z", DeepLinks.pageForPath("/logs?t=3:web&at=2026-09-27T10:00:00.000Z"))
        assertEquals("#/alerts", DeepLinks.pageForPath("/alerts"))
        assertNull(DeepLinks.pageForPath("https://evil.example/"))
        assertNull(DeepLinks.pageForPath("//evil.example/x"))
        assertNull(DeepLinks.pageForPath("/logs\"><script>"))
        assertNull(DeepLinks.pageForPath("javascript:alert(1)"))
        assertNull(DeepLinks.pageForPath(null))
    }

    /** A host shortcut's CONNECT counts only through the app's own entry for it, never from another app (A3-AND-05). */
    @Test
    fun connectsOnlyFromTheAppsOwnShortcut() {
        assertEquals("#/hosts?connect=12", DeepLinks.pageForConnect(12, viaShortcut = true))
        assertNull("another app sent it to the exported screen", DeepLinks.pageForConnect(12, viaShortcut = false))
        assertNull(DeepLinks.pageForConnect(0, viaShortcut = true))
        assertNull(DeepLinks.pageForConnect(-3, viaShortcut = true))
    }
}
