package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class CacheCleanupTest {
    @Test
    fun `copies older than a day go, newer ones and their folders stay (AUDIT2 AND-21)`() {
        val dir = Files.createTempDirectory("share").toFile()
        val now = System.currentTimeMillis()
        val old = dir.resolve("a/old.txt").apply { parentFile.mkdirs(); writeText("x"); setLastModified(now - 2 * CacheCleanup.MAX_AGE_MS) }
        val fresh = dir.resolve("b/fresh.txt").apply { parentFile.mkdirs(); writeText("y") }
        assertEquals(1, CacheCleanup.old(dir, now))
        assertFalse(old.exists())
        assertFalse(old.parentFile.exists())
        assertTrue(fresh.exists())
        dir.deleteRecursively()
    }
}
