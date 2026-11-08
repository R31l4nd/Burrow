package io.github.r31l4nd.burrow

import android.content.res.Configuration
import android.view.View
import android.view.Window
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Edge to edge, with the content kept clear of the bars, the cutout and the
 * keyboard: the WebView shrinks when the keyboard opens, so Burrow's key
 * bar sits right above it.
 */
object Insets {
    /**
     * No screenshots and no preview in the app switcher, unless the user
     * allowed them (Settings -> Android app). Debug builds always allow them,
     * so the device test can show every screen.
     */
    fun secure(window: Window) {
        val flag = android.view.WindowManager.LayoutParams.FLAG_SECURE
        val prefs = Prefs(window.context)
        if (secureBuild(prefs) && !prefs.allowScreenshots) window.addFlags(flag) else window.clearFlags(flag)
    }

    fun secureBuild(prefs: Prefs) = BuildConfig.SECURE_WINDOWS || prefs.simulateRelease

    /**
     * As apply(), but the status bar's strip is a view of its own ([bar],
     * a child of [root]) whose colour the page sets: its dark title bar on a
     * phone, its background on a wider screen. The other children start
     * below it.
     */
    fun applyWithStatusBar(window: Window, root: android.widget.FrameLayout, bar: View) {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val night = (root.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, root).isAppearanceLightNavigationBars = !night
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(i.left, 0, i.right, i.bottom)
            bar.layoutParams = (bar.layoutParams as android.widget.FrameLayout.LayoutParams).apply { height = i.top }
            for (k in 0 until root.childCount) {
                val child = root.getChildAt(k)
                if (child === bar) continue
                child.layoutParams = (child.layoutParams as android.widget.FrameLayout.LayoutParams).apply { topMargin = i.top }
            }
            WindowInsetsCompat.CONSUMED
        }
    }

    /** The status bar's strip in [color], its icons light or dark to stand out on it. */
    fun paintStatusBar(window: Window, bar: View, color: Int) {
        bar.setBackgroundColor(color)
        val lum = (0.299 * android.graphics.Color.red(color) + 0.587 * android.graphics.Color.green(color) + 0.114 * android.graphics.Color.blue(color)) / 255
        WindowCompat.getInsetsController(window, bar).isAppearanceLightStatusBars = lum > 0.6
    }

    fun apply(window: Window, root: View) {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val night = (root.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }
}
