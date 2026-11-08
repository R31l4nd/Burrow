package io.github.r31l4nd.burrow

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import android.view.View
import android.webkit.CookieManager
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject
import java.util.Date

/** One host on the widget's lines (2.13.0): its name, up, down or not known yet, and its package updates. */
data class WidgetHost(val id: Long, val name: String, val state: String, val updates: Int, val security: Int) {
    fun json(): JSONObject = JSONObject(mapOf("id" to id, "name" to name, "state" to state, "updates" to updates, "security" to security))

    companion object {
        fun from(o: JSONObject): WidgetHost = WidgetHost(o.getLong("id"), o.getString("name"), o.getString("state"), o.optInt("updates"), o.optInt("security"))

        /** The list in a Burrow answer or the app's own copy; none from a Burrow before 2.13.0. */
        fun list(o: JSONObject): List<WidgetHost> = o.optJSONArray("list")?.let { a -> (0 until a.length()).map { from(a.getJSONObject(it)) } } ?: emptyList()
    }
}

/**
 * What the home screen widget shows (2.11.0), as Burrow sends it (GET
 * /api/widget, or a push): counts, and each host on a line (2.13.0, report
 * 05a818: the counts alone said too little). Home screen only, not the lock
 * screen (widget_info.xml).
 */
data class WidgetNumbers(val at: Long, val total: Int, val up: Int, val down: Int, val alerts: Int, val updateHosts: Int, val security: Int, val hosts: List<WidgetHost> = emptyList()) {
    fun json(): String =
        JSONObject(mapOf("at" to at, "total" to total, "up" to up, "down" to down, "alerts" to alerts, "updateHosts" to updateHosts, "security" to security))
            .put("list", JSONArray(hosts.map { it.json() }))
            .toString()

    companion object {
        /** Burrow's answer ({at, hosts, alerts, updates, list}); null when it is not one. */
        fun fromBurrow(o: JSONObject): WidgetNumbers? = runCatching {
            val hosts = o.getJSONObject("hosts")
            val updates = o.getJSONObject("updates")
            WidgetNumbers(
                at = java.time.Instant.parse(o.getString("at")).toEpochMilli(),
                total = hosts.getInt("total"),
                up = hosts.getInt("up"),
                down = hosts.getInt("down"),
                alerts = o.getInt("alerts"),
                updateHosts = updates.getInt("hosts"),
                security = updates.getInt("security"),
                hosts = WidgetHost.list(o),
            )
        }.getOrNull()

        /** As kept by the app (json()). */
        fun stored(s: String?): WidgetNumbers? = s?.let {
            runCatching {
                val o = JSONObject(it)
                WidgetNumbers(o.getLong("at"), o.getInt("total"), o.getInt("up"), o.getInt("down"), o.getInt("alerts"), o.getInt("updateHosts"), o.getInt("security"), WidgetHost.list(o))
            }.getOrNull()
        }
    }
}

/** A line of the widget's list: a host, or how many more there are than fit. */
data class WidgetLine(val host: WidgetHost?, val more: Int = 0)

/** The hosts on `room` lines; where they do not all fit, the last line counts the rest. */
fun widgetLines(hosts: List<WidgetHost>, room: Int): List<WidgetLine> = when {
    room <= 0 -> emptyList()
    hosts.size <= room -> hosts.map { WidgetLine(it) }
    else -> hosts.take(room - 1).map { WidgetLine(it) } + WidgetLine(null, hosts.size - (room - 1))
}

/** How old numbers may be before the widget says they are the last known (an hour: two missed half-hour updates). */
const val WIDGET_FRESH_MS = 60 * 60_000L

/** Whether the widget says "last known": numbers older than WIDGET_FRESH_MS, or the last ask failed. */
fun widgetStale(n: WidgetNumbers, now: Long, lastAskFailed: Boolean): Boolean = lastAskFailed || now - n.at > WIDGET_FRESH_MS

class BurrowWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        // What it knew at once; asked again on another thread (the network is not on the main thread).
        Widget.render(context, failed = false)
        val pending = goAsync()
        Thread {
            try {
                Widget.refresh(context)
            } finally {
                pending.finish()
            }
        }.start()
    }

    // Made taller or shorter: as many host lines as it now holds.
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: android.os.Bundle) = Widget.render(context, failed = false)
}

object Widget {
    private const val TUNNEL_USER = "widget"

