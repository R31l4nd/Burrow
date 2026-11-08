package io.github.r31l4nd.burrow

/**
 * What the device key may sign: only Burrow's own challenge for this server,
 * "burrow-device-v1\n<login|step-up>\n<origin>\n<random>". Even a page that
 * was tampered with cannot get a signature over anything else.
 */
object DeviceMessage {
    const val PREFIX = "burrow-device-v1"

    fun purpose(message: String, origin: String): String? {
        val parts = message.split("\n")
        if (parts.size != 4 || parts[0] != PREFIX || parts[2] != origin) return null
        if (parts[1] != "login" && parts[1] != "step-up") return null
        if (!parts[3].matches(Regex("[A-Za-z0-9_-]{32,}"))) return null
        return parts[1]
    }
}
