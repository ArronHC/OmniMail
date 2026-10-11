package com.omnimail.android.data.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

@Serializable
data class ExternalAccount(val id: String, val name: String = "", val email: String = "")
@Serializable
data class ExternalMessage(
    val id: String, val account: ExternalAccount, val subject: String = "", val senderName: String = "",
    val senderAddress: String = "", val isRead: Boolean = false, val date: Long = 0,
    val body: String = "", val html: String = "",
)
@Serializable
data class ExternalMessages(val messages: List<ExternalMessage> = emptyList())
@Serializable
data class ExternalDetail(val message: ExternalMessage)

class ExternalMailApi(private val credentials: suspend (Boolean) -> Pair<String, String>) {
    private val client = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).followRedirects(false).build()
    private val json = Json { ignoreUnknownKeys = true }
    private val providers = setOf("gmail", "microsoft", "qq-mail", "naver-mail", "yandex-mail")
    private suspend fun get(path: String): String {
        var identity = credentials(false)
        repeat(2) { attempt ->
            val result = withContext(Dispatchers.IO) {
                client.newCall(Request.Builder().url(identity.first.trimEnd('/') + path)
                    .header("Authorization", "Bearer " + identity.second).build()).execute().use { it.code to (it.body?.string() ?: "") }
            }
            if (result.first == 401 && attempt == 0) identity = credentials(true)
            else {
                if (result.first !in 200..299) throw ApiException(result.first, "External mail request failed (${result.first})")
                if (result.second.isEmpty()) throw ApiException(502, "Empty external mail response")
                return result.second
            }
        }
        throw ApiException(401, "External mail session expired")
    }
    suspend fun messages(provider: String): List<ExternalMessage> {
        require(provider in providers)
        return json.decodeFromString<ExternalMessages>(get("/api/$provider/messages")).messages
    }
    suspend fun message(provider: String, accountId: String, messageId: String): ExternalMessage {
        require(provider in providers)
        val encode = { value: String -> java.net.URLEncoder.encode(value, "UTF-8") }
        return json.decodeFromString<ExternalDetail>(get("/api/$provider/accounts/${encode(accountId)}/messages/${encode(messageId)}")).message
    }
}
