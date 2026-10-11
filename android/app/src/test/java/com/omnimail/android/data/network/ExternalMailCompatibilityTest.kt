package com.omnimail.android.data.network

import com.omnimail.android.data.model.InstanceConfig
import com.omnimail.android.data.sync.IndexUpdate
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ExternalMailCompatibilityTest {
    private val json = Json { ignoreUnknownKeys = true }
    @Test fun oldInstanceConfigDisablesRealtimeByDefault() {
        assertFalse(json.decodeFromString<InstanceConfig>("{}").realtimeEnabled)
    }
    @Test fun indexEventIgnoresNewServerFieldsWithoutExposingMailContent() {
        val event = json.decodeFromString<IndexUpdate>("""{"type":"indexed","provider":"qq","accountId":"a","measurementId":"m","indexedAt":123} """)
        assertEquals("qq", event.provider)
        assertEquals("a", event.accountId)
    }
    @Test fun providerIndexDecodesLegacySummaryWithoutOptionalBody() {
        val messages = json.decodeFromString<ExternalMessages>("""{"messages":[{"id":"m","account":{"id":"a","email":"test@example.com"},"subject":"New","isRead":false}],"page":{"limit":30}}""")
        assertEquals("New", messages.messages.single().subject)
        assertEquals("", messages.messages.single().body)
    }
}
