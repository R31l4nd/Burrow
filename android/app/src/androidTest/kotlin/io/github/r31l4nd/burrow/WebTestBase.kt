package io.github.r31l4nd.burrow

import android.app.Instrumentation
import android.webkit.WebView
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONTokener
import org.junit.Assert.fail
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** What the device tests share: shell input, JavaScript in a WebView, waiting. */
abstract class WebTestBase {
    protected val instr: Instrumentation get() = InstrumentationRegistry.getInstrumentation()
    protected val ctx get() = instr.targetContext
    protected val app get() = ctx.applicationContext as BurrowApp

    /** Which window has the focus and which activity is in front, now (for the log). */
    protected fun inFront(): String {
        val focus = shell("dumpsys window").lines().filter { "mCurrentFocus" in it }.joinToString(" | ") { it.trim() }
        val top = shell("dumpsys activity activities").lines().filter { "topResumedActivity" in it }.take(1).joinToString(" | ") { it.trim() }
        return "$focus || $top"
    }

    // ---- helpers

    protected fun shell(cmd: String): String =
        instr.uiAutomation.executeShellCommand(cmd).let { pfd ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd).use { String(it.readBytes()) }
        }

    // ---- the language and look of a pass (scripts/android-test.sh: -e lang nl)

    /** The language this pass runs in: the page's and, through the app's own locale, the native screens'. */
    protected val lang: String get() = InstrumentationRegistry.getArguments().getString("lang") ?: "en"

    private val words: org.json.JSONObject by lazy {
        // Burrow's own words (web/src/lib/i18n/<lang>.json, put beside the test by scripts/android-test.sh).
        runCatching { org.json.JSONObject(instr.context.assets.open("i18n/$lang.json").use { String(it.readBytes()) }) }
            .getOrElse { fail("web/src/lib/i18n/$lang.json is not in the test APK (scripts/android-test.sh copies it): $it"); throw it }
    }

    /**
     * A text of Burrow's page in this pass's language, by its key: the tests
     * found buttons by English text and could not run in Dutch. Placeholders
     * given are filled in; the text stops at the first one not given (for a
     * button that goes on with a name).
     */
    protected fun tr(key: String, vararg values: Pair<String, Any>): String {
        var s = words.optString(key).ifEmpty { fail("no text $key in $lang.json"); "" }
        for ((k, v) in values) s = s.replace("{$k}", v.toString())
        val open = s.indexOf('{')
        return if (open >= 0) s.substring(0, open) else s
    }

    /**
     * A fresh step-up for the signed-in admin, with the throwaway instance's
     * authenticator (-e totp): opening a terminal needs one younger than 15
     * minutes, and a longer run (more tests, the tablet and dark passes) went
     * past that from the sign-in. A code counts once: one used already in
     * this half minute waits for the next.
     */
    protected fun stepUp(web: () -> WebView) {
        val secret = InstrumentationRegistry.getArguments().getString("totp") ?: return
        repeat(3) {
            val code = totp(secret, System.currentTimeMillis() / 30_000)
            val status = js(web, "(function(){var x=new XMLHttpRequest();x.open('POST','/api/auth/step-up/totp',false);x.setRequestHeader('content-type','application/json');x.send(JSON.stringify({code:'$code'}));return x.status})()")
            if ((status as? Number)?.toInt() == 200) return
            Thread.sleep(31_000)
        }
        fail("the step-up with the authenticator was refused")
    }

    /** RFC 6238 with otplib's defaults: SHA-1, 6 digits, 30 s. */
    private fun totp(base32: String, counter: Long): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var bits = 0
        var value = 0
        val key = java.io.ByteArrayOutputStream()
        for (c in base32.uppercase().filter { it != '=' }) {
            value = (value shl 5) or alphabet.indexOf(c)
            bits += 5
            if (bits >= 8) {
                key.write((value shr (bits - 8)) and 0xff)
                bits -= 8
            }
        }
        val mac = javax.crypto.Mac.getInstance("HmacSHA1").apply { init(javax.crypto.spec.SecretKeySpec(key.toByteArray(), "HmacSHA1")) }
        val h = mac.doFinal(java.nio.ByteBuffer.allocate(8).putLong(counter).array())
        val o = h.last().toInt() and 0x0f
        val n = ((h[o].toInt() and 0x7f) shl 24) or ((h[o + 1].toInt() and 0xff) shl 16) or ((h[o + 2].toInt() and 0xff) shl 8) or (h[o + 3].toInt() and 0xff)
        return "%06d".format(n % 1_000_000)
    }

    protected fun enterPin() {
        shell("input text 1234")
        shell("input keyevent 66")
    }

    protected fun js(web: () -> WebView, script: String): Any? {
        val latch = CountDownLatch(1)
        var out = "null"
        instr.runOnMainSync {
            web().evaluateJavascript(script) {
                out = it ?: "null"
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return JSONTokener(out).nextValue()
    }

    /**
     * Burrow's page signed in and the app's own lock open. The page loads
     * under the lock's cover, so its navigation alone says nothing: the
     * fingerprint prompt (answered with the emulator's PIN) can still be in
     * front, and a tap then lands on it (the tablet round's flake).
     */
    protected fun opened(web: () -> WebView, timeoutMs: Long = 45_000) {
        waitJs(web, "document.querySelector('nav.bottomnav')", timeoutMs) { enterPin() }
        val app = ctx.applicationContext as BurrowApp
        waitUntil("the app's lock open", 30_000, detail = { inFront() }) {
            if (!app.unlocked && inFront().contains("BiometricPrompt")) {
                enterPin()
                Thread.sleep(800)
            }
            app.unlocked
        }
        // The page in this pass's language (a pass runs as a person who chose it in Settings).
        if (js(web, "document.documentElement.lang") != lang) {
            js(web, "localStorage.setItem('burrow.locale', ${org.json.JSONObject.quote(lang)}); location.reload()")
            Thread.sleep(1000)
            waitJs(web, "document.documentElement.lang === ${org.json.JSONObject.quote(lang)} && document.querySelector('nav.bottomnav')", timeoutMs)
        }
    }

    protected fun waitJs(web: () -> WebView, cond: String, timeoutMs: Long = 30_000, onRetry: (() -> Unit)? = null) {
        val end = System.currentTimeMillis() + timeoutMs
        var n = 0
        while (System.currentTimeMillis() < end) {
            if (js(web, "!!($cond)") == true) return
            Thread.sleep(300)
            if (++n % 15 == 0) onRetry?.invoke()
        }
        // What the screen showed when it gave up (a system prompt, a keyboard).
        screenshot("failed-wait-${System.currentTimeMillis() % 100000}", mayBeBlack = true)
        fail("timed out waiting for: $cond\npage: ${js(web, "location.href + ' ' + (document.body ? document.body.innerText.slice(0, 400) : '')")}\nin front: ${inFront()}")
    }

    /** Whether `cond` became true within the time; no failure when it did not. */
    protected fun waitFor(timeoutMs: Long, cond: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return true
            Thread.sleep(250)
        }
        return false
    }

    /**
     * Waits a moment for the soft keyboard after a field got the focus. Typed
     * before it was connected, the first keys went to the page as raw keys and
     * the later ones through the keyboard, two ways that can overtake each
     * other (DirectRouteTest once typed "ceho" for "echo").
     */
    protected fun keyboardUp() {
        waitFor(3_000) { shell("dumpsys input_method").contains("mInputShown=true") }
        Thread.sleep(300)
    }

    protected fun waitUntil(what: String, timeoutMs: Long = 20_000, detail: () -> String = { "" }, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return
            Thread.sleep(250)
        }
        fail("timed out waiting for $what ${detail()} (in front: ${inFront()})")
    }

    /** Presses the button or link whose text starts with [text] (from [tr]: in this pass's language). */
    protected fun click(web: () -> WebView, text: String) {
        val t = org.json.JSONObject.quote(text)
        waitJs(web, "[...document.querySelectorAll('button, a')].some(b => b.textContent.trim().startsWith($t) && !b.disabled)")
        js(web, "[...document.querySelectorAll('button, a')].find(b => b.textContent.trim().startsWith($t) && !b.disabled).click()")
    }

    /**
     * The page as the DOM has it, on the screen itself: two frames drawn, and
     * a pixel of [selector] (4 px into it) in its own background colour; by
     * default the title bar in the colour the page names (its theme-color).
     * Right after pairing the DOM had the hosts page while the WebView still
     * showed the pairing form, and that was the picture (UIA-16); back from
     * Android's folder picker the same with the folder just added.
     */
    protected fun drawn(web: () -> WebView, selector: String? = null, timeoutMs: Long = 15_000) {
        js(web, "window.__drawn = false; requestAnimationFrame(() => requestAnimationFrame(() => { window.__drawn = true }))")
        waitJs(web, "window.__drawn", timeoutMs)
        val q = selector?.let { org.json.JSONObject.quote(it) }
        // Where (CSS px in the page) and which colour, as the page has it.
        val spec = org.json.JSONArray(
            js(
                web,
                if (q == null) "[4, 4, document.querySelector('meta[name=\"theme-color\"]').getAttribute('content')]"
                else "(() => { const e = document.querySelector($q); const r = e.getBoundingClientRect(); const c = getComputedStyle(e).backgroundColor.match(/\\d+/g).slice(0, 3).map(Number); return [r.left + 4, r.top + 4, '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('')]; })()",
            ).toString(),
        )
        val want = android.graphics.Color.parseColor(spec.getString(2))
        val at = IntArray(2)
        instr.runOnMainSync { web().getLocationOnScreen(at) }
        val d = ctx.resources.displayMetrics.density
        val x = at[0] + (spec.getDouble(0) * d).toInt()
        val y = at[1] + (spec.getDouble(1) * d).toInt()
        var got = 0
        val near = { a: Int, b: Int -> listOf(16, 8, 0).all { kotlin.math.abs(((a shr it) and 0xff) - ((b shr it) and 0xff)) <= 4 } }
        val start = System.currentTimeMillis()
        var tries = 0
        waitUntil("the page drawn on the screen (${selector ?: "its title bar"} #${Integer.toHexString(want and 0xffffff)} at $x,$y)", timeoutMs, detail = { "pixel #${Integer.toHexString(got and 0xffffff)}" }) {
            tries++
            got = instr.uiAutomation.takeScreenshot()?.getPixel(x, y) ?: 0
            near(got, want)
        }
        // How long the screen lagged behind the page (the first look counts as one).
        android.util.Log.i("BurrowTest", "drawn after ${System.currentTimeMillis() - start} ms, $tries looks")
    }

    /**
     * A screenshot for the review of every screen (scripts/android-test.sh
     * copies them to artifacts/android-screens/). Debug builds allow them.
     */
    protected fun screenshot(name: String, mayBeBlack: Boolean = false) {
        Thread.sleep(1200)
        val bmp = instr.uiAutomation.takeScreenshot() ?: return
        // All black: a secure window in front (the system's fingerprint prompt), not the screen meant.
        // Such a picture passed without a word before; now the test says what stood in front.
        val black = (0 until bmp.height step 16).all { y -> (0 until bmp.width step 16).all { x -> bmp.getPixel(x, y) and 0xffffff == 0 } }
        if (black && !mayBeBlack) fail("screenshot $name is black: a secure window in front (${inFront()})")
        val dir = java.io.File(ctx.filesDir, "screens").apply { mkdirs() }
        // Run again as a tablet or turned (scripts/android-test.sh): its screens apart.
        val prefix = androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("shotPrefix") ?: ""
        java.io.FileOutputStream(java.io.File(dir, "$prefix$name.png")).use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 90, it) }
        // What the picture shows, in words: a black one once hid what stood in front.
        android.util.Log.i("TestRunner", "screenshot $prefix$name: ${inFront()}")
    }

    /**
     * Ends the renderer of all of the app's WebViews, as Android does under
     * memory pressure. A WebView client that does not handle that takes the
     * whole app process down with it (A3-AND-02).
     */
    protected fun killRenderer(web: WebView) {
        org.junit.Assume.assumeTrue(
            "WebView can end its renderer",
            androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.GET_WEB_VIEW_RENDERER) &&
                androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_VIEW_RENDERER_TERMINATE),
        )
        var ended = false
        instr.runOnMainSync { ended = androidx.webkit.WebViewCompat.getWebViewRenderProcess(web)?.terminate() == true }
        org.junit.Assert.assertTrue("the renderer was ended", ended)
    }

    /** A picture of one of the app's own views, drawn by the view (for one behind a secure system window). */
    protected fun viewShot(view: android.view.View, name: String) {
        val bmp = android.graphics.Bitmap.createBitmap(view.width.coerceAtLeast(1), view.height.coerceAtLeast(1), android.graphics.Bitmap.Config.ARGB_8888)
        view.draw(android.graphics.Canvas(bmp))
        val dir = java.io.File(ctx.filesDir, "screens").apply { mkdirs() }
        val prefix = InstrumentationRegistry.getArguments().getString("shotPrefix") ?: ""
        java.io.FileOutputStream(java.io.File(dir, "$prefix$name.png")).use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 90, it) }
    }

    protected val device: androidx.test.uiautomator.UiDevice get() = androidx.test.uiautomator.UiDevice.getInstance(instr)

    /** The activity on screen now (one we did not launch ourselves, such as after a tap). */
    protected fun <T : android.app.Activity> resumed(cls: Class<T>, timeoutMs: Long = 15_000): T {
        var found: T? = null
        waitUntil("${cls.simpleName} on screen", timeoutMs) {
            instr.runOnMainSync {
                found = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                    .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).filterIsInstance(cls).firstOrNull()
            }
            found != null
        }
        return found!!
    }

    /** The PIN (the emulator's stand-in for a fingerprint), again until the app is unlocked. */
    protected fun unlockWithPin() {
        for (i in 0 until 6) {
            shell("input keyevent KEYCODE_WAKEUP")
            enterPin()
            if (runCatching { waitUntil("unlock", 4000) { app.unlocked } }.isSuccess) return
        }
        waitUntil("unlock") { app.unlocked }
    }
}
