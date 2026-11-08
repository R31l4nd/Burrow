package io.github.r31l4nd.burrow

import android.provider.DocumentsContract.Document
import org.json.JSONArray
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.InputStream
import java.io.OutputStream

/** The phone's own folders (report a9552e) over a provider in memory: what the page may list, read, write, hold and copy into. */
class PhoneFoldersTest {
    private val rw = Document.FLAG_SUPPORTS_WRITE
    private val mk = Document.FLAG_DIR_SUPPORTS_CREATE
    private val del = Document.FLAG_SUPPORTS_DELETE
    private val ren = Document.FLAG_SUPPORTS_RENAME

    /** A document provider in memory: trees of nodes, and the permissions Android keeps. */
    private class Node(val id: String, var name: String, val mime: String, var data: ByteArray = ByteArray(0), val flags: Int = 0, val mtime: Long = 1_760_000_000_000, var size: Long? = null) {
        val kids = mutableListOf<Node>()
        fun doc() = PhoneFolders.Doc(id, name, mime, size ?: data.size.toLong(), mtime, flags)
    }

    private class Fake : PhoneFolders.Documents {
        val tops = mutableMapOf<String, Node>()
        val nodes = mutableMapOf<String, Node>()
        val granted = mutableMapOf<String, Boolean>()
        var writeGrant = true
        var revoked = false
        var nullChildren = false
        val released = mutableListOf<String>()

        fun tree(tree: String, top: Node) {
            tops[tree] = top
            add(top)
        }

        fun add(n: Node) {
            nodes[n.id] = n
            n.kids.forEach { add(it) }
        }

        private fun check() {
            if (revoked) throw SecurityException("permission gone")
        }

        override fun parts(uri: String): Triple<String?, String?, String?> = java.net.URI(uri).let { Triple(it.scheme, it.rawAuthority, it.path) }

        override val ownPackage = "io.github.r31l4nd.burrow"

        override fun take(tree: String): Boolean {
            granted[tree] = writeGrant
            return writeGrant
        }

        override fun release(tree: String) {
            released += tree
            granted.remove(tree)
        }

        override fun persisted(): List<String> = granted.keys.toList()

        override fun readable(): Set<String> = granted.keys

        override fun topId(tree: String): String = tops[tree]?.id ?: throw FileNotFoundException(tree)

        override fun doc(tree: String, id: String): PhoneFolders.Doc? {
            check()
            return nodes[id]?.doc()
        }

        override fun children(tree: String, parent: String, limit: Int): List<PhoneFolders.Doc>? {
            check()
            if (nullChildren) return null
            return nodes[parent]?.kids?.take(limit)?.map { it.doc() }
        }

        override fun read(tree: String, id: String): InputStream? {
            check()
            return nodes[id]?.let { ByteArrayInputStream(it.data) }
        }

        override fun write(tree: String, id: String): OutputStream? {
            check()
            val n = nodes[id] ?: return null
            return object : ByteArrayOutputStream() {
                override fun close() {
                    n.data = toByteArray()
                }
            }
        }

        override fun opener(tree: String, id: String): HeldFiles.Opener {
            val n = nodes[id]!!
            return object : HeldFiles.Opener {
                override fun channel() = null
                override fun stream(): InputStream = ByteArrayInputStream(n.data)
            }
        }

        override fun uri(tree: String, id: String): String = "$tree/document/$id"

        var refuse = false

        private fun parentOf(id: String) = nodes.values.first { p -> p.kids.any { it.id == id } }

        override fun delete(tree: String, id: String) {
            check()
            if (refuse) throw java.io.IOException("busy")
            val n = nodes[id] ?: throw FileNotFoundException(id)
            parentOf(id).kids.remove(n)
            fun gone(x: Node) {
                nodes.remove(x.id)
                x.kids.forEach { gone(it) }
            }
            gone(n)
        }

        override fun rename(tree: String, id: String, name: String): String {
            check()
            (nodes[id] ?: throw FileNotFoundException(id)).name = name
            return id
        }

        override fun mkdir(tree: String, parent: String, name: String): String {
            check()
            val n = Node("new-$name", name, Document.MIME_TYPE_DIR, flags = Document.FLAG_DIR_SUPPORTS_CREATE)
            (nodes[parent] ?: throw FileNotFoundException(parent)).kids += n
            nodes[n.id] = n
            return n.id
        }
        private var made = 0

