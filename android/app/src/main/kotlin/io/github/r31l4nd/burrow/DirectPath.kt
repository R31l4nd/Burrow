package io.github.r31l4nd.burrow

/** Which way the direct route reaches a host: straight, or through the app's WireGuard. */
object DirectPath {
    /**
     * Whether to try the host again through the tunnel. A host goes straight
     * when a bare TCP connect to its address works; away from home another
     * network with the same private range (192.168.1.0/24 is everywhere) can
     * have a machine listening there, and the host key check then stopped the
     * route exactly where it is needed. So: the straight attempt met a host
     * key Burrow does not know for this host, the tunnel carries the host,
     * and it was not tried that way yet (A3-AND-06). The key check still
     * decides on the second try; nothing is sent before it (no user name).
     */
    fun tryTunnelAfter(hostKeyMismatch: Boolean, wentThroughTunnel: Boolean, carried: Boolean): Boolean =
        hostKeyMismatch && !wentThroughTunnel && carried
}
