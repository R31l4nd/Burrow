package io.github.r31l4nd.burrow

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.text.format.Formatter
import androidx.core.app.NotificationCompat
import java.io.OutputStream

/**
 * The app's own downloads on Android (Downloads.kt holds what they do):
 * the bytes into the app's files, Downloads/Burrow (MediaStore) or a folder
 * the person granted, the keep-alive, and the notifications with their
 * Stop and Retry. Reached by the device test, not the JVM tests.
 */
object AndroidDownloads {
    /**
     * Files this app left half written in Downloads (IS_PENDING) when its process went: removed at
     * start, so no stale partial download stays behind out of sight (AUDIT2 AND-18).
     */
    fun dropStalePending(context: Context) {
        // Matching pending items by query needs API 30; on 29 they stay as before.
        if (Downloads.list().isNotEmpty() || android.os.Build.VERSION.SDK_INT < 30) return
        runCatching {
            val resolver = context.contentResolver
            val query = android.os.Bundle().apply { putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_ONLY) }
            resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Downloads._ID), query, null)?.use { c ->
                while (c.moveToNext()) {
                    val uri = android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0))
                    runCatching { resolver.delete(uri, null, null) }
                }
            }
        }
    }

    /** "12 MB of 120 MB, 1 min left" for what runs now. */
    fun progressText(context: Context, list: List<Downloads.Item>): String {
        val p = Downloads.progress(list)
        val size = if (p.total > 0) context.getString(R.string.download_of, Formatter.formatShortFileSize(context, p.done), Formatter.formatShortFileSize(context, p.total)) else Formatter.formatShortFileSize(context, p.done)
        val left = p.secondsLeft ?: return size
        val eta = if (left < 60) context.getString(R.string.download_seconds_left, left) else context.getString(R.string.download_minutes_left, p.minutesLeft)
        return "$size, $eta"
    }

    /** A Stop button for the notification of what runs now. */
    fun stopAction(context: Context, list: List<Downloads.Item>): NotificationCompat.Action? {
        if (list.isEmpty()) return null
        return NotificationCompat.Action(0, context.getString(R.string.download_stop), action(context, Downloads.STOP, if (list.size == 1) list[0].id else -1))
    }

    internal fun action(context: Context, what: String, id: Int): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            id * 2 + (if (what == Downloads.STOP) 0 else 1) + 1_000,
            Intent(context, Downloads.Actions::class.java).setAction(what).putExtra(Downloads.EXTRA_ID, id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    /** Android's side of a download: the keep-alive, notifications, MediaStore and the granted folders. */
    class Side(private val context: Context) : Downloads.Side {
        private val notifications get() = context.getSystemService(NotificationManager::class.java)

        override fun open(item: Downloads.Item, append: Boolean): OutputStream = when (val t = item.target) {
            is Downloads.Target.Private -> {
                t.file.parentFile?.mkdirs()
                java.io.FileOutputStream(t.file, append)
            }
            is Downloads.Target.Public -> {
                val resolver = context.contentResolver
                val uri = item.uri ?: resolver.insert(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, item.name)
                        put(MediaStore.Downloads.MIME_TYPE, Http.mimeOf(item.name))
                        put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Burrow")
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    },
                )?.also { item.uri = it } ?: error("MediaStore refused the file")
                resolver.openOutputStream(uri, if (append) "wa" else "wt") ?: error("cannot write")
            }
            is Downloads.Target.Document -> {
                val resolver = context.contentResolver
                val uri = item.uri ?: (
                    android.provider.DocumentsContract.createDocument(resolver, Uri.parse(t.folder), Http.mimeOf(item.name), item.name)
                        ?: error("the folder refused the file")
                    ).also { made ->
                    item.uri = made
                    // The provider may have named it otherwise ("notes (1).txt" beside a "notes.txt").
                    runCatching {
                        resolver.query(made, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0)?.let { item.name = it } }
                    }
                }
                (runCatching { resolver.openOutputStream(uri, if (append) "wa" else "wt") }.getOrNull() ?: resolver.openOutputStream(uri, if (append) "wa" else "w")) ?: error("cannot write")
            }
        }

        override fun completed(item: Downloads.Item) {
            if (item.target is Downloads.Target.Public) context.contentResolver.update(item.uri!!, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        }

        override fun dropPartial(item: Downloads.Item) {
            when (val t = item.target) {
                is Downloads.Target.Public -> item.uri?.let { runCatching { context.contentResolver.delete(it, null, null) } }
                is Downloads.Target.Private -> t.file.delete()
                is Downloads.Target.Document -> item.uri?.let { runCatching { android.provider.DocumentsContract.deleteDocument(context.contentResolver, it) } }
            }
        }

        override fun busy(delta: Int, name: String) = TransferService.add(context, "native", delta, name)

        override fun cancel(id: Int) = notifications.cancel(Downloads.NOTIFY_BASE + id)

        override fun refresh() = TransferService.refresh(context)

        override fun now(): Long = SystemClock.elapsedRealtime()

        override fun execute(work: () -> Unit) = WebSetup.io.execute(work)

    /** Done or failed: a notification of its own (Open, or Retry). */
        override fun finished(item: Downloads.Item) {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(Downloads.CHANNEL, context.getString(R.string.downloads_channel), NotificationManager.IMPORTANCE_LOW))
            // On the lock screen without the file's name (as Push does).
            val public = NotificationCompat.Builder(context, Downloads.CHANNEL).setSmallIcon(R.drawable.ic_stat_burrow).setContentTitle(context.getString(R.string.downloads_channel)).build()
            val b = NotificationCompat.Builder(context, Downloads.CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_burrow)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(public)
            if (item.state == Downloads.State.DONE) {
                b.setContentTitle(context.getString(R.string.download_saved_title, item.name))
                    .setContentText(((item.target as? Downloads.Target.Document)?.folderName ?: (item.target as? Downloads.Target.Private)?.folderName)?.let { context.getString(R.string.download_saved_in, it) } ?: context.getString(R.string.download_saved_where))
                item.uri?.let { uri ->
                    val open = Intent(Intent.ACTION_VIEW).setDataAndType(uri, Http.mimeOf(item.name)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    b.setContentIntent(PendingIntent.getActivity(context, Downloads.NOTIFY_BASE + item.id, Intent.createChooser(open, item.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE))
                }
            } else {
                b.setContentTitle(context.getString(R.string.download_failed, item.name))
                    .setContentText(item.error)
                    .addAction(0, context.getString(R.string.download_retry), action(context, Downloads.RETRY, item.id))
                    .addAction(0, context.getString(R.string.download_dismiss), action(context, Downloads.STOP, item.id))
            }
            runCatching { nm.notify(Downloads.NOTIFY_BASE + item.id, b.build()) }
        }
    }
}
