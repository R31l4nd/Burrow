package io.github.r31l4nd.burrow

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import java.io.File
import java.io.OutputStream
import java.net.HttpURLConnection
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch

/**
 * The app's own downloads (a page's download link, an app update): with
 * their progress in the notification, in Burrow's busy pill and in the app
 * tabs, Stop, and Retry that goes on where it broke off (a Range request)
 * when the server allows it. Files go to Downloads/Burrow (or a folder of
 * the phone the person picked, from the Files page), an update to the app's
 * own cache.
 *
 * What happens on the phone besides moving bytes (notifications, the
 * keep-alive, MediaStore and the granted folders) is a [Side]: Android's own
 * (AndroidDownloads.kt) in the app, a fake in the JVM tests.
 */
object Downloads {
    enum class State { RUNNING, DONE, FAILED, STOPPED }

    /** Where the bytes go: the public Downloads/Burrow folder, or a file of the app's own. */
    sealed class Target {
        object Public : Target()

        /** A file of the app's own, or ([folderName]) a new file in a folder of "All files" (PhoneFolders). */
        class Private(val file: File, val folderName: String? = null) : Target()

        /** A folder on the phone the person granted (PhoneFolders): a new file made in it ([folder]: its document URI). */
        class Document(val folder: String, val folderName: String) : Target()
    }

    /** What a download does on the phone besides moving bytes. */
    interface Side {
        /** Where the bytes go: the target's file, from the start or [append]ed. */
        fun open(item: Item, append: Boolean): OutputStream

        /** All bytes are there: the file may be shown (Downloads: no longer pending). */
        fun completed(item: Item)

        /** A half file goes. */
        fun dropPartial(item: Item)

        /** One transfer more ([delta] 1) or less (-1): the keep-alive and its notification. */
        fun busy(delta: Int, name: String)

        /** The item's own notification goes (by id: the item may be gone). */
        fun cancel(id: Int)

        /** Done or failed: its own notification (not for an update done: Android's installer comes then). */
        fun finished(item: Item)

        /** The progress notification with the latest numbers. */
        fun refresh()

        /** A clock that only goes forward (ms). */
        fun now(): Long

        /** [work] on another thread. */
        fun execute(work: () -> Unit)
    }

    class Item(
        val id: Int,
        val url: String,
        var name: String,
        val kind: String,
        val target: Target,
        /** Asked again at every attempt: the cookie and the tunnel may have changed. */
        val cookie: () -> String?,
        val proxy: () -> java.net.Proxy?,
        val userAgent: String?,
        /** Once it is done (also after a Retry from the notification). */
        val onDone: ((Item) -> Unit)?,
        /** An app tab's download may be sent on to another host (Hops.open); the way there. Null: Burrow's own, never. */
        val otherHost: ((java.net.URL) -> java.net.Proxy?)? = null,
    ) {
        @Volatile var done = 0L
        @Volatile var total = -1L
        @Volatile var state = State.RUNNING
        @Volatile var error: String? = null
        @Volatile var stop = false
        @Volatile var uri: Uri? = null
        @Volatile var rate = 0.0
        /** What identifies this version of the file (a strong ETag, or Last-Modified), for If-Range. */
        @Volatile var validator: String? = null
        internal var attempt = CountDownLatch(1)

        /** Seconds still to go, when that can be told. */
        fun secondsLeft(): Long? = if (total > 0 && rate > 1) ((total - done) / rate).toLong() else null

        /** Waits until the attempt under way ends. */
        fun await() = attempt.await()
    }

    internal const val CHANNEL = "downloads"
    internal const val NOTIFY_BASE = 2000
    internal const val STOP = "io.github.r31l4nd.burrow.download.STOP"
    internal const val RETRY = "io.github.r31l4nd.burrow.download.RETRY"
    internal const val EXTRA_ID = "id"

    private val items = CopyOnWriteArrayList<Item>()
    private var next = 1

    /** Called (on any thread) at every change worth showing, a few times a second at most. */
    val listeners = CopyOnWriteArrayList<() -> Unit>()

    fun list(): List<Item> = items.toList()

    fun running(): List<Item> = items.filter { it.state == State.RUNNING }

    fun find(id: Int): Item? = items.find { it.id == id }

