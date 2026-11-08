package io.github.r31l4nd.burrow

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.util.TypedValue
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatDelegate
import org.json.JSONObject

/**
 * The few native screens (server address, app tabs) drawn in Burrow's own
 * look: the same colours as web/src/app.css, light or dark, with the accent
 * chosen in Burrow's settings (handed over by the page, Prefs.uiPrefs).
 */
object Style {
    data class Palette(
        val bg: Int,
        val raised: Int,
        val sunken: Int,
        val border: Int,
        val text: Int,
        val dim: Int,
        val danger: Int,
        val accent: Int,
        val accentText: Int,
        /** The rail's colour (app.css --side): the title bar on a phone, and the status bar above it. */
        val side: Int,
    )

    // name -> dark accent, text on it, light accent, text on it (app.css)
    private val ACCENTS = mapOf(
        "green" to listOf("#5faf86", "#0c1410", "#2e6b4e", "#ffffff"),
        "blue" to listOf("#79c0ff", "#0a1a2e", "#0969da", "#ffffff"),
        "purple" to listOf("#d2a8ff", "#1f1030", "#8250df", "#ffffff"),
        "orange" to listOf("#ffa657", "#2b1400", "#bc4c00", "#ffffff"),
        "pink" to listOf("#ff9bce", "#2e0a1c", "#bf3989", "#ffffff"),
        "teal" to listOf("#56d4dd", "#032326", "#1b7c83", "#ffffff"),
    )

    private fun appearance(context: Context): JSONObject = try {
        JSONObject(JSONObject(Prefs(context).uiPrefs).optString("burrow.appearance", "{}"))
    } catch (e: Exception) {
        JSONObject()
    }

    /** Light, dark or the phone's setting, as chosen in Burrow. */
    fun applyNightMode(context: Context) {
        AppCompatDelegate.setDefaultNightMode(
            when (appearance(context).optString("mode")) {
                "light" -> AppCompatDelegate.MODE_NIGHT_NO
                "dark", "black" -> AppCompatDelegate.MODE_NIGHT_YES
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            },
        )
    }

    fun palette(context: Context): Palette {
        val night = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val a = ACCENTS[appearance(context).optString("accent")] ?: ACCENTS.getValue("green")
        val c = { s: String -> Color.parseColor(s) }
        // The web app's own colours (app.css), so the app's screens and Burrow's look as one.
        return when {
            night && appearance(context).optString("mode") == "black" ->
                Palette(c("#000000"), c("#000000"), c("#000000"), c("#2a2a2a"), c("#e4eae6"), c("#9aa59f"), c("#e5675c"), c(a[0]), c(a[1]), c("#000000"))
            night -> Palette(c("#121714"), c("#1a201c"), c("#0f1411"), c("#2b332e"), c("#e4eae6"), c("#9aa59f"), c("#e5675c"), c(a[0]), c(a[1]), c("#0d110f"))
            else -> Palette(c("#f5f5f2"), c("#ffffff"), c("#eeefeb"), c("#e2e4df"), c("#17201b"), c("#5b655f"), c("#b42318"), c(a[2]), c(a[3]), c("#17201b"))
        }
    }

    fun dp(context: Context, v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, context.resources.displayMetrics).toInt()

