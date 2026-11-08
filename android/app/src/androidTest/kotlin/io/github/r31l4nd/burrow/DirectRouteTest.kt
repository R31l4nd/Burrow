package io.github.r31l4nd.burrow

import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.runner.RunWith

/**
 * Phase 5's criterion on a device: the direct route. Run one step at a time
 * by scripts/android-test.sh, with Burrow stopped in between:
 *   d1: Burrow is up, the host was given the phone's key; the app fetches its cache.
 *   d2: Burrow is down; the app still opens a terminal on the host by itself.
 *   d3: a port of the host, forwarded to the phone.
 */
@RunWith(AndroidJUnit4::class)
class DirectRouteTest : WebTestBase() {
    private val args get() = InstrumentationRegistry.getArguments()
    private val hostId get() = args.getString("hostId")!!.toLong()

    private fun main(scenario: ActivityScenario<MainActivity>): () -> WebView {
        lateinit var a: MainActivity
        scenario.onActivity { a = it }
        return { a.webView }
    }

    private fun direct(scenario: ActivityScenario<DirectActivity>): () -> WebView {
        lateinit var a: DirectActivity
        scenario.onActivity { a = it }
        return { a.webView }
    }

    @Test
    fun d1_fetchesTheCache() {
        app.unlocked = false
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            unlockWithPin()
            val web = main(scenario)
            opened(web)
            // The app syncs by itself once signed in; ask once more, now that
            // the host has the key.
            js(web, "BurrowAndroid.postMessage(JSON.stringify({ id: 99998, method: 'syncDirect', params: {} }))")
            waitUntil("the cache with the host", 30_000) {
                val c = DirectStore(ctx).cache()
                c != null && (0 until c.getJSONArray("hosts").length()).any { c.getJSONArray("hosts").getJSONObject(it).getLong("id") == hostId }
            }
        }
        val h = DirectStore(ctx).cache()!!.getJSONArray("hosts").getJSONObject(0)
        assertEquals(hostId, h.getLong("id"))
        assertNotNull(h.getJSONArray("hostKeys").getJSONObject(0).getString("keyB64"))
    }

    @Test
    fun d2_terminalWithoutBurrow() {
        app.unlocked = false
        ActivityScenario.launch(MainActivity::class.java).use {
            unlockWithPin()
            // Burrow is down: the app says so and offers the way around it.
            val direct = device.wait(Until.findObject(By.text(ctx.getString(R.string.direct_route))), 30_000)
            assertNotNull("the error screen offers the direct route", direct)
            screenshot("09-unreachable")
            direct.click()
            val a = resumed(DirectActivity::class.java)
            val web = { a.webView }
            waitJs(web, "document.querySelector('[data-testid=direct-host]')")
            screenshot("10-direct-hosts")
            js(web, "document.querySelector('[data-testid=direct-host]').click()")
            // Logging in with the phone's key takes a fresh confirmation.
            Thread.sleep(2500)
            enterPin()
            waitJs(web, "document.querySelector('[data-testid=route-direct]') && document.querySelector('.xterm-rows')", 45_000) { enterPin() }
            waitJs(web, "document.querySelector('.xterm-rows').innerText.includes('$')", 20_000)
            js(web, "document.querySelector('.xterm-helper-textarea').focus()")
            keyboardUp()
            // Typed like on the soft keyboard; the answer (reversed) can only
            // come from the host.
            shell("input text echo%sdirect-ok%s|%srev")
            shell("input keyevent KEYCODE_ENTER")
            val screen = "document.querySelector('.xterm-rows').innerText.replace(/\\s+/g, ' ')"
            waitUntil("the host's answer", 20_000, detail = { "screen: ${js(web, "$screen.slice(-500)")}" }) {
                (js(web, "$screen.includes('ko-tcerid')") == true)
            }
            screenshot("11-direct-terminal")

            // Android ends the WebViews' renderer (memory): the app stays, the session too, and the page
            // comes back with it on screen; typing still reaches the host (A3-AND-02).
            val before = web()
            killRenderer(before)
            waitUntil("a new WebView for the direct route", 15_000) {
                var now: WebView? = null
                instr.runOnMainSync { now = a.webView }
                now !== before
            }
            waitJs(web, "document.querySelector('[data-testid=route-direct]') && document.querySelector('.xterm-rows')", 30_000)
            // Tapped where a finger would: the new WebView takes the keyboard.
            val r = org.json.JSONArray(js(web, "(function(){var r=document.querySelector('.xterm-screen').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()").toString())
            val at = IntArray(2)
            instr.runOnMainSync { web().getLocationOnScreen(at) }
            val d = ctx.resources.displayMetrics.density
            device.click((at[0] + r.getDouble(0) * d).toInt(), (at[1] + r.getDouble(1) * d).toInt())
            keyboardUp()
            shell("input text echo%sagain-ok%s|%srev")
            shell("input keyevent KEYCODE_ENTER")
            waitUntil("the same session answers after the renderer came back", 20_000, detail = { "screen: ${js(web, "$screen.slice(-500)")}" }) {
                (js(web, "$screen.includes('ko-niaga')") == true)
            }

            // Leaving: Android's back button (the first press may only close
            // the keyboard). The host has tmux, so the session is kept there:
            // no question, the host list again, the host marked.
            val onList = "document.querySelector('[data-testid=direct-host]') && !document.querySelector('.xterm-rows')"
            device.pressBack()
            if (!waitFor(3_000) { js(web, onList) == true }) device.pressBack()
            waitJs(web, onList)
            waitJs(web, "document.querySelector('[data-testid=direct-kept]')")
            screenshot("12-direct-left")

            // Opened again: the same session, with what it showed before.
            js(web, "document.querySelector('[data-testid=direct-host]').click()")
            Thread.sleep(2500)
            enterPin()
            waitJs(web, "document.querySelector('.xterm-rows')", 45_000) { enterPin() }
            waitUntil("the kept session's earlier output", 20_000, detail = { "screen: ${js(web, "$screen.slice(-400)")}" }) {
                js(web, "$screen.includes('ko-tcerid')") == true
            }

            // Ended on purpose from the menu: asked (it stops what runs), then gone.
            js(web, "document.querySelector('[aria-label=' + ${org.json.JSONObject.quote(org.json.JSONObject.quote(tr("term.sessions")))} + ']').click()")
            waitJs(web, "document.querySelector('[data-testid=direct-end]')")
            screenshot("13-direct-menu")
            js(web, "document.querySelector('[data-testid=direct-end]').click()")
            waitJs(web, "document.querySelector('dialog[open] [data-testid=confirm-ok]')")
            assertEquals("the question says what happens", tr("direct.end"), js(web, "document.querySelector('[data-testid=confirm-ok]').textContent.trim()"))
            js(web, "document.querySelector('[data-testid=confirm-ok]').click()")
            waitJs(web, onList)
            waitJs(web, "!document.querySelector('[data-testid=direct-kept]')")
        }
    }

    /**
     * A port of the host on the phone: the host's own SSH port here, so the
     * phone's 127.0.0.1 answers with the host's SSH banner. The browser that
     * would open the page is stubbed; the address it got is checked.
     */
    @Test
    fun d3_portForward() {
        app.unlocked = true
        androidx.test.espresso.intent.Intents.init()
        try {
            androidx.test.espresso.intent.Intents.intending(androidx.test.espresso.intent.matcher.IntentMatchers.hasAction(android.content.Intent.ACTION_VIEW))
                .respondWith(android.app.Instrumentation.ActivityResult(android.app.Activity.RESULT_OK, null))
            ActivityScenario.launch(DirectActivity::class.java).use { scenario ->
                val web = direct(scenario)
                waitJs(web, "document.querySelector('[data-testid=direct-forward]')")
                js(web, "document.querySelector('[data-testid=direct-forward]').click()")
                waitJs(web, "document.querySelector('[data-testid=forward-port]')")
                js(web, "const i = document.querySelector('[data-testid=forward-port]'); i.value = '22'; i.dispatchEvent(new Event('input', { bubbles: true }))")
                screenshot("14-direct-forward")
                js(web, "document.querySelector('[data-testid=forward-start]').click()")
                Thread.sleep(2500)
                enterPin()
                waitJs(web, "document.querySelector('[data-testid=forwards]')", 45_000) { enterPin() }
                val url = androidx.test.espresso.intent.Intents.getIntents().last { it.action == android.content.Intent.ACTION_VIEW }.dataString!!
                val port = android.net.Uri.parse(url).port
                assertEquals("127.0.0.1", android.net.Uri.parse(url).host)
                val banner = java.net.Socket("127.0.0.1", port).use { it.getInputStream().bufferedReader().readLine() }
                assertEquals(true, banner.startsWith("SSH-2.0"))
            }
        } finally {
            androidx.test.espresso.intent.Intents.release()
        }
    }
}
