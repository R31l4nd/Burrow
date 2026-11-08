package io.github.r31l4nd.burrow

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the app alive while transfers run: uploads in the page and the
 * app's own downloads. Only a notification; the work happens where it was.
 * Started when the first transfer begins (the app is on screen then), stopped
 * when the last one ends.
 */
class TransferService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Started with startForegroundService: in the foreground first, always.
        // A transfer that ended meanwhile is no reason to skip it: stopped
        // before this, Android ended the whole app (DeviceTest t5b, a download
        // stopped right after it began).
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(this, total(), label), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        synchronized(Companion) {
            pending = false
            foreground = true
            if (total() == 0) stopNow()
        }
        return START_NOT_STICKY
    }

    private fun stopNow() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        synchronized(Companion) { foreground = false }
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        // Android 15 caps dataSync services; stop cleanly instead of crashing.
        stopSelf()
    }

    companion object {
        private const val CHANNEL = "transfers"
        private const val NOTIFICATION_ID = 1
        private val counts = HashMap<String, Int>()
        private var label = ""
        // Asked to start and not yet in the foreground; and in it.
        private var pending = false
        private var foreground = false

        @Synchronized
        private fun total() = counts.values.sum()

        /** Something is being uploaded or downloaded now. */
        fun busy(): Boolean = total() > 0

        /** [source]: "web" (the page's queue) or "native" (the app's downloads). */
        @Synchronized
        fun set(context: Context, source: String, count: Int, text: String) {
            val before = total()
            counts[source] = count.coerceAtLeast(0)
            if (text.isNotEmpty()) label = text
            val after = total()
            val app = context.applicationContext
            if (after > 0) {
                try {
                    ContextCompat.startForegroundService(app, Intent(app, TransferService::class.java))
                    if (!foreground) pending = true
                } catch (e: Exception) {
                    // Not allowed from the background (Android 12+): the
                    // transfer still runs, just without the keep-alive.
                }
            } else if (before > 0 && !pending) {
                // Still on its way into the foreground: it stops itself there.
                app.stopService(Intent(app, TransferService::class.java))
            }
        }

        @Synchronized
        fun add(context: Context, source: String, delta: Int, text: String) = set(context, source, (counts[source] ?: 0) + delta, text)

        private fun notification(context: Context, n: Int, text: String): Notification {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.transfers_channel), NotificationManager.IMPORTANCE_LOW))
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                PendingIntent.FLAG_IMMUTABLE,
            )
            // On the lock screen: how many, not which files.
            val public = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle(context.resources.getQuantityString(R.plurals.transfers_running, n, n)).build()
            val b = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle(context.resources.getQuantityString(R.plurals.transfers_running, n, n))
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(public)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(open)
            // The app's own downloads: how far, how long still, and Stop.
            val downloads = Downloads.running()
            if (downloads.isNotEmpty()) {
                b.setSmallIcon(android.R.drawable.stat_sys_download)
                if (n == downloads.size) b.setContentTitle(if (downloads.size == 1) downloads[0].name else context.resources.getQuantityString(R.plurals.downloads_running, downloads.size, downloads.size))
                b.setContentText(AndroidDownloads.progressText(context, downloads))
                val pct = Downloads.percent(downloads)
                b.setProgress(100, pct ?: 0, pct == null)
                AndroidDownloads.stopAction(context, downloads)?.let { b.addAction(it) }
            }
            return b.build()
        }

        /** The notification again with the latest progress (while it is up). */
        fun refresh(context: Context) {
            val n = total()
            if (n == 0) return
            val app = context.applicationContext
            runCatching { app.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(app, n, label)) }
        }
    }
}
