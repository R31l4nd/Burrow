package io.github.r31l4nd.burrow

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Burrow's own push in the app, through UnifiedPush: a distributor on the
 * phone (the ntfy app, or another) keeps the connection and hands messages
 * here; Burrow encrypts each for this phone (Web Push), the connector
 * decrypts it. Where Burrow should send (the endpoint and this phone's keys)
 * is kept and given to the page, which tells Burrow.
 */
class BurrowPushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        // Burrow only sends encrypted: without keys there is nothing to use.
        val keys = endpoint.pubKeySet ?: return
        Prefs(this).pushEndpoint = Push.endpoint(endpoint.url, keys.pubKey, keys.auth)
        (application as BurrowApp).pushChanged?.invoke()
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val m = Push.message(message.decrypted, message.content) ?: return
        // The widget's numbers (2.11.0): kept and drawn, never a notification.
        m.optJSONObject("widget")?.let { return Widget.pushed(this, it) }
        Push.show(this, m)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Prefs(this).pushEndpoint = null
        (application as BurrowApp).pushChanged?.invoke()
    }

    override fun onUnregistered(instance: String) {
        Prefs(this).pushEndpoint = null
        (application as BurrowApp).pushChanged?.invoke()
    }
}

object Push {
    private const val CHANNEL = "alerts"

    /** Where Burrow's push reaches this phone, for the page to tell Burrow: the address and this phone's keys. */
    fun endpoint(url: String, p256dh: String, auth: String): String = JSONObject(mapOf("url" to url, "p256dh" to p256dh, "auth" to auth)).toString()

    /** A message's content: only what was encrypted for this phone, and only JSON. */
    fun message(decrypted: Boolean, content: ByteArray): JSONObject? =
        if (!decrypted) null else runCatching { JSONObject(String(content, Charsets.UTF_8)) }.getOrNull()

    /**
     * What a message shows: the page a tap opens (only a page of Burrow's,
     * else its start), a tag (the same subject again replaces the earlier
     * one), title and text, and whether it is urgent (priority 4 and 5).
     */
    class Notice(val page: String, val tag: String, val title: String, val body: String, val high: Boolean)

    fun notice(m: JSONObject): Notice = Notice(
        page = DeepLinks.pageForPath(m.optString("page", "/")) ?: "#/",
        tag = "${m.optString("topic")}:${m.optString("page")}",
        title = m.optString("title", "Burrow"),
        body = m.optString("body"),
        high = m.optInt("priority", 3) >= 4,
    )

    /** A notification as Burrow's own: its title and text; a tap opens the page it is about. */
    fun show(context: Context, m: JSONObject) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.alerts_channel), NotificationManager.IMPORTANCE_HIGH).apply {
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            },
        )
        val notice = notice(m)
        val open = Intent(Intent.ACTION_VIEW, Uri.parse("burrow://open?to=" + Uri.encode(notice.page.removePrefix("#"))))
            .setClass(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val tag = notice.tag
        val tap = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        // On the lock screen only that something came: host and container names and log lines
        // stay behind the phone's lock, whatever the phone shows by default (A3-AND-10).
        val public = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.getString(R.string.alert_public))
            .build()
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notice.body))
            .setPriority(if (notice.high) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        // The same subject again replaces the earlier one.
        nm.notify(tag, 1, n)
    }
}
