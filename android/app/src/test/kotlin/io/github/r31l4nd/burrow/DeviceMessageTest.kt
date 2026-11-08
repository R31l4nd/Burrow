package io.github.r31l4nd.burrow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceMessageTest {
    private val o = "https://burrow.example.com"
    private val nonce = "q3v0bJk2c8m9XfT1yZp4Ld6sWn7Ge5Ha0Ur2Io3Ki_-"

    @Test
    fun signsOnlyBurrowChallengesForThisServer() {
        assertEquals("login", DeviceMessage.purpose("burrow-device-v1\nlogin\n$o\n$nonce", o))
        assertEquals("step-up", DeviceMessage.purpose("burrow-device-v1\nstep-up\n$o\n$nonce", o))
        assertNull(DeviceMessage.purpose("burrow-device-v1\nlogin\nhttps://other.example.com\n$nonce", o))
        assertNull(DeviceMessage.purpose("burrow-device-v1\ntransfer-money\n$o\n$nonce", o))
        assertNull(DeviceMessage.purpose("burrow-device-v1\nlogin\n$o\nshort", o))
        assertNull(DeviceMessage.purpose("burrow-device-v1\nlogin\n$o\n$nonce\nextra", o))
        assertNull(DeviceMessage.purpose("hello", o))
    }
}
