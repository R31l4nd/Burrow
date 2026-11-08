package io.github.r31l4nd.burrow

import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.regex.Pattern
import kotlin.random.Random

/**
 * The phone's own files on Burrow's Files page (report a9552e), for real: a
 * folder granted in Android's own folder picker (the Storage Access
 * Framework, no storage permission), listed, a text file opened in Burrow's
 * editor, copied to the test host, a host's file copied back into the
 * folder, and the folder removed again, its permission given back. Run by
 * scripts/android-test.sh after DeviceTest (paired and signed in).
 */
@RunWith(AndroidJUnit4::class)
class PhoneFilesTest : WebTestBase() {
    private val args get() = InstrumentationRegistry.getArguments()
    private val hostId get() = args.getString("hostId")!!.toLong()

    private fun q(s: String) = JSONObject.quote(s)

    private fun main(scenario: ActivityScenario<MainActivity>): () -> WebView {
        lateinit var a: MainActivity
        scenario.onActivity { a = it }
        return { a.webView }
    }

    /** Found and pressed, found again when Android drew the screen anew in between (StaleObjectException). */
    private fun press(what: String, selector: androidx.test.uiautomator.BySelector) {
        repeat(3) { n ->
            val o = device.wait(Until.findObject(selector), 15_000)
            assertNotNull(what, o)
            try {
                return o.click()
            } catch (e: androidx.test.uiautomator.StaleObjectException) {
                if (n == 2) throw e
            }
        }
    }

