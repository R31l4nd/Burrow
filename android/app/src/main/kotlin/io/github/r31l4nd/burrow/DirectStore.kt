package io.github.r31l4nd.burrow

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * The direct route's offline data, encrypted on disk with a Keystore key:
 * what Burrow handed out (/api/android/cache: hosts, their host keys,
 * snippets, history), plus what the phone added itself (host keys trusted
 * here, commands run here). [dir] and [key]: the app's files and its
 * Keystore key, or a folder and a plain key in the JVM tests.
 */
class DirectStore(dir: File, private val key: () -> SecretKey) {
    constructor(context: Context) : this(context.filesDir, ::keystoreKey)

    private val cacheFile = File(dir, "direct-cache.bin")
    private val localFile = File(dir, "direct-local.bin")

    private fun read(f: File): JSONObject? = try {
        if (f.exists()) JSONObject(String(Sealed.open(key(), f.readBytes()), Charsets.UTF_8)) else null
    } catch (e: Exception) {
        null
    }

    // Under FENCE's lock (every DirectStore of the app shares it).
    private fun write(f: File, o: JSONObject) {
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeBytes(Sealed.seal(key(), o.toString().toByteArray(Charsets.UTF_8)))
        // Not put in place: said, not the old file kept without a word (A3-AND-21).
        if (!tmp.renameTo(f)) {
            tmp.delete()
            throw java.io.IOException("could not save ${f.name}")
        }
    }

    fun cache(): JSONObject? = read(cacheFile)

    fun local(): JSONObject = read(localFile) ?: JSONObject()

    /** Host key blobs (base64) trusted on the phone for a host. */
    fun trustedHere(hostId: Long): List<String> {
        val a = local().optJSONObject("trusted")?.optJSONArray(hostId.toString()) ?: return emptyList()
        return (0 until a.length()).map { a.getString(it) }
    }

    fun trustHere(hostId: Long, keyB64: String) = FENCE.locked {
        val l = local()
        val t = l.optJSONObject("trusted") ?: JSONObject()
        val a = t.optJSONArray(hostId.toString()) ?: JSONArray()
        a.put(keyB64)
        t.put(hostId.toString(), a)
        write(localFile, l.put("trusted", t))
    }

    /** Commands typed in direct sessions, newest first, for suggestions. */
    fun recorded(hostId: Long): List<String> {
        val a = local().optJSONObject("history")?.optJSONArray(hostId.toString()) ?: return emptyList()
        return (0 until a.length()).map { a.getString(it) }
    }

    fun record(hostId: Long, command: String) = FENCE.locked {
        if (command.isBlank() || command.length > 2000) return@locked
        val l = local()
        val h = l.optJSONObject("history") ?: JSONObject()
        val old = recorded(hostId).filter { it != command }
        h.put(hostId.toString(), JSONArray((listOf(command) + old).take(300)))
        write(localFile, l.put("history", h))
    }

    /**
     * Fetch the cache from Burrow with the app's session cookie; false when
     * Burrow is away. Through the app's WireGuard when it carries Burrow
     * (`proxy`): away from home it failed while the page itself worked.
     */
    fun sync(origin: String, cookie: String?, proxy: java.net.Proxy? = null): Boolean {
        if (cookie.isNullOrEmpty()) return false
        // Cleared (forgotten, another server) while this was on its way: not kept (AUDIT2 AND-06).
        val at = FENCE.begin()
        val url = URL("$origin/api/android/cache")
        val c = (if (proxy != null) url.openConnection(proxy) else url.openConnection()) as HttpURLConnection
        c.connectTimeout = 10_000
        c.readTimeout = 20_000
        // Not followed: a redirect would take the session cookie along (AUDIT2 AND-02).
        c.instanceFollowRedirects = false
        c.setRequestProperty("Cookie", cookie)
        return try {
            if (c.responseCode != 200) return false
            val body = JSONObject(String(c.inputStream.use { it.readBytes() }, Charsets.UTF_8))
            FENCE.commit(at) { write(cacheFile, body) }
        } catch (e: Exception) {
            false
        } finally {
            c.disconnect()
        }
    }

    /** Unpaired or another server: nothing of the old one stays. */
    fun clear() = FENCE.reset {
        cacheFile.delete()
        localFile.delete()
    }

    companion object {
        private const val ALIAS = "burrow-cache"
        private val FENCE = Fence()

        private fun keystoreKey(): SecretKey {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
            val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            gen.init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            return gen.generateKey()
        }
    }
}
