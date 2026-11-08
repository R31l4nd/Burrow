package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeySlotsTest {
    private class FakeStore : KeySlots.Ops, KeySlots.Names {
        val keys = mutableMapOf<String, String>()
        var n = 0
        override fun exists(alias: String) = alias in keys
        override fun delete(alias: String) {
            keys.remove(alias)
        }
        override fun generate(alias: String): String = "pub${++n}".also { keys[alias] = it }
        override var current: String? = null
        override var staged: String? = null
    }

    @Test
    fun aFailedPairingKeepsTheKeyInUse() {
        val f = FakeStore()
        val slots = KeySlots(f, f)
        slots.stage()
        slots.commit()
        val inUse = slots.current()
        val before = f.keys[inUse]
        // A new pairing whose code was wrong: staged, never committed.
        slots.stage()
        assertEquals(inUse, slots.current())
        assertEquals(before, f.keys[inUse])
        assertTrue(f.exists(inUse))
    }

    @Test
    fun aPairingThatWentThroughReplacesTheOldKey() {
        val f = FakeStore()
        val slots = KeySlots(f, f)
        slots.stage()
        slots.commit()
        val old = slots.current()
        val pub = slots.stage()
        slots.commit()
        assertEquals(pub, f.keys[slots.current()])
        assertFalse(f.exists(old))
        slots.forget()
        assertTrue(f.keys.isEmpty())
    }
}
