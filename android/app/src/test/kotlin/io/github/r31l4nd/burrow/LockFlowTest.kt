package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When the fingerprint lock covers the screen and asks (LockGate). */
class LockFlowTest {
    private var unlocked = false
    private var canLock = true
    private var covered = false
    private val prompts = mutableListOf<(Boolean) -> Unit>()
    private val flow = LockFlow({ unlocked }, { unlocked = true }, { canLock }, { prompts += it }, { covered = it })

    /** Covered at once; the prompt only once the screen is up, then open. */
    @Test
    fun coversAtOnceAndAsksWhenTheScreenIsUp() {
        flow.onStart()
        assertTrue(covered)
        assertEquals("no prompt before the screen is up", 0, prompts.size)
        flow.onResume()
        assertEquals(1, prompts.size)
        assertTrue(covered)
        prompts.single()(true)
        assertTrue(unlocked)
        assertFalse(covered)
    }

    /** Cancelled: still covered; the prompt comes again with Unlock, or on the next return, not by itself. */
    @Test
    fun aCancelKeepsItCovered() {
        flow.onStart()
        flow.onResume()
        prompts.single()(false)
        assertTrue(covered)
        assertFalse(unlocked)
        flow.onResume()
        assertEquals("once per return to the app", 1, prompts.size)
        flow.guard()
        assertEquals("Unlock asks again", 2, prompts.size)
        prompts[1](false)
        flow.onStart()
        flow.onResume()
        assertEquals(3, prompts.size)
    }

    /** Never two prompts at a time: Unlock tapped while one is open does nothing more. */
    @Test
    fun onePromptAtATime() {
        flow.guard()
        flow.guard()
        flow.onStart()
        flow.onResume()
        assertEquals(1, prompts.size)
        prompts[0](false)
        flow.guard()
        assertEquals(2, prompts.size)
    }

    /** Unlocked already (another screen of the app): not covered, no prompt. */
    @Test
    fun unlockedStaysOpen() {
        unlocked = true
        flow.onStart()
        assertFalse(covered)
        flow.onResume()
        assertFalse(covered)
        assertEquals(0, prompts.size)
    }

    /** A phone without a screen lock has nothing to lock with: open, and so marked. */
    @Test
    fun withoutAScreenLockItIsOpen() {
        canLock = false
        flow.onStart()
        assertFalse(covered)
        flow.onResume()
        assertTrue(unlocked)
        assertEquals(0, prompts.size)
    }

    /** Out of sight more than five minutes: locked again on return; less, or locked already, not. */
    @Test
    fun theLockComesBackAfterFiveMinutes() {
        val hidden = 1_000_000L
        assertFalse(LockFlow.relocks(true, hidden + LockFlow.LOCK_AFTER_MS, hidden))
        assertTrue(LockFlow.relocks(true, hidden + LockFlow.LOCK_AFTER_MS + 1, hidden))
        assertFalse(LockFlow.relocks(false, hidden + 10 * LockFlow.LOCK_AFTER_MS, hidden))
        assertEquals(300_000L, LockFlow.LOCK_AFTER_MS)
    }
}
