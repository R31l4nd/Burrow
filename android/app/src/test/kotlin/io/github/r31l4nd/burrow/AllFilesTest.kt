package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

/** "All files" (report 862305): the phone's storage as plain files beside the granted folders, named and looked up the same way, never outside the volume. */
class AllFilesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var volume: File
    private var on = true
    private var saved: String? = null
    private val shared = mutableListOf<File>()

    private fun phone(): PhoneFolders {
        volume = tmp.root.resolve("storage/emulated/0").apply { mkdirs() }
        val files = FileDocuments { f -> shared += f; "content://io.github.r31l4nd.burrow.files/storage${f.path}" }
        return PhoneFolders(NoDocs, { saved }, { saved = it }, files) { if (on) listOf(FileDocuments.root(volume, "Internal storage")) else emptyList() }
    }

    /** No folder granted through the picker. */
    private object NoDocs : PhoneFolders.Documents {
        override fun parts(uri: String) = Triple<String?, String?, String?>(null, null, null)
        override val ownPackage = "io.github.r31l4nd.burrow"
        override fun take(tree: String) = false
        override fun release(tree: String) {}
        override fun persisted() = emptyList<String>()
        override fun readable() = emptySet<String>()
        override fun topId(tree: String) = throw java.io.FileNotFoundException()
        override fun doc(tree: String, id: String) = null
        override fun children(tree: String, parent: String, limit: Int) = null
        override fun read(tree: String, id: String) = null
        override fun write(tree: String, id: String) = null
        override fun opener(tree: String, id: String) = throw java.io.FileNotFoundException()
        override fun uri(tree: String, id: String) = ""
        override fun delete(tree: String, id: String) = throw java.io.FileNotFoundException()
        override fun rename(tree: String, id: String, name: String) = throw java.io.FileNotFoundException()
        override fun mkdir(tree: String, parent: String, name: String) = throw java.io.FileNotFoundException()

        override fun create(tree: String, parent: String, name: String, mime: String) = throw java.io.FileNotFoundException()
    }

    private fun error(f: () -> Unit): String? = (runCatching { f() }.exceptionOrNull() as? PhoneFolders.PhoneError)?.code

    @Test
    fun theVolumeIsListedWhileOnAndReadLikeAGrantedFolder() {
        val phone = phone()
        File(volume, "Music/Hardstyle").mkdirs()
        File(volume, "Music/Hardstyle/a.mp3").writeBytes(ByteArray(10))
        File(volume, "notes.txt").writeText("hello\n")
        val roots = phone.rootsJson()
        assertEquals(1, roots.length())
        val root = roots.getJSONObject(0)
        assertEquals("Internal storage", root.getString("name"))
        assertTrue(root.getBoolean("all"))
        assertFalse(root.getBoolean("lost"))
        val id = root.getString("id")
        // The same id every time: a bookmark of a folder in it keeps working.
        assertEquals(id, phone.rootsJson().getJSONObject(0).getString("id"))
        val top = phone.list("/$id")
        val names = (0 until top.getJSONArray("entries").length()).map { top.getJSONArray("entries").getJSONObject(it).getString("name") }.sorted()
        assertEquals(listOf("Music", "notes.txt"), names)
        val deep = phone.list("/$id/Music/Hardstyle").getJSONArray("entries").getJSONObject(0)
        assertEquals("/$id/Music/Hardstyle/a.mp3", deep.getString("path"))
        assertEquals(10, deep.getLong("size"))
        val text = phone.text("/$id/notes.txt")
        assertEquals("hello\n", text.getString("content"))
        assertTrue(text.getBoolean("writable"))
        // Written back over the version read only.
        phone.saveText("/$id/notes.txt", "changed\n", text.getString("hash"))
        assertEquals("changed\n", File(volume, "notes.txt").readText())
        assertTrue(phone.saveText("/$id/notes.txt", "again\n", text.getString("hash")).getBoolean("conflict"))
        // Handed to another app through the app's provider.
        assertTrue(phone.forViewing("/$id/notes.txt").first.startsWith("content://"))
        assertEquals(File(volume, "notes.txt").path, shared.single().path)
        // Held to show or upload: its bytes.
        val held = HeldFiles()
        val h = phone.hold(listOf("/$id/Music/Hardstyle/a.mp3"), HeldFiles.Kind.LOCAL, held).getJSONObject(0)
        assertEquals(10, held.read(h.getString("token"), 0, 100).size)
    }

    @Test
    fun switchedOffItIsGoneAtOnce() {
        val phone = phone()
        val id = phone.rootsJson().getJSONObject(0).getString("id")
        on = false
        assertEquals(0, phone.rootsJson().length())
        assertEquals("no_folder", error { phone.list("/$id") })
        // Never kept with the granted folders: nothing of it in the app's preferences.
        assertTrue(saved == null || !saved!!.contains("file://"))
    }

    /** A link inside the volume to a folder outside it (the app's own data): neither listed nor opened. */
    @Test
    fun aLinkOutOfTheVolumeLeadsNowhere() {
        val phone = phone()
        val secret = tmp.root.resolve("data/data/io.github.r31l4nd.burrow").apply { mkdirs() }
        File(secret, "keys.txt").writeText("secret")
        Files.createSymbolicLink(File(volume, "out").toPath(), secret.toPath())
        File(volume, "in.txt").writeText("x")
        val id = phone.rootsJson().getJSONObject(0).getString("id")
        val entries = phone.list("/$id").getJSONArray("entries")
        assertEquals(listOf("in.txt"), (0 until entries.length()).map { entries.getJSONObject(it).getString("name") })
        assertEquals("not_found", error { phone.text("/$id/out/keys.txt") })
        // No ".." or absolute name gets there either.
        assertEquals("bad_path", error { phone.list("/$id/../../data") })
    }

    /** A host's file copied into a folder of it: a new file, its name made free beside one of the same name. */
    @Test
    fun aCopyFromAHostGetsAFreeName() {
        val phone = phone()
        File(volume, "Download").mkdirs()
        File(volume, "Download/report.pdf").writeText("old")
        val id = phone.rootsJson().getJSONObject(0).getString("id")
        val into = phone.folderForNew("/$id/Download", "report.pdf") as PhoneFolders.NewIn.Plain
        assertEquals("report (1).pdf", into.file.name)
        assertEquals("Download", into.folderName)
        val fresh = phone.folderForNew("/$id/Download", "new.txt") as PhoneFolders.NewIn.Plain
        assertEquals(File(volume, "Download/new.txt").path, fresh.file.path)
        assertEquals("not_a_folder", error { phone.folderForNew("/$id/Download/report.pdf", "x") })
    }

    /**
     * Delete, rename and a new folder in "All files" (report 6eaf00): a
     * folder goes with all in it, but a link in it is removed itself, never
     * what it leads to; the volume's own top is never deleted or renamed.
     */
    @Test
    fun deletedRenamedAndMadeNeverPastALinkNorTheVolumeItself() {
        val phone = phone()
        val secret = tmp.root.resolve("data/data/io.github.r31l4nd.burrow").apply { mkdirs() }
        File(secret, "keys.txt").writeText("secret")
        File(volume, "Old/deeper").mkdirs()
        File(volume, "Old/deeper/a.txt").writeText("a")
        Files.createSymbolicLink(File(volume, "Old/out").toPath(), secret.toPath())
        File(volume, "notes.txt").writeText("n")
        val id = phone.rootsJson().getJSONObject(0).getString("id")
        val entries = phone.list("/$id").getJSONArray("entries")
        val notes = (0 until entries.length()).map { entries.getJSONObject(it) }.first { it.getString("name") == "notes.txt" }
        assertTrue(notes.getBoolean("deletable"))
        assertTrue(notes.getBoolean("renamable"))
        assertTrue(phone.list("/$id").getBoolean("canCreate"))

        assertEquals(listOf("Old" to true), phone.forDelete(listOf("/$id/Old")))
        assertEquals(1, phone.delete(listOf("/$id/Old")))
        assertFalse(File(volume, "Old").exists())
        assertEquals("secret", File(secret, "keys.txt").readText())

        assertEquals("/$id/kept.txt", phone.rename("/$id/notes.txt", "kept.txt").getString("path"))
        assertEquals("n", File(volume, "kept.txt").readText())
        assertEquals("/$id/Photos", phone.mkdir("/$id", "Photos").getString("path"))
        assertTrue(File(volume, "Photos").isDirectory)
        assertEquals("exists", error { phone.mkdir("/$id", "Photos") })
        assertEquals("exists", error { phone.rename("/$id/kept.txt", "Photos") })

        // The volume's own top: not this way (switched off in the app instead).
        assertEquals("bad_path", error { phone.delete(listOf("/$id")) })
        assertEquals("bad_path", error { phone.rename("/$id", "x") })
        assertTrue(volume.isDirectory)
    }

    /** Removing a folder of the list never touches the volume: "All files" is switched off in the app instead. */
    @Test
    fun theVolumeIsNotAFolderToRemove() {
        val phone = phone()
        val id = phone.rootsJson().getJSONObject(0).getString("id")
        phone.remove(id)
        assertEquals(1, phone.rootsJson().length())
        phone.clear()
        assertEquals(1, phone.rootsJson().length())
    }
}
