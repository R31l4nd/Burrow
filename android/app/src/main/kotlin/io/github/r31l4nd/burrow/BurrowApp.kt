package io.github.r31l4nd.burrow

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.SystemClock

/**
 * App-wide state: held files, and when the app last went out of sight (the
 * fingerprint lock comes back after [LockFlow.LOCK_AFTER_MS] in the background).
 */
class BurrowApp : Application() {
    val held = HeldFiles()

    /** Called when where Burrow's push reaches this phone changed (Push.kt): the page tells Burrow. */
    @Volatile var pushChanged: (() -> Unit)? = null

    /** The app's own WireGuard (phase 13). */
    val wireguard by lazy { WireGuard(this).also { it.inSight = { started > 0 } } }

    private var started = 0
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    // Battery: out of sight for a minute, the tunnel goes down, unless a
    // transfer still needs it or a direct session is kept open on purpose;
    // coming back decides again, home or away.
    private val tunnelIdle: Runnable = object : Runnable {
        override fun run() {
            if (started > 0) return
            if (TransferService.busy() || KeepAlive.wanted()) main.postDelayed(this, tunnelIdleMs) else if (wireguard.active) wireguard.stopSoon()
        }
    }

    /** How long out of sight before the tunnel goes down (tests shorten it). */
    @androidx.annotation.VisibleForTesting
    var tunnelIdleMs = TUNNEL_IDLE_MS

    /** Keep-open ended while out of sight: the wait starts now. */
    fun hiddenNow() {
        main.post {
            if (started == 0) {
                main.removeCallbacks(tunnelIdle)
                main.postDelayed(tunnelIdle, tunnelIdleMs)
            }
        }
    }
    private var hiddenAt = 0L
    private val afterUnlock = WhenOpen()
    var unlocked = false
        set(v) {
            field = v
            if (v) afterUnlock.open() else afterUnlock.close()
        }

    /**
     * Device test only: unlocked as if the app had just been on screen. A pass
     * of its own (tablet, dark) starts a new process, whose first screen locked
     * it again (out of sight "since boot"), and the app tabs then gave way to
     * the lock.
     */
    @androidx.annotation.VisibleForTesting
    fun unlockForTest() {
        hiddenAt = SystemClock.elapsedRealtime()
        unlocked = true
    }

    /** Runs [f] (on the main thread) once Burrow is unlocked: at once when it is. */
    fun whenUnlocked(f: () -> Unit) = afterUnlock.run(f)

    override fun onCreate() {
        super.onCreate()
        Style.applyNightMode(this)
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(a: Activity) {
                if (started++ == 0 && LockFlow.relocks(unlocked, SystemClock.elapsedRealtime(), hiddenAt)) unlocked = false
                main.removeCallbacks(tunnelIdle)
            }

            override fun onActivityStopped(a: Activity) {
                if (--started == 0) {
                    hiddenAt = SystemClock.elapsedRealtime()
                    main.postDelayed(tunnelIdle, tunnelIdleMs)
                    // Alerts read, a host woken: the widget asks again now, while the tunnel may still be up.
                    Widget.poke(this@BurrowApp)
                }
            }

            // Every screen follows the screenshot setting, also right after it changed.
            override fun onActivityCreated(a: Activity, b: Bundle?) = Insets.secure(a.window)
            override fun onActivityResumed(a: Activity) = Insets.secure(a.window)
            override fun onActivityPaused(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {}
        })
        // Copies left from sharing and opening files, a day old or more.
        WebSetup.io.execute {
            for (d in listOf("share", "open")) CacheCleanup.old(java.io.File(cacheDir, d))
            AndroidDownloads.dropStalePending(this)
        }
    }

    companion object {
        const val TUNNEL_IDLE_MS = 60_000L
    }
}
