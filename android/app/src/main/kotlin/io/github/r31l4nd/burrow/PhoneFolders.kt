package io.github.r31l4nd.burrow

import android.provider.DocumentsContract.Document
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream

/**
 * The phone's own files for Burrow's Files page, through Android's Storage
 * Access Framework: only folders the person picked in Android's own folder
 * picker (ACTION_OPEN_DOCUMENT_TREE), each kept with a persisted permission
 * until it is removed here. No storage permission of the app's own.
 *
 * The page names a file by a folder id and names (PhonePaths); every name
 * is looked up among the children of the folder before it, through the
 * granted tree's own URIs, which Android checks again (a document outside
 * the tree is refused by the provider). Nothing here talks to Burrow's
 * server: what the page gets stays on the page, unless the person copies a
 * file to a host.
 *
 * The provider itself is [docs] (Android's in SafDocuments.kt, a fake in the
 * JVM tests); the granted folders are kept by [load] and [save] (Prefs).
 *
 * "All files" (report 862305), when the person switched it on and Android
 * gave the permission: the phone's storage volumes ([volumes]) beside them,
 * as plain files ([files], FileDocuments), named and looked up the same way.
 */
class PhoneFolders(
    private val docs: Documents,
    private val load: () -> String?,
    private val save: (String) -> Unit,
    private val files: FileDocuments? = null,
    private val volumes: () -> List<PhonePaths.Root> = { emptyList() },
) {
    constructor(context: android.content.Context) : this(context, Prefs(context))

    private constructor(context: android.content.Context, prefs: Prefs) : this(
        SafDocuments(context),
        { prefs.phoneRoots },
        { prefs.phoneRoots = it },
        AllFiles.documents(context),
        { AllFiles.volumes(context, prefs) },
    )

    /** A refusal the page shows in its own words, by its code (phone.error.<code>). */
    class PhoneError(val code: String) : Exception(code)

    /** A document as its provider describes it. */
    class Doc(val id: String, val name: String, val mime: String, val size: Long, val mtime: Long, val flags: Int) {
        val isDir get() = mime == Document.MIME_TYPE_DIR
        val writable get() = flags and Document.FLAG_SUPPORTS_WRITE != 0
        val canCreate get() = isDir && flags and Document.FLAG_DIR_SUPPORTS_CREATE != 0
        val canDelete get() = flags and Document.FLAG_SUPPORTS_DELETE != 0
        val canRename get() = flags and Document.FLAG_SUPPORTS_RENAME != 0
    }

    /**
     * The documents of the trees the person granted, by the tree's URI and a
     * document id. SecurityException (the permission went) and
     * FileNotFoundException pass through; PhoneFolders says them in the page's words.
     */
    interface Documents {
        /** A URI's scheme, authority and path, as Android reads it. */
        fun parts(uri: String): Triple<String?, String?, String?>

        /** The app's own package: its providers are never a folder to grant. */
        val ownPackage: String

        /** Keeps read and write permission for the tree (true), or read only when write is not granted (false); throws without even that. */
        fun take(tree: String): Boolean

        fun release(tree: String)

        /** Every tree with a persisted permission; [readable]: those that may be read. */
        fun persisted(): List<String>

        fun readable(): Set<String>

        /** The tree's top document's id. */
        fun topId(tree: String): String

        fun doc(tree: String, id: String): Doc?

        /** The first [limit] children of a folder; null when the provider lists nothing (no access). */
        fun children(tree: String, parent: String, limit: Int): List<Doc>?

        fun read(tree: String, id: String): InputStream?

        /** Written over from the start. */
        fun write(tree: String, id: String): OutputStream?

        fun opener(tree: String, id: String): HeldFiles.Opener

        /** The document's own URI, to hand to another app or make a file in. */
        fun uri(tree: String, id: String): String

        /** Gone; a folder with everything in it. Throws when the provider did not. */
        fun delete(tree: String, id: String)

        /** Named [name] in its own folder: the id it has then (a provider may give it another). */
        fun rename(tree: String, id: String, name: String): String

        /** A new folder [name] in [parent]: its id. */
        fun mkdir(tree: String, parent: String, name: String): String

        /** A new, empty file [name] in [parent] (an archive unpacked): its id. */
        fun create(tree: String, parent: String, name: String, mime: String): String
    }

    /** The folders granted through the picker (kept), then the volumes of "All files" when it is on. */
    fun roots(): List<PhonePaths.Root> = saved() + (if (files != null) volumes() else emptyList())

    private fun saved(): List<PhonePaths.Root> = PhonePaths.decodeRoots(load())

    private fun isVolume(r: PhonePaths.Root) = r.uri.startsWith(FileDocuments.SCHEME)

    private fun docsOf(r: PhonePaths.Root): Documents = if (isVolume(r)) files ?: throw PhoneError("no_access") else docs

    private fun keep(list: List<PhonePaths.Root>) {
        save(PhonePaths.encodeRoots(list))
    }

    /** The granted folders for the page, and whether Android still holds each one's permission (gone: pick it again). */
    fun rootsJson(): JSONArray {
        val held = docs.readable()
        return BridgeProtocol.array(roots().map { BridgeProtocol.obj("id" to it.id, "name" to it.name, "writable" to it.writable, "lost" to (!isVolume(it) && it.uri !in held), "all" to isVolume(it)) })
    }

    /** A folder the picker gave: its permission kept, and listed (once: the same folder again is the same one). */
    fun add(uri: String): PhonePaths.Root {
        val (scheme, authority, path) = docs.parts(uri)
        if (!PhonePaths.acceptsTree(scheme, authority, path, docs.ownPackage)) throw PhoneError("bad_folder")
        val writable = docs.take(uri)
        val list = saved()
        list.find { it.uri == uri }?.let { old ->
            val now = old.copy(writable = writable)
            keep(list.map { if (it.id == old.id) now else it })
            return now
        }
        if (list.size >= PhonePaths.MAX_ROOTS) {
            release(uri)
            throw PhoneError("too_many")
        }
        val top = guarded { docs.doc(uri, docs.topId(uri)) }
        val root = PhonePaths.Root(PhonePaths.newRootId(), uri, FileNames.safe(top?.name, "folder"), writable)
        keep(list + root)
        return root
    }

    /** Gone from the list, and its permission given back to Android (unless another entry is the same folder). */
    fun remove(id: String) {
        val list = saved()
        val r = list.find { it.id == id } ?: return
        keep(list - r)
        if (list.none { it.id != id && it.uri == r.uri }) release(r.uri)
    }

    /** All of them (another server chosen): the new one sees none of the folders granted for the old one. */
    fun clear() {
        for (r in saved()) remove(r.id)
        // Any permission left over (an entry lost from the list): given back too.
        for (t in docs.persisted()) release(t)
    }

    private fun release(tree: String) {
        runCatching { docs.release(tree) }
    }

    // ---- reading

    private fun parse(path: String?): PhonePaths.Parsed = PhonePaths.parse(path) ?: throw PhoneError("bad_path")

    private fun <T> guarded(f: () -> T): T = try {
        f()
    } catch (e: SecurityException) {
        // Android took the permission back (the folder was removed in its settings, the app was cleared).
        throw PhoneError("no_access")
    } catch (e: java.io.FileNotFoundException) {
        throw PhoneError("not_found")
    }

    private fun children(d: Documents, tree: String, parent: String, limit: Int): List<Doc> = guarded { d.children(tree, parent, limit) ?: throw PhoneError("no_access") }

    internal class Found(val root: PhonePaths.Root, val tree: String, val doc: Doc, val docs: Documents)

    private fun Found.uri(): String = docs.uri(tree, doc.id)

    /** The document a path names: the folder's top, then each name among the children of the one before. */
    private fun resolve(p: PhonePaths.Parsed): Found {
        val root = roots().find { it.id == p.rootId } ?: throw PhoneError("no_folder")
        val tree = root.uri
        val d = docsOf(root)
        var doc = guarded { d.doc(tree, d.topId(tree)) } ?: throw PhoneError("no_access")
        for (name in p.names) {
            if (!doc.isDir) throw PhoneError("not_found")
            doc = children(d, tree, doc.id, Int.MAX_VALUE).firstOrNull { it.name == name } ?: throw PhoneError("not_found")
        }
        return Found(root, tree, doc, d)
    }

    /** One folder: its entries (folders and files), at most MAX_ENTRIES. */
    fun list(path: String): JSONObject {
        val p = parse(path)
        if (p.rootId == null) throw PhoneError("bad_path")
        val f = resolve(p)
        if (!f.doc.isDir) throw PhoneError("not_a_folder")
        val all = children(f.docs, f.tree, f.doc.id, PhonePaths.MAX_ENTRIES + 1)
        val entries = JSONArray()
        // A name that could not be named again (a "/" in it, too long) is left out: it could not be opened.
        for (d in all.take(PhonePaths.MAX_ENTRIES).filter { PhonePaths.nameOk(it.name) }) {
            entries.put(
                BridgeProtocol.obj(
                    "name" to d.name,
                    "path" to PhonePaths.join(f.root.id, p.names + d.name),
                    "type" to if (d.isDir) "dir" else "file",
                    "size" to if (d.isDir) 0 else d.size,
                    "mtime" to PhonePaths.isoTime(d.mtime),
                    "mime" to d.mime,
                    "writable" to d.writable,
                    "deletable" to (f.root.writable && d.canDelete),
                    "renamable" to (f.root.writable && d.canRename),
                ),
            )
        }
        return BridgeProtocol.obj(
            "path" to PhonePaths.join(f.root.id, p.names),
            "parent" to PhonePaths.parent(p),
            "root" to BridgeProtocol.obj("id" to f.root.id, "name" to f.root.name),
            "names" to JSONArray(p.names),
            "canCreate" to (f.doc.canCreate && f.root.writable),
            "truncated" to (all.size > PhonePaths.MAX_ENTRIES),
            "entries" to entries,
        )
    }

    private fun readUpTo(f: Found, max: Int): ByteArray = guarded {
        (f.docs.read(f.tree, f.doc.id) ?: throw PhoneError("not_found")).use { input ->
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            while (out.size() <= max) {
                val n = input.read(buf, 0, minOf(buf.size, max + 1 - out.size()))
                if (n < 0) break
                out.write(buf, 0, n)
            }
            out.toByteArray()
        }
    }

    /** A text file for the editor, up to 5 MB, with the SHA-256 of what was read (a save checks it). */
    fun text(path: String): JSONObject {
        val f = resolve(parse(path))
        if (f.doc.isDir) throw PhoneError("not_a_file")
        if (f.doc.size > PhonePaths.MAX_TEXT) throw PhoneError("too_large")
        val bytes = readUpTo(f, PhonePaths.MAX_TEXT)
        if (bytes.size > PhonePaths.MAX_TEXT) throw PhoneError("too_large")
        if (PhonePaths.isBinary(bytes)) throw PhoneError("binary")
        return BridgeProtocol.obj(
            "path" to path,
            "content" to String(bytes, Charsets.UTF_8),
            "hash" to PhonePaths.sha256(bytes),
            "size" to bytes.size,
            "mtime" to PhonePaths.isoTime(f.doc.mtime),
            "writable" to f.doc.writable,
        )
    }

    /**
     * The editor's text written back, only over the version it read: changed
     * since (another app wrote it), nothing is written and the page is told.
     */
    fun saveText(path: String, content: String, baseHash: String): JSONObject {
        val f = resolve(parse(path))
        if (f.doc.isDir) throw PhoneError("not_a_file")
        if (!f.doc.writable) throw PhoneError("read_only")
        val bytes = content.toByteArray(Charsets.UTF_8)
        if (bytes.size > PhonePaths.MAX_TEXT) throw PhoneError("too_large")
        // Only over a text file the editor could have opened: a photo's first 5 MB hashed by the
        // page let it write a photo empty without any question (audit 2026-11-05).
        if (f.doc.size > PhonePaths.MAX_TEXT) throw PhoneError("too_large")
        val now = readUpTo(f, PhonePaths.MAX_TEXT)
        if (now.size > PhonePaths.MAX_TEXT) throw PhoneError("too_large")
        if (PhonePaths.isBinary(now)) throw PhoneError("binary")
        if (PhonePaths.sha256(now) != baseHash) return BridgeProtocol.obj("conflict" to true)
        guarded {
            (f.docs.write(f.tree, f.doc.id) ?: throw PhoneError("read_only")).use { it.write(bytes) }
        }
        val after = guarded { f.docs.doc(f.tree, f.doc.id) }
        return BridgeProtocol.obj("path" to path, "hash" to PhonePaths.sha256(bytes), "size" to bytes.size, "mtime" to PhonePaths.isoTime(after?.mtime ?: 0), "writable" to true)
    }

    /** Files held by token (HeldFiles), read by the page in 1 MiB pieces: to show a picture, or to upload to a host. */
    fun hold(paths: List<String>, kind: HeldFiles.Kind, held: HeldFiles): JSONArray {
        if (paths.size > MAX_HOLD) throw PhoneError("too_many")
        val out = JSONArray()
        for (path in paths) {
            val f = resolve(parse(path))
            if (f.doc.isDir) throw PhoneError("not_a_file")
            val h = held.add(HeldFiles.Held(held.newToken(), kind, FileNames.safe(f.doc.name), f.doc.mime.takeIf { it.contains('/') } ?: Http.mimeOf(f.doc.name), f.doc.size, f.docs.opener(f.tree, f.doc.id)))
            out.put(BridgeProtocol.obj("token" to h.token, "name" to h.name, "mime" to h.mime, "size" to h.size))
        }
        return out
    }

    /** A file's own URI and type, to hand to another app (a PDF, a video): read only. */
    fun forViewing(path: String): Pair<String, String> {
        val f = resolve(parse(path))
        if (f.doc.isDir) throw PhoneError("not_a_file")
        return f.uri() to (f.doc.mime.takeIf { it.contains('/') && it != "application/octet-stream" } ?: Http.mimeOf(f.doc.name))
    }

    // ---- changing what is there (report 6eaf00): delete, rename, a new folder.
    // Never a granted folder's or a volume's own top (that is "Remove from
    // Burrow"); only where the person gave write access and the provider
    // says it can. A delete is asked first by the app itself (Bridge), not
    // by the page: the page alone cannot delete a file of the phone.

    /** A file or folder below a granted folder's top, that may be changed. */
    private fun below(path: String): Pair<PhonePaths.Parsed, Found> {
        val p = parse(path)
        if (p.rootId == null || p.names.isEmpty()) throw PhoneError("bad_path")
        val f = resolve(p)
        if (!f.root.writable) throw PhoneError("read_only")
        return p to f
    }

    private fun checkedName(name: String): String {
        val n = name.trim()
        if (!PhonePaths.nameOk(n)) throw PhoneError("bad_name")
        return n
    }

    /** What a delete of [paths] takes, checked before the app asks: the names, folders marked. */
    fun forDelete(paths: List<String>): List<Pair<String, Boolean>> {
        if (paths.isEmpty() || paths.size > MAX_HOLD) throw PhoneError("too_many")
        return paths.map { path ->
            val (_, f) = below(path)
            if (!f.doc.canDelete) throw PhoneError("read_only")
            f.doc.name to f.doc.isDir
        }
    }

    private fun Doc.mark() = "$id|$isDir|$size|$mtime"

    /**
     * What each of [paths] is now, to be sure the delete takes the ones the
     * person was asked about: between the question and the tap the page
     * could rename another folder to a name shown (audit 2026-11-05).
     */
    fun marks(paths: List<String>): List<String> = paths.map { below(it).second.doc.mark() }

    /**
     * Each one gone (a folder with all in it), in turn; the number gone. One
     * that fails stops the rest; [marks] (from marks() when the person was
     * asked): one that is no longer what it was is refused ("changed").
     */
    fun delete(paths: List<String>, marks: List<String>? = null): Int {
        forDelete(paths)
        if (marks != null && marks != marks(paths)) throw PhoneError("changed")
        var n = 0
        for (path in paths) {
            val (_, f) = below(path)
            if (!f.doc.canDelete) throw PhoneError("read_only")
            try {
                guarded { f.docs.delete(f.tree, f.doc.id) }
            } catch (e: java.io.IOException) {
                throw PhoneError("not_done")
            }
            n++
        }
        return n
    }

    private fun taken(f: Found, parent: String, name: String) = children(f.docs, f.tree, parent, Int.MAX_VALUE).any { it.name == name }

    /** Named anew in its folder; refused when the name is taken there. Its path then. */
    fun rename(path: String, name: String): JSONObject {
        val (p, f) = below(path)
        val n = checkedName(name)
        if (n == f.doc.name) return BridgeProtocol.obj("path" to path)
        if (!f.doc.canRename) throw PhoneError("read_only")
        val parent = resolve(PhonePaths.Parsed(p.rootId, p.names.dropLast(1)))
        if (taken(f, parent.doc.id, n)) throw PhoneError("exists")
        val id = try {
            guarded { f.docs.rename(f.tree, f.doc.id, n) }
        } catch (e: java.io.IOException) {
            throw PhoneError("not_done")
        }
        val now = guarded { f.docs.doc(f.tree, id) }?.name?.takeIf { PhonePaths.nameOk(it) } ?: n
        return BridgeProtocol.obj("path" to PhonePaths.join(p.rootId!!, p.names.dropLast(1) + now))
    }

    /** A new folder in a folder (a granted folder's top too); refused when the name is taken there. Its path. */
    fun mkdir(dir: String, name: String): JSONObject {
        val p = parse(dir)
        if (p.rootId == null) throw PhoneError("bad_path")
        val f = resolve(p)
        if (!f.doc.isDir) throw PhoneError("not_a_folder")
        if (!f.doc.canCreate || !f.root.writable) throw PhoneError("read_only")
        val n = checkedName(name)
        if (taken(f, f.doc.id, n)) throw PhoneError("exists")
        val id = try {
            guarded { f.docs.mkdir(f.tree, f.doc.id, n) }
        } catch (e: java.io.IOException) {
            throw PhoneError("not_done")
        }
        val now = guarded { f.docs.doc(f.tree, id) }?.name?.takeIf { PhonePaths.nameOk(it) } ?: n
        return BridgeProtocol.obj("path" to PhonePaths.join(p.rootId, p.names + now))
    }

    /** Where a host's file copied into a folder goes: a new document in a granted folder (its URI), or a new file of "All files". */
    sealed class NewIn(val folderName: String) {
        class Tree(val uri: String, folderName: String) : NewIn(folderName)

        class Plain(val file: java.io.File, folderName: String) : NewIn(folderName)
    }

    /** A folder a host's file is copied into, if new files may be made in it. */
    fun folderForNew(path: String, name: String): NewIn {
        val p = parse(path)
        if (p.rootId == null) throw PhoneError("bad_path")
        val f = resolve(p)
        if (!f.doc.isDir) throw PhoneError("not_a_folder")
        if (!f.doc.canCreate || !f.root.writable) throw PhoneError("read_only")
        val folderName = p.names.lastOrNull() ?: f.root.name
        val plain = files
        if (plain != null && f.docs === plain) return NewIn.Plain(guarded { plain.newFile(f.tree, f.doc.id, name) }, folderName)
        return NewIn.Tree(f.uri(), folderName)
    }

    // ---- archives as folders, and unpacked (report 99d993, "as Material
    // Files"): zip, jar, apk, tar, tar.gz (Archives). Read as a stream, the
    // list kept for the archive as it is (its size and time), so going into
    // its folders reads it once.

    private class Listed(val key: String, val entries: List<Archives.Entry>, val cut: Boolean)

    private val listed = ArrayDeque<Listed>()

    private fun archiveOf(path: String): Pair<Found, Archives.Kind> {
        val f = resolve(parse(path))
        if (f.doc.isDir) throw PhoneError("not_a_file")
        return f to (Archives.kind(f.doc.name) ?: throw PhoneError("not_an_archive"))
    }

    private fun entriesOf(f: Found, kind: Archives.Kind): Listed {
        val key = "${f.tree}|${f.doc.id}|${f.doc.size}|${f.doc.mtime}"
        synchronized(listed) { listed.firstOrNull { it.key == key } }?.let { return it }
        val (all, cut) = try {
            guarded { (f.docs.read(f.tree, f.doc.id) ?: throw PhoneError("not_found")).use { Archives.list(it, kind) } }
        } catch (e: java.io.IOException) {
            throw PhoneError("bad_archive")
        }
        val l = Listed(key, all, cut)
        synchronized(listed) {
            listed.addFirst(l)
            while (listed.size > 3) listed.removeLast()
        }
        return l
    }

    /** What is in an archive's folder [inner] ("" its top), as a folder's listing is. */
    fun archive(path: String, inner: String): JSONObject {
        val (f, kind) = archiveOf(path)
        val dir = if (inner.isEmpty()) "" else Archives.clean(inner) ?: throw PhoneError("bad_path")
        val l = entriesOf(f, kind)
        if (dir.isNotEmpty() && l.entries.none { it.dir && it.path == dir }) throw PhoneError("not_found")
        val entries = JSONArray()
        for (e in Archives.inside(l.entries, dir)) {
            entries.put(
                BridgeProtocol.obj(
                    "name" to e.path.substringAfterLast('/'),
                    "path" to e.path,
                    "type" to if (e.dir) "dir" else "file",
                    "size" to e.size,
                    "mtime" to if (e.mtime > 0) PhonePaths.isoTime(e.mtime) else null,
                    "mime" to Http.mimeOf(e.path),
                ),
            )
        }
        return BridgeProtocol.obj("path" to path, "inner" to dir, "name" to f.doc.name, "truncated" to l.cut, "entries" to entries)
    }

    /** One file of an archive, taken out into [into] (the app's own cache) for another app to show. */
    fun archiveEntry(path: String, inner: String, into: java.io.File): java.io.File {
        val (f, kind) = archiveOf(path)
        val want = Archives.clean(inner) ?: throw PhoneError("bad_path")
        into.mkdirs()
        val out = java.io.File(into, want.substringAfterLast('/'))
        val n = try {
            guarded {
                (f.docs.read(f.tree, f.doc.id) ?: throw PhoneError("not_found")).use { s ->
                    Archives.copyOut(s, kind, { e -> if (e.path == want) out.outputStream() else null })
                }
            }
        } catch (e: java.io.IOException) {
            throw PhoneError("bad_archive")
        }
        if (n == 0) throw PhoneError("not_found")
        return out
    }

    /** What unpacking takes, checked first: the archive, its folder and the new folder's name there. */
    class Unpack internal constructor(internal val f: Found, internal val kind: Archives.Kind, val folder: String, val total: Long, internal val parent: Found)

    fun forUnpack(path: String): Unpack {
        val p = parse(path)
        if (p.rootId == null || p.names.isEmpty()) throw PhoneError("bad_path")
        val (f, kind) = archiveOf(path)
        val parent = resolve(PhonePaths.Parsed(p.rootId, p.names.dropLast(1)))
        if (!parent.doc.canCreate || !parent.root.writable) throw PhoneError("read_only")
        val base = Archives.folderName(f.doc.name)
        val names = children(parent.docs, parent.tree, parent.doc.id, Int.MAX_VALUE).map { it.name }.toSet()
        val folder = (sequenceOf(base) + (1..999).asSequence().map { "$base ($it)" }).firstOrNull { it !in names } ?: throw PhoneError("exists")
        val total = entriesOf(f, kind).entries.filter { !it.dir }.sumOf { it.size }
        return Unpack(f, kind, folder, total, parent)
    }

    /**
     * The archive unpacked into a new folder beside it ([u].folder), its
     * folders made as needed; [progress] hears the bytes written. The new
     * folder's path and the files written.
     */
    fun unpack(path: String, u: Unpack, progress: (Long) -> Unit): JSONObject {
        val f = u.f
        val parent = u.parent
        val p = parse(path)
        val top = try {
            guarded { parent.docs.mkdir(parent.tree, parent.doc.id, u.folder) }
        } catch (e: java.io.IOException) {
            throw PhoneError("not_done")
        }
        // Folder ids by their path inside the archive.
        val dirs = HashMap<String, String>().apply { put("", top) }
        fun dirId(dir: String): String = dirs.getOrPut(dir) {
            val up = dirId(dir.substringBeforeLast('/', ""))
            guarded { parent.docs.mkdir(parent.tree, up, dir.substringAfterLast('/')) }
        }
        val n = try {
            guarded {
                (f.docs.read(f.tree, f.doc.id) ?: throw PhoneError("not_found")).use { s ->
                    Archives.copyOut(s, u.kind, { e ->
                        val dir = dirId(e.path.substringBeforeLast('/', ""))
                        val id = parent.docs.create(parent.tree, dir, e.path.substringAfterLast('/'), Http.mimeOf(e.path))
                        parent.docs.write(parent.tree, id) ?: throw PhoneError("read_only")
                    }, progress)
                }
            }
        } catch (e: java.io.IOException) {
            throw PhoneError("not_done")
        }
        return BridgeProtocol.obj("path" to PhonePaths.join(p.rootId!!, p.names.dropLast(1) + u.folder), "files" to n)
    }

    companion object {
        /** Files held at once for one upload or view. */
        const val MAX_HOLD = 200
    }
}
