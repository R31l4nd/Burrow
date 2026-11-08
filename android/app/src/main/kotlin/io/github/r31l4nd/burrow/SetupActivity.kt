package io.github.r31l4nd.burrow

import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature

/** First start (or "Change server"): which Burrow to open. */
class SetupActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Insets.secure(window)
        val prefs = Prefs(this)
        val p = Style.palette(this)
        val pad = Style.dp(this, 24f)
        val root = android.widget.FrameLayout(this).apply { setBackgroundColor(p.bg) }
        // One column, as wide as a phone even on a tablet.
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        root.addView(column, android.widget.FrameLayout.LayoutParams(Style.dp(this, Style.COLUMN_DP).coerceAtMost(resources.displayMetrics.widthPixels), android.widget.FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        val gap = { v: android.view.View, top: Float -> column.addView(v, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = Style.dp(this@SetupActivity, top) }) }

        val icon = android.widget.ImageView(this).apply { setImageResource(R.mipmap.ic_launcher) }
        column.addView(icon, LinearLayout.LayoutParams(Style.dp(this, 72f), Style.dp(this, 72f)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        gap(Style.centered(Style.text(this, getString(R.string.setup_title), 24f, p.text, bold = true)), 16f)
        gap(Style.centered(Style.text(this, getString(R.string.setup_hint), 15f, p.dim)), 8f)
        gap(Style.text(this, getString(R.string.setup_label), 14f, p.dim), 28f)
        val input = Style.input(this).apply {
            id = R.id.server_input
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            hint = "https://burrow.example.com"
            setText(prefs.origin ?: BuildConfig.DEFAULT_SERVER)
            setSingleLine()
        }
        gap(input, 6f)
        val error = Style.text(this, getString(R.string.setup_invalid), 14f, p.danger).apply { visibility = android.view.View.GONE }
        gap(error, 6f)
        val go = Style.button(this, getString(R.string.setup_continue), primary = true)
        gap(go, 20f)
        setContentView(root)
        Insets.apply(window, root)

        val submit = {
            val origin = Origins.normalize(input.text.toString())
            if (origin == null) {
                error.visibility = android.view.View.VISIBLE
            } else {
                if (origin != prefs.origin) forgetServer(this, prefs)
                prefs.origin = origin
                startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                finish()
            }
        }
        go.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, _, _ ->
            submit()
            true
        }
    }

    companion object {
        const val EXTRA_CHANGE = "change"

        /**
         * Another server: what belongs to the old one goes. The paired key and
         * the cookies, the direct route's cache and its SSH key (the old
         * server's hosts trusted it until that server unpaired the phone, and
         * the new one would be told the same key), and Burrow's push
         * registration (the old server could still notify the phone,
         * A3-AND-09), and the phone's folders granted for its Files page. The
         * WireGuard configuration is the person's own network,
         * not the server's: it stays.
         */
        fun forgetServer(activity: AppCompatActivity, prefs: Prefs) {
            DeviceKey.delete(prefs)
            DirectKey.delete()
            DirectStore(activity).clear()
            (activity.application as BurrowApp).held.clear()
            // The phone's folders granted for the old server's Files page: given back to Android.
            runCatching { PhoneFolders(activity).clear() }
            // "All files" too: the next server is not given the whole phone because the last one was.
            prefs.allFiles = false
            prefs.deviceId = null
            if (prefs.pushEndpoint != null) runCatching { org.unifiedpush.android.connector.UnifiedPush.unregister(activity) }
            prefs.pushEndpoint = null
            CookieManager.getInstance().removeAllCookies(null)
            // The app tabs' own profiles of the old server: gone too, where none is open.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                val store = ProfileStore.getInstance()
                for (p in store.allProfileNames.filter { it.startsWith(AppProfiles.PREFIX) }) runCatching { store.deleteProfile(p) }
            }
        }
    }
}
