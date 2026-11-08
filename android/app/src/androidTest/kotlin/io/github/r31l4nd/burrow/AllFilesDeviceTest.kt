package io.github.r31l4nd.burrow

import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.random.Random

/**
 * "All files" on the emulator (report 862305), apart from PhoneFilesTest: the emulator itself died
 * (exit 139, nothing said) when the app read its storage this way, in most runs, while a phone does
 * not. Run by scripts/android-test.sh only with ALL_FILES=1; the app's side is AllFilesTest (JVM).
 */
@RunWith(AndroidJUnit4::class)
class AllFilesDeviceTest : WebTestBase() {
    private fun q(s: String) = JSONObject.quote(s)

    private fun main(scenario: ActivityScenario<MainActivity>): () -> WebView {
        lateinit var a: MainActivity
        scenario.onActivity { a = it }
        return { a.webView }
    }

    /**
     * "All files" (report 862305), for real: Android's "All files access" given (as the person does in
     * Android's settings; here by appops), switched on after the page's warning, the phone's storage
     * listed beside the folders and a file in it opened; switched off, gone from the list at once.
     */
    @Test
    fun allFilesListsThePhonesStorageOnlyWhileSwitchedOn() {
        val folder = "BurrowAll${Random.nextInt(100000)}"
        val name = "all-${Random.nextInt(100000)}.txt"
        val text = "anywhere on the phone ${Random.nextInt(100000)}"
        shell("appops set ${ctx.packageName} MANAGE_EXTERNAL_STORAGE allow")
        // Written by the app's own process (the test runs in it), allowed now; the shell here runs one
        // command without a shell, so "&&" and ">" made folders of their words.
        java.io.File("/sdcard/$folder").mkdirs()
        java.io.File("/sdcard/$folder/$name").writeText("$text\n")
        try {
            instr.runOnMainSync { app.unlockForTest() }
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val web = main(scenario)
                opened(web)
                js(web, "location.hash = '#/files/phone?p=%2F'")
                waitJs(web, "document.querySelector('[data-testid=phone-all-on]')", 20_000)
                assertTrue("off until switched on", !Prefs(ctx).allFiles)
                js(web, "document.querySelector('[data-testid=phone-all-on]').click()")
                waitJs(web, "document.querySelector('dialog[open] [data-testid=confirm-ok]')")
                screenshot("46-phone-all-files-warning")
                js(web, "document.querySelector('[data-testid=confirm-ok]').click()")
                val volume = "[...document.querySelectorAll('[data-testid=phone-root]')].find(r => r.querySelector('[data-testid=phone-all-off]'))"
                waitJs(web, volume, 20_000)
                assertTrue("switched on in the app", Prefs(ctx).allFiles)
                drawn(web, "[data-testid=phone-roots]")
                screenshot("47-phone-all-files")
                // Into the test's folder of the storage by its path (the storage's id is its path's hash): the
                // emulator died (exit 139) at the storage's top listing in four runs of six, a phone does not.
                val id = PhonePaths.sha256("/storage/emulated/0".toByteArray()).take(16)
                js(web, "location.hash = '#/files/phone?p=' + encodeURIComponent(${q("/$id/$folder")})")
                val row = "[...document.querySelectorAll('[data-testid=phone-row]')].find(r => r.textContent.includes(${q(name)}))"
                waitJs(web, row, 20_000)
                js(web, "$row.querySelector('[data-testid=phone-open]').click()")
                waitJs(web, "document.querySelector('[data-testid=editor]') && document.querySelector('[data-testid=editor]').textContent.includes(${q(text)})", 20_000)
                // Off: gone from the list at once, the files left on the phone.
                js(web, "location.hash = '#/files/phone?p=%2F'")
                waitJs(web, volume, 20_000)
                js(web, "$volume.querySelector('[data-testid=phone-all-off]').click()")
                waitJs(web, "!($volume) && document.querySelector('[data-testid=phone-all-on]')", 20_000)
                assertFalse("switched off in the app", Prefs(ctx).allFiles)
                assertTrue("the phone's files stay", shell("ls /sdcard/$folder").contains(name))
            }
        } finally {
            // Android's permission left as it is: taking it back kills the app's process, and this test's
            // with it (the emulator is thrown away after). Off in the app is what Burrow goes by.
            Prefs(ctx).allFiles = false
            shell("rm -rf /sdcard/$folder")
        }
    }
}
