package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FenceTest {
    @Test
    fun aSyncThatEndsAfterAClearIsNotKept() {
        val fence = Fence()
        var cache: String? = null
        val late = fence.begin()
        fence.reset { cache = null }
        assertFalse(fence.commit(late) { cache = "old server" })
        assertEquals(null, cache)
        val now = fence.begin()
        assertTrue(fence.commit(now) { cache = "new server" })
        assertEquals("new server", cache)
    }
}