        override fun create(tree: String, parent: String, name: String, mime: String): String {
            check()
            val n = Node("file-${made++}-$name", name, mime, flags = Document.FLAG_SUPPORTS_WRITE)
            (nodes[parent] ?: throw FileNotFoundException(parent)).kids += n
            nodes[n.id] = n
            return n.id
        }
    }

    private val tree = "content://com.android.externalstorage.documents/tree/primary%3ADocuments"
    private val docs = Fake()
    private var saved: String? = null
    private val phone = PhoneFolders(docs, { saved }, { saved = it })

    private val notes = Node("n", "notes.txt", "text/plain", "hello\n".toByteArray(), rw)
    private val photo = Node("p", "zee.jpg", "image/jpeg", ByteArray(3000) { it.toByte() })
    private val sub = Node("s", "Sub", Document.MIME_TYPE_DIR, flags = mk).apply { kids += Node("deep", "deep.md", "text/markdown", "# deep".toByteArray(), rw) }
    private val top = Node("top", "Documents", Document.MIME_TYPE_DIR, flags = mk or rw).apply {
        kids += listOf(sub, notes, photo, Node("bad", "a/b", "text/plain"), Node("ro", "readonly.txt", "text/plain", "x".toByteArray()))
    }

    init {
        docs.tree(tree, top)
    }

    private fun error(f: () -> Unit): String? = (runCatching { f() }.exceptionOrNull() as? PhoneFolders.PhoneError)?.code

    private fun added(): String = phone.add(tree).id

    @Test
    fun addsAPickedFolderOnce() {
        val root = phone.add(tree)
        assertEquals("Documents", root.name)
        assertTrue(root.writable)
        assertEquals(true, docs.granted[tree])
        // The same folder again is the same entry; granted read only now, it says so.
        docs.writeGrant = false
        val again = phone.add(tree)
        assertEquals(root.id, again.id)
        assertFalse(again.writable)
        assertEquals(1, phone.roots().size)
        val json = phone.rootsJson().getJSONObject(0)
        assertEquals(root.id, json.getString("id"))
        assertFalse(json.getBoolean("lost"))
        // Android took the permission back: the page says to pick it again.
        docs.granted.clear()
        assertTrue(phone.rootsJson().getJSONObject(0).getBoolean("lost"))
    }

    /** Only another app's tree: never this app's own provider (its private files), nor a single document or a file. */
    @Test
    fun refusesWhatIsNotAnotherAppsFolder() {
        for (bad in listOf("content://io.github.r31l4nd.burrow.files/tree/x", "content://10@io.github.r31l4nd.burrow.debug.files/tree/x", "content://com.android.externalstorage.documents/document/primary%3Ax", "file:///sdcard/Documents")) {
            assertEquals(bad, "bad_folder", error { phone.add(bad) })
        }
        assertTrue(docs.granted.isEmpty())
    }

    /** Android keeps 128 permissions per app: at most 32 folders, the one too many given back at once. */
    @Test
    fun atMostSoManyFolders() {
        repeat(PhonePaths.MAX_ROOTS) { docs.tree("$tree$it", Node("t$it", "F$it", Document.MIME_TYPE_DIR)); phone.add("$tree$it") }
        assertEquals("too_many", error { phone.add(tree) })
        assertEquals(listOf(tree), docs.released)
        assertEquals(PhonePaths.MAX_ROOTS, phone.roots().size)
    }

    @Test
    fun aFolderWithoutANameIsCalledFolder() {
        docs.tree("$tree-x", Node("x", "", Document.MIME_TYPE_DIR))
        assertEquals("folder", phone.add("$tree-x").name)
    }

    /** Removed: off the list and its permission given back, unless another entry is the same folder. */
    @Test
    fun removeGivesThePermissionBack() {
        val a = "0123456789abcdef"
        val b = "fedcba9876543210"
        saved = PhonePaths.encodeRoots(listOf(PhonePaths.Root(a, tree, "A", true), PhonePaths.Root(b, tree, "B", true)))
        docs.granted[tree] = true
        phone.remove(a)
        assertEquals(listOf(b), phone.roots().map { it.id })
        assertTrue("still B's", docs.released.isEmpty())
        phone.remove("not-there")
        phone.remove(b)
        assertEquals(listOf(tree), docs.released)
        assertTrue(phone.roots().isEmpty())
    }

