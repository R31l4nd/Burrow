package io.github.r31l4nd.burrow

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.PixelCopy
import android.view.View
import java.io.ByteArrayOutputStream

/**
 * The page as it is on the screen, for a problem report: the page drew its
 * own picture from its markup, which is not what the person saw (a dialog,
 * the editor's panels, a scroll position; report "not the exact screen").
 * Only the WebView's own pixels, cut from the app's window, never the status
 * bar or another app: what the page could see anyway. Works under
 * FLAG_SECURE, which keeps the window out of other apps' captures, not the
 * app's own copy of it.
 */
object Screenshot {
    /** At most this wide in pixels (twice a phone's CSS width): a 3.25x screen made a picture too big to send. */
    fun width(viewWidth: Int, maxWidth: Int): Int = if (maxWidth in 1 until viewWidth) maxWidth else viewWidth

    /** The view's pixels as a JPEG data URL with its size, or a failure the page answers by drawing its own picture. */
    fun take(activity: Activity, view: View, maxWidth: Int, done: (Result<Any?>) -> Unit) {
        val w = view.width
        val h = view.height
        if (w <= 0 || h <= 0) return done(Result.failure(IllegalStateException("not on the screen")))
        val at = IntArray(2)
        view.getLocationInWindow(at)
        val shot = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        PixelCopy.request(activity.window, Rect(at[0], at[1], at[0] + w, at[1] + h), shot, { code ->
            if (code != PixelCopy.SUCCESS) {
                shot.recycle()
                done(Result.failure(IllegalStateException("PixelCopy $code")))
            } else {
                WebSetup.io.execute { done(runCatching { encode(shot, width(w, maxWidth)) }) }
            }
        }, Handler(Looper.getMainLooper()))
    }

    private fun encode(shot: Bitmap, width: Int): Any {
        val scaled = if (width == shot.width) shot else Bitmap.createScaledBitmap(shot, width, shot.height * width / shot.width, true).also { shot.recycle() }
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 85, out)
        val size = scaled.width to scaled.height
        scaled.recycle()
        return BridgeProtocol.obj("picture" to "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), "width" to size.first, "height" to size.second)
    }
}
