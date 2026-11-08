package io.github.r31l4nd.burrow

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.storage.StorageManager
import android.provider.Settings
import androidx.core.content.FileProvider

/**
 * "All files" (report 862305) on Android: off until the person switches it
 * on in Burrow, and then only while Android gives the app "All files access"
 * (MANAGE_EXTERNAL_STORAGE, Android 11 and later). Its volumes are the
 * phone's storage and any SD card, read and written as plain files
 * (FileDocuments). Switched off, or the permission taken back in Android's
 * settings, they are gone from the list at once.
 */
object AllFiles {
    /** Android has the permission at all (11 and later). */
    val available: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    fun granted(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

    fun status(prefs: Prefs) = BridgeProtocol.obj("available" to available, "granted" to granted(), "on" to prefs.allFiles)

    fun documents(context: Context): FileDocuments? =
        if (!available) null else FileDocuments { file -> FileProvider.getUriForFile(context, "${context.packageName}.files", file).toString() }

    /** The volumes, when switched on and allowed; mounted ones only. */
    fun volumes(context: Context, prefs: Prefs): List<PhonePaths.Root> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || !prefs.allFiles || !granted()) return emptyList()
        val sm = context.getSystemService(StorageManager::class.java) ?: return emptyList()
        return sm.storageVolumes
            .filter { it.state == Environment.MEDIA_MOUNTED }
            .mapNotNull { v -> v.directory?.let { FileDocuments.root(it, v.getDescription(context)) } }
    }

    /** Android's own screen where the person gives Burrow "All files access" (the app's settings before Android 11). */
    fun settingsIntent(context: Context): Intent =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}"))
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
}

/**
 * Android's "All files access" screen, registered when the activity is made
 * (like FolderPick): [ask] gives whether the app has it once the person comes back.
 */
class AllFilesAsk(activity: androidx.appcompat.app.AppCompatActivity) {
    private var pending: ((Boolean) -> Unit)? = null
    private val launcher = activity.registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()) {
        val done = pending ?: return@registerForActivityResult
        pending = null
        done(AllFiles.granted())
    }
    private val context = activity

    fun ask(done: (Boolean) -> Unit) {
        if (AllFiles.granted()) return done(true)
        pending?.invoke(AllFiles.granted())
        pending = done
        launcher.launch(AllFiles.settingsIntent(context))
    }
}