    /** Asks Burrow: at home straight, away through the tunnel for a moment when that is the choice, else the last numbers stay. */
    fun refresh(context: Context) {
        val prefs = Prefs(context)
        val origin = prefs.origin ?: return render(context, failed = false)
        val cookie = runCatching { CookieManager.getInstance().getCookie(origin) }.getOrNull()
        val ok = if (WireGuard.reachable(origin)) ask(context, origin, cookie, null)
        else if (prefs.widgetAway == "tunnel") throughTunnel(context, origin, cookie)
        else null
        render(context, failed = ok == false)
    }

    private fun throughTunnel(context: Context, origin: String, cookie: String?): Boolean? {
        val wg = (context.applicationContext as BurrowApp).wireguard
        if (!wg.configured) return null
        wg.use(TUNNEL_USER)
        val was = wg.active
        try {
            if (!wg.active && !wg.start()) return false
            return ask(context, origin, cookie, wg.proxyFor(Uri.parse(origin).host, origin))
        } finally {
            wg.done(TUNNEL_USER)
            // Up only for this: down again, unless the app or a session uses it meanwhile.
            if (!was && !wg.inSight() && !KeepAlive.wanted() && !TransferService.busy()) wg.stopSoon()
        }
    }

    /**
     * GET /api/widget with the app's cookie; its sign-in run out (seven days
     * unused), the widget's own key instead. True when read, false when not
     * (a sign-in wanted is kept).
     */
    private fun ask(context: Context, origin: String, cookie: String?, proxy: java.net.Proxy?): Boolean =
        askWith(context, origin, proxy, "/api/widget") { if (cookie != null) it.setRequestProperty("Cookie", cookie) }.let { read ->
            if (read != false || !Prefs(context).widgetSignIn) return read == true
            val id = Prefs(context).deviceId ?: return false
            val header = runCatching { WidgetKey.header(origin, id, System.currentTimeMillis()) }.getOrNull() ?: return false
            askWith(context, origin, proxy, "/api/widget/device") { it.setRequestProperty("X-Burrow-Widget", header) } == true
        }

    private fun askWith(context: Context, origin: String, proxy: java.net.Proxy?, path: String, sign: (java.net.HttpURLConnection) -> Unit): Boolean? {
        val prefs = Prefs(context)
        return runCatching {
            val c = Hops.open("$origin$path", proxy) { c, _ ->
                c.connectTimeout = 10_000
                c.readTimeout = 15_000
                c.setRequestProperty("Accept", "application/json")
                sign(c)
            }
            try {
                when (c.responseCode) {
                    200 -> {
                        val n = WidgetNumbers.fromBurrow(JSONObject(c.inputStream.bufferedReader().readText())) ?: error("not Burrow's numbers")
                        prefs.widgetLast = n.json()
                        prefs.widgetSignIn = false
                        true
                    }
                    401 -> {
                        prefs.widgetSignIn = true
                        false
                    }
                    else -> null
                }
            } finally {
                c.disconnect()
            }
        }.getOrNull()
    }

    /** Numbers pushed by Burrow (Push.kt): kept and shown. */
    fun pushed(context: Context, o: JSONObject) {
        val n = WidgetNumbers.fromBurrow(o) ?: return
        Prefs(context).widgetLast = n.json()
        Prefs(context).widgetSignIn = false
        render(context, failed = false)
    }

