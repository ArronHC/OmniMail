package com.omnimail.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.ui.platform.LocalContext
import com.omnimail.android.ui.components.openExternalUrl
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.omnimail.android.R
import com.omnimail.android.data.network.ExternalMailApi
import com.omnimail.android.data.network.ExternalMessage
import com.omnimail.android.ui.components.SafeEmailWebView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun ExternalMailScreen(state: AppUiState, viewModel: AppViewModel, padding: PaddingValues) {
    val api = remember(viewModel) { ExternalMailApi(viewModel::externalCredentials) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var pendingLink by remember { mutableStateOf<String?>(null) }
    var provider by remember { mutableStateOf("gmail") }
    var messages by remember { mutableStateOf(emptyList<ExternalMessage>()) }
    var detail by remember { mutableStateOf<ExternalMessage?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    suspend fun refresh() {
        val selected = provider
        try {
            val result = api.messages(selected)
            if (provider == selected) { messages = result; error = "" }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (provider == selected) error = e.message ?: "Request failed" }
    }
    LaunchedEffect(provider) { detail = null; loading = true; refresh(); loading = false }
    LaunchedEffect(state.realtimeRevision) {
        val matches = mapOf("qq-mail" to "qq", "naver-mail" to "naver", "yandex-mail" to "yandex")[provider] ?: provider
        if (state.realtimeRevision > 0 && (state.realtimeProvider.isEmpty() || state.realtimeProvider == matches)) refresh()
    }
    BackHandler { if (detail != null) detail = null else viewModel.openSettings() }
    AccountPage(stringResource(R.string.external_mail), { if (detail != null) detail = null else viewModel.openSettings() }, padding) {
        Text(stringResource(R.string.external_realtime_note), style = MaterialTheme.typography.bodySmall)
        val names = listOf("gmail" to "Gmail", "microsoft" to "Outlook", "qq-mail" to "QQ", "naver-mail" to "NAVER", "yandex-mail" to "Yandex")
        Column {
            names.chunked(3).forEach { group -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                group.forEach { (id, name) -> OutlinedButton(onClick = { provider = id }, enabled = !loading && provider != id) { Text(name) } }
            } }
        }
        OutlinedButton(onClick = { scope.launch { refresh() } }, enabled = !loading) { Text(stringResource(R.string.external_refresh)) }
        if (loading) CircularProgressIndicator()
        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        val opened = detail
        if (opened != null) {
            Text(opened.subject, style = MaterialTheme.typography.titleLarge)
            Text(opened.senderAddress)
            if (opened.html.isNotBlank()) SafeEmailWebView(opened.html, state.readerPreferences.loadRemoteImages, Modifier.fillMaxWidth().height(500.dp), onExternalLink = { link ->
                if (state.readerPreferences.confirmExternalLinks) pendingLink = link else openExternalUrl(context, link)
            })
            else SelectionContainer { Text(opened.body) }
        } else {
            if (!loading && messages.isEmpty()) Text(stringResource(R.string.external_no_messages))
            messages.forEach { message -> OutlinedButton(onClick = {
                val selected = provider
                scope.launch {
                    try {
                        val result = api.message(selected, message.account.id, message.id)
                        if (provider == selected) { detail = result; refresh() }
                    }
                    catch (e: CancellationException) { throw e }
                    catch (e: Exception) { error = e.message ?: "Request failed" }
                }
            }, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().padding(4.dp)) {
                    Text(message.subject, fontWeight = if (message.isRead) FontWeight.Normal else FontWeight.Bold)
                    Text(message.senderName.ifBlank { message.senderAddress }, style = MaterialTheme.typography.bodySmall)
                    Text(message.account.email, style = MaterialTheme.typography.labelSmall)
                }
            } }
        }
    }
    pendingLink?.let { link ->
        AlertDialog(onDismissRequest = { pendingLink = null },
            title = { Text(stringResource(R.string.open_external_link_title)) }, text = { Text(link) },
            confirmButton = { TextButton(onClick = { pendingLink = null; openExternalUrl(context, link) }) { Text(stringResource(R.string.open_in_browser)) } },
            dismissButton = { TextButton(onClick = { pendingLink = null }) { Text(stringResource(R.string.cancel)) } })
    }
}
