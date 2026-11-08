package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Test

class TunnelChangeTest {
    /**
     * The tunnel back after it went down in the background (the battery rule):
     * a page that is there is told, never reloaded, or its unsaved work went
     * (A3-AND-03). Only a page that did not load is loaded again.
     */
    @Test
    fun aPageOnScreenIsToldNotReloaded() {
        // Up again, a new start of the tunnel, the page there: told.
        assertEquals(TunnelChange.Action.TELL_PAGE, TunnelChange.decide(up = true, viaTunnel = true, starts = 3, loadedWith = 2, pageShown = true))
        // Away now, the page loaded straight before: told as well (its requests take the proxy from now on).
        assertEquals(TunnelChange.Action.TELL_PAGE, TunnelChange.decide(up = true, viaTunnel = false, starts = 1, loadedWith = 0, pageShown = true))
        // Home again: told.
        assertEquals(TunnelChange.Action.TELL_PAGE, TunnelChange.decide(up = false, viaTunnel = true, starts = 1, loadedWith = 1, pageShown = true))
        // The error screen in front (nothing loaded): loaded again.
        assertEquals(TunnelChange.Action.RELOAD, TunnelChange.decide(up = true, viaTunnel = false, starts = 1, loadedWith = 0, pageShown = false))
        // Nothing changed: nothing done.
        assertEquals(TunnelChange.Action.NONE, TunnelChange.decide(up = true, viaTunnel = true, starts = 2, loadedWith = 2, pageShown = true))
        assertEquals(TunnelChange.Action.NONE, TunnelChange.decide(up = false, viaTunnel = false, starts = 2, loadedWith = 1, pageShown = false))
    }
}
