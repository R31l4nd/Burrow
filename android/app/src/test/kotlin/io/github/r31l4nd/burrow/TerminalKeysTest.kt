package io.github.r31l4nd.burrow

import android.view.KeyEvent
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayInputStream

/** The terminal's volume keys and the direct route's completion helpers. */
class TerminalKeysTest {
    @Test
    fun theVolumeKeysGoToTheTerminalOncePerPress() {
        assertEquals("down", TerminalMode.volumeKey(true, KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.ACTION_DOWN, 0))
        assertEquals("up", TerminalMode.volumeKey(true, KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.ACTION_DOWN, 0))
        assertEquals("its repeat: only swallowed", "", TerminalMode.volumeKey(true, KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.ACTION_DOWN, 1))
        assertEquals("its release: only swallowed", "", TerminalMode.volumeKey(true, KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.ACTION_UP, 0))
        assertNull("the phone's volume as usual", TerminalMode.volumeKey(false, KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.ACTION_DOWN, 0))
        assertNull("another key", TerminalMode.volumeKey(true, KeyEvent.KEYCODE_ENTER, KeyEvent.ACTION_DOWN, 0))
    }

    /** A directory for path completion: from home, absolute, or from where the shell is. */
    @Test
    fun completionListsTheRightFolder() {
        assertEquals("/home/pi/docs", DirectSsh.dirFor("~/docs", "/srv", "/home/pi"))
        assertEquals("/etc/nginx", DirectSsh.dirFor("/etc/nginx", "/srv", "/home/pi"))
        assertEquals("/srv", DirectSsh.dirFor("", "/srv", "/home/pi"))
        assertEquals("/home/pi", DirectSsh.dirFor("", null, "/home/pi"))
        assertEquals("/srv/app", DirectSsh.dirFor("app", "/srv/", "/home/pi"))
        assertEquals("/home/pi/app", DirectSsh.dirFor("app", null, "/home/pi"))
    }

    /** A folder name with a quote cannot break out of the cd before the command. */
    @Test
    fun quotesForTheShell() {
        assertEquals("'it'\\''s here'", DirectSsh.quote("it's here"))
        assertEquals("'\$(rm -rf ~)'", DirectSsh.quote("\$(rm -rf ~)"))
    }

    /** A completion that floods is cut at its cap. */
    @Test
    fun aCommandsOutputIsCapped() {
        val big = ByteArray(DirectSsh.MAX_EXEC + 10_000) { 'x'.code.toByte() }
        assertEquals(DirectSsh.MAX_EXEC, DirectSsh.readCapped(ByteArrayInputStream(big)).size)
        assertArrayEquals("ok".toByteArray(), DirectSsh.readCapped(ByteArrayInputStream("ok".toByteArray())))
    }
}
