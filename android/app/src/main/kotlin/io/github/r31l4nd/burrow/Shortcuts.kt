package io.github.r31l4nd.burrow

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

/** Home screen shortcuts (long-press the icon) to favourite and recent hosts. */
object Shortcuts {
    const val ACTION_CONNECT = "io.github.r31l4nd.burrow.CONNECT"
    const val EXTRA_HOST = "hostId"

    /** The direct route, first in the list: it must work when Burrow does not. */
    private fun direct(context: Context) = ShortcutInfoCompat.Builder(context, "direct")
        .setShortLabel(context.getString(R.string.direct_route))
        .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_host))
        .setIntent(Intent(context, DirectActivity::class.java).setAction(Intent.ACTION_VIEW))
        .setRank(0)
        .build()

    fun ensureDirect(context: Context) {
        ShortcutManagerCompat.pushDynamicShortcut(context, direct(context))
    }

    fun set(context: Context, hosts: List<Pair<Long, String>>) {
        val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context).coerceAtMost(4) - 1
        val list = listOf(direct(context)) + hosts.take(max).map { (id, name) ->
            ShortcutInfoCompat.Builder(context, "host-$id")
                .setShortLabel(name.take(25))
                .setLongLabel(name.take(45))
                .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_host))
                // Through the app's own entry, which no other app can start (DeepLinks.pageForConnect).
                .setIntent(Intent().setClassName(context, DeepLinks.SHORTCUT_ENTRY).setAction(ACTION_CONNECT).putExtra(EXTRA_HOST, id))
                .build()
        }
        ShortcutManagerCompat.setDynamicShortcuts(context, list)
    }
}