    /** The list for the page: what Burrow's busy pill and Settings show. */
    /** The app update on its way, if one is: a second request waits for it instead of starting another into the same file (AUDIT2 AND-12). */
    fun runningUpdate(): Item? = items.firstOrNull { it.kind == "update" && it.state == State.RUNNING }

    fun json(): JSONArray = JSONArray().apply {
        for (i in items) {
            put(BridgeProtocol.obj("id" to i.id, "name" to i.name, "kind" to i.kind, "state" to i.state.name.lowercase(), "done" to i.done, "total" to i.total, "error" to i.error, "secondsLeft" to i.secondsLeft()))
        }
    }

    fun start(
        context: Context,
        url: String,
        name: String,
        kind: String,
        target: Target,
        cookie: () -> String?,
        proxy: () -> java.net.Proxy?,
        userAgent: String?,
        otherHost: ((java.net.URL) -> java.net.Proxy?)? = null,
        onDone: ((Item) -> Unit)? = null,
    ): Item = start(AndroidDownloads.Side(context.applicationContext), url, name, kind, target, cookie, proxy, userAgent, otherHost, onDone)

    @Synchronized
    fun start(
        side: Side,
        url: String,
        name: String,
        kind: String,
        target: Target,
        cookie: () -> String?,
        proxy: () -> java.net.Proxy?,
        userAgent: String?,
        otherHost: ((java.net.URL) -> java.net.Proxy?)? = null,
        onDone: ((Item) -> Unit)? = null,
    ): Item {
        // One app update at a time: an earlier one (failed or under way) goes.
        if (kind == "update") items.filter { it.kind == "update" && it.state != State.RUNNING }.forEach { forget(side, it) }
        // Done ones have said so in their own notification.
        items.removeAll { it.state == State.DONE }
        val item = Item(next++, url, FileNames.safe(name), kind, target, cookie, proxy, userAgent, onDone, otherHost)
        items.add(item)
        run(side, item)
        return item
    }

    fun stop(context: Context, id: Int) = stop(AndroidDownloads.Side(context.applicationContext), id)

    fun stop(side: Side, id: Int) {
        // Not known any more (the app was closed since): only its notification is left, and it goes.
        val item = find(id) ?: return side.cancel(id)
        item.stop = true
        // Failed (not running): stopping it means letting it go.
        if (item.state != State.RUNNING) forget(side, item)
    }

    fun retry(context: Context, id: Int) = retry(AndroidDownloads.Side(context.applicationContext), id)

    fun retry(side: Side, id: Int) {
        // A Retry from a notification of an app process that is gone: nothing to try again with
        // (its address and cookies were in memory); the notification goes instead of doing nothing (AUDIT2 AND-18).
        val item = find(id) ?: return side.cancel(id)
        if (item.state != State.FAILED) return
        run(side, item)
    }

    /** Gone from the list, and a half file with it. */
    private fun forget(side: Side, item: Item) {
        items.remove(item)
        if (item.state != State.DONE) {
            side.dropPartial(item)
            item.uri = null
            item.done = 0
        }
        side.cancel(item.id)
        changed(side, force = true)
    }

    private fun run(side: Side, item: Item) {
        item.state = State.RUNNING
        item.error = null
        item.stop = false
        item.rate = 0.0
        item.attempt = CountDownLatch(1)
        side.cancel(item.id)
        side.busy(1, item.name)
        changed(side, force = true)
        side.execute {
            try {
                fetch(side, item)
                item.state = State.DONE
            } catch (e: Exception) {
                item.state = if (item.stop) State.STOPPED else State.FAILED
                item.error = if (item.stop) null else (e.message ?: e.javaClass.simpleName)
            }
            side.busy(-1, "")
            when (item.state) {
                State.STOPPED -> forget(side, item)
                State.DONE -> runCatching { item.onDone?.invoke(item) }
                else -> {}
            }
            if (item.state != State.STOPPED) {
                // An update goes to Android's installer, which says enough itself.
                if (!(item.kind == "update" && item.state == State.DONE)) side.finished(item)
                changed(side, force = true)
            }
            item.attempt.countDown()
        }
    }

