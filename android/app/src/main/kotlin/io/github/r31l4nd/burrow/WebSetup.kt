package io.github.r31l4nd.burrow

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import java.util.concurrent.Executors

/** What both kinds of WebView (Burrow and app tabs) share. */
object WebSetup {
    val io = Executors.newCachedThreadPool()

    /**
     * A request to this phone's own loopback, refused. The app's WireGuard
     * proxy listens there and answers its own realm with the secret; a page
     * (or another app's server on the phone) asking in that realm from
     * 127.0.0.1 looked like the proxy. No app of yours lives on the phone's
     * loopback, so nothing is lost. `allow`: an origin that does (a test).
     */
    fun loopbackRefused(request: android.webkit.WebResourceRequest, allow: String? = null): android.webkit.WebResourceResponse? {
        if (!toLoopback(request.url, allow)) return null
        return android.webkit.WebResourceResponse("text/plain", "utf-8", 403, "Not on this phone", emptyMap(), null)
    }

    /**
     * A page load to the phone's loopback (but [allow]). shouldInterceptRequest
     * does not see where a redirect leads, shouldOverrideUrlLoading does: a
     * page that redirects there is stopped by this (AUDIT2 AND-03).
     */
    fun toLoopback(url: Uri, allow: String? = null): Boolean = toLoopback(url.host, url.toString(), allow)

    /** As above, from the address's host (as Android read it) and the address itself. */
    fun toLoopback(host: String?, url: String, allow: String? = null): Boolean =
        Origins.isLoopback(host) && !(allow != null && Origins.same(url, allow))

    /** A message to a page's bridge; only where WebView has message listeners (it does wherever a reply proxy exists). */
    fun send(proxy: androidx.webkit.JavaScriptReplyProxy?, text: String) {
        if (proxy != null && androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_MESSAGE_LISTENER)) proxy.postMessage(text)
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun configure(web: WebView) {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // No file:// or content:// pages: only the web.
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
    }

    /**
     * confirm() and alert() of Burrow's own pages as plain dialogs, without
     * the WebView's "The page at https://... says:" header (it is our page).
     * App tabs keep the default: there the origin is worth showing.
     */
    open class OwnPageChrome(private val activity: Activity) : WebChromeClient() {
        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: android.webkit.JsResult): Boolean {
            androidx.appcompat.app.AlertDialog.Builder(activity)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }
                .create()
                // A window of its own: secure as the page's (it may name hosts and commands), before its first frame.
                .apply { window?.let(Insets::secure) }
                .show()
            return true
        }

        /**
         * Leaving a page with unsaved work (a reload, a link): the app's own
         * question, in its words, instead of WebView's bare "Confirm
         * navigation" (A3-AND-03).
         */
        override fun onJsBeforeUnload(view: WebView, url: String?, message: String?, result: android.webkit.JsResult): Boolean {
            androidx.appcompat.app.AlertDialog.Builder(activity)
                .setMessage(R.string.leave_unsaved)
                .setPositiveButton(R.string.leave) { _, _ -> result.confirm() }
                .setNegativeButton(R.string.stay) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }
                .create()
                // A window of its own: secure as the page's (it may name hosts and commands), before its first frame.
                .apply { window?.let(Insets::secure) }
                .show()
            return true
        }

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: android.webkit.JsResult): Boolean {
            androidx.appcompat.app.AlertDialog.Builder(activity)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.confirm() }
                .create()
                // A window of its own: secure as the page's (it may name hosts and commands), before its first frame.
                .apply { window?.let(Insets::secure) }
                .show()
            return true
        }
    }

    /**
     * The page's <input type=file>: Android's picker (gallery, files, camera
     * apps), one or several files.
     */
    class FileChooser(activity: AppCompatActivity) {
        private var pending: ValueCallback<Array<Uri>>? = null
        private val launcher: ActivityResultLauncher<Intent> =
            activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
                val cb = pending ?: return@registerForActivityResult
                pending = null
                cb.onReceiveValue(if (r.resultCode == Activity.RESULT_OK) uris(r.data) else null)
            }

        fun show(activity: Activity, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
            pending?.onReceiveValue(null)
            pending = callback
            val intent = params.createIntent()
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            return try {
                launcher.launch(intent)
                true
            } catch (e: Exception) {
                pending = null
                Toast.makeText(activity, R.string.no_app, Toast.LENGTH_SHORT).show()
                false
            }
        }

        private fun uris(data: Intent?): Array<Uri>? {
            data ?: return null
            val clip: ClipData? = data.clipData
            if (clip != null && clip.itemCount > 0) return Array(clip.itemCount) { clip.getItemAt(it).uri }
            return data.data?.let { arrayOf(it) }
        }
    }
}