    @Test
    fun aFolderOfThePhoneIsGrantedListedOpenedCopiedAndRemoved() {
        val folder = "BurrowPhone${Random.nextInt(100000)}"
        val name = "phone-${Random.nextInt(100000)}.txt"
        val text = "written on the phone ${Random.nextInt(100000)}"
        // A folder in Download with a text file, as a person keeps one (Android gives the Download
        // folder only by its folders). Made through the media store: the test has no storage permission either.
        val made = ctx.contentResolver.insert(
            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name)
                put(android.provider.MediaStore.Downloads.MIME_TYPE, "text/plain")
                put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "Download/$folder")
            },
        )!!
        val bytes = "$text\n".toByteArray()
        ctx.contentResolver.openOutputStream(made)!!.use { it.write(bytes) }
        val size = bytes.size.toLong()
        // An archive beside it (report 99d993): shown as a folder, unpacked beside itself.
        val zipBase = "bundle-${Random.nextInt(100000)}"
        val zipped = ctx.contentResolver.insert(
            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, "$zipBase.zip")
                put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/zip")
                put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "Download/$folder")
            },
        )!!
        ctx.contentResolver.openOutputStream(zipped)!!.use { o ->
            java.util.zip.ZipOutputStream(o).use { z ->
                for ((n, t) in listOf("inner/hello.txt" to "hello from the zip", "top.txt" to "top")) {
                    z.putNextEntry(java.util.zip.ZipEntry(n))
                    z.write(t.toByteArray())
                    z.closeEntry()
                }
            }
        }
        // Paired and unlocked by DeviceTest before (the lock itself is its test).
        instr.runOnMainSync { app.unlockForTest() }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val web = main(scenario)
            opened(web)
            js(web, "location.hash = '#/files'")
            waitJs(web, "document.querySelector('[data-testid=phone-files]')")
            js(web, "document.querySelector('[data-testid=phone-files]').click()")
            waitJs(web, "document.querySelector('[data-testid=phone-add-downloads]')")
            screenshot("40-phone-folders-none")

            // Android's folder picker, at Download: the test's folder, "Use this folder", "Allow".
            js(web, "document.querySelector('[data-testid=phone-add-downloads]').click()")
            val item = device.wait(Until.findObject(By.text(folder)), 20_000)
            assertNotNull("the folder in Android's picker (in front: ${inFront()})", item)
            item.click()
            Thread.sleep(1500)
            screenshot("41-phone-picker", mayBeBlack = true)
            press("the picker's Use this folder", By.text(Pattern.compile("use this folder", Pattern.CASE_INSENSITIVE)))
            press("Android asks to allow access", By.res("android:id/button1"))
            waitJs(web, "[...document.querySelectorAll('[data-testid=phone-root]')].some(r => r.textContent.includes(${q(folder)}))", 30_000)
            assertTrue("Android keeps the permission", ctx.contentResolver.persistedUriPermissions.any { it.uri.toString().contains(folder) && it.isReadPermission })
            // Back from Android's picker the screen lagged behind the page: the shot showed "No folder added yet".
            drawn(web, "[data-testid=phone-roots]")
            screenshot("42-phone-folders")

            // Its files, and the text file in Burrow's editor.
            js(web, "[...document.querySelectorAll('[data-testid=phone-root]')].find(r => r.textContent.includes(${q(folder)})).querySelector('[data-testid=phone-root-open]').click()")
            val row = "[...document.querySelectorAll('[data-testid=phone-row]')].find(r => r.textContent.includes(${q(name)}))"
            waitJs(web, row, 20_000)
            screenshot("43-phone-list")
            js(web, "$row.querySelector('[data-testid=phone-open]').click()")
            waitJs(web, "document.querySelector('[data-testid=editor]') && document.querySelector('[data-testid=editor]').textContent.includes(${q(text)})", 20_000)
            screenshot("44-phone-editor")

            // Copied to the host: held by the app, the share page, the normal upload.
            js(web, "history.back()")
            waitJs(web, row, 20_000)
            js(web, "$row.querySelector('[data-testid=phone-menu]').click()")
            waitJs(web, "document.querySelector('[data-testid=phone-copy]')")
            js(web, "document.querySelector('[data-testid=phone-copy]').click()")
            waitJs(web, "location.hash.startsWith('#/share')")
            val upload = tr("share.upload", "n" to 1)
            waitJs(web, "[...document.querySelectorAll('button')].some(b => b.textContent.includes(${q(upload)}) && !b.disabled)", 20_000)
            click(web, upload)
            val fetch = "window.__l = null; fetch('/api/files/$hostId/list?path=~').then(r => r.json()).then(j => window.__l = j)"
            js(web, fetch)
            waitJs(web, "window.__l && window.__l.entries.some(e => e.name === ${q(name)} && e.size === $size)", 60_000) { js(web, fetch) }

            // And back: the host's file into the phone's folder, by the app's own download.
            js(web, "location.hash = '#/files/$hostId?p=' + encodeURIComponent(window.__l.path)")
            val menu = q(tr("files.menuFor", "name" to name))
            waitJs(web, "document.querySelector('[aria-label=' + JSON.stringify($menu) + ']')", 20_000)
            js(web, "document.querySelector('[aria-label=' + JSON.stringify($menu) + ']').click()")
            waitJs(web, "document.querySelector('[data-testid=copy-to-phone]')")
            js(web, "document.querySelector('[data-testid=copy-to-phone]').click()")
            val pickRoot = "[...document.querySelectorAll('[data-testid=phone-pick-root]')].find(r => r.textContent.includes(${q(folder)}))"
            waitJs(web, pickRoot, 20_000)
            js(web, "$pickRoot.click()")
            waitJs(web, "document.querySelector('[data-testid=phone-pick-here]') && !document.querySelector('[data-testid=phone-pick-here]').disabled", 20_000)
            screenshot("45-phone-pick-folder")
            js(web, "document.querySelector('[data-testid=phone-pick-here]').click()")
            // Beside the one there, under a name of its own ("phone-1.txt" became "phone-1 (1).txt").
            val base = name.removeSuffix(".txt")
            waitUntil("the host's file in the phone's folder", 60_000, detail = { shell("ls /sdcard/Download/$folder") }) {
                shell("ls /sdcard/Download/$folder").lines().any { it.startsWith("$base (") && it.endsWith(".txt") }
            }

            // Changed on the phone (report 6eaf00): a new folder, the copy renamed,
            // then deleted only after the app's own question (No there first: it stays).
            val ls = { shell("ls /sdcard/Download/$folder").lines().map { it.trim() } }
            val copy = ls().first { it.startsWith("$base (") }
            js(web, "location.hash = '#/files/phone?p=%2F'")
            val opened = "[...document.querySelectorAll('[data-testid=phone-root]')].find(r => r.textContent.includes(${q(folder)}))"
            waitJs(web, opened, 20_000)
            js(web, "$opened.querySelector('[data-testid=phone-root-open]').click()")
            val rowOf = { n: String -> "[...document.querySelectorAll('[data-testid=phone-row]')].find(r => r.querySelector('.title').textContent === ${q(n)})" }
            waitJs(web, rowOf(copy), 20_000)
            // What the page said (a refusal in the dialog, a toast), for a timeout's message.
            val said = { "page: " + js(web, "(document.querySelector('[data-testid=phone-name-error]')?.textContent ?? '-') + ' | ' + [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' ; ')") }
            val nameInput = "document.querySelector('[data-testid=phone-name]')"
            val named = { n: String ->
                waitJs(web, "$nameInput && $nameInput.offsetParent !== null")
                // In a block of its own: a second "const i" at the top failed (one scope for every script of the page).
                js(web, "{ const i = $nameInput; i.value = ${q(n)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('phone-name-form').requestSubmit() }")
            }
            js(web, "document.querySelector('[data-testid=phone-folder-menu]').click()")
            waitJs(web, "document.querySelector('[data-testid=phone-new-folder]')")
            js(web, "document.querySelector('[data-testid=phone-new-folder]').click()")
            named("Kept")
            waitUntil("the new folder on the phone", detail = { ls().joinToString() + said() }) { "Kept" in ls() }
            waitJs(web, rowOf("Kept"), 20_000)

            val renamed = "renamed-$base.txt"
            js(web, "${rowOf(copy)}.querySelector('[data-testid=phone-menu]').click()")
            waitJs(web, "document.querySelector('[data-testid=phone-rename]')")
            js(web, "document.querySelector('[data-testid=phone-rename]').click()")
            named(renamed)
            screenshot("46-phone-rename")
            waitUntil("the copy renamed on the phone", detail = { ls().joinToString() + said() }) { renamed in ls() && copy !in ls() }
            waitJs(web, rowOf(renamed), 20_000)

            val askDelete = { n: String ->
                js(web, "${rowOf(n)}.querySelector('[data-testid=phone-menu]').click()")
                waitJs(web, "document.querySelector('[data-testid=phone-delete]') && document.querySelector('[data-testid=phone-delete]').offsetParent !== null")
                js(web, "document.querySelector('[data-testid=phone-delete]').click()")
            }
            askDelete("Kept")
            press("No in the app's own question", By.res(Pattern.compile(".*:id/ask_cancel")))
            Thread.sleep(1000)
            assertTrue("said no: the folder stays", "Kept" in ls())
            askDelete("Kept")
            screenshot("47-phone-delete-ask", mayBeBlack = true)
            // Its OK takes no tap for a moment after it shows (Style.GUARD_MS).
            Thread.sleep(Style.GUARD_MS + 300)
            press("Delete in the app's own question", By.res(Pattern.compile(".*:id/ask_ok")))
            waitUntil("the folder deleted", detail = { ls().joinToString() }) { "Kept" !in ls() }
            askDelete(renamed)
            // Its OK takes no tap for a moment after it shows (Style.GUARD_MS).
            Thread.sleep(Style.GUARD_MS + 300)
            press("Delete in the app's own question", By.res(Pattern.compile(".*:id/ask_ok")))
            waitUntil("the file deleted", detail = { ls().joinToString() }) { renamed !in ls() }
            waitJs(web, "!(${rowOf(renamed)})", 20_000)
            assertTrue("the other file stays", name in ls())

            // The archive: its folders shown, then unpacked into a folder of its name beside it, through Android's provider.
            val zipRow = rowOf("$zipBase.zip")
            waitJs(web, zipRow, 20_000)
            js(web, "$zipRow.querySelector('[data-testid=phone-open]').click()")
            val inside = "[...document.querySelectorAll('[data-testid=phone-archive-row]')].map(r => r.querySelector('.title').textContent).join(',')"
            waitJs(web, "$inside === 'inner,top.txt'", 20_000)
            screenshot("48-phone-archive")
            js(web, "document.querySelector('[data-testid=phone-unpack-here]').click()")
            waitUntil("the archive unpacked beside it", 60_000, detail = { ls().joinToString() + said() }) {
                shell("cat /sdcard/Download/$folder/$zipBase/inner/hello.txt").contains("hello from the zip")
            }
            waitJs(web, rowOf(zipBase), 20_000)
            screenshot("49-phone-unpacked")

            // Removed from Burrow: its permission given back to Android, the files left on the phone.
            js(web, "location.hash = '#/files/phone?p=%2F'")
            val root = "[...document.querySelectorAll('[data-testid=phone-root]')].find(r => r.textContent.includes(${q(folder)}))"
            waitJs(web, root, 20_000)
            js(web, "$root.querySelector('[data-testid=phone-root-remove]').click()")
            waitJs(web, "document.querySelector('dialog[open] [data-testid=confirm-ok]')")
            js(web, "document.querySelector('[data-testid=confirm-ok]').click()")
            waitJs(web, "!($root)", 20_000)
            waitUntil("the permission given back") { ctx.contentResolver.persistedUriPermissions.none { it.uri.toString().contains(folder) } }
            assertFalse("the folder is off the app's list", Prefs(ctx).phoneRoots.orEmpty().contains(folder))
            assertTrue("the phone's files stay", shell("ls /sdcard/Download/$folder").contains(name))
        }
        ctx.contentResolver.delete(made, null, null)
        shell("rm -rf /sdcard/Download/$folder")
    }
}
