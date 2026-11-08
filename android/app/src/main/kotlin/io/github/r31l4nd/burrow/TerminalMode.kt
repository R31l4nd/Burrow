package io.github.r31l4nd.burrow

import android.app.Activity
import android.content.Context
import android.graphics.Rect
import android.text.InputType
import android.view.ActionMode
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import org.json.JSONObject

/**
 * A WebView that can ask the keyboard for plain characters while the
 * terminal has it, as Termux does ("enforce-char-based-input") and Termius
 * feels: no suggestions and no corrections, each character sent as it is
 * typed. A keyboard that rewrites words (Gboard) made the terminal get text
 * twice. Other fields on the page (the compose box, forms) keep the
 * keyboard's help: the page switches this on and off with the focus.
 */
class TermWebView(context: Context) : WebView(context) {
    var charInput = false
        set(on) {
            if (field == on) return
            field = on
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).restartInput(this)
        }

    /** The volume keys go to the terminal (down: Ctrl, up: the next key's special meaning). */
    var volumeKeys = false

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val ic = super.onCreateInputConnection(outAttrs)
        if (charInput && ic != null) {
            outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            outAttrs.imeOptions = outAttrs.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        }
        return ic
    }
}

/** The page's "terminal" call, the same in Burrow and on the direct route. */
object TerminalMode {
    fun apply(activity: Activity, web: TermWebView, p: JSONObject) {
        web.charInput = p.optBoolean("input")
        web.volumeKeys = p.optBoolean("keys")
        // The screen stays on while a terminal is in sight (a long build, Claude Code working).
        if (p.optBoolean("screen")) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    /**
     * A volume key while the terminal takes them: "down" or "up" once per
     * press (to send to the page), "" for its repeat and release (only
     * swallowed), null when it is the phone's volume as usual.
     */
    fun volumeKey(web: TermWebView?, event: KeyEvent): String? = volumeKey(web?.volumeKeys == true, event.keyCode, event.action, event.repeatCount)

    /** As above, from the key's own numbers ([taken]: the terminal takes the volume keys now). */
    fun volumeKey(taken: Boolean, keyCode: Int, action: Int, repeatCount: Int): String? {
        if (!taken) return null
        val name = when (keyCode) {
            KeyEvent.KEYCODE_VOLUME_DOWN -> "down"
            KeyEvent.KEYCODE_VOLUME_UP -> "up"
            else -> return null
        }
        return if (action == KeyEvent.ACTION_DOWN && repeatCount == 0) name else ""
    }
}

/**
 * Android's own floating menu over the terminal's selection (Copy, Paste,
 * Select all), as in any other app; the page makes the selection and does
 * what is picked. The page calls show() with the selection's box (CSS
 * pixels in the WebView) and with null when the selection is gone; a pick
 * comes back as the "selectionAction" event, and so does "close" when
 * Android dismissed the menu itself.
 */
class SelectionMenu(private val web: View, private val emit: (String, Any?) -> Unit) {
    private var mode: ActionMode? = null
    private val box = Rect()
    private var closing = false

    fun show(p: JSONObject) {
        if (!p.has("w")) {
            closing = true
            mode?.finish()
            mode = null
            closing = false
            return
        }
        val d = web.resources.displayMetrics.density
        val x = p.getDouble("x")
        val y = p.getDouble("y")
        box.set((x * d).toInt(), (y * d).toInt(), ((x + p.getDouble("w")) * d).toInt(), ((y + p.getDouble("h")) * d).toInt())
        mode?.let {
            it.invalidateContentRect()
            return
        }
        mode = web.startActionMode(
            object : ActionMode.Callback2() {
                override fun onCreateActionMode(m: ActionMode, menu: Menu): Boolean {
                    menu.add(Menu.NONE, COPY, 0, android.R.string.copy)
                    menu.add(Menu.NONE, PASTE, 1, android.R.string.paste)
                    menu.add(Menu.NONE, ALL, 2, android.R.string.selectAll)
                    return true
                }

                override fun onPrepareActionMode(m: ActionMode, menu: Menu) = false

                override fun onActionItemClicked(m: ActionMode, item: MenuItem): Boolean {
                    emit("selectionAction", when (item.itemId) { COPY -> "copy"; PASTE -> "paste"; else -> "all" })
                    return true
                }

                override fun onDestroyActionMode(m: ActionMode) {
                    if (mode !== m) return
                    mode = null
                    if (!closing) emit("selectionAction", "close")
                }

                override fun onGetContentRect(m: ActionMode, view: View, outRect: Rect) {
                    outRect.set(box)
                }
            },
            ActionMode.TYPE_FLOATING,
        )
    }

    private companion object {
        const val COPY = 1
        const val PASTE = 2
        const val ALL = 3
    }
}
