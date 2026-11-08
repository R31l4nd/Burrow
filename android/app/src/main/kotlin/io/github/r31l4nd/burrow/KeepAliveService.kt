package io.github.r31l4nd.burrow

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * A direct-route session through the app's WireGuard, kept open on purpose
 * while the app is out of sight (the tunnel goes down after a minute
 * otherwise, for the battery). A notification says so and can stop it.
 */
class KeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            KeepAlive.clear(this)
            return START_NOT_STICKY
        }
        // Started with startForegroundService: in the foreground first, always (stopped
        // before that, Android ends the whole app); then gone again if no longer wanted.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(this), type)
        if (!KeepAlive.started()) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun notification(context: Context): Notification {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.keepalive_channel), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(context, 0, Intent(context, DirectActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(context, 1, Intent(context, KeepAliveService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_burrow)
            .setContentTitle(context.getString(R.string.keepalive_title))
            .setContentText(context.getString(R.string.keepalive_text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, context.getString(R.string.keepalive_stop), stop)
            .build()
    }

    companion object {
        private const val CHANNEL = "keepalive"
        private const val NOTIFICATION_ID = 2
        const val ACTION_STOP = "io.github.r31l4nd.burrow.KEEPALIVE_STOP"
    }
}

/** Which direct sessions are to stay open in the background. */
object KeepAlive {
    private val sessions = HashSet<String>()
    // Asked to start, not yet in the foreground: not stopped from outside then (TransferService does the same).
    private var pending = false

    /** The service is in the foreground now; whether it is still wanted. */
    @Synchronized
    fun started(): Boolean {
        pending = false
        return sessions.isNotEmpty()
    }

    /** Stop tapped in the notification: the sessions may close with the tunnel again. */
    var onCleared: (() -> Unit)? = null

    @Synchronized
    fun wanted(): Boolean = sessions.isNotEmpty()

    @Synchronized
    fun has(id: String): Boolean = id in sessions

    @Synchronized
    fun set(context: Context, id: String, on: Boolean) {
        val before = sessions.isNotEmpty()
        if (on) sessions.add(id) else sessions.remove(id)
        update(context, before)
    }

    fun clear(context: Context) {
        val before: Boolean
        synchronized(this) {
            before = sessions.isNotEmpty()
            sessions.clear()
        }
        update(context, before)
        onCleared?.invoke()
    }

    private fun update(context: Context, before: Boolean) {
        val app = context.applicationContext
        val now = wanted()
        if (now && !before) {
            runCatching { ContextCompat.startForegroundService(app, Intent(app, KeepAliveService::class.java)) }.onSuccess { synchronized(this) { pending = true } }
        } else if (!now && before) {
            if (!synchronized(this) { pending }) app.stopService(Intent(app, KeepAliveService::class.java))
            // Out of sight already: the minute starts now.
            (app as? BurrowApp)?.hiddenNow()
        }
    }
}
