package io.github.r31l4nd.burrow

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlin.math.sqrt

/**
 * A shake of the phone reports a problem with what is on the screen (the
 * page opens its report form), instead of the way through Settings. Two
 * firm jolts within a second count; a walk, a bump or a phone put down do
 * not. Listening only while Burrow is in front, and not at all when the
 * person turned it off (Settings -> Android app).
 */
class Shake(context: Context, private val onShake: () -> Unit) : SensorEventListener {
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private var listening = false
    private val counter = ShakeCounter()

    fun start() {
        if (listening) return
        val accel = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        listening = sensors.registerListener(this, accel, SensorManager.SENSOR_DELAY_UI)
    }

    fun stop() {
        if (!listening) return
        sensors.unregisterListener(this)
        listening = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        val (x, y, z) = event.values
        if (jolt(x, y, z) && counter.counts(System.currentTimeMillis())) onShake()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    companion object {
        /** In g: gravity is 1, a firm shake well over 2. */
        const val JOLT_G = 2.5f

        fun jolt(x: Float, y: Float, z: Float): Boolean = sqrt(x * x + y * y + z * z) / 9.80665f > JOLT_G
    }
}

/** Which jolts make a shake: two within a second (not one jolt read several times), then quiet. */
class ShakeCounter {
    private var firstAt = 0L
    private var lastShakeAt = 0L

    /** A jolt at `now`: true when it makes a shake (the second within a second, not right after the last). */
    fun counts(now: Long): Boolean {
        // Once, then quiet for a while: one shake is one report.
        if (lastShakeAt != 0L && now - lastShakeAt < QUIET_MS) return false
        if (firstAt != 0L && now - firstAt in GAP_MS..WITHIN_MS) {
            firstAt = 0L
            lastShakeAt = now
            return true
        }
        // One jolt lasts several readings: those do not start it again.
        if (firstAt == 0L || now - firstAt > WITHIN_MS) firstAt = now
        return false
    }

    companion object {
        const val GAP_MS = 150L
        const val WITHIN_MS = 1_000L
        const val QUIET_MS = 3_000L
    }
}
