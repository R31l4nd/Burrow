package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Test

class ScreenshotTest {
    @Test
    fun aDenseScreenIsDrawnSmaller() {
        // 343 CSS pixels at 3.25x: 1115 pixels, drawn at twice the CSS width.
        assertEquals(686, Screenshot.width(1115, 686))
    }

    @Test
    fun neverLarger() {
        assertEquals(720, Screenshot.width(720, 1080))
    }

    @Test
    fun noLimitIsTheViewsWidth() {
        assertEquals(1115, Screenshot.width(1115, 0))
    }
}
