package io.github.r31l4nd.burrow

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The home screen widget's numbers (2.11.0): read from Burrow, kept, and said as the last known when old. */
class WidgetTest {
    private val burrow = """{"at":"2026-11-01T12:00:00.000Z","hosts":{"total":4,"up":3,"down":1},"alerts":2,"updates":{"hosts":1,"security":2},"list":[{"id":2,"name":"pi","state":"down","updates":0,"security":0},{"id":1,"name":"nas","state":"up","updates":3,"security":2}]}"""

    @Test
    fun readFromBurrowAndKept() {
        val n = WidgetNumbers.fromBurrow(JSONObject(burrow))!!
        val list = listOf(WidgetHost(2, "pi", "down", 0, 0), WidgetHost(1, "nas", "up", 3, 2))
        assertEquals(WidgetNumbers(at = 1_793_534_400_000L, total = 4, up = 3, down = 1, alerts = 2, updateHosts = 1, security = 2, hosts = list), n)
        assertEquals(n, WidgetNumbers.stored(n.json()))
    }

    @Test
    fun fromABurrowBeforeTheListNoLines() {
        // A Burrow before 2.13.0 sends no list, and numbers kept by the app before then have none.
        val old = """{"at":"2026-11-01T12:00:00.000Z","hosts":{"total":4,"up":3,"down":1},"alerts":2,"updates":{"hosts":1,"security":2}}"""
        assertEquals(emptyList<WidgetHost>(), WidgetNumbers.fromBurrow(JSONObject(old))!!.hosts)
        assertEquals(emptyList<WidgetHost>(), WidgetNumbers.stored("""{"at":1,"total":1,"up":1,"down":0,"alerts":0,"updateHosts":0,"security":0}""")!!.hosts)
    }

    @Test
    fun asManyHostsAsFitTheRestCounted() {
        // Report 05a818: each host on a line; where they do not all fit, the last line says how many more.
        val list = (1..6).map { WidgetHost(it.toLong(), "h$it", "up", 0, 0) }
        assertEquals(list.map { it.name }, widgetLines(list, 6).map { it.host?.name })
        val four = widgetLines(list, 4)
        assertEquals(listOf("h1", "h2", "h3", null), four.map { it.host?.name })
        assertEquals(3, four.last().more)
        assertEquals(emptyList<WidgetLine>(), widgetLines(list, 0))
    }

    @Test
    fun notBurrowsNumbersAreNone() {
        assertNull(WidgetNumbers.fromBurrow(JSONObject("""{"title":"Disk full"}""")))
        assertNull(WidgetNumbers.fromBurrow(JSONObject("""{"at":"yesterday","hosts":{"total":1,"up":1,"down":0},"alerts":0,"updates":{"hosts":0,"security":0}}""")))
        assertNull(WidgetNumbers.stored(null))
        assertNull(WidgetNumbers.stored("garbage"))
    }

    @Test
    fun theLastKnownAfterAnHourOrAFailedAsk() {
        val n = WidgetNumbers.fromBurrow(JSONObject(burrow))!!
        assertFalse(widgetStale(n, n.at + 30 * 60_000L, lastAskFailed = false))
        assertTrue(widgetStale(n, n.at + 61 * 60_000L, lastAskFailed = false))
        assertTrue(widgetStale(n, n.at + 60_000L, lastAskFailed = true))
    }

    @Test
    fun theWidgetKeySignsWhatBurrowChecks() {
        // As server/src/android/widget.ts builds it (widgetMessage).
        assertEquals("burrow-widget\nhttps://burrow.example\n7\n1793534400000", WidgetKey.message("https://burrow.example", 7, 1_793_534_400_000L))
    }
}

