package io.github.r31l4nd.burrow

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * The phone's own files as the page names them (PhoneFolders.kt): "/" is
 * the list of folders the person granted, "/<folder id>/a/b.txt" a file in
 * one of them. A path is only ever a folder's id and names: each name is
 * looked up among the children of the folder before it, so no name can
 * lead outside the granted folder (there is no "..", no absolute path, no
 * document id from the page). Pure, for the JVM tests.
 */
object PhonePaths {
    /** A granted folder: its id on the page, the tree URI Android gave, its name, and whether it may be written. */
    data class Root(val id: String, val uri: String, val name: String, val writable: Boolean)

    /** A path taken apart: the folder's id (null for the list of folders) and the names inside it. */
    data class Parsed(val rootId: String?, val names: List<String>)

    /** The editor opens files up to 5 MB, as on a host (server/src/files/service.ts). */
    const val MAX_TEXT = 5 * 1024 * 1024

    /** A folder lists at most this many entries (and says it left the rest out). */
    const val MAX_ENTRIES = 5000

    const val MAX_PATH = 4096
    const val MAX_NAME = 255
    const val MAX_DEPTH = 64

    /** Granted folders, at most: each holds one of Android's persisted permissions (128 per app). */
    const val MAX_ROOTS = 32

    private val ROOT_ID = Regex("[0-9a-f]{16}")

    /** The path taken apart, or null when it is not one the page may give. */
    fun parse(path: String?): Parsed? {
        if (path == null || path.length > MAX_PATH || !path.startsWith("/")) return null
        val body = path.removePrefix("/").removeSuffix("/")
        if (body.isEmpty()) return Parsed(null, emptyList())
        val parts = body.split('/')
        if (parts.size > MAX_DEPTH + 1) return null
        val root = parts[0]
        if (!ROOT_ID.matches(root)) return null
        val names = parts.drop(1)
        if (names.any { !nameOk(it) }) return null
        return Parsed(root, names)
    }

    /** One name in a folder: not empty, not "." or "..", no NUL, not too long ("/" cannot be in one, split above). */
    fun nameOk(name: String): Boolean =
        name.isNotEmpty() && name != "." && name != ".." && name.length <= MAX_NAME && name.none { it == '\u0000' || it == '/' }

    fun join(rootId: String, names: List<String>): String = "/" + (listOf(rootId) + names).joinToString("/")

    /** The folder above, or null at a granted folder's top (its parent is the list of folders, "/"). */
    fun parent(p: Parsed): String? = when {
        p.rootId == null -> null
        p.names.isEmpty() -> "/"
        else -> join(p.rootId, p.names.dropLast(1))
    }

    /**
     * A folder Android handed back from its picker (ACTION_OPEN_DOCUMENT_TREE):
     * a content:// tree of another app's provider. This app's own providers
     * (its FileProvider) never: they would show the app's private files.
     */
    fun acceptsTree(scheme: String?, authority: String?, path: String?, own: String): Boolean {
        if (!scheme.equals("content", ignoreCase = true)) return false
        val a = authority?.substringAfter('@')?.lowercase()
        if (a.isNullOrEmpty() || a == own || a.startsWith("$own.")) return false
        return path != null && path.startsWith("/tree/")
    }

    /** Looks like a binary file: a NUL in its first 8 KiB (as on a host). */
    fun isBinary(bytes: ByteArray): Boolean {
        val n = minOf(bytes.size, 8192)
        for (i in 0 until n) if (bytes[i] == 0.toByte()) return true
        return false
    }

    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    fun newRootId(random: SecureRandom = SecureRandom()): String {
        val b = ByteArray(8)
        random.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }

    /** The folders kept in the app's preferences; anything unreadable is left out. */
    fun decodeRoots(json: String?): List<Root> = runCatching {
        val a = JSONArray(json ?: "[]")
        (0 until a.length()).mapNotNull { i ->
            val o = a.optJSONObject(i) ?: return@mapNotNull null
            val id = o.optString("id")
            val uri = o.optString("uri")
            if (!ROOT_ID.matches(id) || !uri.startsWith("content://")) null else Root(id, uri, o.optString("name").ifEmpty { "?" }, o.optBoolean("writable"))
        }.distinctBy { it.id }
    }.getOrDefault(emptyList())

    fun encodeRoots(roots: List<Root>): String = JSONArray().apply {
        for (r in roots) put(JSONObject().put("id", r.id).put("uri", r.uri).put("name", r.name).put("writable", r.writable))
    }.toString()

    /** The document's last change as the page's time (ISO 8601, UTC), or null when the provider does not say. */
    fun isoTime(millis: Long): String? =
        if (millis <= 0) null else java.time.Instant.ofEpochMilli(millis).toString()
}
