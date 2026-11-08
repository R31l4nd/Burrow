package io.github.r31l4nd.burrow

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * The app against a real Burrow (scripts/android-test.sh): lock, pairing,
 * signing in with the device key, the share target, "open with" coming
 * back edited, and an app tab keeping its own sign-in. In order: each step
 * builds on the one before, like a person setting up their phone.
 *
 * The emulator has a PIN (1234) instead of a fingerprint; on Android 11+ the
 * app lock and the device key accept both.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class DeviceTest : WebTestBase() {
    companion object {
        private val instr: Instrumentation get() = InstrumentationRegistry.getInstrumentation()
        private val args get() = InstrumentationRegistry.getArguments()
        private val origin get() = args.getString("origin")!!
        private val hostId get() = args.getString("hostId")!!.toLong()
        private val appId get() = args.getString("appId")!!.toLong()
        private val appUrl get() = args.getString("appUrl")!!

        // Shared between the steps: the file the share target uploaded.
        private var sharedName = ""
        private var sharedSize = 0L

        @BeforeClass
        @JvmStatic
        fun fresh() {
            // Run again as a tablet or turned (scripts/android-test.sh): as it is,
            // paired and unlocked (the lock itself is t1's, on the phone).
            if (args.getString("keep") != null) {
                instr.runOnMainSync { (instr.targetContext.applicationContext as BurrowApp).unlockForTest() }
                return
            }
            // A fresh install: no server chosen yet (t0 goes through the setup screen).
            Prefs(instr.targetContext).origin = null
        }
    }

    /** Waits until the server lists [name] in the host's home folder with [size] bytes. */
    private fun waitServerFile(web: () -> WebView, name: String, size: Long) {
        val q = org.json.JSONObject.quote(name)
        val fetch = "window.__l = null; fetch('/api/files/$hostId/list?path=~').then(r => r.json()).then(j => window.__l = j)"
        js(web, fetch)
        waitJs(web, "window.__l && window.__l.entries.some(e => e.name === $q && e.size === $size)", 60_000) { js(web, fetch) }
    }

    private fun main(scenario: ActivityScenario<MainActivity>): () -> WebView {
        lateinit var a: MainActivity
        scenario.onActivity { a = it }
        return { a.webView }
    }

    // ---- the steps

    @Test
    fun t0_asksForTheServerFirst() {
        app.unlocked = false
        ActivityScenario.launch(MainActivity::class.java).use {
            val input = device.wait(Until.findObject(By.res(ctx.packageName, "server_input")), 15_000)
            assertNotNull("the setup screen asks for the server", input)
            screenshot("01-setup")
            // Only https: a plain address is refused with a message.
            input.text = "http://burrow.example.com"
            device.findObject(By.text(ctx.getString(R.string.setup_continue))).click()
            assertNotNull(device.wait(Until.findObject(By.text(ctx.getString(R.string.setup_invalid))), 5_000))
            screenshot("01b-setup-error")
            input.text = origin
            device.findObject(By.text(ctx.getString(R.string.setup_continue))).click()
            waitUntil("the server saved") { Prefs(ctx).origin == origin }
            resumed(MainActivity::class.java)
        }
    }

    @Test
    fun t1_locksThenPairsWithACode() {
        app.unlocked = false
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            // This debug build takes screenshots for the review (t8 checks the release behaviour).
            scenario.onActivity { assertFalse(it.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0) }
            Thread.sleep(2500)
            assertFalse("locked at start", app.unlocked)
            // The page loading behind the cover is hidden from screen readers and
            // accessibility services too, and takes no keyboard focus (A3-AND-08).
            scenario.onActivity {
                assertEquals("the page behind the lock is hidden from accessibility", android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, it.webView.importantForAccessibility)
                assertFalse("the page behind the lock takes no focus", it.webView.isFocusable)
            }
            // The system's fingerprint prompt in front is a secure window (a screenshot of it is
            // black, and Back does not cancel its PIN pad): the app's own lock screen behind it,
            // drawn by itself, is the picture.
            scenario.onActivity { viewShot(it.lockCover(), "02-lock") }
            unlockWithPin()
            scenario.onActivity {
                assertEquals("open again for accessibility", android.view.View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, it.webView.importantForAccessibility)
                // Focusable on a touch again: setFocusable(false) under the cover had turned that off
                // too, and the keyboard never came up again in that window (report 5e035c).
                assertTrue("takes the focus again", it.webView.isFocusable)
                assertTrue("takes the focus on a touch again, for the keyboard", it.webView.isFocusableInTouchMode)
            }

            val web = main(scenario)
            waitJs(web, "document.querySelector('.auth-card')")
            screenshot("03-login")
            assertEquals("object", js(web, "typeof BurrowAndroid"))
            click(web, tr("login.pairWithCode"))
            val code = org.json.JSONObject.quote(args.getString("pairCode")!!)
            js(web, "(() => { const i = document.querySelector('.auth-card form input'); i.value = $code; i.dispatchEvent(new Event('input', { bubbles: true })); })()")
            click(web, tr("login.pair"))
            waitJs(web, "document.querySelector('nav.bottomnav')")
            // The first screen after pairing as it is drawn, not the form before it (UIA-16).
            drawn(web)
            screenshot("04-hosts")
            // Kept for the next run (ONLY= runs the other tests in a new process after this one).
            instr.runOnMainSync { CookieManager.getInstance().flush() }
            assertNotNull(Prefs(ctx).deviceId)
            assertTrue(DeviceKey.exists(Prefs(ctx)))
        }
    }

    @Test
    fun t2_signsInWithTheDeviceKey() {
        val latch = CountDownLatch(1)
        instr.runOnMainSync { CookieManager.getInstance().removeAllCookies { latch.countDown() } }
        latch.await(5, TimeUnit.SECONDS)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            // The login page asks for the key straight away; the prompt
            // takes the PIN. Typed again if the prompt was not up yet.
            Thread.sleep(3000)
            enterPin()
            waitJs(web, "document.querySelector('nav.bottomnav')", 45_000) {
                // The prompt gone without the PIN (the emulator, now and then:
                // "Cancelled"): asked again, as a person would.
                val again = org.json.JSONObject.quote(tr("login.fingerprint"))
                val cancelled = org.json.JSONObject.quote(tr("login.fingerprintCancelled").substringBefore('.'))
                js(web, "(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith($again)); if (b && document.body.innerText.includes($cancelled)) b.click(); })()")
                Thread.sleep(2000)
                enterPin()
            }
        }
    }

    @Test
    fun t3_uploadsWhatIsSharedToIt() {
        sharedName = "photo-${Random.nextInt(100000)}.jpg"
        val bytes = Random.nextBytes(2_500_000)
        sharedSize = bytes.size.toLong()
        // This app's own files, shared to it by another app (a file:// path, its own provider):
        // not read, not offered for upload (A3-AND-07).
        val own = File(ctx.cacheDir, "share/test/$sharedName").apply {
            parentFile!!.mkdirs()
            writeBytes(bytes)
        }
        app.held.clear()
        for (bad in listOf(FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", own), android.net.Uri.fromFile(java.io.File(ctx.dataDir, "shared_prefs/burrow.xml")))) {
            ActivityScenario.launch<MainActivity>(Intent(ctx, MainActivity::class.java).setAction(Intent.ACTION_SEND).setType("image/jpeg").putExtra(Intent.EXTRA_STREAM, bad)).use { scenario ->
                main(scenario)
                Thread.sleep(1500)
                assertTrue("$bad is not held for upload", app.held.list(HeldFiles.Kind.SHARED).isEmpty())
            }
        }
        own.delete()
        // What another app shares: its own provider's file (the media store's, here).
        val uri = ctx.contentResolver.insert(
            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, sharedName)
                put(android.provider.MediaStore.Downloads.MIME_TYPE, "image/jpeg")
                put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "Download/BurrowTest")
            },
        )!!
        ctx.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
        val intent = Intent(ctx, MainActivity::class.java)
            .setAction(Intent.ACTION_SEND)
            .setType("image/jpeg")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            val web = main(scenario)
            waitJs(web, "location.hash.startsWith('#/share')")
            val upload = tr("share.upload", "n" to 1)
            waitJs(web, "[...document.querySelectorAll('button')].some(b => b.textContent.includes(${org.json.JSONObject.quote(upload)}) && !b.disabled)")
            screenshot("05-share")
            click(web, upload)
            waitServerFile(web, sharedName, sharedSize)
            // The folder on screen shows it without a manual refresh.
            val q = org.json.JSONObject.quote(sharedName)
            waitJs(web, "[...document.querySelectorAll('[data-testid=file-row]')].some(r => r.textContent.includes($q))", 15_000)
            screenshot("05b-uploaded")
            // Done without errors: the transfers list goes away by itself.
            waitJs(web, "!document.querySelector('[data-testid=transfers], [data-testid=transfers-pill]')", 15_000)
        }
        ctx.contentResolver.delete(uri, null, null)
    }

    @Test
    fun t4_openWithBringsEditsBack() {
        Intents.init()
        try {
            intending(hasAction(Intent.ACTION_VIEW)).respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, null))
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val web = main(scenario)
                opened(web)
                js(web, "window.__home = null; fetch('/api/files/$hostId/list?path=~').then(r => r.json()).then(j => window.__home = j.path)")
                waitJs(web, "window.__home")
                val home = js(web, "window.__home") as String
                val path = "$home/$sharedName"
                // As a person would: Files, the file's menu, Open with...
                js(web, "location.hash = '#/files/$hostId?p=' + encodeURIComponent(window.__home)")
                val menu = org.json.JSONObject.quote(tr("files.menuFor", "name" to sharedName))
                waitJs(web, "document.querySelector('[aria-label=' + JSON.stringify($menu) + ']')")
                js(web, "document.querySelector('[aria-label=' + JSON.stringify($menu) + ']').click()")
                screenshot("06-file-menu")
                click(web, tr("files.openWith"))

                // The other app gets a copy; "edit" it there.
                val openDir = File(ctx.cacheDir, "open")
                waitUntil("the copy for the other app") {
                    openDir.walk().any { it.name == sharedName && it.length() == sharedSize }
                }
                val copy = openDir.walk().first { it.name == sharedName }
                Intents.intended(hasAction(Intent.ACTION_VIEW))
                copy.writeText("edited on the phone\n".repeat(50))
                copy.setLastModified(System.currentTimeMillis() + 2000)

                // Back in Burrow: it offers the change in its own dialog; yes.
                scenario.moveToState(Lifecycle.State.STARTED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                waitJs(web, "document.querySelector('dialog[open] [data-testid=confirm-ok]')")
                js(web, "document.querySelector('[data-testid=confirm-ok]').click()")
                waitServerFile(web, sharedName, copy.length())
            }
        } finally {
            Intents.release()
        }
    }

    @Test
    fun t5_appTabKeepsItsOwnSignIn() {
        // Signed out at the start, also when an earlier pass (tablet, dark) signed this tab in already.
        instr.runOnMainSync {
            val jar = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                androidx.webkit.ProfileStore.getInstance().getOrCreateProfile(AppProfiles.name(Prefs(ctx).origin ?: "", appId)).cookieManager
            } else {
                CookieManager.getInstance()
            }
            jar.setCookie(appUrl, "fakeapp=; Max-Age=0; Path=/")
            jar.flush()
        }
        val intent = Intent(ctx, AppTabsActivity::class.java)
            .putExtra(AppTabsActivity.EXTRA_ID, appId)
            .putExtra(AppTabsActivity.EXTRA_NAME, "Fake app")
            .putExtra(AppTabsActivity.EXTRA_URL, appUrl)
        val tab = { scenario: ActivityScenario<AppTabsActivity> ->
            lateinit var a: AppTabsActivity
            scenario.onActivity { a = it }
            ({ a.currentWebView()!! })
        }
        ActivityScenario.launch<AppTabsActivity>(intent).use { scenario ->
            val web = tab(scenario)
            waitJs(web, "document.getElementById('state')?.textContent === 'signed out'")
            // No bridge outside Burrow's own origin.
            assertEquals("undefined", js(web, "typeof BurrowAndroid"))
            js(web, "location.href = '/login'")
            waitJs(web, "document.getElementById('state')?.textContent === 'signed in'")
            if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                // Its own cookie jar: Burrow's WebView never saw the app's cookie.
                assertNull(CookieManager.getInstance().getCookie(appUrl))
            }
        }
        ActivityScenario.launch<AppTabsActivity>(intent).use { scenario ->
            waitJs(tab(scenario), "document.getElementById('state')?.textContent === 'signed in'")
            // At home (no tunnel): no tunnel icon in the bar.
            assertFalse(device.hasObject(By.desc(ctx.getString(R.string.through_tunnel))))
            screenshot("07-app-tab")
            // The tab's close button closes it; the last one takes you back to Burrow.
            val close = device.wait(Until.findObject(By.desc(ctx.getString(R.string.close_tab_named, "Fake app"))), 5_000)
            assertNotNull("each app tab can be closed", close)
            close.click()
            waitUntil("the tabs screen gone") { scenario.state == Lifecycle.State.DESTROYED }
        }
    }

    /**
     * The app's own downloads: an app tab's download asks first, then goes to
     * Downloads/Burrow whole; one that broke off goes on where it stopped
     * (a Range request) on Retry; Stop ends one and leaves nothing behind.
     */
    @Test
    fun t5b_downloadsAskFirstResumeAndStop() {
        val base = appUrl.trimEnd('/')
        // The file as the fake app serves it now (an earlier pass may have bumped its version).
        val served = java.net.URL("${appUrl.trimEnd('/')}/version").readText().trim().toInt()
        val expected = ByteArray(2 * 1024 * 1024) { ((it + served) % 251).toByte() }
        Downloads.clear(ctx)
        val intent = Intent(ctx, AppTabsActivity::class.java)
            .putExtra(AppTabsActivity.EXTRA_ID, appId)
            .putExtra(AppTabsActivity.EXTRA_NAME, "Fake app")
            .putExtra(AppTabsActivity.EXTRA_URL, "$base/downloads")
        ActivityScenario.launch<AppTabsActivity>(intent).use { scenario ->
            lateinit var a: AppTabsActivity
            scenario.onActivity { a = it }
            val web = { a.currentWebView()!! }
            waitJs(web, "document.getElementById('dl')")
            js(web, "document.getElementById('dl').click()")
            // Asked first; nothing runs before Save.
            waitUntil("the download is asked first") { a.asking?.isShowing == true }
            assertTrue(Downloads.list().isEmpty())
            // In Burrow's own look, as the page's questions (decision 23): its buttons as written,
            // not in capitals (A3-AND-23); Cancel and Save as wide as each other, Save filled with
            // the accent; a sheet as wide as the phone at its bottom, a box in the middle on a tablet.
            instr.runOnMainSync {
                val d = a.asking!!
                val ok = d.findViewById<android.widget.Button>(R.id.ask_ok)
                val cancel = d.findViewById<android.widget.Button>(R.id.ask_cancel)
                assertNotNull("Burrow's own Save button", ok)
                assertNotNull("and its Cancel", cancel)
                assertFalse("the question's buttons are not in capitals", ok.isAllCaps || cancel.isAllCaps)
                assertEquals("Cancel and Save as wide as each other", cancel.width, ok.width)
                val p = Style.palette(a)
                assertEquals("Save in the accent", p.accent, ((ok.background as android.graphics.drawable.RippleDrawable).getDrawable(0) as android.graphics.drawable.GradientDrawable).color?.defaultColor)
                assertEquals("the title in Burrow's words", ctx.getString(R.string.download_ask_title), d.findViewById<android.widget.TextView>(R.id.ask_title).text.toString())
                val box = d.window!!.decorView
                val screen = a.window.decorView.width
                if (a.resources.configuration.screenWidthDp >= Style.DIALOG_CENTRED_DP) {
                    assertTrue("a box in the middle on a tablet", box.width <= Style.dp(a, Style.DIALOG_DP) + 2)
                } else {
                    assertEquals("a sheet as wide as the phone", screen, box.width)
                    val at = IntArray(2)
                    box.getLocationOnScreen(at)
                    val content = IntArray(2)
                    a.window.decorView.findViewById<android.view.View>(android.R.id.content).getLocationOnScreen(content)
                    val bottom = content[1] + a.window.decorView.findViewById<android.view.View>(android.R.id.content).height
                    assertTrue("at the bottom of the screen (${at[1] + box.height} of $bottom)", at[1] + box.height >= bottom - Style.dp(a, 64f))
                }
            }
            screenshot("07b-download-asked")
            val save = device.wait(Until.findObject(By.text(java.util.regex.Pattern.compile("(?i)" + ctx.getString(R.string.download_save)))), 5_000)
            assertNotNull("a Save button", save)
            save.click()
            waitUntil("the download done", 30_000) { Downloads.list().any { it.name == "file.bin" && it.state == Downloads.State.DONE } }
            val item = Downloads.list().first { it.name == "file.bin" }
            val got = ctx.contentResolver.openInputStream(item.uri!!)!!.use { it.readBytes() }
            assertTrue("the whole file, byte for byte", got.contentEquals(expected))
            // In Downloads/Burrow.
            ctx.contentResolver.query(item.uri!!, arrayOf(android.provider.MediaStore.Downloads.RELATIVE_PATH), null, null, null)!!.use { c ->
                assertTrue(c.moveToFirst())
                assertEquals("Download/Burrow/", c.getString(0))
            }
            ctx.contentResolver.delete(item.uri!!, null, null)
        }

        // Broken off halfway: Retry asks for the rest only.
        val file = java.io.File(ctx.cacheDir, "dltest/file.bin").apply { delete() }
        val token = System.nanoTime().toString()
        val broken = Downloads.start(ctx, "$base/file.bin?break=$token", "file.bin", "file", Downloads.Target.Private(file), { null }, { null }, null)
        broken.await()
        assertEquals(Downloads.State.FAILED, broken.state)
        val half = broken.done
        assertTrue("part of it arrived ($half)", half in 1 until expected.size)
        Downloads.retry(ctx, broken.id)
        broken.await()
        assertEquals(broken.error, Downloads.State.DONE, broken.state)
        assertTrue("the whole file after the retry", file.readBytes().contentEquals(expected))
        val range = java.net.URL("$base/last-range").readText()
        assertEquals("the retry asked for the rest", "bytes=$half-", range)

        // Changed on the server between the two: the retry takes the new file
        // whole (If-Range), never the old half with the new rest.
        val file2 = java.io.File(ctx.cacheDir, "dltest/file2.bin").apply { delete() }
        val second = Downloads.start(ctx, "$base/file.bin?break=${System.nanoTime()}", "file2.bin", "file", Downloads.Target.Private(file2), { null }, { null }, null)
        second.await()
        assertEquals(Downloads.State.FAILED, second.state)
        val v = java.net.URL("$base/bump").readText().trim().toInt()
        Downloads.retry(ctx, second.id)
        second.await()
        assertEquals(second.error, Downloads.State.DONE, second.state)
        assertTrue("the new version, whole", file2.readBytes().contentEquals(ByteArray(2 * 1024 * 1024) { ((it + v) % 251).toByte() }))
        file2.delete()

        // Stop: gone, and its half file with it.
        val slowFile = java.io.File(ctx.cacheDir, "dltest/slow.bin").apply { delete() }
        val slow = Downloads.start(ctx, "$base/slow.bin", "slow.bin", "file", Downloads.Target.Private(slowFile), { null }, { null }, null)
        waitUntil("the slow one under way") { slow.done > 0 }
        assertTrue("its progress is told", Downloads.json().toString().contains("\"slow.bin\""))
        Downloads.stop(ctx, slow.id)
        slow.await()
        assertNull(Downloads.find(slow.id))
        assertFalse("nothing left behind", slowFile.exists())
        file.delete()
    }

    /**
     * The renderer of the app's WebViews ended (memory, a crash in a heavy
     * app): the app stays, and the tab comes back at its page (A3-AND-02).
     * Before, the tabs' client did not handle it and Android ended the whole
     * app, this test's process with it.
     */
    @Test
    fun t5c_anAppTabOutlivesItsRenderer() {
        val intent = Intent(ctx, AppTabsActivity::class.java)
            .putExtra(AppTabsActivity.EXTRA_ID, appId)
            .putExtra(AppTabsActivity.EXTRA_NAME, "Fake app")
            .putExtra(AppTabsActivity.EXTRA_URL, appUrl)
        ActivityScenario.launch<AppTabsActivity>(intent).use { scenario ->
            lateinit var a: AppTabsActivity
            scenario.onActivity { a = it }
            var before: WebView? = null
            instr.runOnMainSync { before = a.currentWebView() }
            waitJs({ before!! }, "document.getElementById('state')")
            killRenderer(before!!)
            waitUntil("a new WebView for the tab", 15_000) {
                var now: WebView? = null
                instr.runOnMainSync { now = a.currentWebView() }
                now != null && now !== before
            }
            waitJs({ a.currentWebView()!! }, "document.getElementById('state')", 30_000)
            assertEquals("the tabs screen is still there", Lifecycle.State.RESUMED, scenario.state)
        }
    }

    /**
     * An app tab whose app cannot be reached says so over the page, with
     * Retry; the WebView's own grey page had neither (A3-AND-11).
     */
    @Test
    fun t5d_anAppTabThatCannotBeReachedSaysSo() {
        // The test machine, at a port where nothing listens (and one Chromium does not refuse by itself).
        val down = android.net.Uri.parse(appUrl).let { "http://${it.host}:59/" }
        val intent = Intent(ctx, AppTabsActivity::class.java)
            .putExtra(AppTabsActivity.EXTRA_ID, 99_002L)
            .putExtra(AppTabsActivity.EXTRA_NAME, "Down app")
            .putExtra(AppTabsActivity.EXTRA_URL, down)
        ActivityScenario.launch<AppTabsActivity>(intent).use { scenario ->
            lateinit var a: AppTabsActivity
            scenario.onActivity { a = it }
            waitUntil("the tab says it cannot reach the app", 30_000) {
                var shown = false
                instr.runOnMainSync { shown = a.errorShown() }
                shown
            }
            assertNotNull("with Retry", device.wait(Until.findObject(By.text(ctx.getString(R.string.retry))), 5_000))
            var said = ""
            instr.runOnMainSync { said = a.errorText() }
            assertTrue("and what: $said", said.contains(android.net.Uri.parse(down).host!!) && said.contains(ctx.getString(R.string.tab_reason_connect)))
            screenshot("07c-app-tab-unreachable")
            device.findObject(By.text(ctx.getString(R.string.retry))).click()
            waitUntil("asked again, and said again", 30_000) {
                var shown = false
                instr.runOnMainSync { shown = a.errorShown() }
                shown
            }
        }
    }

    @Test
    fun t6_reportsItsDirectRouteKey() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            // The lock open too: the page works under it, and a screenshot then was black.
            opened(web)
            // Signed in with the device key: the app reports its SSH key by itself.
            val fetch = "window.__d = null; fetch('/api/account/devices').then(r => r.json()).then(j => window.__d = j)"
            js(web, fetch)
            waitJs(web, "window.__d && window.__d.some(d => d.current && d.hasSshKey)", 30_000) { js(web, fetch) }
            val line = DirectKey.openSshLine()
            assertTrue(line.startsWith("ecdsa-sha2-nistp256 "))
            // Long-press on the icon: the direct route is always there.
            val ids = androidx.core.content.pm.ShortcutManagerCompat.getDynamicShortcuts(ctx).map { it.id }
            assertTrue("dynamic shortcuts: $ids", "direct" in ids)
            js(web, "location.hash = '#/settings/android'")
            waitJs(web, "document.querySelector('[data-testid=direct-route]')")
            js(web, "document.querySelector('[data-testid=direct-route]').scrollIntoView({ block: 'center' })")
            screenshot("08-settings-android")
            // Containers of the test host (its stand-in docker has a small stack) and their logs.
            js(web, "location.hash = '#/containers'")
            waitJs(web, "document.querySelector('[data-testid=container-row] svg polyline')", 30_000)
            screenshot("08b-containers")
            js(web, "document.querySelector('[data-testid=stack-logs]').click()")
            waitJs(web, "document.querySelector('[data-testid=log-line]')", 20_000)
            screenshot("08c-logs")
        }
        // The next steps run in a new process: keep the session cookie.
        val latch = CountDownLatch(1)
        instr.runOnMainSync { CookieManager.getInstance().flush(); latch.countDown() }
        latch.await(5, TimeUnit.SECONDS)
    }

    @Test
    fun t6b_aWireGuardQrCodeScannedIsKeptByTheApp() {
        // The camera itself is not in the test: the scanner answers as it would have read the code (#96).
        fun key() = android.util.Base64.encodeToString(Random.nextBytes(32), android.util.Base64.NO_WRAP)
        val secret = key()
        val conf = "[Interface]\nPrivateKey = $secret\nAddress = 10.98.0.2/32\n\n[Peer]\nPublicKey = ${key()}\nEndpoint = 192.0.2.1:51820\nAllowedIPs = 10.98.0.0/24\n"
        val wg = app.wireguard
        wg.remove()
        val scanner = androidx.test.espresso.intent.matcher.IntentMatchers.hasComponent(SecureCapture::class.java.name)
        Intents.init()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val web = main(scenario)
                waitJs(web, "document.querySelector('nav.bottomnav')")
                js(web, "location.hash = '#/settings/android'")
                waitJs(web, "document.querySelector('[data-testid=wg-scan]')")
                // Not a WireGuard code: said, nothing kept.
                intending(scanner).respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().putExtra("SCAN_RESULT", "https://example.org")))
                js(web, "document.querySelector('[data-testid=wg-scan]').click()")
                waitJs(web, "[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('WireGuard'))")
                assertFalse("a code that is not WireGuard is not kept", wg.configured)
                // Gone back from the scanner: nothing happens. Clicked once the first scan
                // is done (the button is off meanwhile: a click then did nothing).
                intending(scanner).respondWith(Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null))
                waitJs(web, "!document.querySelector('[data-testid=wg-scan]').disabled")
                js(web, "document.querySelector('[data-testid=wg-scan]').click()")
                // The scanner opened and came back before the next answer is set: checked on the
                // button alone, the third answer could reach this second scan.
                val scans = { Intents.getIntents().count { it.component?.className == SecureCapture::class.java.name } }
                waitUntil("the second scan", detail = { "scans: ${scans()}" }) { scans() == 2 }
                waitJs(web, "!document.querySelector('[data-testid=wg-scan]').disabled")
                assertFalse(wg.configured)
                // The configuration's code: kept, sealed, and the page shows its summary only.
                intending(scanner).respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().putExtra("SCAN_RESULT", conf)))
                js(web, "document.querySelector('[data-testid=wg-scan]').click()")
                waitUntil("the scanned configuration kept") { wg.configured }
                waitJs(web, "document.querySelector('[data-testid=wg-state]')")
                assertFalse("the page never has the private key", (js(web, "document.body.innerText") as String).contains(secret))
                Intents.intended(scanner, androidx.test.espresso.intent.VerificationModes.times(3))
            }
        } finally {
            Intents.release()
            wg.remove()
        }
    }

    @Test
    fun t7_longPressOnTheIconOffersTheDirectRoute() {
        // As a person does it: home screen, all apps, long-press Burrow.
        // The launcher's app list, opened by a swipe up; the launcher does not always take the first.
        var icon: androidx.test.uiautomator.UiObject2? = null
        for (attempt in 1..3) {
            device.pressHome()
            device.waitForIdle()
            val h = device.displayHeight
            device.swipe(device.displayWidth / 2, h * 4 / 5, device.displayWidth / 2, h / 5, 20)
            icon = device.wait(Until.findObject(By.text(ctx.getString(R.string.app_name))), 10_000)
            if (icon != null) break
        }
        assertNotNull("Burrow in the app list (in front: ${inFront()})", icon)
        icon!!.longClick()
        val shortcut = device.wait(Until.findObject(By.text(ctx.getString(R.string.direct_route))), 5_000)
        screenshot("09a-icon-shortcuts")
        assertNotNull("long-press shows the direct route", shortcut)
        device.pressBack()
        device.pressHome()
    }

    @Test
    fun t8_screenshotsAreBlockedUnlessAllowed() {
        val prefs = Prefs(ctx)
        prefs.simulateRelease = true
        prefs.allowScreenshots = false
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val web = main(scenario)
                val secure = { var on = false; scenario.onActivity { on = it.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0 }; on }
                assertTrue("blocked by default", secure())
                waitJs(web, "document.querySelector('nav.bottomnav')", 30_000)
                // Blocked for other apps only: the app's own copy for a problem report still shows the page, not black (Screenshot.kt).
                val latch = java.util.concurrent.CountDownLatch(1)
                var got: Result<Any?>? = null
                scenario.onActivity { a -> Screenshot.take(a, web(), 0) { got = it; latch.countDown() } }
                assertTrue("the app's own picture taken", latch.await(10, java.util.concurrent.TimeUnit.SECONDS))
                val data = ((got!!.getOrThrow() as org.json.JSONObject).getString("picture")).substringAfter(",")
                val bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT)
                val bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                val colours = (1..9).flatMap { i -> (1..9).map { j -> bmp.getPixel(bmp.width * i / 10, bmp.height * j / 10) } }.toSet()
                assertTrue("the page in the app's own picture under FLAG_SECURE, not one colour", colours.size > 1)
                js(web, "location.hash = '#/settings/android'")
                waitJs(web, "document.querySelector('[data-testid=allow-screenshots]')")
                // Allowed only in the app's own question (audit 2026-11-05): No leaves it off.
                val box = "document.querySelector('[data-testid=allow-screenshots]')"
                js(web, "$box.click()")
                val no = device.wait(Until.findObject(By.res(ctx.packageName, "ask_cancel")), 15_000)
                assertNotNull("the app asks before screenshots are allowed", no)
                no.click()
                Thread.sleep(800)
                assertTrue("said no: still secure", secure())
                assertEquals("and the box not ticked", false, js(web, "$box.checked"))
                js(web, "$box.click()")
                assertNotNull(device.wait(Until.findObject(By.res(ctx.packageName, "ask_ok")), 15_000))
                // A tap at once is not taken (tapjacking): the OK waits a moment after it shows.
                Thread.sleep(Style.GUARD_MS + 300)
                screenshot("08c-screenshots-ask", mayBeBlack = true)
                device.findObject(By.res(ctx.packageName, "ask_ok")).click()
                waitUntil("screenshots allowed") { !secure() }
                // Its help tip sits beside the checkbox, not on a line below it.
                js(web, "document.querySelector('[data-testid=allow-screenshots]').scrollIntoView({ block: 'center' })")
                val beside = "(() => { const l = document.querySelector('[data-testid=allow-screenshots]').closest('label'); const h = l.nextElementSibling; return !!h && h.classList.contains('helptip') && h.getBoundingClientRect().top < l.getBoundingClientRect().bottom - 2; })()"
                assertEquals("help tip beside the screenshots checkbox", true, js(web, beside))
                screenshot("08d-screenshots-toggle")
                js(web, "document.querySelector('[data-testid=allow-screenshots]').click()")
                waitUntil("blocked again") { secure() }
            }
        } finally {
            prefs.simulateRelease = false
            prefs.allowScreenshots = false
        }
    }

    @Test
    fun t9_aPushNotificationLinkOpensThePage() {
        // What the ntfy app does on a tap: VIEW a burrow:// link.
        val link = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("burrow://open?to=%2Falerts")).setClass(ctx, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(link).use { scenario ->
            val web = main(scenario)
            opened(web)
            waitJs(web, "location.hash === '#/alerts' && document.querySelector('[data-testid=alerts]')", 30_000)
            screenshot("10-alerts")
        }
        // A link to anything but a page of Burrow opens Burrow's start, not that.
        val bad = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("burrow://open?to=https%3A%2F%2Fevil.example")).setClass(ctx, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(bad).use { scenario ->
            val web = main(scenario)
            waitJs(web, "document.querySelector('nav.bottomnav')", 30_000)
            assertEquals(false, js(web, "location.href.includes('evil')"))
        }
    }

    /**
     * A host shortcut's CONNECT counts only through the app's own entry,
     * which no other app can start; sent by another app straight to the
     * exported main screen it only opens Burrow (A3-AND-05). Burrow's page
     * then asks before it connects.
     */
    @Test
    fun t9b_onlyTheAppsOwnShortcutAsksForAHost() {
        // As another app would: the exported main screen, CONNECT and a host id.
        val foreign = Intent(ctx, MainActivity::class.java).setAction(Shortcuts.ACTION_CONNECT).putExtra(Shortcuts.EXTRA_HOST, hostId)
        ActivityScenario.launch<MainActivity>(foreign).use { scenario ->
            val web = main(scenario)
            opened(web)
            Thread.sleep(2000)
            assertEquals("no host asked for by another app's intent", false, js(web, "location.hash.includes('connect=') || location.hash.startsWith('#/term/')"))
        }
        // Another app cannot start the shortcut entry at all: it is not exported. (Asked of
        // the package manager: the shell may start anything of a debug build.)
        val entry = ctx.packageManager.getActivityInfo(android.content.ComponentName(ctx, DeepLinks.SHORTCUT_ENTRY), 0)
        assertFalse("the shortcut entry is not exported", entry.exported)
        // The app's own shortcut, as the launcher starts it: the page gets the host.
        ctx.startActivity(Intent().setClassName(ctx, DeepLinks.SHORTCUT_ENTRY).setAction(Shortcuts.ACTION_CONNECT).putExtra(Shortcuts.EXTRA_HOST, hostId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val a = resumed(MainActivity::class.java)
        // The page takes the link's part off the address at once and asks first ("Open a terminal on ...?"):
        // the address alone was missed when the question came before the look.
        waitJs({ a.webView }, "location.hash.includes('connect=$hostId') || location.hash.startsWith('#/term/') || !!document.querySelector('dialog[open] [data-testid=confirm-ok]')", 30_000)
        a.runOnUiThread { a.finish() }
    }

    /**
     * The direct route in its own task: opening Burrow's main screen (a push
     * tapped, the transfers notification, a share) ended it before, and every
     * direct session with it (A3-AND-04). A larger font no longer recreates it
     * either (A3-AND-20).
     */
    @Test
    fun t9c_openingBurrowKeepsTheDirectRoute() {
        // Not closed by use {}: its screen moved between tasks here, and the scenario lost track of it.
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            opened(main(scenario))
            scenario.onActivity { it.openDirect() }
            val direct = resumed(DirectActivity::class.java)
            waitJs({ direct.webView }, "document.body && document.body.innerText.length > 0", 20_000)
            // A push tapped: Burrow's main screen comes to the front.
            ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("burrow://open?to=%2Falerts")).setClass(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            resumed(MainActivity::class.java)
            Thread.sleep(1500)
            var gone = true
            instr.runOnMainSync { gone = direct.isDestroyed || direct.isFinishing }
            assertFalse("the direct route is still there after Burrow came to the front", gone)
            // Back to it, and the font made larger: the same screen, not a new one.
            ctx.startActivity(Intent(ctx, DirectActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val again = resumed(DirectActivity::class.java)
            assertTrue("the same direct screen", again === direct)
            val scale = shell("settings get system font_scale").trim()
            try {
                shell("settings put system font_scale 1.3")
                Thread.sleep(2500)
                instr.runOnMainSync { gone = direct.isDestroyed || direct.isFinishing }
                assertFalse("a larger font keeps the direct route", gone)
            } finally {
                shell("settings put system font_scale ${scale.takeIf { it.isNotEmpty() && it != "null" } ?: "1.0"}")
            }
            instr.runOnMainSync { direct.finish() }
        } finally {
            runCatching { scenario.close() }
        }
    }

    /**
     * The tunnel up again after it went down in the background (or home and
     * away changed): the page is told, not reloaded, so what was typed and
     * not saved stays (A3-AND-03).
     */
    @Test
    fun t9d_aTunnelThatCameBackKeepsThePage() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            js(web, "window.__unsaved = 'typed, not saved'")
            scenario.onActivity { it.tunnelChanged(true) }
            Thread.sleep(3000)
            assertEquals("the page was not reloaded", "typed, not saved", js(web, "window.__unsaved"))
            scenario.onActivity { it.tunnelChanged(false) }
            Thread.sleep(2000)
            assertEquals("nor when home again", "typed, not saved", js(web, "window.__unsaved"))
        }
    }

    /**
     * The native screens (the lock, "cannot be reached") keep a phone-wide
     * column on a tablet: their buttons stretched over the whole width
     * (1,150 dp on a tablet, A3-AND-23).
     */
    @Test
    fun ta2_nativeScreensKeepAPhoneWideColumn() {
        instr.runOnMainSync {
            val box = Style.screen(ctx, R.string.lock_title)
            val button = Style.button(ctx, ctx.getString(R.string.lock_retry), primary = true)
            box.addView(button, Style.row(ctx, 24f))
            val wide = Style.dp(ctx, 1150f)
            box.measure(android.view.View.MeasureSpec.makeMeasureSpec(wide, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(Style.dp(ctx, 800f), android.view.View.MeasureSpec.EXACTLY))
            assertTrue("a button ${button.measuredWidth} px wide on a tablet", button.measuredWidth <= Style.dp(ctx, Style.COLUMN_DP))
            // On a phone it takes the width there is, as before.
            val narrow = Style.dp(ctx, 360f)
            box.measure(android.view.View.MeasureSpec.makeMeasureSpec(narrow, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(Style.dp(ctx, 800f), android.view.View.MeasureSpec.EXACTLY))
            assertEquals(narrow - 2 * Style.dp(ctx, 32f), button.measuredWidth)
        }
    }

    /**
     * Android's back button with a dialog open: the dialog closes and the
     * page stays (it went back a page, the dialog left open over the next).
     */
    @Test
    fun ta_backClosesAnOpenDialogFirst() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            js(web, "location.hash = '#/settings/channels'")
            waitJs(web, "location.hash === '#/settings/channels' && document.querySelector('[data-testid=add-channel]')")
            js(web, "document.querySelector('[data-testid=add-channel]').click()")
            waitJs(web, "document.querySelector('dialog[open]')")
            device.pressBack()
            waitJs(web, "!document.querySelector('dialog[open]')")
            Thread.sleep(500)
            assertEquals("still on the same page", "#/settings/channels", js(web, "location.hash"))
        }
    }

    /**
     * The terminal's text box on the phone, in a tmux of the person's own
     * (started in a session without Burrow's tmux, with "mouse on" and
     * extended keys, as on the author's host): typed with the phone's
     * keyboard, sent with the send button, and run.
     */
    @Test
    fun tz_theTextBoxRunsInYourOwnTmux() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            val sync = { method: String, url: String, body: String -> js(web, "(function(){var x=new XMLHttpRequest();x.open('$method','$url',false);x.setRequestHeader('content-type','application/json');x.send($body);return x.responseText})()") as String }
            // Opening a terminal needs a step-up younger than 15 minutes.
            stepUp(web)
            val hosts = org.json.JSONArray(sync("GET", "/api/hosts", "null"))
            val hostId = (0 until hosts.length()).map { hosts.getJSONObject(it) }.first { it.getString("name") == "phone-test" }.getLong("id")
            val id = org.json.JSONObject(sync("POST", "/api/terminal/sessions", "JSON.stringify({hostId:$hostId,cols:60,rows:30,tmux:'never'})")).getString("id")
            js(web, "location.hash = '#/term/$id'")
            val rows = "document.querySelector('.xterm-rows').innerText.replace(/\\s+/g, ' ')"
            waitJs(web, "document.querySelector('.xterm-rows') && $rows.includes('$')", 30_000)
            // The text box on (as in the Sessions menu).
            js(web, "[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${org.json.JSONObject.quote(tr("term.menu"))}).click()")
            waitJs(web, "document.querySelector('[data-testid=compose-toggle]')")
            js(web, "document.querySelector('[data-testid=compose-toggle]').click()")
            waitJs(web, "document.querySelector('[data-testid=compose]')")
            // Outside tmux it works (the person said so): the config and tmux itself.
            val put = { text: String -> js(web, "(function(){var b=document.querySelector('[data-testid=compose]');var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(b,${org.json.JSONObject.quote(text)});b.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-testid=compose-send]').click()})()") }
            put("printf 'set -g extended-keys on\\nset -g extended-keys-format csi-u\\nset -g mouse on\\n' > /tmp/own.conf; tmux -L own -f /tmp/own.conf new -s own")
            waitJs(web, "$rows.includes('[own]')", 20_000)
            // In tmux: tapped, typed on the phone's keyboard, sent with a tap on the send button,
            // each where a finger would touch the screen.
            val tap = { selector: String ->
                val r = org.json.JSONArray(js(web, "(function(){var r=document.querySelector('$selector').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()").toString())
                val at = IntArray(2)
                instr.runOnMainSync { web().getLocationOnScreen(at) }
                val d = ctx.resources.displayMetrics.density
                device.click((at[0] + r.getDouble(0) * d).toInt(), (at[1] + r.getDouble(1) * d).toInt())
            }
            tap("[data-testid=compose]")
            Thread.sleep(800)
            assertEquals("the text box has the focus", true, js(web, "document.activeElement === document.querySelector('[data-testid=compose]')"))
            shell("input text echo%stmux-\$((6*7))")
            Thread.sleep(800)
            screenshot("11-tmux-text-box")
            assertEquals("typed into the text box, not the terminal (in front: ${inFront()})", "echo tmux-\$((6*7))", js(web, "document.querySelector('[data-testid=compose]').value"))
            tap("[data-testid=compose-send]")
            waitUntil("tmux-42 run in the person's own tmux", 15_000, detail = { "screen: ${js(web, "$rows.slice(-400)")}" }) {
                js(web, "$rows.includes('tmux-42')") == true
            }
            screenshot("12-tmux-ran")
            put("tmux -L own kill-server")
        }
    }

    @Test
    fun tzc_aShakeReportsAProblemUnlessTurnedOff() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            // A shake (what the accelerometer's two jolts end in; ShakeTest has
            // which jolts count): the report form, with the screen as it was.
            scenario.onActivity { it.shaken() }
            waitJs(web, "document.querySelector('dialog[data-tour=bug-report][open] img')", 15_000)
            // Send on the screen as it opens, with the screen's picture in it: the shake is the
            // app's quickest way to report, and its Send was below the screen (UIA-02).
            val send = "(() => { const d = document.querySelector('dialog[data-tour=bug-report][open]'); const b = d && [...d.querySelectorAll('button')].find((x) => x.classList.contains('primary')); if (!b) return 'no primary button'; const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight ? true : 'Send at ' + Math.round(r.top) + '-' + Math.round(r.bottom) + ' of ' + innerHeight; })()"
            assertEquals("the report's Send on the screen", true, js(web, send))
            // The picture is the screen as the app shows it, taken by the app (a JPEG the shape of the
            // screen, not black), not the page drawn again from its markup ("not the exact screen I see").
            // Every pixel of it made small, not a few points: on a tall tablet nine along the diagonal all fell on the empty page.
            js(web, "(async () => { const i = document.querySelector('[data-testid=bug-shot]'); await i.decode(); const c = document.createElement('canvas'); c.width = 64; c.height = Math.round((64 * i.naturalHeight) / i.naturalWidth); const g = c.getContext('2d'); g.drawImage(i, 0, 0, c.width, c.height); const px = g.getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let k = 0; k < px.length; k += 4) seen.add(px[k] + ',' + px[k + 1] + ',' + px[k + 2]); window.__shot = [i.src.slice(0, 15), Math.abs(i.naturalHeight / i.naturalWidth - innerHeight / innerWidth) < 0.02, seen.size > 1].join(' '); })()")
            waitJs(web, "window.__shot", 10_000)
            assertEquals("the report's picture, from the app", "data:image/jpeg true true", js(web, "window.__shot"))
            screenshot("16-shake-report")
            js(web, "[...document.querySelectorAll('dialog[data-tour=bug-report] button')].find(b => b.type === 'button' && !b.closest('.pics')).click()")
            waitJs(web, "!document.querySelector('dialog[data-tour=bug-report][open]')", 10_000)
            // Off in Settings -> Android app: kept on the phone.
            js(web, "location.hash = '#/settings/android'")
            waitJs(web, "document.querySelector('[data-testid=shake-report]')", 20_000)
            js(web, "document.querySelector('[data-testid=shake-report]').click()")
            waitUntil("shaking turned off on this phone", 10_000) { !Prefs(ctx).shakeReport }
            js(web, "document.querySelector('[data-testid=shake-report]').click()")
            waitUntil("and on again", 10_000) { Prefs(ctx).shakeReport }
        }
    }

    /**
     * A finger held on a word in the editor selects that word (report
     * 36ee73, a .env file on a foldable's inner screen with FUTO's keyboard:
     * the text a few lines below was selected): with the keyboard down and
     * already up, on a line wrapped over several rows, the file scrolled; with
     * the emulator's keyboard and FUTO's, at the phone's size and the
     * foldable's.
     */
    @Test
    fun tzd_aFingerHeldOnAWordInTheEditorSelectsThatWord() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            js(web, "window.__home = null; fetch('/api/files/$hostId/list?path=~').then(r => r.json()).then(j => window.__home = j.path)")
            waitJs(web, "window.__home")
            // A .env as people keep one: a comment over each setting, long enough to wrap on a phone.
            val text = (1..60).joinToString("") { "# note$it one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen$it sixteen\nKEY$it=alpha$it beta$it gamma$it\n" }
            js(web, "window.__put = null; fetch('/api/files/$hostId/text', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: window.__home + '/hold.env', content: ${org.json.JSONObject.quote(text)}, baseHash: null }) }).then(r => window.__put = r.status)")
            waitJs(web, "window.__put")
            val at = IntArray(2)
            // Where a word is on the screen now, in CSS pixels: the middle of its first row.
            val find = "function(w){for(const l of document.querySelectorAll('.cm-line')){const tw=document.createTreeWalker(l,NodeFilter.SHOW_TEXT);let t;while((t=tw.nextNode())){const s=t.textContent;let i=s.indexOf(w);while(i>=0){const a=/[A-Za-z0-9]/;if(!a.test(s[i-1]||'')&&!a.test(s[i+w.length]||'')){const g=document.createRange();g.setStart(t,i);g.setEnd(t,i+w.length);const b=g.getClientRects()[0];return [b.left+b.width/2,b.top+b.height/2]}i=s.indexOf(w,i+1)}}}return null}"
            val press = { word: String, ms: Int ->
                val r = org.json.JSONArray(js(web, "($find)(${org.json.JSONObject.quote(word)})").toString())
                val d = ctx.resources.displayMetrics.density
                instr.runOnMainSync { web().getLocationOnScreen(at) }
                val x = (at[0] + r.getDouble(0) * d).toInt()
                val y = (at[1] + r.getDouble(1) * d).toInt()
                if (ms > 0) device.swipe(x, y, x, y, ms / 5) else device.click(x, y)
            }
            // Held on a word: what the page then has selected (CodeMirror puts its own selection back when the page's is cleared, so: a new one).
            val hold = { word: String, tag: String ->
                val before = js(web, "String(window.getSelection())") as String
                press(word, 750)
                var sel = ""
                waitUntil("a new selection after holding on $word ($tag)", 5_000, detail = { "selected: '$sel' (before: '$before')" }) {
                    sel = js(web, "String(window.getSelection())") as String
                    sel.isNotEmpty() && sel != before
                }
                Thread.sleep(700)
                sel = js(web, "String(window.getSelection())") as String
                if (sel != word) screenshot("17-editor-hold-$tag-wrong")
                assertEquals("held on $word ($tag)", word, sel)
            }
            // The number of a setting whose line is between those parts of the page's height now.
            val lineAt = { lo: Double, hi: Double -> (js(web, "(function(){var h=innerHeight;var l=[...document.querySelectorAll('.cm-line')].filter(x=>{var b=x.getBoundingClientRect();return /^KEY\\d+=/.test(x.textContent)&&b.top>h*$lo&&b.bottom<h*$hi});return l.length?Number(l[0].textContent.match(/^KEY(\\d+)/)[1]):0})()") as Number).toInt() }
            val round = { tag: String ->
                js(web, "location.hash = '#/hosts'")
                js(web, "location.hash = '#/edit/$hostId?p=' + encodeURIComponent(window.__home + '/hold.env')")
                waitJs(web, "[...document.querySelectorAll('.cm-line')].some(l => l.textContent === 'KEY3=alpha3 beta3 gamma3')", 30_000)
                Thread.sleep(500)
                hold("beta3", "$tag, keyboard down")
                screenshot("17-editor-hold-$tag")
                // A word on a comment's second or third row.
                hold("fifteen4", "$tag, a wrapped line")
                // Scrolled as a finger does (the selection let go first with a tap: a swipe from its handle
                // drags the handle), then held on a line in the upper middle.
                press("alpha2", 0)
                waitUntil("the selection let go ($tag)", 5_000) { js(web, "String(window.getSelection())") == "" }
                instr.runOnMainSync { web().getLocationOnScreen(at) }
                val w = web().width
                val h = web().height
                // An emulator under load delivers the swipe's first moves late: then it is a hold
                // and a drag, and selects rows instead of scrolling (2.15.0's Android test). Let go
                // with a tap and swipe again; a swipe the screen took as one is a scroll.
                for (attempt in 1..3) {
                    device.swipe(at[0] + w / 2, at[1] + h * 2 / 3, at[0] + w / 2, at[1] + h / 3, 30)
                    Thread.sleep(1500)
                    if (js(web, "String(window.getSelection())") == "") break
                    android.util.Log.i("BurrowTest", "the swipe selected instead of scrolling ($tag, try $attempt)")
                    press("alpha2", 0)
                    waitUntil("the swipe's selection let go ($tag)", 5_000) { js(web, "String(window.getSelection())") == "" }
                }
                val n = lineAt(0.25, 0.6)
                assertTrue("a setting in sight after scrolling ($tag)", n > 0)
                hold("beta$n", "$tag, scrolled")
                // The keyboard up first (a tap at the end of a line), then held.
                // Below the held word: Android's menu over a selection sits above it, and a tap there is its Select all.
                val k = lineAt(0.55, 0.98)
                assertTrue("a setting low in sight ($tag)", k > 0)
                press("gamma$k", 0)
                waitUntil("the selection let go with a tap ($tag)", 5_000, detail = { "selected: '${js(web, "String(window.getSelection())")}'" }) { js(web, "String(window.getSelection())") == "" }
                waitUntil("the keyboard up ($tag)", 10_000) { js(web, "innerHeight < screen.height * 0.75") == true }
                Thread.sleep(800)
                val m = lineAt(0.15, 0.6)
                assertTrue("a setting in sight with the keyboard up ($tag)", m > 0)
                hold("alpha$m", "$tag, keyboard up")
                screenshot("17b-editor-hold-$tag-keyboard")
                device.pressBack()
            }
            round("phone")
            val futo = shell("ime list -a -s").lines().map { it.trim() }.firstOrNull { it.contains("futo", ignoreCase = true) }
            try {
                if (futo != null) {
                    shell("ime enable $futo")
                    shell("ime set $futo")
                    round("futo")
                }
                // The foldable's inner screen (2268 pixels wide at 3.25x).
                shell("wm size 2268x2440")
                shell("wm density 520")
                Thread.sleep(3000)
                round("fold")
            } finally {
                shell("wm size reset")
                shell("wm density reset")
                shell("ime reset")
            }
        }
    }

    /**
     * Typing straight into the terminal: while it has the keyboard, the app
     * asks for plain characters (no suggestions, as Termux and Termius), the
     * screen stays on, and the volume keys are keys (down: Ctrl, up: the
     * next key's special meaning). Settings -> Android shows this app's version.
     */
    @Test
    fun tzb_theTerminalTakesTheKeyboardAndTheVolumeKeys() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            val sync = { method: String, url: String, body: String -> js(web, "(function(){var x=new XMLHttpRequest();x.open('$method','$url',false);x.setRequestHeader('content-type','application/json');x.send($body);return x.responseText})()") as String }
            // Opening a terminal needs a step-up younger than 15 minutes.
            stepUp(web)
            val hosts = org.json.JSONArray(sync("GET", "/api/hosts", "null"))
            val hostId = (0 until hosts.length()).map { hosts.getJSONObject(it) }.first { it.getString("name") == "phone-test" }.getLong("id")
            val id = org.json.JSONObject(sync("POST", "/api/terminal/sessions", "JSON.stringify({hostId:$hostId,cols:60,rows:30,tmux:'never'})")).getString("id")
            // Typed straight into the terminal (the text box off, as the earlier test left it on).
            js(web, "localStorage.setItem('burrow.terminal', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('burrow.terminal') || '{}'), { compose: false })))")
            js(web, "location.hash = '#/term/$id'; location.reload()")
            val rows = "document.querySelector('.xterm-rows').innerText.replace(/\\s+/g, ' ')"
            waitJs(web, "document.querySelector('.xterm-rows') && $rows.includes('$')", 45_000)
            // Tapped where a finger would (a focus() from script gives no focus event
            // while the page does not have the window's).
            val r = org.json.JSONArray(js(web, "(function(){var r=document.querySelector('[data-testid=terminal]').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()").toString())
            val at = IntArray(2)
            instr.runOnMainSync { web().getLocationOnScreen(at) }
            val d = ctx.resources.displayMetrics.density
            val tapTerminal = { device.click((at[0] + r.getDouble(0) * d).toInt(), (at[1] + r.getDouble(1) * d).toInt()) }
            // As a tablet the launcher was at times found in front here: before or after the tap?
            android.util.Log.i("BurrowTest", "before the tap at ${at.toList()} + $r x $d: ${inFront()}")
            tapTerminal()
            waitUntil("plain characters asked of the keyboard", 5_000) { (web() as TermWebView).charInput }
            // The keyboard itself up and taking text before typing: right after the
            // terminal asked for it, the first characters were at times lost ("q 1 300").
            waitUntil("the keyboard up", 5_000) { var up = false; instr.runOnMainSync { up = web().rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime()) == true }; up }
            Thread.sleep(300)
            // A plain shell (no program taking the mouse): one finger scrolls back, as ever.
            shell("input text seq%s1%s300")
            device.pressEnter()
            waitJs(web, "document.querySelector('.xterm-rows').innerText.includes('299')", 15_000)
            // The first number on the screen: smaller once scrolled back.
            val top = "Math.min(...[...document.querySelectorAll('.xterm-rows > div')].map(d => /^\\d+$/.test(d.textContent.trim()) ? Number(d.textContent) : 9999))"
            val before = (js(web, top) as Number).toDouble()
            // Within the part in sight: with the keyboard up the terminal keeps
            // its rows and runs on under the keyboard (report f18108).
            val box = org.json.JSONArray(js(web, "(function(){var r=document.querySelector('[data-testid=terminal]').closest('.term-wrap').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height*0.25,r.top+r.height*0.75]})()").toString())
            val x = (at[0] + box.getDouble(0) * d).toInt()
            device.swipe(x, (at[1] + box.getDouble(1) * d).toInt(), x, (at[1] + box.getDouble(2) * d).toInt(), 20)
            // Back in the history layer (2.19.0): the session's history over the terminal, scrolled
            // back from its bottom by what the finger moved. Its top is not the terminal's: with the
            // keyboard up the terminal keeps its rows and runs on under it, the layer ends above it.
            val back = "(function(){var l=document.querySelector('[data-testid=term-history]');return l?l.scrollHeight-l.clientHeight-l.scrollTop:-1})()"
            waitUntil("one finger scrolled the history back", 5_000, detail = { "first number $before, back ${js(web, back)} px" }) { (js(web, back) as Number).toDouble() > 40 }
            screenshot("11a-scrolled-back")
            // Typed straight into the terminal on the phone's keyboard: the
            // suggestions above it come (from this host's history: seq ran).
            shell("input text se")
            waitJs(web, "document.querySelector('[data-testid=suggestions]')", 10_000)
            screenshot("11b-direct-suggestions")
            device.pressKeyCode(android.view.KeyEvent.KEYCODE_DEL)
            device.pressKeyCode(android.view.KeyEvent.KEYCODE_DEL)
            // The same with the on-screen keyboard itself (taps on its keys, as
            // a person types: the keyboard app commits text, no key events).
            // Reported: no suggestions with FUTO's keyboard.
            val key = { c: String ->
                val k = device.wait(Until.findObject(By.desc(c)), 3_000) ?: device.findObject(By.text(c))
                assertNotNull("the keyboard's key $c (content description or text)", k)
                k.click()
                Thread.sleep(150)
            }
            val typeAndSee = { shot: String ->
                key("s")
                key("e")
                try {
                    waitJs(web, "document.querySelector('[data-testid=suggestions]')", 10_000)
                } catch (e: AssertionError) {
                    // What the screen showed: which keyboard, what arrived.
                    screenshot("$shot-failed", mayBeBlack = true)
                    // And what the keyboard was told about the field.
                    android.util.Log.i("BurrowTest", "ime: " + shell("dumpsys input_method").lines().filter { it.contains("inputType") || it.contains("mCurMethodId") || it.contains("imeOptions") }.joinToString(" | "))
                    android.util.Log.i("BurrowTest", "webview: " + shell("dumpsys webviewupdate").lines().filter { it.contains("Current WebView package") }.joinToString(" | "))
                    throw e
                }
                screenshot(shot)
                device.pressKeyCode(android.view.KeyEvent.KEYCODE_DEL)
                device.pressKeyCode(android.view.KeyEvent.KEYCODE_DEL)
            }
            typeAndSee("11c-keyboard-suggestions")
            // FUTO's keyboard, when the test run installed it (scripts/android-test.sh).
            val futo = shell("ime list -a -s").lines().map { it.trim() }.firstOrNull { it.contains("futo", ignoreCase = true) }
            if (futo != null) {
                shell("ime enable $futo")
                shell("ime set $futo")
                try {
                    // The keyboard again, now FUTO's. Switched while the
                    // terminal has the keyboard, the emulator binds FUTO to
                    // the field in its own time (at times with the field's
                    // old description): the terminal tapped until it has the
                    // focus with plain characters asked, and the whole of it
                    // tried up to three times. A keyboard that never gets
                    // suggestions fails all three.
                    val focused = "document.activeElement === document.querySelector('[data-testid=terminal] textarea')"
                    val plain = { shell("dumpsys input_method").contains("inputType=0x80091") }
                    var last: Throwable? = null
                    for (attempt in 1..3) {
                        try {
                            Thread.sleep(800)
                            waitUntil("the terminal has the focus with FUTO's keyboard, asked for plain characters", 15_000, detail = {
                                shell("dumpsys input_method").lines().filter { it.contains("inputType") || it.contains("mCurMethodId") }.joinToString(" | ")
                            }) {
                                tapTerminal()
                                Thread.sleep(700)
                                js(web, focused) == true && (web() as TermWebView).charInput && plain()
                            }
                            typeAndSee("11d-futo-suggestions")
                            last = null
                            break
                        } catch (e: AssertionError) {
                            last = e
                            // What it typed, taken back before the next try.
                            device.pressKeyCode(android.view.KeyEvent.KEYCODE_DEL)
                            device.pressKeyCode(android.view.KeyEvent.KEYCODE_DEL)
                        }
                    }
                    last?.let { throw it }
                } finally {
                    shell("ime reset")
                }
            }
            // A finger held on a number: Android's own floating menu over it
            // (not the page's bar), and its Copy puts the number on the clipboard.
            // A line with a number on it, where it is now (the keyboard may have moved it).
            val num = org.json.JSONArray(js(web, "(function(){var l=[...document.querySelectorAll('.xterm-rows > div')].filter(d=>/^\\d+$/.test(d.textContent.trim())).pop().getBoundingClientRect();return [l.left+8,l.top+l.height/2]})()").toString())
            instr.runOnMainSync { web().getLocationOnScreen(at) }
            val nx = (at[0] + num.getDouble(0) * d).toInt()
            val ny = (at[1] + num.getDouble(1) * d).toInt()
            device.swipe(nx, ny, nx, ny, 150)
            val copy = device.wait(Until.findObject(By.text(java.util.regex.Pattern.compile("(?i)" + java.util.regex.Pattern.quote(ctx.getString(android.R.string.copy))))), 5_000)
            assertNotNull("Android's menu over the selection, with Copy (in front: ${inFront()})", copy)
            assertEquals("not the page's own bar", false, js(web, "!!document.querySelector('[data-testid=term-pickbar]')"))
            screenshot("11e-copy-menu")
            copy!!.click()
            var clip = ""
            waitUntil("the number on the clipboard", 5_000, detail = { "clipboard: '$clip'" }) {
                instr.runOnMainSync { clip = (ctx.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).primaryClip?.getItemAt(0)?.text?.toString() ?: "" }
                clip.trim().matches(Regex("\\d+"))
            }
            waitJs(web, "!document.querySelector('[data-testid=term-grip]')", 5_000)
            // The status bar's strip in the colour of the page's top: its dark
            // title bar on a phone (as the page reports it), and whatever the
            // page says next.
            // As the page tells it: its theme-color, hex (the --side token itself is a colour mix).
            val side = js(web, "document.querySelector('meta[name=\"theme-color\"]').getAttribute('content')") as String
            var strip: Int? = null
            waitUntil("the status bar strip in the title bar's colour $side", 10_000, detail = { "strip: ${strip?.let { Integer.toHexString(it) }}" }) {
                scenario.onActivity { strip = it.topColor() }
                strip == android.graphics.Color.parseColor(side)
            }
            js(web, "BurrowAndroid.postMessage(JSON.stringify({ id: 990001, method: 'chrome', params: { top: '#f5f5f2' } }))")
            waitUntil("the strip as the page asked", 5_000) {
                scenario.onActivity { strip = it.topColor() }
                strip == android.graphics.Color.parseColor("#f5f5f2")
            }
            js(web, "BurrowAndroid.postMessage(JSON.stringify({ id: 990002, method: 'chrome', params: { top: '$side' } }))")
            var on = false
            scenario.onActivity { on = it.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0 }
            assertTrue("the screen stays on while a terminal is shown", on)
            // Volume up: said on the key bar, for the next key.
            device.pressKeyCode(android.view.KeyEvent.KEYCODE_VOLUME_UP)
            waitJs(web, "document.querySelector('[data-testid=volume-up-key]')", 5_000)
            // Volume down: Ctrl, lit on the key bar.
            device.pressKeyCode(android.view.KeyEvent.KEYCODE_VOLUME_DOWN)
            waitJs(web, "[...document.querySelectorAll('.keybar .key.on')].some(b => b.textContent.trim() === 'Ctrl')", 5_000)
            // Leaving the terminal: the keyboard and the volume are the phone's again.
            js(web, "location.hash = '#/settings?s=android'")
            waitUntil("the keyboard's help back", 5_000) { !(web() as TermWebView).charInput && !(web() as TermWebView).volumeKeys }
            waitJs(web, "document.querySelector('[data-testid=app-version]')", 10_000)
            assertTrue("this app's version shown", (js(web, "document.querySelector('[data-testid=app-version]').textContent") as String).contains(BuildConfig.VERSION_NAME.removeSuffix("-debug")))
            sync("DELETE", "/api/terminal/sessions/$id", "null")
        }
    }

    /**
     * Burrow's own push in the app. Turned on without a UnifiedPush app on
     * the phone: it says what to install. A message (as the connector hands
     * it over, decrypted) shows as Burrow's own notification, and a tap
     * opens the page it is about.
     */
    /**
     * The home screen widget (2.11.0): asked at home with the app's own
     * sign-in, its numbers kept; numbers pushed by Burrow kept too; how it
     * asks away from home set in Burrow's page and kept by the app.
     */
    @Test
    fun tzc2_theWidgetAsksBurrowAndKeepsItsNumbers() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            val prefs = Prefs(ctx)
            prefs.widgetLast = null
            Thread { Widget.refresh(ctx) }.apply { start() }.join(30_000)
            val n = WidgetNumbers.stored(prefs.widgetLast)
            assertNotNull("the widget's numbers read from Burrow", n)
            assertTrue("the test hosts counted: ${n!!.total}", n.total >= 1)
            assertFalse("signed in", prefs.widgetSignIn)
            // Pushed numbers replace them.
            Widget.pushed(ctx, org.json.JSONObject("""{"at":"2026-11-01T12:00:00.000Z","hosts":{"total":9,"up":8,"down":1},"alerts":3,"updates":{"hosts":2,"security":1}}"""))
            assertEquals(9, WidgetNumbers.stored(prefs.widgetLast)!!.total)
            // Away from home: chosen in Settings -> Android app, kept by the app.
            js(web, "location.hash = '#/settings/android'")
            waitJs(web, "document.querySelector('[data-testid=widget-away]')", 15_000)
            js(web, "(s => { s.value = 'last'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('[data-testid=widget-away]'))")
            waitUntil("the choice kept by the app", 10_000) { prefs.widgetAway == "last" }
            screenshot("16-widget-setting")
            js(web, "(s => { s.value = 'tunnel'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('[data-testid=widget-away]'))")
            waitUntil("back to the tunnel", 10_000) { prefs.widgetAway == "tunnel" }
        }
    }

    @Test
    fun tzc_ownPushNotifications() {
        // Notifications allowed, as the person would when Android asks.
        shell("pm grant ${ctx.packageName} android.permission.POST_NOTIFICATIONS")
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            js(web, "location.hash = '#/settings?s=notify'")
            waitJs(web, "document.querySelector('[data-testid=push-toggle]')", 15_000)
            assertEquals("off at first", tr("push.off"), js(web, "document.querySelector('[data-testid=push-state]').textContent.trim()"))
            js(web, "document.querySelector('[data-testid=push-toggle]').click()")
            val install = org.json.JSONObject.quote(ctx.getString(R.string.no_distributor).take(30))
            waitJs(web, "[...document.querySelectorAll('[role=alert], [role=status]')].some(e => e.textContent.includes($install))", 15_000)
        }
        // A message as the connector gives it: shown as Burrow's, a tap opens its page.
        Push.show(ctx, org.json.JSONObject(mapOf("title" to "Disk almost full", "body" to "/data on nas is 95% full", "page" to "/alerts", "priority" to 4, "topic" to "alerts")))
        // On the lock screen only that something came, not what (A3-AND-10).
        val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
        // Posting is asynchronous: listed a moment later.
        waitUntil("the alert posted", 10_000) { nm.activeNotifications.any { it.tag == "alerts:/alerts" } }
        val posted = nm.activeNotifications.first { it.tag == "alerts:/alerts" }.notification
        assertEquals("private on the lock screen", android.app.Notification.VISIBILITY_PRIVATE, posted.visibility)
        val public = posted.publicVersion
        assertNotNull("a public version for the lock screen", public)
        val onLock = "${public!!.extras.getCharSequence(android.app.Notification.EXTRA_TITLE)} ${public.extras.getCharSequence(android.app.Notification.EXTRA_TEXT)}"
        assertFalse("the lock screen's version names nothing: $onLock", onLock.contains("nas") || onLock.contains("95%") || onLock.contains("Disk"))
        device.openNotification()
        val n = device.wait(Until.findObject(By.text("Disk almost full")), 10_000)
        assertNotNull("the notification is shown", n)
        screenshot("15-own-push")
        n.click()
        // Burrow in front, at the page of the message.
        val shown = {
            var a: android.app.Activity? = null
            instr.runOnMainSync { a = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).firstOrNull() }
            a as? MainActivity
        }
        waitUntil("Burrow opened by the tap", 30_000) { shown() != null }
        val opened = shown()!!
        val web = { opened.webView }
        waitJs(web, "location.hash === '#/alerts'", 30_000)
    }

    /**
     * Last, as it signs the app out: the widget's own key (told to Burrow at
     * the start, signed in with this phone's key) reads the counts once the
     * app's sign-in is gone, without a fingerprint (2.12.0).
     */
    @Test
    fun zz_theWidgetReadsWithItsOwnKeyOnceSignedOut() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            // The page tells Burrow the key at its start (a request after the first page): its answer waited for.
            Thread.sleep(3_000)
        }
        val cookies = android.webkit.CookieManager.getInstance()
        instr.runOnMainSync { cookies.removeAllCookies(null) }
        instr.runOnMainSync { cookies.flush() }
        val prefs = Prefs(ctx)
        prefs.widgetLast = null
        prefs.widgetSignIn = false
        Thread { Widget.refresh(ctx) }.apply { start() }.join(30_000)
        val n = WidgetNumbers.stored(prefs.widgetLast)
        assertNotNull("read with the widget's own key", n)
        assertFalse("no sign-in asked for", prefs.widgetSignIn)
    }
}
