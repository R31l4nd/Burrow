package io.github.r31l4nd.burrow

import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.common.SecurityUtils
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.sftp.FileMode
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import java.io.InputStreamReader
import java.nio.charset.Charset
import java.security.PublicKey
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * One direct SSH session: the phone's own connection to a host, used when
 * Burrow cannot be reached. Host keys are checked against what Burrow
 * trusts (HostKeys); the login uses the Keystore key (DirectKey).
 */
class DirectSsh private constructor(
    val id: String,
    private val client: SSHClient,
    private val session: Session,
    private val shell: Session.Shell,
    /** In tmux on the host: leaving detaches, the next connect attaches again. */
    val kept: Boolean,
) {
    private var sftp: SFTPClient? = null

    sealed class Connected {
        class Ok(val ssh: DirectSsh) : Connected()
        class Forwarding(val forward: Forward) : Connected()
        class HostKey(val verdict: HostKeys.Verdict, val keyB64: String) : Connected()
        class Failed(val status: String, val message: String) : Connected()
    }

    /** SSH keepalives every [seconds] (0: none), for a session kept open in the background. */
    fun keepAlive(seconds: Int) {
        client.connection.keepAlive.keepAliveInterval = seconds
    }

    fun input(data: String, charset: Charset) {
        shell.outputStream.write(data.toByteArray(charset))
        shell.outputStream.flush()
    }

    fun resize(cols: Int, rows: Int) = shell.changeWindowDimensions(cols, rows, 0, 0)

    /** A completion generator: a short command on its own channel, with a time limit. */
    fun exec(command: String, cwd: String?): String {
        val full = if (cwd != null) "cd ${quote(cwd)} 2>/dev/null; $command" else command
        return client.startSession().use { s ->
            val cmd = s.exec(full)
            val out = Executors.newSingleThreadExecutor()
            try {
                out.submit<String> { readCapped(cmd.inputStream).toString(Charsets.UTF_8) }.get(5, TimeUnit.SECONDS)
            } finally {
                out.shutdownNow()
            }
        }
    }

    /** Path completion: a directory over SFTP on the same connection. */
    fun ls(path: String, cwd: String?): Pair<String, List<Triple<String, Boolean, Boolean>>> {
        val sf = sftp ?: client.newSFTPClient().also { sftp = it }
        val dir = dirFor(path, cwd, sf.canonicalize("."))
        val entries = try {
            sf.ls(dir).take(1000).map { e ->
                val type = e.attributes.type
                Triple(e.name, type == FileMode.Type.DIRECTORY, type == FileMode.Type.SYMLINK)
            }
        } catch (e: Exception) {
            emptyList()
        }
        return dir to entries.sortedWith(compareBy({ !it.second }, { it.first }))
    }

    /** Ends the kept session on the host too (leaving only detaches). */
    fun end() {
        if (kept) runCatching { exec(TMUX_END, null) }
        close()
    }

    fun close() {
        runCatching { sftp?.close() }
        runCatching { shell.close() }
        runCatching { session.close() }
        runCatching { client.disconnect() }
    }

    companion object {
        internal const val MAX_EXEC = 512 * 1024

        init {
            // sshj would register its own BouncyCastle provider; Android's JCA
            // (Conscrypt, and the Keystore for our key) does everything needed.
            SecurityUtils.setRegisterBouncyCastle(false)
            SecurityUtils.setSecurityProvider(null)
        }

        fun quote(s: String) = "'" + s.replace("'", "'\\''") + "'"

        /** The folder a completion lists: [path] from the home folder (~), absolute, or from [cwd] (else home). */
        fun dirFor(path: String, cwd: String?, home: String): String {
            val base = cwd ?: home
            return when {
                path.startsWith("~") -> home + path.substring(1)
                path.startsWith("/") -> path
                path.isEmpty() -> base
                else -> base.trimEnd('/') + "/" + path
            }
        }

        /**
         * The phone's kept session on a host: its own tmux server, attached or
         * made. Options quietly (-q): an older tmux without one still starts.
         * The shell integration's marks pass through (allow-passthrough). Its shell's
         * $TMUX names the person's own default server, as in Burrow's tmux: a plain
         * `tmux attach -t main` reaches their sessions, not this one (review 2026-10-24).
         */
        const val TMUX_KEEP = "D=\"\${TMUX_TMPDIR:-/tmp}/tmux-\$(id -u)/default\"; " +
            "exec tmux -L burrow-direct -f /dev/null start-server \\; set -gq status off \\; set -gq prefix None \\; " +
            "set -gq default-command \"exec env TMUX='\$D,0,0' '\${SHELL:-/bin/sh}' -l\" \\; " +
            "set -gq allow-passthrough on \\; set -gq history-limit 10000 \\; set -saq terminal-overrides ',*:smcup@:rmcup@' \\; new-session -A -s phone"
        const val TMUX_END = "tmux -L burrow-direct kill-session -t phone 2>/dev/null; true"

        /** At most [MAX_EXEC] bytes of a command's output: a completion that floods is cut, not kept whole. */
        internal fun readCapped(input: java.io.InputStream): ByteArray {
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(8192)
            while (out.size() < MAX_EXEC) {
                val n = input.read(buf, 0, minOf(buf.size, MAX_EXEC - out.size()))
                if (n < 0) break
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        }

        private fun blobOf(key: PublicKey): ByteArray = Buffer.PlainBuffer().putPublicKey(key).compactData

        /**
         * Connect and check the host key; [authorize] runs (on this thread)
         * once the key is fine and must return true after a fingerprint, so
         * the Keystore key can sign the login.
         */
        fun connect(
            id: String,
            host: String,
            port: Int,
            username: String,
            known: List<HostKeys.Known>,
            cols: Int,
            rows: Int,
            charset: Charset,
            /** Through the app's WireGuard, when that carries this host (else null: straight). */
            sockets: javax.net.SocketFactory?,
            authorize: () -> Boolean,
            /** Not a shell but a port forward: this host:port, reachable on the phone's 127.0.0.1. */
            forwardTo: Pair<String, Int>? = null,
            /** Keep the session on the host (tmux, when it has it): leaving detaches. */
            keep: Boolean = false,
            onOutput: (String) -> Unit,
            onClosed: (String?) -> Unit,
        ): Connected {
            var seen: Pair<HostKeys.Verdict, String>? = null
            val client = SSHClient(DefaultConfig())
            client.connectTimeout = 10_000
            client.timeout = 30_000
            if (sockets != null) client.socketFactory = sockets
            client.addHostKeyVerifier(object : HostKeyVerifier {
                override fun verify(hostname: String, p: Int, key: PublicKey): Boolean {
                    val blob = blobOf(key)
                    val v = HostKeys.judge(blob, known)
                    seen = v to Base64.getEncoder().encodeToString(blob)
                    return v is HostKeys.Verdict.Trusted
                }

                override fun findExistingAlgorithms(hostname: String, p: Int): List<String> = HostKeys.preferredAlgorithms(known)
            })
            try {
                client.connect(host, port)
            } catch (e: Exception) {
                runCatching { client.disconnect() }
                val s = seen
                if (s != null && s.first !is HostKeys.Verdict.Trusted) return Connected.HostKey(s.first, s.second)
                // In logcat only in a debug build: a release keeps host names and errors out of the phone's log.
                if (BuildConfig.DEBUG) android.util.Log.w("BurrowDirect", "connect to $host:$port failed", e)
                return Connected.Failed("error", e.message ?: e.javaClass.simpleName)
            }
            if (!authorize()) {
                runCatching { client.disconnect() }
                return Connected.Failed("cancelled", "")
            }
            try {
                client.authPublickey(username, object : KeyProvider {
                    override fun getPrivate() = DirectKey.privateKey()
                    override fun getPublic(): PublicKey = DirectKey.publicKey()
                    override fun getType() = KeyType.ECDSA256
                })
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) android.util.Log.w("BurrowDirect", "login on $host:$port failed", e)
                runCatching { client.disconnect() }
                return Connected.Failed("auth_failed", e.message ?: "")
            }
            if (forwardTo != null) return forwardOver(client, id, forwardTo)
            return try {
                // tmux on the host keeps the session when the phone leaves;
                // without it, a plain shell as before.
                val tmux = keep && runCatching {
                    client.startSession().use { s -> s.exec("command -v tmux >/dev/null 2>&1 && echo yes").let { c -> readCapped(c.inputStream).toString(Charsets.UTF_8).trim() == "yes" } }
                }.getOrDefault(false)
                val session = client.startSession()
                session.allocatePTY("xterm-256color", cols, rows, 0, 0, emptyMap())
                val shell: Session.Shell = if (tmux) {
                    // A tmux server of its own (not the person's, not Burrow's):
                    // no status bar, no prefix key, output into the scrollback.
                    session.exec(TMUX_KEEP) as Session.Shell
                } else session.startShell()
                val ssh = DirectSsh(id, client, session, shell, tmux)
                thread(name = "direct-$id", isDaemon = true) {
                    var message: String? = null
                    try {
                        InputStreamReader(shell.inputStream, charset).use { r ->
                            val buf = CharArray(8192)
                            while (true) {
                                val n = r.read(buf)
                                if (n < 0) break
                                if (n > 0) onOutput(String(buf, 0, n))
                            }
                        }
                    } catch (e: Exception) {
                        message = e.message
                    }
                    ssh.close()
                    onClosed(message)
                }
                Connected.Ok(ssh)
            } catch (e: Exception) {
                runCatching { client.disconnect() }
                Connected.Failed("error", e.message ?: e.javaClass.simpleName)
            }
        }
    }
}