    /** Another server chosen: every folder goes, and any permission left over too. */
    @Test
    fun clearLeavesNothing() {
        added()
        docs.granted["content://other/tree/leftover"] = true
        phone.clear()
        assertTrue(phone.roots().isEmpty())
        assertTrue(docs.granted.isEmpty())
    }

    @Test
    fun listsAFolder() {
        val id = added()
        val l = phone.list("/$id")
        assertEquals("/$id", l.getString("path"))
        assertEquals("/", l.getString("parent"))
        assertEquals("Documents", l.getJSONObject("root").getString("name"))
        assertTrue(l.getBoolean("canCreate"))
        assertFalse(l.getBoolean("truncated"))
        val entries = l.getJSONArray("entries").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
        assertEquals("a name that could not be named again is left out", listOf("Sub", "notes.txt", "zee.jpg", "readonly.txt"), entries.map { it.getString("name") })
        val sub = entries[0]
        assertEquals("dir", sub.getString("type"))
        assertEquals(0, sub.getLong("size"))
        assertEquals("/$id/Sub", sub.getString("path"))
        val n = entries[1]
        assertEquals("file", n.getString("type"))
        assertEquals(6, n.getLong("size"))
        assertTrue(n.getBoolean("writable"))
        assertEquals("2025-10-09T08:53:20Z", n.getString("mtime"))
        val deep = phone.list("/$id/Sub")
        assertEquals("/$id", deep.getString("parent"))
        assertEquals(JSONArray(listOf("Sub")).toString(), deep.getJSONArray("names").toString())
        assertEquals("deep.md", deep.getJSONArray("entries").getJSONObject(0).getString("name"))
    }

    @Test
    fun aHugeFolderSaysItLeftTheRestOut() {
        val id = added()
        repeat(PhonePaths.MAX_ENTRIES + 5) { sub.kids += Node("k$it", "f$it", "text/plain") }
        val l = phone.list("/$id/Sub")
        assertTrue(l.getBoolean("truncated"))
        assertEquals(PhonePaths.MAX_ENTRIES, l.getJSONArray("entries").length())
    }

    /** Every refusal in the page's own words. */
    @Test
    fun refusalsHaveTheirCodes() {
        val id = added()
        assertEquals("bad_path", error { phone.list("/") })
        assertEquals("bad_path", error { phone.list("/$id/../x") })
        assertEquals("no_folder", error { phone.list("/0000000000000000") })
        assertEquals("not_found", error { phone.list("/$id/missing") })
        assertEquals("not_found", error { phone.list("/$id/notes.txt/inside") })
        assertEquals("not_a_folder", error { phone.list("/$id/notes.txt") })
        assertEquals("not_a_file", error { phone.text("/$id/Sub") })
        assertEquals("not_a_file", error { phone.forViewing("/$id/Sub") })
        assertEquals("not_a_file", error { phone.hold(listOf("/$id/Sub"), HeldFiles.Kind.LOCAL, HeldFiles()) })
        assertEquals("not_a_file", error { phone.saveText("/$id/Sub", "", "") })
        assertEquals("bad_path", error { phone.folderForNew("/", "x") })
        assertEquals("not_a_folder", error { phone.folderForNew("/$id/notes.txt", "x") })
        docs.nullChildren = true
        assertEquals("no_access", error { phone.list("/$id") })
        docs.nullChildren = false
        // Android took the permission back meanwhile.
        docs.revoked = true
        assertEquals("no_access", error { phone.list("/$id") })
        assertEquals("no_access", error { phone.text("/$id/notes.txt") })
        docs.revoked = false
        // The tree itself is gone.
        docs.tops.clear()
        assertEquals("not_found", error { phone.list("/$id") })
    }

    /** The editor gets the text and its hash; a binary or too large file is refused. */
    @Test
    fun readsTextForTheEditor() {
        val id = added()
        val t = phone.text("/$id/notes.txt")
        assertEquals("hello\n", t.getString("content"))
        assertEquals(PhonePaths.sha256("hello\n".toByteArray()), t.getString("hash"))
        assertEquals(6, t.getInt("size"))
        assertTrue(t.getBoolean("writable"))
        assertEquals("binary", error { phone.text("/$id/zee.jpg") })
        notes.size = PhonePaths.MAX_TEXT + 1L
        assertEquals("too large by its size", "too_large", error { phone.text("/$id/notes.txt") })
        notes.size = 10
        notes.data = ByteArray(PhonePaths.MAX_TEXT + 1) { 'a'.code.toByte() }
        assertEquals("larger than it said", "too_large", error { phone.text("/$id/notes.txt") })
    }

