package io.github.r31l4nd.burrow

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush
import java.io.File

/**
 * The page's way to the phone (web/src/lib/android.ts). Injected only into
 * the server's origin, and every message is checked again: main frame, that
 * origin. What the page can ask for is a short fixed list, and nothing on
 * it runs without the user seeing it (a fingerprint prompt, an app chooser,
 * a notification).
 */
class Bridge(private val activity: MainActivity, private val web: TermWebView, private val origin: String) : WebViewCompat.WebMessageListener {
    private val main = Handler(Looper.getMainLooper())
    private val app get() = activity.application as BurrowApp
    private val held get() = app.held
    private val prefs = Prefs(activity)
    private val phone by lazy { PhoneFolders(activity) }
    private val selection by lazy { SelectionMenu(web) { name, data -> emit(name, data) } }
    private var proxy: JavaScriptReplyProxy? = null
    // Read once on the UI thread: WebView refuses calls from other threads.
    private val userAgent: String = web.settings.userAgentString

    override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, reply: JavaScriptReplyProxy) {
        if (!BridgeProtocol.fromPage(isMainFrame, sourceOrigin.toString(), origin)) return
        val req = BridgeProtocol.parse(message.data ?: return) ?: return
        proxy = reply
        val answer: (Result<Any?>) -> Unit = { r ->
            main.post {
                WebSetup.send(
                    reply,
                    r.fold({ BridgeProtocol.result(req.id, it) }, { BridgeProtocol.error(req.id, it.message ?: it.javaClass.simpleName) }),
                )
            }
        }
        try {
            handle(req.method, req.params, answer)
        } catch (e: Exception) {
            answer(Result.failure(e))
        }
    }

    /** Push an event to the page (when it has said hello since loading). */
    fun emit(name: String, data: Any?) {
        main.post { WebSetup.send(proxy, BridgeProtocol.event(name, data)) }
    }

    private fun background(answer: (Result<Any?>) -> Unit, work: () -> Any?) {
        WebSetup.io.execute { answer(runCatching(work)) }
    }

    private fun sameOriginUrl(p: JSONObject): String = BridgeRules.sameOrigin(p.getString("url"), origin)

    private fun cookie(url: String): String? = CookieManager.getInstance().getCookie(url)

    private fun handle(method: String, p: JSONObject, answer: (Result<Any?>) -> Unit) {
        when (method) {
            "hello" -> answer(Result.success(null))

            "info" -> answer(
                Result.success(
                    BridgeProtocol.obj(
                        "version" to BuildConfig.VERSION_NAME,
                        "versionCode" to BuildConfig.VERSION_CODE,
                        "deviceId" to prefs.deviceId?.takeIf { DeviceKey.exists(prefs) },
                        "deviceName" to deviceName(),
                        "profiles" to WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
                        "screenshots" to (!Insets.secureBuild(prefs) || prefs.allowScreenshots),
                        "screenshotsFixed" to !Insets.secureBuild(prefs),
                        "shake" to prefs.shakeReport,
                        "selectionMenu" to true,
                        "qrCamera" to true,
                        "phoneFiles" to true,
                        // Delete, rename and a new folder on the phone (report 6eaf00; apps from 2.18.0).
                        "phoneChange" to true,
                        // Archives as folders, unpacked; open with (the chooser), share (report 99d993).
                        "phoneArchives" to true,
                        // forgetDevice, wgSave and setScreenshots(true) are asked by the app itself; the page does not ask too.
                        "asksItself" to true,
                        "phoneAllFiles" to AllFiles.available,
                        "widget" to true,
                    ),
                ),
            )

            "createKey" -> background(answer) { BridgeProtocol.obj("publicKey" to DeviceKey.create(prefs)) }

            "saveDevice" -> {
                // Paired: the new key takes over from the old one only now.
                DeviceKey.commit(prefs)
                prefs.deviceId = p.getLong("deviceId")
                answer(Result.success(null))
            }

            // Asked by the app itself (audit 2026-11-05): the page alone cannot make the phone
            // forget its keys. The page does not ask again, and unpairs on the server after it.
            "forgetDevice" -> confirm(R.string.forget_ask_title, activity.getString(R.string.forget_ask_text), R.string.forget_ask_ok, true, answer) {
                DeviceKey.delete(prefs)
                DirectKey.delete()
                DirectStore(activity).clear()
                prefs.deviceId = null
                answer(Result.success(null))
            }

            // ---- the direct route (phase 5)

            "sshPublicKey" -> background(answer) { BridgeProtocol.obj("publicKey" to DirectKey.openSshLine()) }

            "syncDirect" -> {
                val c = cookie(origin)
                background(answer) { BridgeProtocol.obj("ok" to DirectStore(activity).sync(origin, c, app.wireguard.proxyFor(Uri.parse(origin).host, origin))) }
            }

            "openDirect" -> {
                activity.openDirect(p.optLong("hostId").takeIf { it > 0 })
                answer(Result.success(null))
            }

            // ---- the app's own WireGuard (phase 13). The configuration goes
            // from the page to the phone only; the page never gets the key back.

            "wgStatus" -> answer(Result.success(app.wireguard.summary()))

            // Where it would send the phone's traffic, asked by the app itself: a page could
            // otherwise put in a tunnel of someone else's (audit 2026-11-05).
            "wgSave" -> {
                val conf = p.getString("conf")
                val endpoint = BridgeRules.wgEndpoint(conf) ?: "?"
                confirm(R.string.wg_ask_title, activity.getString(R.string.wg_ask_text, endpoint), R.string.wg_ask_ok, false, answer) {
                    background(answer) {
                        val problem = app.wireguard.save(conf)
                        if (problem == null) main.post { activity.recheckTunnel() }
                        BridgeProtocol.obj("error" to problem)
                    }
                }
            }

            // Read with the camera and kept here: the configuration (its private
            // key) never goes through the page.
            "wgScan" -> activity.scanQr { text ->
                if (text == null) answer(Result.success(BridgeProtocol.obj("cancelled" to true)))
                else background(answer) {
                    val problem = if (text.contains("[Interface]")) app.wireguard.save(text) else activity.getString(R.string.wg_scan_not)
                    if (problem == null) main.post { activity.recheckTunnel() }
                    BridgeProtocol.obj("error" to problem)
                }
            }

            // Not on the main thread: stopping waits for a start that may be resolving a name (an ANR, audit 2026-11-05).
            "wgRemove" -> background(answer) {
                app.wireguard.remove()
                null
            }

            "wgTargets" -> {
                val wg = app.wireguard
                wg.viaBurrow = p.getBoolean("viaBurrow")
                wg.hosts = BridgeRules.tunnelHosts(p.getJSONArray("hosts"))
                activity.recheckTunnel()
                answer(Result.success(wg.summary()))
            }

            // A newer app from this Burrow (Settings -> Android): fetched with
            // this page's cookie, checked against the SHA-256 Burrow gives,
            // then Android's own installer asks the person.
            "installUpdate" -> {
                val sha = p.getString("sha256")
                if (!activity.packageManager.canRequestPackageInstalls()) {
                    // Once: Android asks whether Burrow may install apps.
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                    answer(Result.success(BridgeProtocol.obj("state" to "permission")))
                    return
                }
                // One at a time: a second tap waits for the update already on its way, it does not
                // empty its folder under it (AUDIT2 AND-12).
                Downloads.runningUpdate()?.let { going ->
                    background(answer) {
                        going.await()
                        if (going.state != Downloads.State.DONE) throw IllegalStateException(going.error ?: "stopped")
                        BridgeProtocol.obj("state" to "installing")
                    }
                    return
                }
                val url = "$origin/api/android/burrow.apk"
                val ctx = activity.applicationContext
                val install = { file: File ->
                    main.post {
                        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", file)
                        runCatching {
                            ctx.startActivity(
                                Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }.onFailure { android.widget.Toast.makeText(ctx, R.string.no_app, android.widget.Toast.LENGTH_LONG).show() }
                    }
                }
                // Downloaded already and checked (a second tap, the installer maybe still open on it):
                // handed over again, not deleted from under it (review 2026-10-24).
                // By the checked sum kept beside it: hashing the file again on this thread took a moment.
                val ready = File(activity.cacheDir, "update/burrow.apk")
                if (BridgeRules.readyUpdate(ready, sha)) {
                    install(ready)
                    answer(Result.success(BridgeProtocol.obj("state" to "installing")))
                    return
                }
                val dir = File(activity.cacheDir, "update").apply {
                    deleteRecursively()
                    mkdirs()
                }
                // The app's own download (its progress in the notification and
                // on the page); checked and handed to the installer once done,
                // also after a Retry from the notification.
                val item = Downloads.start(activity, url, "burrow.apk", "update", Downloads.Target.Private(File(dir, "burrow.apk")), { cookie(url) }, { app.wireguard.proxyFor(Uri.parse(url).host, origin) }, userAgent) { d ->
                    val file = (d.target as Downloads.Target.Private).file
                    if (!BridgeRules.updateMatches(file, sha)) {
                        file.delete()
                        d.state = Downloads.State.FAILED
                        d.done = 0
                        d.error = ctx.getString(R.string.update_sha_mismatch)
                        return@start
                    }
                    BridgeRules.markChecked(file, sha)
                    install(file)
                }
                background(answer) {
                    item.await()
                    if (item.state != Downloads.State.DONE) throw IllegalStateException(item.error ?: "stopped")
                    BridgeProtocol.obj("state" to "installing")
                }
            }

            // The app's own downloads (Downloads.kt): the list now, Stop and Retry;
            // changes follow as "downloads".
            "downloads" -> answer(Result.success(Downloads.json()))

            "stopDownload" -> {
                Downloads.stop(activity, p.getInt("id"))
                answer(Result.success(null))
            }

            "retryDownload" -> {
                Downloads.retry(activity, p.getInt("id"))
                answer(Result.success(null))
            }

            // Burrow's own push (Push.kt): where it reaches this phone, if on.
            "pushState" -> answer(Result.success(pushState()))

            // On: the phone's UnifiedPush distributor (asked once which, if
            // there are several); the address comes later as "pushEndpoint".
            "pushRegister" -> {
                askNotifications()
                val vapid = p.optString("vapid").ifEmpty { null }
                UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { ok ->
                    if (!ok) {
                        answer(Result.failure(IllegalStateException(activity.getString(R.string.no_distributor))))
                        return@tryUseCurrentOrDefaultDistributor
                    }
                    UnifiedPush.register(activity, vapid = vapid)
                    answer(Result.success(null))
                }
            }

            // The home screen widget (2.11.0): how it gets its numbers away from home, and whether there is one.
            "widgetState" -> answer(Result.success(BridgeProtocol.obj("away" to prefs.widgetAway, "placed" to Widget.placed(activity))))
            // The widget's own key, for the page to tell Burrow (signed in on this phone).
            "widgetKey" -> background(answer) { BridgeProtocol.obj("publicKey" to WidgetKey.publicKey()) }
            "setWidgetAway" -> {
                val away = p.optString("away")
                if (away !in setOf("tunnel", "last", "push")) return answer(Result.failure(IllegalArgumentException("unknown: $away")))
                prefs.widgetAway = away
                Widget.poke(activity)
                answer(Result.success(null))
            }

            "pushUnregister" -> {
                UnifiedPush.unregister(activity)
                prefs.pushEndpoint = null
                answer(Result.success(null))
            }

            "terminal" -> {
                TerminalMode.apply(activity, web, p)
                answer(Result.success(null))
            }

            "chrome" -> {
                // "#rrggbb" or "#rgb" from the page's own CSS; anything else is ignored.
                BridgeRules.topColor(p.optString("top"))?.let { color -> main.post { activity.paintTop(android.graphics.Color.parseColor(color)) } }
                answer(Result.success(null))
            }

            // A problem report's picture: the page as on the screen (Screenshot.kt).
            "screenshot" -> main.post { Screenshot.take(activity, web, p.optInt("maxWidth"), answer) }

            "selectionMenu" -> {
                selection.show(p)
                answer(Result.success(null))
            }

            "setShake" -> {
                prefs.shakeReport = p.getBoolean("on")
                activity.listenForShake()
                answer(Result.success(null))
            }

            // Allowed only when the person says so in the app's own question: FLAG_SECURE off shows
            // keys and terminals to screenshots and the app switcher (audit 2026-11-05). Off needs no question.
            "setScreenshots" -> {
                val set = {
                    prefs.allowScreenshots = p.getBoolean("allow")
                    Insets.secure(activity.window)
                    answer(Result.success(null))
                }
                if (!p.getBoolean("allow") || prefs.allowScreenshots) set()
                else confirm(R.string.shots_ask_title, activity.getString(R.string.shots_ask_text), R.string.shots_ask_ok, false, answer, set)
            }

            "uiPrefs" -> {
                val keep = BridgeRules.uiPrefs(p.optJSONObject("values"))
                val changed = prefs.uiPrefs != keep
                prefs.uiPrefs = keep
                // Burrow's light/dark choice also for the app's own screens.
                if (changed) {
                    main.post {
                        Style.applyNightMode(activity)
                        activity.refreshBackground()
                    }
                }
                answer(Result.success(null))
            }

            "sign" -> {
                val message = p.getString("message")
                require(DeviceMessage.purpose(message, origin) != null) { "not a Burrow sign-in message" }
                val sig = try {
                    DeviceKey.signature(prefs)
                } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
                    // New fingerprints were enrolled: the key is void by design.
                    DeviceKey.delete(prefs)
                    prefs.deviceId = null
                    null
                } ?: throw IllegalStateException("no device key; pair again")
                Biometrics.sign(activity, Uri.parse(origin).host ?: origin, sig, message.toByteArray()) { r ->
                    answer(r.map { BridgeProtocol.obj("signature" to Base64.encodeToString(it, Base64.NO_WRAP)) })
                }
            }

            "openWith" -> {
                val url = sameOriginUrl(p)
                val name = FileNames.safe(p.getString("name"))
                val editable = p.optBoolean("editable", false)
                val token = held.newToken()
                background(answer) {
                    val file = fetch(url, File(activity.cacheDir, "open/$token"), name)
                    val h = held.add(
                        HeldFiles.Held(
                            token, HeldFiles.Kind.OPENED, file.name, Http.mimeOf(file.name), file.length(), HeldFiles.fileOpener(file),
                            hostId = p.optLong("hostId"), path = p.optString("path"), local = file, stamp = file.lastModified(),
                        ),
                    )
                    main.post {
                        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
                        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, h.mime)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or if (editable) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
                        try {
                            activity.startActivity(intent)
                        } catch (e: ActivityNotFoundException) {
                            held.remove(token)
                            activity.toast(activity.getString(R.string.no_app))
                        }
                    }
                    null
                }
            }

            // Text the page made (an exported log), into Downloads/Burrow: a blob link the page
            // makes goes nowhere in a WebView (AUDIT2 AND-11).
            "saveText" -> {
                val name = FileNames.safe(p.getString("name"))
                val text = p.getString("text")
                background(answer) {
                    BridgeRules.savedText(text)
                    val resolver = activity.contentResolver
                    val uri = resolver.insert(
                        android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        android.content.ContentValues().apply {
                            put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name)
                            put(android.provider.MediaStore.Downloads.MIME_TYPE, "text/plain")
                            put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "${android.os.Environment.DIRECTORY_DOWNLOADS}/Burrow")
                        },
                    ) ?: error("MediaStore refused the file")
                    resolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) } ?: error("the file could not be written")
                    null
                }
            }

            "share" -> {
                val url = sameOriginUrl(p)
                val name = FileNames.safe(p.getString("name"))
                background(answer) {
                    val file = fetch(url, File(activity.cacheDir, "share/${held.newToken()}"), name)
                    main.post {
                        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
                        val send = Intent(Intent.ACTION_SEND).setType(Http.mimeOf(file.name)).putExtra(Intent.EXTRA_STREAM, uri)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        activity.startActivity(Intent.createChooser(send, file.name))
                    }
                    null
                }
            }

            // What was shared or opened is shown and read only once Burrow is
            // unlocked: the page behind the cover waits for the answer.
            "sharedFiles" -> app.whenUnlocked {
                answer(
                    Result.success(
                        BridgeProtocol.array(
                            held.list(HeldFiles.Kind.SHARED).map { BridgeProtocol.obj("token" to it.token, "name" to it.name, "mime" to it.mime, "size" to it.size) },
                        ),
                    ),
                )
            }

            "read" -> {
                val token = p.getString("token")
                val offset = p.getLong("offset")
                val length = p.getInt("length")
                app.whenUnlocked { background(answer) { BridgeProtocol.obj("data" to Base64.encodeToString(held.read(token, offset, length), Base64.NO_WRAP)) } }
            }

            "release" -> {
                held.remove(p.getString("token"))
                answer(Result.success(null))
            }

            // ---- the phone's own files (Files -> This phone): only folders the
            // person picked in Android's folder picker (PhoneFolders), read and
            // written by the app; nothing of it goes to Burrow unless the person
            // copies a file to a host. Like shared files, only once unlocked.

            "phoneRoots" -> app.whenUnlocked { background(answer) { phone.rootsJson() } }

            // "All files" (report 862305): off by default; on only by the person, here
            // after the page's warning, and with Android's "All files access" too.
            "phoneAllFiles" -> answer(Result.success(AllFiles.status(prefs)))

            "phoneSetAllFiles" -> {
                val on = p.getBoolean("on")
                app.whenUnlocked {
                    if (!on || !AllFiles.available) {
                        prefs.allFiles = false
                        answer(Result.success(AllFiles.status(prefs)))
                    } else {
                        activity.askAllFiles { granted ->
                            prefs.allFiles = granted
                            answer(Result.success(AllFiles.status(prefs)))
                        }
                    }
                }
            }

            // Android's own screen for the permission: to take it back there.
            "phoneAllFilesSettings" -> {
                runCatching { activity.startActivity(AllFiles.settingsIntent(activity)) }
                answer(Result.success(null))
            }

            "phoneAddRoot" -> {
                val start = SafDocuments.startAt(p.optString("start"))
                app.whenUnlocked {
                    activity.pickFolder(start) { uri ->
                        if (uri == null) answer(Result.success(BridgeProtocol.obj("cancelled" to true)))
                        else background(answer) { phone.add(uri.toString()).let { BridgeProtocol.obj("id" to it.id, "name" to it.name, "writable" to it.writable) } }
                    }
                }
            }

            // Removed from the list, and its permission given back to Android.
            "phoneRemoveRoot" -> {
                val id = p.getString("id")
                background(answer) {
                    phone.remove(id)
                    null
                }
            }

            "phoneList" -> {
                val path = p.getString("path")
                app.whenUnlocked { background(answer) { phone.list(path) } }
            }

            "phoneText" -> {
                val path = p.getString("path")
                app.whenUnlocked { background(answer) { phone.text(path) } }
            }

            "phoneSaveText" -> {
                val path = p.getString("path")
                val content = p.getString("content")
                val base = p.getString("baseHash")
                app.whenUnlocked { background(answer) { phone.saveText(path, content, base) } }
            }

            // Delete, rename, a new folder (report 6eaf00), where the person gave
            // write access. A delete is asked by the app itself, in its own
            // dialog: the page (or whoever controls the server) cannot delete a
            // file of the phone without the person's tap here.
            "phoneDelete" -> {
                val paths = BridgeRules.holdPaths(p.getJSONArray("paths"))
                app.whenUnlocked {
                    background({ r ->
                        r.onFailure { answer(Result.failure(it)) }.onSuccess { found ->
                            @Suppress("UNCHECKED_CAST")
                            val asked = found as Pair<List<Pair<String, Boolean>>, List<String>>
                            val (names, marks) = asked
                            main.post { askDelete(names, paths, marks, answer) }
                        }
                    }) { phone.forDelete(paths) to phone.marks(paths) }
                }
            }

            "phoneRename" -> {
                val path = p.getString("path")
                val name = p.getString("name")
                app.whenUnlocked { background(answer) { phone.rename(path, name) } }
            }

            "phoneMkdir" -> {
                val dir = p.getString("dir")
                val name = p.getString("name")
                app.whenUnlocked { background(answer) { phone.mkdir(dir, name) } }
            }

            // Held by token and read with "read" in 1 MiB pieces: to show a picture
            // ("view"), or to upload to a host ("upload": the share page's list).
            "phoneHold" -> {
                val paths = BridgeRules.holdPaths(p.getJSONArray("paths"))
                val kind = BridgeRules.holdKind(p.optString("purpose"))
                app.whenUnlocked { background(answer) { phone.hold(paths, kind, held) } }
            }

            // Another app shows it (a PDF, a video, an APK installed): read only.
            // `chooser`: always Android's list of apps ("Open with", report 99d993).
            "phoneOpen" -> {
                val path = p.getString("path")
                val chooser = p.optBoolean("chooser", false)
                app.whenUnlocked {
                    background(answer) {
                        val (uri, mime) = phone.forViewing(path)
                        main.post { view(Uri.parse(uri), mime, chooser, path.substringAfterLast('/')) }
                        null
                    }
                }
            }

            // Android's share list for files of the phone (one or a selection).
            "phoneShare" -> {
                val paths = BridgeRules.sharePaths(p.getJSONArray("paths"))
                app.whenUnlocked {
                    background(answer) {
                        val items = paths.map { phone.forViewing(it) }
                        main.post {
                            val uris = ArrayList(items.map { Uri.parse(it.first) })
                            val mime = items.map { it.second }.distinct().singleOrNull() ?: "*/*"
                            val send = if (uris.size == 1) Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
                            else Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                            send.setType(mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            // The receiving app reads the URIs through the clip, the grant goes with it.
                            send.clipData = android.content.ClipData.newRawUri("", uris[0]).apply { uris.drop(1).forEach { addItem(android.content.ClipData.Item(it)) } }
                            activity.startActivity(Intent.createChooser(send, null))
                        }
                        null
                    }
                }
            }

            // An archive as a folder (zip, jar, apk, tar, tar.gz): what is in its folder `inner`.
            "phoneArchive" -> {
                val path = p.getString("path")
                val inner = p.optString("inner", "")
                app.whenUnlocked { background(answer) { phone.archive(path, inner) } }
            }

            // One file of an archive, taken out into the app's cache, shown by another app.
            "phoneArchiveOpen" -> {
                val path = p.getString("path")
                val inner = p.getString("inner")
                val chooser = p.optBoolean("chooser", false)
                app.whenUnlocked {
                    background(answer) {
                        val dir = File(activity.cacheDir, "open/archive")
                        // One at a time: the one before is no longer shown by anyone.
                        dir.deleteRecursively()
                        val file = phone.archiveEntry(path, inner, File(dir, held.newToken()))
                        main.post { view(FileProvider.getUriForFile(activity, "${activity.packageName}.files", file), Http.mimeOf(file.name), chooser, file.name) }
                        null
                    }
                }
            }

            // Unpacked into a new folder beside it, with progress ("phoneProgress" events).
            "phoneUnpack" -> {
                val path = p.getString("path")
                val id = p.getString("id")
                app.whenUnlocked {
                    background(answer) {
                        val u = phone.forUnpack(path)
                        TransferService.add(activity, "native", 1, u.folder)
                        try {
                            var last = 0L
                            phone.unpack(path, u) { done ->
                                val now = System.currentTimeMillis()
                                if (now - last >= 250) {
                                    last = now
                                    emit("phoneProgress", BridgeProtocol.obj("id" to id, "done" to done, "total" to u.total))
                                }
                            }
                        } finally {
                            TransferService.add(activity, "native", -1, "")
                        }
                    }
                }
            }

            // A host's file into a folder of the phone: the app's own download
            // (its progress in the notification and in "downloads").
            "phoneSaveFrom" -> {
                val url = sameOriginUrl(p)
                val name = FileNames.safe(p.getString("name"))
                val dir = p.getString("dir")
                app.whenUnlocked {
                    background(answer) {
                        val target = when (val into = phone.folderForNew(dir, name)) {
                            is PhoneFolders.NewIn.Tree -> Downloads.Target.Document(into.uri, into.folderName)
                            is PhoneFolders.NewIn.Plain -> Downloads.Target.Private(into.file, into.folderName)
                        }
                        // In a folder of "All files": the name made free there ("notes (1).txt").
                        val item = Downloads.start(activity, url, (target as? Downloads.Target.Private)?.file?.name ?: name, "file", target, { cookie(url) }, { app.wireguard.proxyFor(Uri.parse(url).host, origin) }, userAgent)
                        BridgeProtocol.obj("id" to item.id)
                    }
                }
            }

            "transfers" -> {
                val n = p.getInt("active")
                if (n > 0) askNotifications()
                TransferService.set(activity, "web", n, p.optString("label"))
                answer(Result.success(null))
            }

            "shortcuts" -> {
                Shortcuts.set(activity, BridgeRules.shortcutHosts(p.getJSONArray("hosts")))
                answer(Result.success(null))
            }

            "openApps" -> answer(Result.success(BridgeProtocol.array(synchronized(AppTabsActivity.openIds) { AppTabsActivity.openIds.toList() })))

            "openApp" -> {
                val url = BridgeRules.appUrl(p.getString("url"))
                activity.startActivity(
                    Intent(activity, AppTabsActivity::class.java)
                        .putExtra(AppTabsActivity.EXTRA_ID, p.getLong("id"))
                        .putExtra(AppTabsActivity.EXTRA_NAME, p.getString("name"))
                        .putExtra(AppTabsActivity.EXTRA_URL, url),
                )
                answer(Result.success(null))
            }

            else -> answer(Result.failure(IllegalArgumentException("unknown method $method")))
        }
    }

    /**
     * The app's own question for something a page asked for; no answer (Cancel, Back, the cross)
     * is {cancelled: true} to the page. [onOk] answers itself.
     */
    private fun confirm(title: Int, text: String, ok: Int, danger: Boolean, answer: (Result<Any?>) -> Unit, onOk: () -> Unit) {
        main.post {
            var answered = false
            Style.ask(activity, activity.getString(title), Style.askText(activity, text), activity.getString(ok), danger = danger, guarded = true, onDismiss = {
                if (!answered) answer(Result.success(BridgeProtocol.obj("cancelled" to true)))
            }) {
                answered = true
                onOk()
            }.show()
        }
    }

    /** Shown by another app: Android's choice, or always its list of apps ([chooser]). */
    private fun view(uri: Uri, mime: String, chooser: Boolean, title: String) {
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            activity.startActivity(if (chooser) Intent.createChooser(intent, title) else intent)
        } catch (e: ActivityNotFoundException) {
            activity.toast(activity.getString(R.string.no_app))
        }
    }

    /** The app's own question before a delete: the names (five at most, then how many more), and that it cannot be undone. */
    private fun askDelete(found: List<Pair<String, Boolean>>, paths: List<String>, marks: List<String>, answer: (Result<Any?>) -> Unit) {
        var answered = false
        val names = found.take(5).map { (name, dir) -> if (dir) activity.getString(R.string.phone_delete_folder, name) else name }
        val more = found.size - names.size
        val lines = names + (if (more > 0) listOf(activity.resources.getQuantityString(R.plurals.phone_delete_more, more, more)) else emptyList()) + activity.getString(R.string.phone_delete_note)
        Style.ask(activity, activity.getString(R.string.phone_delete_title), Style.askText(activity, *lines.toTypedArray()), activity.getString(R.string.phone_delete_ok), danger = true, onDismiss = {
            if (!answered) answer(Result.success(BridgeProtocol.obj("cancelled" to true)))
        }) {
            answered = true
            // Exactly what was named: anything swapped in meanwhile is refused.
            background(answer) { BridgeProtocol.obj("deleted" to phone.delete(paths, marks)) }
        }.show()
    }

    private fun fetch(url: String, dir: File, name: String): File {
        TransferService.add(activity, "native", 1, name)
        try {
            return Http.toFile(url, cookie(url), userAgent, dir, name, app.wireguard.proxyFor(Uri.parse(url).host, origin))
        } finally {
            TransferService.add(activity, "native", -1, "")
        }
    }

    /** Opened files that another app saved since: offer them back to the page. */
    fun checkChanged() {
        for (h in held.list(HeldFiles.Kind.OPENED)) {
            val f = h.local ?: continue
            if (f.exists() && f.lastModified() != h.stamp) {
                h.stamp = f.lastModified()
                h.size = f.length()
                emit(
                    "fileChanged",
                    BridgeProtocol.obj("token" to h.token, "name" to h.name, "mime" to h.mime, "size" to h.size, "hostId" to h.hostId, "path" to h.path),
                )
            }
        }
    }

    private fun pushState(): Any? = prefs.pushEndpoint?.let { JSONObject(it) }

    private val downloadsChanged: () -> Unit = { emit("downloads", Downloads.json()) }

    // Kept by the app: cleared when this page goes, or it held the activity and its WebView (audit 2026-11-05).
    private val pushChanged: () -> Unit = { emit("pushEndpoint", pushState()) }

    init {
        // A new address (or none) while the page is open: it tells Burrow.
        app.pushChanged = pushChanged
        Downloads.listeners.add(downloadsChanged)
    }

    /** The page's activity is gone: no more events for it. */
    fun dispose() {
        Downloads.listeners.remove(downloadsChanged)
        if (app.pushChanged === pushChanged) app.pushChanged = null
    }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || prefs.askedNotifications) return
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        prefs.askedNotifications = true
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    private fun deviceName(): String =
        Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()
}
