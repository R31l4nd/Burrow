package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The phone's own files as the page names them (report a9552e): only names inside a granted folder. */
class PhonePathsTest {
    private val id = "0123456789abcdef"

    @Test
    fun takesAFolderAndNamesApart() {
        assertEquals(PhonePaths.Parsed(null, emptyList()), PhonePaths.parse("/"))
        assertEquals(PhonePaths.Parsed(id, emptyList()), PhonePaths.parse("/$id"))
        assertEquals(PhonePaths.Parsed(id, emptyList()), PhonePaths.parse("/$id/"))
        assertEquals(PhonePaths.Parsed(id, listOf("Notes", "todo list.txt")), PhonePaths.parse("/$id/Notes/todo list.txt"))
        // Names as the phone has them: spaces, dots inside, other scripts, a leading dot.
        assertEquals(listOf(".hidden", "a.b.c", "Foto\u00e9s van zee"), PhonePaths.parse("/$id/.hidden/a.b.c/Foto\u00e9s van zee")!!.names)
    }

    @Test
    fun refusesWaysOutOfTheFolder() {
        for (bad in listOf(
            null, "", "relative", "$id/x",
            "/$id/..", "/$id/../x", "/$id/a/../../etc", "/$id/./x", "/$id/a//b",
            "/$id/a\u0000b",
            // Not a folder id the app gave: a document id, a tree URI, another length, capitals.
            "/primary:Download", "/content:", "/0123456789ABCDEF/x", "/0123/x", "/${id}0/x", "/../x",
        )) {
            assertNull("refused: $bad", PhonePaths.parse(bad))
        }
    }

    @Test
    fun refusesWhatIsTooLong() {
        assertNull(PhonePaths.parse("/$id/" + "a".repeat(PhonePaths.MAX_NAME + 1)))
        assertEquals(1, PhonePaths.parse("/$id/" + "a".repeat(PhonePaths.MAX_NAME))!!.names.size)
        assertNull(PhonePaths.parse("/$id" + "/a".repeat(PhonePaths.MAX_DEPTH + 1)))
        assertEquals(PhonePaths.MAX_DEPTH, PhonePaths.parse("/$id" + "/a".repeat(PhonePaths.MAX_DEPTH))!!.names.size)
        assertNull(PhonePaths.parse("/$id/" + "abcdefgh/".repeat(600)))
    }

    @Test
    fun namesAndParents() {
        assertTrue(PhonePaths.nameOk("x"))
        for (bad in listOf("", ".", "..", "a/b", "a\u0000")) assertFalse("not a name: $bad", PhonePaths.nameOk(bad))
        assertTrue(PhonePaths.nameOk("..."))
        assertEquals("/$id/a/b", PhonePaths.join(id, listOf("a", "b")))
        assertEquals("/$id", PhonePaths.join(id, emptyList()))
        assertEquals("/$id/a", PhonePaths.parent(PhonePaths.parse("/$id/a/b")!!))
        assertEquals("/", PhonePaths.parent(PhonePaths.parse("/$id")!!))
        assertNull(PhonePaths.parent(PhonePaths.parse("/")!!))
        // What join made, parse takes back.
        assertEquals(listOf("a b", ".c"), PhonePaths.parse(PhonePaths.join(id, listOf("a b", ".c")))!!.names)
    }

    @Test
    fun onlyAnotherAppsTreeIsTaken() {
        val own = "io.github.r31l4nd.burrow"
        assertTrue(PhonePaths.acceptsTree("content", "com.android.externalstorage.documents", "/tree/primary:Documents", own))
        assertTrue(PhonePaths.acceptsTree("CONTENT", "10@com.android.externalstorage.documents", "/tree/primary:Download/Burrow", own))
        // A single document (not a folder tree), a file path, this app's own provider, none.
        assertFalse(PhonePaths.acceptsTree("content", "com.android.externalstorage.documents", "/document/primary:Documents", own))
        assertFalse(PhonePaths.acceptsTree("file", "", "/tree/x", own))
        assertFalse(PhonePaths.acceptsTree("content", "$own.files", "/tree/x", own))
        assertFalse(PhonePaths.acceptsTree("content", own, "/tree/x", own))
        assertFalse(PhonePaths.acceptsTree("content", null, "/tree/x", own))
        assertFalse(PhonePaths.acceptsTree("content", "com.android.externalstorage.documents", null, own))
    }

    @Test
    fun theFoldersKeptSurviveWhatIsBroken() {
        val roots = listOf(PhonePaths.Root(id, "content://com.android.externalstorage.documents/tree/primary%3ADocuments", "Documents", true))
        assertEquals(roots, PhonePaths.decodeRoots(PhonePaths.encodeRoots(roots)))
        assertEquals(emptyList<PhonePaths.Root>(), PhonePaths.decodeRoots(null))
        assertEquals(emptyList<PhonePaths.Root>(), PhonePaths.decodeRoots("not json"))
        // A bad id or a URI that is not a content one is left out; the rest stays.
        val mixed = """[{"id":"x","uri":"content://a/tree/b"},{"id":"$id","uri":"file:///sdcard"},{"id":"fedcba9876543210","uri":"content://a/tree/b","name":""}]"""
        assertEquals(listOf(PhonePaths.Root("fedcba9876543210", "content://a/tree/b", "?", false)), PhonePaths.decodeRoots(mixed))
    }

    @Test
    fun readLimits() {
        assertEquals(5 * 1024 * 1024, PhonePaths.MAX_TEXT)
        assertTrue(PhonePaths.isBinary(byteArrayOf(65, 0, 66)))
        assertFalse(PhonePaths.isBinary("plain text\n".toByteArray()))
        // A NUL after the first 8 KiB: still text (as on a host).
        assertFalse(PhonePaths.isBinary(ByteArray(9000) { if (it == 8500) 0 else 65 }))
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", PhonePaths.sha256(ByteArray(0)))
        assertEquals("1970-01-01T00:00:01Z", PhonePaths.isoTime(1000))
        assertNull(PhonePaths.isoTime(0))
        assertTrue(PhonePaths.newRootId().matches(Regex("[0-9a-f]{16}")))
    }
}
