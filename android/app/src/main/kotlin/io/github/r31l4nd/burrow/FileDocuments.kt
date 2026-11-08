package io.github.r31l4nd.burrow

import android.provider.DocumentsContract.Document
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream

/**
 * "All files" (report 862305): the phone's storage volumes as plain files,
 * for PhoneFolders beside the folders granted through Android's picker. Only
 * while the person switched it on in Burrow and Android gave the app "All
 * files access" (MANAGE_EXTERNAL_STORAGE); off by default.
 *
 * A tree is a volume ("file:///storage/emulated/0"), a document id the
 * absolute path of a file in it. PhoneFolders still names a file by the
 * volume's id and names looked up child by child; here every path is
 * checked again to be inside its volume as it really is (a link that leads
 * out of it is neither listed nor opened). Pure java.io, for the JVM tests;
 * [share] makes the URI another app may read a file through (FileProvider).
 */
class FileDocuments(private val share: (File) -> String) : PhoneFolders.Documents {
    override fun parts(uri: String): Triple<String?, String?, String?> = java.net.URI(uri).let { Triple(it.scheme, it.rawAuthority, it.path) }

    override val ownPackage: String = ""

    // No permission of Android's per tree: the volumes come from the app, never from the page.
    override fun take(tree: String): Boolean = true

    override fun release(tree: String) {}

    override fun persisted(): List<String> = emptyList()

    override fun readable(): Set<String> = emptySet()

    /** The volume's folder, as it really is. */
    private fun top(tree: String): File {
        if (!tree.startsWith(SCHEME)) throw FileNotFoundException(tree)
        return File(tree.removePrefix(SCHEME)).canonicalFile
    }

    /** The file an id names, only when it is the volume itself or inside it. */
    private fun inside(tree: String, id: String): File {
        val root = top(tree)
        val f = File(id)
        if (!f.isAbsolute) throw FileNotFoundException(id)
        val real = f.canonicalFile
        if (real != root && !real.path.startsWith(root.path + File.separator)) throw SecurityException("outside the volume")
        return f
    }

    override fun topId(tree: String): String = top(tree).path

    private fun File.doc(): PhoneFolders.Doc {
        val dir = isDirectory
        // Deleted or renamed: a change to the folder it is in (PhoneFolders never offers a volume's own top).
        val inWritable = parentFile?.canWrite() == true
        val flags = (if (!dir && canWrite()) Document.FLAG_SUPPORTS_WRITE else 0) or (if (dir && canWrite()) Document.FLAG_DIR_SUPPORTS_CREATE else 0) or
            (if (inWritable) Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME else 0)
        return PhoneFolders.Doc(path, name, if (dir) Document.MIME_TYPE_DIR else Http.mimeOf(name), if (dir) 0 else length(), lastModified(), flags)
    }

    override fun doc(tree: String, id: String): PhoneFolders.Doc? {
        val f = inside(tree, id)
        return if (f.exists()) f.doc() else null
    }

    override fun children(tree: String, parent: String, limit: Int): List<PhoneFolders.Doc>? {
        val dir = inside(tree, parent)
        val root = top(tree)
        // Android/data and the like: listed as nothing by Android even with "All files access".
        val names = dir.list() ?: return null
        return names.asSequence()
            .map { File(dir, it) }
            .filter { f -> runCatching { f.canonicalFile.let { it == root || it.path.startsWith(root.path + File.separator) } }.getOrDefault(false) }
            .take(limit)
            .map { it.doc() }
            .toList()
    }

    override fun read(tree: String, id: String): InputStream = FileInputStream(inside(tree, id))

    override fun write(tree: String, id: String): OutputStream = FileOutputStream(inside(tree, id), false)

    override fun opener(tree: String, id: String): HeldFiles.Opener {
        val f = inside(tree, id)
        return object : HeldFiles.Opener {
            override fun channel() = FileInputStream(f).channel
            override fun stream(): InputStream = FileInputStream(f)
        }
    }

    override fun uri(tree: String, id: String): String = share(inside(tree, id))

    /** Not the volume itself: the top is never deleted or renamed. */
    private fun belowTop(tree: String, id: String): File {
        val f = inside(tree, id)
        if (f.canonicalFile == top(tree)) throw SecurityException("the volume itself")
        return f
    }

    /**
     * Gone, a folder with all in it, without following a link: a link is
     * removed itself, never what it leads to (which may be outside the volume).
     */
    override fun delete(tree: String, id: String) {
        val start = belowTop(tree, id).toPath()
        java.nio.file.Files.walkFileTree(
            start,
            object : java.nio.file.SimpleFileVisitor<java.nio.file.Path>() {
                override fun visitFile(file: java.nio.file.Path, attrs: java.nio.file.attribute.BasicFileAttributes): java.nio.file.FileVisitResult {
                    java.nio.file.Files.delete(file)
                    return java.nio.file.FileVisitResult.CONTINUE
                }

                override fun postVisitDirectory(dir: java.nio.file.Path, exc: java.io.IOException?): java.nio.file.FileVisitResult {
                    if (exc != null) throw exc
                    java.nio.file.Files.delete(dir)
                    return java.nio.file.FileVisitResult.CONTINUE
                }
            },
        )
    }

    override fun rename(tree: String, id: String, name: String): String {
        val f = belowTop(tree, id)
        val to = File(f.parentFile, name)
        if (to.exists() || !f.renameTo(to)) throw java.io.IOException("not renamed")
        return to.path
    }

    override fun mkdir(tree: String, parent: String, name: String): String {
        val f = File(inside(tree, parent), name)
        if (!f.mkdir()) throw java.io.IOException("not made")
        return f.path
    }

    override fun create(tree: String, parent: String, name: String, mime: String): String {
        val f = File(inside(tree, parent), name)
        if (!f.createNewFile()) throw java.io.IOException("not made")
        return f.path
    }

    /** A new file in a folder of a volume for a copy from a host: its name made free ("notes (1).txt" beside a "notes.txt"). */
    fun newFile(tree: String, folder: String, name: String): File {
        val dir = inside(tree, folder)
        if (!dir.isDirectory || !dir.canWrite()) throw SecurityException("read only")
        val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
        var f = File(dir, name)
        var n = 1
        while (f.exists() && n < 1000) f = File(dir, "${name.substring(0, dot)} ($n)${name.substring(dot)}").also { n++ }
        // Never one that is there: it was written over, and deleted when the copy failed (audit 2026-11-05).
        if (f.exists()) throw PhoneFolders.PhoneError("exists")
        return f
    }

    companion object {
        const val SCHEME = "file://"

        /** A volume as a folder of the page's list: a stable id from its path, and its name. */
        fun root(dir: File, name: String): PhonePaths.Root = PhonePaths.Root(PhonePaths.sha256(dir.path.toByteArray()).take(16), SCHEME + dir.path, FileNames.safe(name, "storage"), true)
    }
}