    fun shape(context: Context, fill: Int, stroke: Int? = null, radiusDp: Float = 12f): GradientDrawable = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(context, radiusDp).toFloat()
        if (stroke != null) setStroke(dp(context, 1f), stroke)
    }

    private fun pressable(context: Context, base: Drawable, p: Palette): Drawable =
        RippleDrawable(ColorStateList.valueOf(p.border), base, null)

    /** [danger]: what cannot be undone (a delete), red on the raised colour, as the page's .btn.danger. */
    fun button(context: Context, label: String, primary: Boolean, danger: Boolean = false): Button {
        val p = palette(context)
        return Button(context, null, 0).apply {
            text = label
            isAllCaps = false
            textSize = 16f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(if (danger) p.danger else if (primary) p.accentText else p.text)
            background = pressable(context, shape(context, if (danger) p.raised else if (primary) p.accent else p.raised, if (danger) androidx.core.graphics.ColorUtils.blendARGB(p.border, p.danger, 0.45f) else if (primary) null else p.border), p)
            minHeight = dp(context, 48f)
            gravity = Gravity.CENTER
            val pad = dp(context, 16f)
            setPadding(pad, 0, pad, 0)
            stateListAnimator = null
        }
    }

    fun input(context: Context): EditText {
        val p = palette(context)
        return EditText(context).apply {
            setTextColor(p.text)
            setHintTextColor(p.dim)
            textSize = 16f
            background = shape(context, p.sunken, p.border, 8f)
            val pad = dp(context, 12f)
            setPadding(pad, pad, pad, pad)
        }
    }

    fun text(context: Context, value: String, sizeSp: Float, color: Int, bold: Boolean = false): TextView = TextView(context).apply {
        text = value
        textSize = sizeSp
        setTextColor(color)
        if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }

    fun iconButton(context: Context, icon: Int, description: String, tint: Int): ImageButton = ImageButton(context).apply {
        setImageResource(icon)
        setColorFilter(tint)
        contentDescription = description
        // Only a ripple when pressed; nothing drawn at rest.
        background = RippleDrawable(ColorStateList.valueOf(palette(context).border), GradientDrawable().apply { setColor(Color.TRANSPARENT) }, shape(context, Color.WHITE, null, 24f))
        isFocusable = false
        val s = dp(context, 48f)
        minimumWidth = s
        minimumHeight = s
        scaleType = android.widget.ImageView.ScaleType.CENTER
    }

    fun centered(v: TextView) = v.apply { gravity = Gravity.CENTER }

    /** Full-width row in a column, with space above. */
    fun row(context: Context, topDp: Float) = android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT).apply {
        topMargin = dp(context, topDp)
    }

    /** As wide as Burrow's dialogs get (Dialog.svelte: 520 px), and from which width they stand in the middle (640). */
    const val DIALOG_DP = 520f
    const val DIALOG_CENTRED_DP = 640

    /** How long a guarded question's OK ignores taps after it shows. */
    const val GUARD_MS = 500L

    /**
     * A question of the app's own (a download, a sign-in of an app tab, a
     * page's confirm()) in Burrow's dialog look, as the page's questions
     * (web/src/components/Dialog.svelte): a sheet from the bottom on a phone,
     * a box in the middle from 640 dp, the title with a close button, the
     * body, and a footer of Cancel and the primary button, as wide as each
     * other, light or dark as the app. Android's own AlertDialog was square
     * with small text buttons (decision 23). [cancel] null: the primary
     * button alone. [danger]: the primary button red, for what cannot be
     * undone. [onDismiss] runs however it closes, after [onOk].
     */
    fun ask(
        context: Context,
        title: String,
        body: android.view.View,
        ok: String,
        cancel: String? = context.getString(R.string.cancel),
        danger: Boolean = false,
        // A question the page brought up (a delete, a key forgotten, screenshots allowed): its OK
        // does nothing for a moment after it shows, and not under another window, so a tap meant
        // for the page beneath cannot answer it (tapjacking, audit 2026-11-05).
        guarded: Boolean = danger,
        onDismiss: () -> Unit = {},
        onOk: () -> Unit,
    ): android.app.Dialog {
        var shownAt = Long.MAX_VALUE
        val p = palette(context)
        val wide = context.resources.configuration.screenWidthDp >= DIALOG_CENTRED_DP
        val r = dp(context, if (wide) 10f else 12f).toFloat()
        val dialog = android.app.Dialog(context)
        // A window of its own: secure as the screen it asks for (FLAG_SECURE is not inherited).
        dialog.window?.let(Insets::secure)
        dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        val column = android.widget.LinearLayout(context).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(p.raised)
                setStroke(dp(context, 1f), p.border)
                cornerRadii = floatArrayOf(r, r, r, r, if (wide) r else 0f, if (wide) r else 0f, if (wide) r else 0f, if (wide) r else 0f)
            }
            clipToOutline = true
        }
        val header = android.widget.LinearLayout(context).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(context, 18f), dp(context, 6f), dp(context, 4f), dp(context, 6f))
        }
        header.addView(text(context, title, 17f, p.text, bold = true).apply { id = R.id.ask_title }, android.widget.LinearLayout.LayoutParams(0, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(iconButton(context, R.drawable.ic_close, context.getString(R.string.close), p.text).apply { setOnClickListener { dialog.cancel() } })
        column.addView(header)
        val line = { android.view.View(context).apply { setBackgroundColor(p.border) } }
        column.addView(line(), android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, dp(context, 1f)))
        column.addView(body.apply { setPadding(dp(context, 18f), dp(context, 16f), dp(context, 18f), dp(context, 16f)) })
        column.addView(line(), android.widget.LinearLayout.LayoutParams(android.widget.LinearLayout.LayoutParams.MATCH_PARENT, dp(context, 1f)))
        val footer = android.widget.LinearLayout(context).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            setBackgroundColor(p.bg)
            setPadding(dp(context, 18f), dp(context, 12f), dp(context, 18f), dp(context, 12f))
        }
        val half = { gap: Float -> android.widget.LinearLayout.LayoutParams(0, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(context, gap) } }
        if (cancel != null) footer.addView(button(context, cancel, primary = false).apply { id = R.id.ask_cancel; setOnClickListener { dialog.cancel() } }, half(0f))
        footer.addView(
            button(context, ok, primary = true, danger = danger).apply {
                id = R.id.ask_ok
                if (guarded) filterTouchesWhenObscured = true
                setOnClickListener {
                    if (guarded && android.os.SystemClock.uptimeMillis() - shownAt < GUARD_MS) return@setOnClickListener
                    onOk()
                    dialog.dismiss()
                }
            },
            half(if (cancel != null) 10f else 0f),
        )
        column.addView(footer)
        dialog.setContentView(column)
        dialog.setOnDismissListener { onDismiss() }
        dialog.setOnShowListener { shownAt = android.os.SystemClock.uptimeMillis() }
        dialog.window?.apply {
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            setGravity(if (wide) Gravity.CENTER else Gravity.BOTTOM)
            setLayout(if (wide) dp(context, DIALOG_DP) else android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT)
            setDimAmount(0.5f)
            // A field in the body: the sheet rises above the keyboard.
            setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        return dialog
    }

    /** A question's body: lines of text, the first one bold when [firstBold] (a file's name). */
    fun askText(context: Context, vararg lines: String, firstBold: Boolean = false): android.widget.LinearLayout {
        val p = palette(context)
        return android.widget.LinearLayout(context).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            lines.filter { it.isNotEmpty() }.forEachIndexed { i, l ->
                addView(text(context, l, 16f, if (i == 0 || !firstBold) p.text else p.dim, bold = i == 0 && firstBold), row(context, if (i == 0) 0f else 6f))
            }
        }
    }

    /** As wide as the native screens' column gets: a phone's width, also on a tablet. */
    const val COLUMN_DP = 440f

    /**
     * A centred full-screen message: the app icon, a title; the caller adds
     * text and buttons. Its column is at most [COLUMN_DP] wide, as the setup
     * screen's: on a tablet the lock's and the error screen's buttons
     * stretched over the whole width (A3-AND-23).
     */
    fun screen(context: Context, title: Int): android.widget.LinearLayout {
        val p = palette(context)
        val pad = dp(context, 32f)
        val column = dp(context, COLUMN_DP)
        return object : android.widget.LinearLayout(context) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val side = maxOf(pad, (MeasureSpec.getSize(widthMeasureSpec) - column + 1) / 2)
                if (paddingLeft != side || paddingRight != side) setPadding(side, pad, side, pad)
                super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            }
        }.apply {
            orientation = android.widget.LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(p.bg)
            setPadding(pad, pad, pad, pad)
            isClickable = true
            addView(android.widget.ImageView(context).apply { setImageResource(R.mipmap.ic_launcher) }, android.widget.LinearLayout.LayoutParams(dp(context, 72f), dp(context, 72f)))
            addView(centered(text(context, context.getString(title), 22f, p.text, bold = true)), row(context, 16f))
        }
    }
}
