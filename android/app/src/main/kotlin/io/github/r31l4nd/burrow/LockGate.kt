package io.github.r31l4nd.burrow

import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.fragment.app.FragmentActivity

/**
 * The fingerprint lock over a screen: a cover while locked, the prompt once
 * the screen is up, and an Unlock button after a cancel. The unlocked state
 * is app-wide (BurrowApp): one fingerprint opens Burrow and the direct route.
 *
 * [behind] is the page under the cover: while covered it is hidden from
 * accessibility services and screen readers and takes no keyboard focus, and
 * [covered] tells the screen to keep keys (the volume keys) from it. The
 * cover alone hid it only from the eye (A3-AND-08).
 */
class LockGate(private val activity: FragmentActivity, root: FrameLayout, extra: Pair<Int, () -> Unit>? = null, private val behind: () -> android.view.ViewGroup? = { null }) {
    private val app get() = activity.application as BurrowApp

    val cover: View = Style.screen(activity, R.string.lock_title).apply {
        addView(Style.button(activity, activity.getString(R.string.lock_retry), primary = true).apply { setOnClickListener { flow.guard() } }, Style.row(activity, 24f))
        if (extra != null) {
            addView(Style.button(activity, activity.getString(extra.first), primary = false).apply { setOnClickListener { extra.second() } }, Style.row(activity, 10f))
        }
    }.also { root.addView(it, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT) }

    /** The cover is up: what is behind it gets no keys. */
    val covered: Boolean get() = cover.visibility == View.VISIBLE

    // What the page had before it was covered, given back as it was: set to
    // other values, the WebView no longer took the keyboard's focus properly.
    // Focusable in touch mode too: setFocusable(false) turns that off as well,
    // and without it a tap never gave the page the keyboard again (report 5e035c).
    private data class Before(val a11y: Int, val focus: Int, val focusable: Boolean, val inTouchMode: Boolean)
    private var before: Before? = null
    private var hidden: android.view.ViewGroup? = null

    private fun cover(on: Boolean) {
        cover.visibility = if (on) View.VISIBLE else View.GONE
        if (on) {
            val page = behind() ?: return
            if (hidden !== page) {
                hidden = page
                before = Before(page.importantForAccessibility, page.descendantFocusability, page.isFocusable, page.isFocusableInTouchMode)
            }
            page.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            page.descendantFocusability = android.view.ViewGroup.FOCUS_BLOCK_DESCENDANTS
            page.isFocusable = false
            page.clearFocus()
        } else {
            val page = hidden ?: return
            before?.let { b ->
                page.importantForAccessibility = b.a11y
                page.descendantFocusability = b.focus
                page.isFocusable = b.focusable
                page.isFocusableInTouchMode = b.inTouchMode
            }
            hidden = null
            before = null
        }
    }

    /** The page behind was made anew (its renderer went): covered as the screen is. */
    fun refresh() = cover(covered)

    private val flow = LockFlow(
        unlocked = { app.unlocked },
        unlock = { app.unlocked = true },
        canLock = { Biometrics.canLock(activity) },
        prompt = { done -> Biometrics.unlock(activity, done) },
        cover = { on -> cover(on) },
    )

    /** Covered at once; the prompt itself waits for onResume (a prompt started earlier can be dismissed by the activity coming up). */
    fun onStart() = flow.onStart()

    /** Once per return to the app: after a cancel, the Unlock button asks again. */
    fun onResume() = flow.onResume()

    fun guard() = flow.guard()
}
