package io.github.r31l4nd.burrow

import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.InputStream
import java.io.OutputStream

/**
 * PhoneFolders' documents on Android: the Storage Access Framework's
 * persisted permissions and the granted trees' own URIs (Android checks
 * each one again). Reached by the device test (PhoneFilesTest), not the
 * JVM tests.
 */
class SafDocuments(private val context: Context) : PhoneFolders.Documents {
    private val resolver get() = context.contentResolver

    override fun parts(uri: String): Triple<String?, String?, String?> = Uri.parse(uri).let { Triple(it.scheme, it.authority, it.path) }

    override val ownPackage: String get() = context.packageName

    override fun take(tree: String): Boolean {
        val uri = Uri.parse(tree)
        return runCatching { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }.isSuccess ||
            run {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                false
            }
    }

    override fun release(tree: String) {
        val uri = Uri.parse(tree)
        runCatching { resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
            .onFailure { runCatching { resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
    }

    override fun persisted(): List<String> = resolver.persistedUriPermissions.map { it.uri.toString() }

    override fun readable(): Set<String> = resolver.persistedUriPermissions.filter { it.isReadPermission }.map { it.uri.toString() }.toSet()

    override fun topId(tree: String): String = DocumentsContract.getTreeDocumentId(Uri.parse(tree))

    private fun docUri(tree: String, id: String): Uri = DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), id)

    override fun uri(tree: String, id: String): String = docUri(tree, id).toString()

    private fun Cursor.doc(): PhoneFolders.Doc = PhoneFolders.Doc(
        getString(0) ?: "",
        getString(1) ?: "",
        getString(2) ?: "application/octet-stream",
        if (isNull(3)) 0 else getLong(3),
        if (isNull(4)) 0 else getLong(4),
        if (isNull(5)) 0 else getInt(5),
    )

    override fun doc(tree: String, id: String): PhoneFolders.Doc? =
        resolver.query(docUri(tree, id), PROJECTION, null, null, null)?.use { c -> if (c.moveToFirst()) c.doc() else null }

    override fun children(tree: String, parent: String, limit: Int): List<PhoneFolders.Doc>? =
        resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(Uri.parse(tree), parent), PROJECTION, null, null, null)?.use { c ->
            val out = ArrayList<PhoneFolders.Doc>()
            while (out.size < limit && c.moveToNext()) out.add(c.doc())
            out
        }

    override fun read(tree: String, id: String): InputStream? = resolver.openInputStream(docUri(tree, id))

    // "wt" truncates; a provider that does not know it gets "w" (which some truncate anyway).
    override fun write(tree: String, id: String): OutputStream? {
        val uri = docUri(tree, id)
        return runCatching { resolver.openOutputStream(uri, "wt") }.getOrNull() ?: resolver.openOutputStream(uri, "w")
    }

    /** A provider's own refusal (IllegalStateException, UnsupportedOperationException): not done; a lost permission stays itself. */
    private fun <T> done(f: () -> T?): T = try {
        f() ?: throw java.io.IOException("not done")
    } catch (e: SecurityException) {
        throw e
    } catch (e: RuntimeException) {
        throw java.io.IOException(e)
    }

    override fun delete(tree: String, id: String) {
        if (!done { DocumentsContract.deleteDocument(resolver, docUri(tree, id)) }) throw java.io.IOException("not deleted")
    }

    override fun rename(tree: String, id: String, name: String): String = DocumentsContract.getDocumentId(done { DocumentsContract.renameDocument(resolver, docUri(tree, id), name) })

    override fun mkdir(tree: String, parent: String, name: String): String = DocumentsContract.getDocumentId(done { DocumentsContract.createDocument(resolver, docUri(tree, parent), Document.MIME_TYPE_DIR, name) })

    override fun create(tree: String, parent: String, name: String, mime: String): String = DocumentsContract.getDocumentId(done { DocumentsContract.createDocument(resolver, docUri(tree, parent), mime, name) })

    override fun opener(tree: String, id: String): HeldFiles.Opener {
        val uri = docUri(tree, id)
        return object : HeldFiles.Opener {
            override fun channel() = resolver.openFileDescriptor(uri, "r")?.let { ParcelFileDescriptor.AutoCloseInputStream(it).channel }
            override fun stream(): InputStream = resolver.openInputStream(uri) ?: throw PhoneFolders.PhoneError("not_found")
        }
    }

    companion object {
        const val EXTERNAL = "com.android.externalstorage.documents"

        /** Where the picker starts: the phone's Documents or Download folder, or where it was last. */
        fun startAt(where: String): Uri? = when (where) {
            "documents" -> DocumentsContract.buildDocumentUri(EXTERNAL, "primary:Documents")
            "downloads" -> DocumentsContract.buildDocumentUri(EXTERNAL, "primary:Download")
            else -> null
        }

        private val PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
        )
    }
}

/**
 * Android's own folder picker (ACTION_OPEN_DOCUMENT_TREE), registered when
 * the activity is made, like QrScan: [pick] gives the folder the person
 * chose, or null when they went back.
 */
class FolderPick(activity: androidx.appcompat.app.AppCompatActivity) {
    private var pending: ((Uri?) -> Unit)? = null
    private val launcher = activity.registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree()) { uri ->
        val done = pending ?: return@registerForActivityResult
        pending = null
        done(uri)
    }

    fun pick(start: Uri?, done: (Uri?) -> Unit) {
        // A second pick asked while one is open: the first one is over.
        pending?.invoke(null)
        pending = done
        launcher.launch(start)
    }
}
