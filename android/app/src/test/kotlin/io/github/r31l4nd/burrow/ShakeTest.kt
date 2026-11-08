package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Test

class ShakeTest {
    private fun shakes(vararg at: Long): List<Long> {
        val c = ShakeCounter()
        return at.filter { c.counts(it) }
    }

    @Test
    fun twoJoltsWithinASecondAreAShake() {
        assertEquals(listOf(1_300L), shakes(1_000, 1_300))
    }

    @Test
    fun oneJoltReadSeveralTimesIsNot() {
        assertEquals(emptyList<Long>(), shakes(1_000, 1_040, 1_090, 1_120))
    }

    @Test
    fun joltsFarApartAreNot() {
        assertEquals(emptyList<Long>(), shakes(1_000, 2_500, 4_000))
    }

    @Test
    fun oneShakeIsOneReportThenQuiet() {
        assertEquals(listOf(1_300L, 5_300L), shakes(1_000, 1_300, 1_600, 1_900, 5_000, 5_300))
    }

    @Test
    fun aJoltIsWellOverGravity() {
        assertEquals(false, Shake.jolt(0f, 0f, 9.81f))
        assertEquals(false, Shake.jolt(10f, 10f, 9.81f))
        assertEquals(true, Shake.jolt(25f, 0f, 9.81f))
    }
}
