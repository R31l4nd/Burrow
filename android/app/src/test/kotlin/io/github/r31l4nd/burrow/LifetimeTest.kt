package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

class LifetimeTest {
    @Test
    fun aResultAfterTheScreenEndedIsClosedNotKept() {
        // Audit AN-07: a connection made after the direct screen was left stayed open.
        val life = Lifetime()
        val kept = mutableListOf<String>()
        val closed = mutableListOf<String>()
        assertTrue(life.keep("before", { closed += it }) { kept += it })
        life.end()
        assertFalse(life.keep("after", { closed += it }) { kept += it })
        assertEquals(listOf("before"), kept)
        assertEquals(listOf("after"), closed)
    }

    @Test
    fun aWaitForTheFingerprintEndsWithTheScreen() {
        val life = Lifetime()
        val latch = CountDownLatch(1)
        var answer: Boolean? = null
        val t = thread { answer = life.await(latch, 60_000) }
        Thread.sleep(100)
        life.end()
        t.join(2_000)
        assertEquals(false, answer)
    }

    @Test
    fun aWaitEndsAfterItsTime() {
        assertFalse(Lifetime().await(CountDownLatch(1), 50))
        val done = CountDownLatch(1).apply { countDown() }
        assertTrue(Lifetime().await(done, 50))
    }
}
