package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectBacklogTest {
    @Test
    fun `output before the page listens is kept in order and given at attach, then passes at once (AUDIT2 AND-08)`() {
        val b = DirectBacklog()
        assertNull(b.output("user@host:~$ "))
        assertNull(b.output("ls\r\n"))
        val (text, end) = b.attach()
        assertEquals("user@host:~$ ls\r\n", text)
        assertFalse(end.first)
        assertEquals("next", b.output("next"))
        assertTrue(b.close("bye"))
    }

    @Test
    fun `an end before the page listens is given at attach, after the output`() {
        val b = DirectBacklog()
        b.output("goodbye")
        assertFalse(b.close("Connection closed"))
        val (text, end) = b.attach()
        assertEquals("goodbye", text)
        assertTrue(end.first)
        assertEquals("Connection closed", end.second)
    }

    @Test
    fun `held output is bounded, the oldest going first`() {
        val b = DirectBacklog(max = 4)
        b.output("abc")
        b.output("defg")
        assertEquals("defg", b.attach().first)
    }
}
