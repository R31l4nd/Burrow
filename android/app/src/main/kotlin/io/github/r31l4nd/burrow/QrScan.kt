package io.github.r31l4nd.burrow

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * A QR code read with the camera (ZXing, no Google services): the WireGuard
 * configuration a server such as wg-easy shows. Registered when the
 * activity is made; [scan] gives the text, or null when the person went back.
 * Android asks for the camera the first time.
 */
class QrScan(private val activity: AppCompatActivity) {
    private var pending: ((String?) -> Unit)? = null
    private val launcher = activity.registerForActivityResult(ScanContract()) { r ->
        val done = pending ?: return@registerForActivityResult
        pending = null
        done(r.contents)
    }

    fun scan(done: (String?) -> Unit) {
        // A second scan asked while one is open: the first one is over.
        pending?.invoke(null)
        pending = done
        launcher.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(activity.getString(R.string.wg_scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false)
                .setCaptureActivity(SecureCapture::class.java),
        )
    }
}

/** ZXing's scanner, kept out of screenshots and the recent apps like the rest of the app: the code holds a private key. */
class SecureCapture : CaptureActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Insets.secure(window)
    }
}