    /** Draws every widget of the app from what it knows, each as many host lines as its height holds. */
    fun render(context: Context, failed: Boolean) {
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(ComponentName(context, BurrowWidget::class.java))
        for (id in ids) {
            // Its height on the home screen (the smaller of portrait and landscape), in dp.
            val height = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 80)
            manager.updateAppWidget(id, views(context, failed, height))
        }
    }

    private fun views(context: Context, failed: Boolean, height: Int): RemoteViews {
        val prefs = Prefs(context)
        val n = WidgetNumbers.stored(prefs.widgetLast)
        val v = RemoteViews(context.packageName, R.layout.widget)
        val r = context.resources
        v.removeAllViews(R.id.widget_list)
        if (n == null) {
            v.setTextViewText(R.id.widget_hosts, context.getString(if (prefs.widgetSignIn) R.string.widget_sign_in else R.string.widget_never))
            v.setViewVisibility(R.id.widget_hosts, View.VISIBLE)
            v.setTextViewText(R.id.widget_more, "")
            v.setTextViewText(R.id.widget_when, "")
        } else {
            // Each host on a line (a Burrow before 2.13.0 sends none: then the count as before). The
            // header, the line under the list and the padding take about 70 dp; a line 24.
            val lines = widgetLines(n.hosts, (height - 70) / 24)
            if (lines.isEmpty()) {
                v.setTextViewText(R.id.widget_hosts, r.getQuantityString(R.plurals.widget_hosts, n.total, n.up, n.total) + if (n.down > 0) " | " + r.getQuantityString(R.plurals.widget_down, n.down, n.down) else "")
                v.setTextColor(R.id.widget_hosts, context.getColor(if (n.down > 0) R.color.widget_bad else R.color.widget_text))
                v.setViewVisibility(R.id.widget_hosts, View.VISIBLE)
            } else {
                v.setViewVisibility(R.id.widget_hosts, View.GONE)
                for ((i, line) in lines.withIndex()) v.addView(R.id.widget_list, row(context, line, i))
            }
            val more = listOf(
                r.getQuantityString(R.plurals.widget_alerts, n.alerts, n.alerts),
                if (n.updateHosts > 0) r.getQuantityString(R.plurals.widget_updates, n.updateHosts, n.updateHosts) + if (n.security > 0) " (" + r.getQuantityString(R.plurals.widget_security, n.security, n.security) + ")" else "" else null,
            ).filterNotNull().joinToString(" | ")
            v.setTextViewText(R.id.widget_more, more)
            val time = DateFormat.getTimeFormat(context).format(Date(n.at))
            v.setTextViewText(
                R.id.widget_when,
                when {
                    prefs.widgetSignIn -> context.getString(R.string.widget_sign_in)
                    widgetStale(n, System.currentTimeMillis(), failed) -> context.getString(R.string.widget_last, time)
                    else -> time
                },
            )
        }
        // A tap opens Burrow; a host's line opens that host.
        v.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        return v
    }

    private fun row(context: Context, line: WidgetLine, i: Int): RemoteViews {
        val v = RemoteViews(context.packageName, R.layout.widget_host)
        val h = line.host
        if (h == null) {
            v.setViewVisibility(R.id.widget_host_dot, View.INVISIBLE)
            v.setTextViewText(R.id.widget_host_name, context.resources.getQuantityString(R.plurals.widget_more_hosts, line.more, line.more))
            v.setTextColor(R.id.widget_host_name, context.getColor(R.color.widget_dim))
            v.setTextViewText(R.id.widget_host_state, "")
            return v
        }
        val colour = context.getColor(
            when (h.state) {
                "down" -> R.color.widget_bad
                "up" -> R.color.widget_ok
                else -> R.color.widget_dim
            },
        )
        v.setInt(R.id.widget_host_dot, "setColorFilter", colour)
        v.setTextViewText(R.id.widget_host_name, h.name)
        // At the right: down said in red, else its updates, else up.
        val state = when {
            h.state == "down" -> context.getString(R.string.widget_state_down)
            h.state == "unknown" -> context.getString(R.string.widget_state_unknown)
            h.updates > 0 -> context.resources.getQuantityString(R.plurals.widget_host_updates, h.updates, h.updates)
            else -> context.getString(R.string.widget_state_up)
        }
        v.setTextViewText(R.id.widget_host_state, state)
        v.setTextColor(R.id.widget_host_state, context.getColor(if (h.state == "down" || h.security > 0) R.color.widget_bad else R.color.widget_dim))
        v.setContentDescription(R.id.widget_host_row, context.getString(R.string.widget_open_host, h.name) + ", " + state)
        // Its own page in Burrow (the host's statistics, its packages among them), through the app's deep link.
        val open = Intent(Intent.ACTION_VIEW, Uri.parse("burrow://open?to=" + Uri.encode("/hosts/${h.id}/stats")), context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        v.setOnClickPendingIntent(R.id.widget_host_row, PendingIntent.getActivity(context, 1000 + i, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        return v
    }

    /** Whether the person put the widget on a home screen. */
    fun placed(context: Context): Boolean = AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, BurrowWidget::class.java)).isNotEmpty()

    /** Asks for an update now (the app came to the front, a setting changed). */
    fun poke(context: Context) {
        val ids = AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, BurrowWidget::class.java))
        if (ids.isEmpty()) return
        context.sendBroadcast(Intent(context, BurrowWidget::class.java).setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE).putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids))
    }
}