    /** Written back only over the version read; changed since, nothing is written and the page is told. */
    @Test
    fun savesOnlyOverTheVersionRead() {
        val id = added()
        val base = phone.text("/$id/notes.txt").getString("hash")
        val r = phone.saveText("/$id/notes.txt", "new text", base)
        assertEquals("new text", String(notes.data))
        assertEquals(PhonePaths.sha256("new text".toByteArray()), r.getString("hash"))
        assertEquals(8, r.getInt("size"))
        // Another app wrote it since: a conflict, the file as that app left it.
        notes.data = "theirs".toByteArray()
        assertTrue(phone.saveText("/$id/notes.txt", "mine", r.getString("hash")).getBoolean("conflict"))
        assertEquals("theirs", String(notes.data))
        assertEquals("read_only", error { phone.saveText("/$id/readonly.txt", "x", PhonePaths.sha256("x".toByteArray())) })
        assertEquals("too_large", error { phone.saveText("/$id/notes.txt", "a".repeat(PhonePaths.MAX_TEXT + 1), "") })
    }

    /** Held by token for the page to read in pieces; at most MAX_HOLD at once. */
    @Test
    fun holdsFilesForThePage() {
        val id = added()
        val held = HeldFiles()
        val a = phone.hold(listOf("/$id/zee.jpg", "/$id/Sub/deep.md"), HeldFiles.Kind.SHARED, held)
        assertEquals(2, a.length())
        val first = a.getJSONObject(0)
        assertEquals("zee.jpg", first.getString("name"))
        assertEquals("image/jpeg", first.getString("mime"))
        assertEquals(3000, first.getLong("size"))
        assertArrayEquals(photo.data.copyOfRange(1000, 1100), held.read(first.getString("token"), 1000, 100))
        assertEquals(setOf("zee.jpg", "deep.md"), held.list(HeldFiles.Kind.SHARED).map { it.name }.toSet())
        assertEquals("too_many", error { phone.hold(List(PhoneFolders.MAX_HOLD + 1) { "/$id/notes.txt" }, HeldFiles.Kind.LOCAL, held) })
        // A provider's type that is no type: guessed from the name instead.
        top.kids += Node("odd", "odd.bin", "nonsense").also { docs.add(it) }
        assertEquals("application/octet-stream", phone.hold(listOf("/$id/odd.bin"), HeldFiles.Kind.LOCAL, held).getJSONObject(0).getString("mime"))
    }

    @Test
    fun handsAFileToAnotherAppReadOnly() {
        val id = added()
        assertEquals("$tree/document/p" to "image/jpeg", phone.forViewing("/$id/zee.jpg"))
        top.kids += Node("o", "x.pdf", "application/octet-stream").also { docs.add(it) }
        assertEquals("a byte stream is guessed from the name", "application/octet-stream", phone.forViewing("/$id/x.pdf").second)
    }

    /** A host's file goes only into a folder where new files may be made, of a folder granted for writing. */
    @Test
    fun copiesOnlyIntoAWritableFolder() {
        val id = added()
        val into = { path: String -> (phone.folderForNew(path, "x.txt") as PhoneFolders.NewIn.Tree).let { it.uri to it.folderName } }
        assertEquals("$tree/document/top" to "Documents", into("/$id"))
        assertEquals("$tree/document/s" to "Sub", into("/$id/Sub"))
        docs.add(Node("ro-dir", "Fixed", Document.MIME_TYPE_DIR).also { top.kids += it })
        assertEquals("read_only", error { phone.folderForNew("/$id/Fixed", "x") })
        // Granted read only: not even into a folder that could take it.
        docs.writeGrant = false
        phone.add(tree)
        assertEquals("read_only", error { phone.folderForNew("/$id/Sub", "x") })
    }

