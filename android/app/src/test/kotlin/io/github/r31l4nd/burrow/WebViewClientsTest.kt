package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every WebViewClient of the app handles the loss of the WebViews' shared
 * renderer: one that does not takes the whole app down with it (A3-AND-02).
 * Android lint's own check for this flags every Kotlin client (it takes the
 * super constructor call for a plain WebViewClient), so it is off and this
 * test holds the rule (A3-AND-12).
 */
class WebViewClientsTest {
    @Test
    fun everyClientHandlesALostRenderer() {
        val dir = File("src/main/kotlin")
        assertTrue("the app's sources at ${dir.absolutePath}", dir.isDirectory)
        val clients = mutableListOf<String>()
        for (f in dir.walk().filter { it.name.endsWith(".kt") }) {
            val text = f.readText()
            var at = text.indexOf(": WebViewClient()")
            while (at >= 0) {
                // The client's body: from its opening brace to the matching closing one.
                val open = text.indexOf('{', at)
                var depth = 0
                var end = open
                while (end < text.length) {
                    if (text[end] == '{') depth++
                    if (text[end] == '}' && --depth == 0) break
                    end++
                }
                val body = text.substring(open, end)
                clients += "${f.name}:${text.substring(0, at).count { it == '\n' } + 1}"
                assertTrue("${clients.last()} handles onRenderProcessGone", body.contains("override fun onRenderProcessGone("))
                at = text.indexOf(": WebViewClient()", end)
            }
        }
        // MainActivity, the app tabs and the direct route: if one goes or comes, look at this test again.
        assertEquals(clients.toString(), 3, clients.size)
    }
}