    private fun fetch(side: Side, item: Item) {
        val proxy = item.proxy()
        // Part of it there already (a Retry): ask for the rest, but only of the
        // same file (If-Range with what identified it): changed meanwhile, the
        // server sends it whole, and the part is not mixed with a new one.
        val have = item.done > 0 && (item.uri != null || item.target is Target.Private)
        val from = if (have && item.validator != null) item.done else 0L
        val c = Hops.open(item.url, proxy, item.otherHost) { c, same ->
            c.connectTimeout = 15_000
            c.readTimeout = 60_000
            // The cookie is the first host's: not past it (an app tab's download sent on to a CDN).
            if (same) item.cookie()?.let { c.setRequestProperty("Cookie", it) }
            item.userAgent?.let { c.setRequestProperty("User-Agent", it) }
            if (from > 0) {
                c.setRequestProperty("Range", "bytes=$from-")
                c.setRequestProperty("If-Range", item.validator)
            }
        }
        try {
            val code = c.responseCode
            if (code !in 200..299) error("HTTP $code")
            // The rest, from where it stopped: anything else starts over.
            val resumed = from > 0 && code == 206 && (c.getHeaderField("Content-Range") ?: "").startsWith("bytes $from-")
            if (code == 206 && !resumed) error("the server sent another part than asked")
            if (!resumed) item.validator = validatorOf(c)
            // The whole file again (the server ignores Range): from the start.
            if (!resumed) item.done = 0
            val length = c.contentLengthLong
            item.total = if (length >= 0) item.done + length else -1
            c.inputStream.use { input ->
                side.open(item, append = resumed).use { out ->
                    val buf = ByteArray(64 * 1024)
                    val t0 = side.now()
                    val d0 = item.done
                    while (true) {
                        if (item.stop) error("stopped")
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        item.done += n
                        val ms = side.now() - t0
                        if (ms > 500) item.rate = (item.done - d0) * 1000.0 / ms
                        changed(side)
                    }
                }
            }
            if (item.total > 0 && item.done < item.total) error("the download broke off")
            item.total = item.done
            side.completed(item)
        } finally {
            c.disconnect()
        }
    }

    /** A strong ETag (a weak one may not be used for a range), else Last-Modified; null without either. */
    @androidx.annotation.VisibleForTesting
    fun validatorOf(c: HttpURLConnection): String? {
        val etag = c.getHeaderField("ETag")
        if (etag != null && !etag.startsWith("W/")) return etag
        return c.getHeaderField("Last-Modified")
    }

    private var lastChange = 0L

    private fun changed(side: Side, force: Boolean = false) {
        val now = side.now()
        synchronized(this) {
            if (!force && now - lastChange < 400) return
            lastChange = now
        }
        side.refresh()
        listeners.forEach { runCatching { it() } }
    }

    /** How far what runs now is: bytes done, of how many (-1: not known), and the seconds still to go (null: not known). */
    class Progress(val done: Long, val total: Long, val secondsLeft: Long?) {
        /** Whole minutes still to go, rounded up. */
        val minutesLeft: Long? get() = secondsLeft?.let { (it + 59) / 60 }
    }

    fun progress(list: List<Item>): Progress = Progress(
        list.sumOf { it.done },
        if (list.all { it.total > 0 }) list.sumOf { it.total } else -1L,
        list.mapNotNull { it.secondsLeft() }.maxOrNull(),
    )

    /** Percent of what runs now, or null when a size is not known. */
    fun percent(list: List<Item>): Int? {
        if (list.isEmpty() || list.any { it.total <= 0 }) return null
        return (list.sumOf { it.done } * 100 / list.sumOf { it.total }).toInt().coerceIn(0, 100)
    }

    /** The notification's buttons. */
    class Actions : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val id = intent.getIntExtra(EXTRA_ID, 0)
            when (intent.action) {
                STOP -> if (id == -1) running().forEach { stop(context, it.id) } else stop(context, id)
                RETRY -> retry(context, id)
            }
        }
    }

    @androidx.annotation.VisibleForTesting
    fun clear(context: Context) = clear(AndroidDownloads.Side(context.applicationContext))

    @androidx.annotation.VisibleForTesting
    fun clear(side: Side) {
        items.toList().forEach { it.stop = true; if (it.state != State.RUNNING) forget(side, it) }
    }


}