/**
 * A port on the host (or a machine it reaches), on the phone's 127.0.0.1:
 * a web page on the host opens in the phone's browser. Only this phone
 * reaches it, but any app on the phone can, for as long as it runs (it is
 * a plain loopback port); closing it ends the SSH connection (A3-AND-15).
 */
class Forward(val id: String, private val client: SSHClient, private val server: java.net.ServerSocket, val target: Pair<String, Int>) {
    val localPort: Int get() = server.localPort

    fun close() {
        runCatching { server.close() }
        runCatching { client.disconnect() }
    }
}

private fun forwardOver(client: SSHClient, id: String, target: Pair<String, Int>): DirectSsh.Connected = try {
    val server = java.net.ServerSocket()
    server.reuseAddress = true
    server.bind(java.net.InetSocketAddress("127.0.0.1", 0))
    val params = net.schmizz.sshj.connection.channel.direct.Parameters("127.0.0.1", server.localPort, target.first, target.second)
    val forwarder = client.newLocalPortForwarder(params, server)
    val f = Forward(id, client, server, target)
    thread(name = "forward-$id", isDaemon = true) {
        runCatching { forwarder.listen() }
        f.close()
    }
    DirectSsh.Connected.Forwarding(f)
} catch (e: Exception) {
    runCatching { client.disconnect() }
    DirectSsh.Connected.Failed("error", e.message ?: e.javaClass.simpleName)
}