    /**
     * Delete, rename and a new folder (report 6eaf00): only below a granted
     * folder's top, only where the provider says it can and the person gave
     * write access; a name taken or one that could not be named again is refused.
     */
    @Test
    fun theEditorsSaveWritesOnlyOverTextNeverOverAPicture() {
        // A picture's bytes, hashed by the page itself (held and read), wrote it empty with no question (audit 2026-11-05).
        val pic = Node("pic", "holiday.jpg", "image/jpeg", byteArrayOf(-1, -40, -1, -32, 0, 16, 74, 70, 73, 70, 0, 1), rw)
        val big = Node("big", "big.txt", "text/plain", ByteArray(0), rw, size = PhonePaths.MAX_TEXT + 1L)
        top.kids += listOf(pic, big)
        docs.add(pic)
        docs.add(big)
        val id = added()
        assertEquals("binary", error { phone.saveText("/$id/holiday.jpg", "", PhonePaths.sha256(pic.data)) })
        assertEquals(12, pic.data.size)
        assertEquals("too_large", error { phone.saveText("/$id/big.txt", "", PhonePaths.sha256(ByteArray(0))) })
    }

    @Test
    fun aDeleteTakesWhatThePersonWasAskedAboutNotWhatWasSwappedIn() {
        // Asked about "tmp.txt"; before the tap the page renamed it away and a folder to its name.
        val tmp = Node("tmp", "tmp.txt", "text/plain", "x".toByteArray(), rw or del or ren)
        val dcim = Node("dcim", "DCIM", Document.MIME_TYPE_DIR, flags = mk or del or ren).apply { kids += Node("d1", "IMG_1.jpg", "image/jpeg") }
        top.kids += listOf(tmp, dcim)
        docs.add(tmp)
        docs.add(dcim)
        val id = added()
        val marks = phone.marks(listOf("/$id/tmp.txt"))
        phone.rename("/$id/tmp.txt", "away.txt")
        phone.rename("/$id/DCIM", "tmp.txt")
        assertEquals("changed", error { phone.delete(listOf("/$id/tmp.txt"), marks) })
        assertTrue(top.kids.contains(dcim))
        assertEquals(1, phone.delete(listOf("/$id/away.txt"), phone.marks(listOf("/$id/away.txt"))))
    }

    @Test
    fun anArchiveIsAFolderAndUnpacksBesideItself() {
        val zip = ByteArrayOutputStream().also { o ->
            java.util.zip.ZipOutputStream(o).use { z ->
                for ((n, t) in listOf("docs/readme.md" to "hello", "top.txt" to "t", "../escape.sh" to "rm")) {
                    z.putNextEntry(java.util.zip.ZipEntry(n))
                    z.write(t.toByteArray())
                    z.closeEntry()
                }
            }
        }.toByteArray()
        val a = Node("z", "backup.zip", "application/zip", zip, rw)
        val taken = Node("t", "backup", Document.MIME_TYPE_DIR, flags = mk)
        top.kids += listOf(a, taken)
        docs.add(a)
        docs.add(taken)
        val id = added()
        val list = phone.archive("/$id/backup.zip", "")
        assertEquals(listOf("docs", "top.txt"), list.getJSONArray("entries").let { e -> (0 until e.length()).map { e.getJSONObject(it).getString("name") } })
        assertEquals("docs/readme.md", phone.archive("/$id/backup.zip", "docs").getJSONArray("entries").getJSONObject(0).getString("path"))
        assertEquals("not_found", error { phone.archive("/$id/backup.zip", "nope") })
        assertEquals("bad_path", error { phone.archive("/$id/backup.zip", "../x") })
        assertEquals("not_an_archive", error { phone.archive("/$id/notes.txt", "") })

        // One file taken out for another app to show.
        val cache = kotlin.io.path.createTempDirectory().toFile()
        assertEquals("hello", phone.archiveEntry("/$id/backup.zip", "docs/readme.md", cache).readText())
        assertEquals("not_found", error { phone.archiveEntry("/$id/backup.zip", "docs/none.md", cache) })

        // Unpacked beside it, in a folder of its own name made free ("backup" is taken).
        val u = phone.forUnpack("/$id/backup.zip")
        assertEquals("backup (1)", u.folder)
        assertEquals(6L, u.total)
        var bytes = 0L
        val done = phone.unpack("/$id/backup.zip", u) { bytes = it }
        assertEquals("/$id/backup (1)", done.getString("path"))
        assertEquals(2, done.getInt("files"))
        assertEquals(6L, bytes)
        val made = top.kids.first { it.name == "backup (1)" }
        assertEquals(listOf("docs", "top.txt"), made.kids.map { it.name })
        assertEquals("hello", String(made.kids.first { it.name == "docs" }.kids.single().data))
        assertFalse("nothing named out of the folder", docs.nodes.values.any { it.name.contains("escape") })
        // Not where new files may not be made.
        docs.tree("$tree-ro", Node("ro", "Read", Document.MIME_TYPE_DIR, flags = mk).apply { kids += Node("z2", "backup.zip", "application/zip", zip) })
        docs.writeGrant = false
        val ro = phone.add("$tree-ro").id
        docs.writeGrant = true
        assertEquals("read_only", error { phone.forUnpack("/$ro/backup.zip") })
    }

