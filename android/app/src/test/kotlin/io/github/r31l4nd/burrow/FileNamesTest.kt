package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FileNamesTest {
    @Test
    fun keepsOnlyTheLastPart() {
        assertEquals("passwd", FileNames.safe("../../etc/passwd"))
        assertEquals("x.txt", FileNames.safe("C:\\dir\\x.txt"))
        assertEquals("file", FileNames.safe(".."))
        assertEquals("file", FileNames.safe(null))
        assertEquals(".env", FileNames.safe(".env"))
        assertEquals("ab.txt", FileNames.safe("a\u0000b.txt"))
    }

    @Test
    fun shortensLongNamesKeepingTheExtension() {
        val n = FileNames.safe("a".repeat(300) + ".jpeg")
        assertTrue(n.length <= 120)
        assertTrue(n.endsWith(".jpeg"))
    }
}
