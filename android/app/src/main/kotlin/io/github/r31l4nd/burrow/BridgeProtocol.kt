package io.github.r31l4nd.burrow

import org.json.JSONArray
import org.json.JSONObject

/**
 * The messages between Burrow's page (web/src/lib/android.ts) and the app:
 * requests { id, method, params }, answers { id, result } or { id, error },
 * and events { event, data }.
 */
object BridgeProtocol {
    data class Request(val id: Long, val method: String, val params: JSONObject)

    /**
     * A message the bridge takes: from the page's main frame, on exactly the
     * origin the bridge was made for (scheme, host and port). A frame inside
     * the page, or a page that navigated elsewhere, gets nothing, even where
     * WebView offered the listener (A3-AND-13: the check itself, tested).
     */
    fun fromPage(isMainFrame: Boolean, sourceOrigin: String, origin: String): Boolean =
        isMainFrame && Origins.of(sourceOrigin) != null && Origins.of(sourceOrigin) == Origins.of(origin)

    fun parse(text: String): Request? = try {
        val o = JSONObject(text)
        val id = o.getLong("id")
        val method = o.getString("method")
        if (!method.matches(Regex("[a-zA-Z]{1,40}"))) null else Request(id, method, o.optJSONObject("params") ?: JSONObject())
    } catch (e: Exception) {
        null
    }

    fun result(id: Long, result: Any?): String = JSONObject().put("id", id).put("result", result ?: JSONObject.NULL).toString()

    fun error(id: Long, message: String): String = JSONObject().put("id", id).put("error", message).toString()

    fun event(name: String, data: Any?): String = JSONObject().put("event", name).put("data", data ?: JSONObject.NULL).toString()

    fun obj(vararg pairs: Pair<String, Any?>): JSONObject = JSONObject().apply { for ((k, v) in pairs) put(k, v ?: JSONObject.NULL) }

    fun array(items: List<Any>): JSONArray = JSONArray().apply { items.forEach { put(it) } }
}

/**
 * What the bridge (Bridge.kt) takes from a request's params, checked here
 * before anything is done with it: plain Kotlin, for the JVM tests.
 */
object BridgeRules {
    /** An exported log, at most (characters). */
    const val MAX_SAVED_TEXT = 32 shl 20

    private val HOST = Regex("""[A-Za-z0-9.:\[\]-]{1,253}""")
    private val COLOR = Regex("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
    private val UI_PREFS = listOf("burrow.locale", "burrow.appearance", "burrow.terminal")

    /** The other hosts the app's WireGuard carries: host names and addresses only, trimmed; anything else is left out. */
    fun tunnelHosts(list: JSONArray): Set<String> =
        (0 until list.length()).map { list.getString(it).trim() }.filter { it.matches(HOST) }.toSet()

    /**
     * Where a WireGuard configuration sends the phone's traffic (its peers' Endpoint lines), for the
     * app's question; null when none. Read as the tunnel reads it (android/wg parseConfig: a comment
     * cut off, any space trimmed, the key in any case): a stricter reading left out a peer the tunnel
     * then used (audit 2026-11-09). An endpoint that says nothing shows as "?".
     */
    fun wgEndpoint(conf: String): String? =
        conf.lines().mapNotNull { raw ->
            val line = raw.substringBefore('#').trim()
            val eq = line.indexOf('=')
            if (eq < 0 || !line.substring(0, eq).trim().equals("endpoint", ignoreCase = true)) null
            else line.substring(eq + 1).trim().ifEmpty { "?" }
        }.distinct().joinToString(", ").ifEmpty { null }?.take(400)

    /** The status bar's colour from the page's own CSS: "#rrggbb" for "#rgb" or "#rrggbb", null for anything else. */
    fun topColor(top: String): String? {
        val hex = COLOR.matchEntire(top)?.groupValues?.get(1) ?: return null
        return "#" + if (hex.length == 3) hex.map { "$it$it" }.joinToString("") else hex
    }

    /** Only the three known settings, as plain strings of at most 2000 characters. */
    fun uiPrefs(values: JSONObject?): String {
        val v = values ?: JSONObject()
        val keep = JSONObject()
        for (k in UI_PREFS) if (v.has(k)) keep.put(k, v.getString(k).take(2000))
        return keep.toString()
    }

    /** An address on exactly this server (scheme, host and port), else refused. */
    fun sameOrigin(url: String, origin: String): String {
        require(Origins.same(url, origin)) { "not this server" }
        return url
    }

    /** An app tab's address: a web page, nothing else (no intent:, file:, javascript:). */
    fun appUrl(url: String): String {
        require(url.startsWith("https://") || url.startsWith("http://")) { "not a web address" }
        return url
    }

    /** The paths to hold: one more than allowed at most, so PhoneFolders.hold refuses too many instead of holding a part. */
    fun holdPaths(a: JSONArray): List<String> = (0 until minOf(a.length(), PhoneFolders.MAX_HOLD + 1)).map { a.getString(it) }

    /** Files to share: at least one (an empty list ended the app on its main thread, audit 2026-11-09). */
    fun sharePaths(a: JSONArray): List<String> = holdPaths(a).also { require(it.isNotEmpty()) { "nothing to share" } }

    /** Held to upload (the share page's list) or only to show. */
    fun holdKind(purpose: String): HeldFiles.Kind = if (purpose == "upload") HeldFiles.Kind.SHARED else HeldFiles.Kind.LOCAL

    /** The hosts for the launcher's shortcuts: id and name. */
    fun shortcutHosts(a: JSONArray): List<Pair<Long, String>> = (0 until a.length()).map { a.getJSONObject(it).let { h -> h.getLong("id") to h.getString("name") } }

    /** Text the page made, to save as a file: not beyond [MAX_SAVED_TEXT]. */
    fun savedText(text: String): String {
        require(text.length <= MAX_SAVED_TEXT) { "too large to save" }
        return text
    }

    /** The app's update as downloaded is the one Burrow named (its SHA-256, any case). */
    fun updateMatches(file: java.io.File, sha256: String): Boolean = Http.sha256(file) == sha256.lowercase()

    /** A downloaded update checked already: its sum kept beside it (a second tap hands it over again). */
    fun markChecked(apk: java.io.File, sha256: String) = java.io.File(apk.parentFile, apk.name + ".sha256").writeText(sha256.lowercase())

    /** The update downloaded and checked already, for this very release. */
    fun readyUpdate(apk: java.io.File, sha256: String): Boolean {
        val sum = java.io.File(apk.parentFile, apk.name + ".sha256")
        return apk.isFile && sum.isFile && runCatching { sum.readText() }.getOrNull() == sha256.lowercase()
    }
}
