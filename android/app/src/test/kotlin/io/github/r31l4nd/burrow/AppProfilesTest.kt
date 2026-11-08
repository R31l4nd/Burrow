package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppProfilesTest {
    @Test
    fun `app 1 of two servers gets two profiles, the same server and app the same one (AUDIT2 AND-15)`() {
        val a = AppProfiles.name("https://burrow.home.example.com", 1)
        val b = AppProfiles.name("https://burrow.other.example.org", 1)
        assertNotEquals(a, b)
        assertEquals(a, AppProfiles.name("https://burrow.home.example.com", 1))
        assertNotEquals(a, AppProfiles.name("https://burrow.home.example.com", 2))
        assertTrue(a.startsWith(AppProfiles.PREFIX))
    }
}