    @Test
    fun deletesRenamesAndMakesFoldersWhereAllowed() {
        val gone = Node("g", "gone.txt", "text/plain", "x".toByteArray(), rw or del or ren)
        val old = Node("o", "Old", Document.MIME_TYPE_DIR, flags = mk or del).apply { kids += Node("o1", "in.txt", "text/plain") }
        top.kids += listOf(gone, old)
        docs.add(gone)
        docs.add(old)
        val id = added()
        val entries = phone.list("/$id").getJSONArray("entries").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }.associateBy { it.getString("name") }
        assertTrue(entries["gone.txt"]!!.getBoolean("deletable"))
        assertTrue(entries["gone.txt"]!!.getBoolean("renamable"))
        assertFalse("the provider cannot", entries["notes.txt"]!!.getBoolean("deletable"))
        assertFalse(entries["Old"]!!.getBoolean("renamable"))

        // What the app's question names first; a delete of a folder takes all in it.
        assertEquals(listOf("gone.txt" to false, "Old" to true), phone.forDelete(listOf("/$id/gone.txt", "/$id/Old")))
        assertEquals("read_only", error { phone.forDelete(listOf("/$id/notes.txt")) })
        assertEquals("bad_path", error { phone.forDelete(listOf("/$id")) })
        assertEquals("too_many", error { phone.forDelete(emptyList()) })
        assertEquals("too_many", error { phone.forDelete(List(PhoneFolders.MAX_HOLD + 1) { "/$id/gone.txt" }) })
        assertEquals("read_only", error { phone.delete(listOf("/$id/gone.txt", "/$id/notes.txt")) })
        assertTrue("nothing went when one may not", top.kids.contains(gone))
        docs.refuse = true
        assertEquals("not_done", error { phone.delete(listOf("/$id/Old")) })
        docs.refuse = false
        assertEquals(1, phone.delete(listOf("/$id/Old")))
        assertFalse(top.kids.contains(old))
        assertEquals(null, docs.nodes["o1"])

        // Renamed in its folder, to a name not taken there.
        assertEquals("/$id/kept.txt", phone.rename("/$id/gone.txt", " kept.txt ").getString("path"))
        assertEquals("kept.txt", gone.name)
        assertEquals("exists", error { phone.rename("/$id/kept.txt", "notes.txt") })
        assertEquals("/$id/kept.txt", phone.rename("/$id/kept.txt", "kept.txt").getString("path"))
        for (bad in listOf("", "..", ".", "a/b", "x".repeat(PhonePaths.MAX_NAME + 1))) assertEquals(bad, "bad_name", error { phone.rename("/$id/kept.txt", bad) })
        assertEquals("read_only", error { phone.rename("/$id/notes.txt", "n.txt") })
        assertEquals("bad_path", error { phone.rename("/$id", "Docs") })

        // A new folder, at the top too.
        assertEquals("/$id/Photos", phone.mkdir("/$id", "Photos").getString("path"))
        assertEquals("/$id/Sub/Deeper", phone.mkdir("/$id/Sub", "Deeper").getString("path"))
        assertEquals("exists", error { phone.mkdir("/$id", "Photos") })
        assertEquals("not_a_folder", error { phone.mkdir("/$id/kept.txt", "x") })
        assertEquals("bad_name", error { phone.mkdir("/$id", "a/b") })

        // Granted read only: nothing of it, and the page is told.
        docs.writeGrant = false
        phone.add(tree)
        assertFalse(phone.list("/$id").getBoolean("canCreate"))
        assertFalse(phone.list("/$id").getJSONArray("entries").getJSONObject(0).getBoolean("deletable"))
        assertEquals("read_only", error { phone.delete(listOf("/$id/kept.txt")) })
        assertEquals("read_only", error { phone.rename("/$id/kept.txt", "y.txt") })
        assertEquals("read_only", error { phone.mkdir("/$id", "More") })
    }
}
