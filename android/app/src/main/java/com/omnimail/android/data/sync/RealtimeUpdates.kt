package com.omnimail.android.data.sync

import com.omnimail.android.data.repository.MailRepository
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

@Serializable
data class IndexUpdate(val type: String = "", val provider: String = "", val accountId: String = "")

/** Collected only while the UI is STARTED; no foreground service or background polling. */
class RealtimeUpdates(private val repository: MailRepository) {
    private val client = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }
    fun events(forceRefresh: Boolean = false) = callbackFlow {
        val credentials = repository.realtimeAccess(forceRefresh)
        val request = Request.Builder()
            .url(credentials.first.trimEnd('/') + "/api/realtime/updates")
            .header("Authorization", "Bearer " + credentials.second)
            .build()
        val socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                trySend(IndexUpdate(type = "reconnected"))
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = runCatching { json.decodeFromString<IndexUpdate>(text) }.getOrNull() ?: return
                if (event.type == "indexed") trySend(event)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close() }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // Exception contents/response bodies can contain credentials; do not log them.
                close(RealtimeConnectionException(response?.code == 401))
            }
        })
        awaitClose { socket.cancel() }
    }
}
class RealtimeConnectionException(val authentication: Boolean) : Exception("Realtime connection unavailable")
