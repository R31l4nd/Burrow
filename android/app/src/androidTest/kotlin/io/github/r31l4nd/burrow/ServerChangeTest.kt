package io.github.r31l4nd.burrow

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * "Change server" leaves nothing of the old server behind (run last by
 * scripts/android-test.sh: it unpairs the app). Before, the direct route's
 * SSH key stayed trusted on the old server's hosts and the old server could
 * still push to the phone (A3-AND-09).
 */
@RunWith(AndroidJUnit4::class)
class ServerChangeTest : WebTestBase() {
    @Test
    fun changingTheServerForgetsTheOldOnesKeys() {
        val prefs = Prefs(ctx)
        DirectKey.publicKey()
        prefs.pushEndpoint = """{"url":"https://push.example/up/abc","p256dh":"k","auth":"a"}"""
        instr.runOnMainSync { app.unlocked = true }
        ActivityScenario.launch<SetupActivity>(Intent(ctx, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_CHANGE, true)).use {
            val input = device.wait(Until.findObject(By.res(ctx.packageName, "server_input")), 10_000)
            assertNotNull("the setup screen", input)
            input.text = "https://another.example"
            device.findObject(By.text(ctx.getString(R.string.setup_continue))).click()
            waitUntil("the new server saved") { prefs.origin == "https://another.example" }
        }
        assertFalse("the direct route's SSH key of the old server is gone", DirectKey.exists())
        assertNull("the old server's push address is gone", prefs.pushEndpoint)
        assertNull("the old server's pairing is gone", prefs.deviceId)
    }
}
