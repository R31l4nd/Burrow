package io.github.r31l4nd.burrow

/**
 * What Burrow's screen does when the app's WireGuard changes under it (home
 * or away, or back up after it went down in the background).
 */
object TunnelChange {
    enum class Action { NONE, TELL_PAGE, RELOAD }

    /**
     * [up]: the tunnel in use now; [viaTunnel]: as the page last knew it;
     * [starts]/[loadedWith]: the tunnel's start count now and when the page
     * last knew it (a new start means the page lost its connections);
     * [pageShown]: the page is there (not the error screen).
     *
     * A page that is there is told ("resumed": it checks and reconnects its
     * connections, as after any loss of network), never reloaded: a reload
     * took the person's unsaved work in an editor or a form (A3-AND-03).
     */
    fun decide(up: Boolean, viaTunnel: Boolean, starts: Int, loadedWith: Int, pageShown: Boolean): Action {
        val restarted = up && starts != loadedWith
        if (up == viaTunnel && !restarted) return Action.NONE
        return if (pageShown) Action.TELL_PAGE else Action.RELOAD
    }
}
