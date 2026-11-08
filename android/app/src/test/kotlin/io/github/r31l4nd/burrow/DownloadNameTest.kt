package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DownloadNameTest {
    /** Burrow names a file as filename*=UTF-8''...: URLUtil.guessFileName reads only filename and saved it as "raw.bin" (report 1fb877). */
    @Test
    fun aDownloadKeepsTheNameItIsSentWith() {
        val url = "https://burrow.example/api/files/2/raw?path=%2Fmnt%2Fhdd%2FScript_output.log&download=1"
        assertEquals("Script_output.log", FileNames.forDownload(url, "attachment; filename*=UTF-8''Script_output.log", "application/octet-stream"))
        assertEquals("caf\u00e9 \"x\".bin".let { FileNames.safe(it) }, FileNames.forDownload(url, "attachment; filename=\"caf_ _x_.bin\"; filename*=UTF-8''caf%C3%A9%20%22x%22.bin", null))
        // filename* wins over filename, wherever it stands; then filename, quoted or not.
        assertEquals("\u00e9t\u00e9.txt", FileNames.forDownload(url, "inline; filename*=utf-8'nl'%C3%A9t%C3%A9.txt; filename=\"_t_.txt\"", null))
        assertEquals("a;b.txt", FileNames.forDownload(url, "attachment; filename=\"a;b.txt\"", null))
        assertEquals("plain.txt", FileNames.forDownload(url, "attachment; filename=plain.txt", null))
        assertEquals("q\"d.txt".let { FileNames.safe(it) }, FileNames.forDownload(url, "attachment; filename=\"q\\\"d.txt\"", null))
        assertEquals("\u00a3.txt", FileNames.forDownload(url, "attachment; filename*=ISO-8859-1''%A3.txt", null))
        // Still made safe: no path, no characters a file name cannot have.
        assertEquals("passwd", FileNames.forDownload(url, "attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd", null))
    }

    @Test
    fun aBrokenFilenameStarIsNotTaken() {
        assertNull(FileNames.fromDisposition(null))
        assertNull(FileNames.fromDisposition("attachment"))
        assertNull(FileNames.fromDisposition("attachment; filename*=UTF-8''%E9.txt"))
        assertNull(FileNames.fromDisposition("attachment; filename*=UTF-8''%zz.txt"))
        assertNull(FileNames.fromDisposition("attachment; filename*=KOI8-R''x.txt"))
        assertEquals("ok.txt", FileNames.fromDisposition("attachment; filename=\"ok.txt\"; filename*=UTF-8''%E9.txt"))
        assertNull(FileNames.fromDisposition("attachment; name=\"filename=x.txt\""))
    }
}
