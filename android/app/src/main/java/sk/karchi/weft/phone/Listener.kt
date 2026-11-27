package sk.karchi.weft.phone

import android.app.Notification
import android.app.Person
import android.app.RemoteInput
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject

/** Notifications of the apps Karchi picked go into the queue: a chat app's messages one by one (MessagingStyle),
 *  anything else as its title and text. An updated notification with the same text is the same item; what came
 *  before the app was ticked (a chat notification keeps earlier messages) stays out, and so do Karchi's own
 *  messages in it (an answer he sent, from Weft too). The same ids find a notification again to answer it (beta). */
class Listener : NotificationListenerService() {
    override fun onListenerConnected() { current = this }
    override fun onListenerDisconnected() { if (current === this) current = null }
    override fun onDestroy() {
        if (current === this) current = null
        super.onDestroy()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val store = Store.get(this)
        if (store.token == null || sbn.packageName !in store.apps) return
        val since = store.since(sbn.packageName)
        val found = items(sbn).filter { it.getLong("ts") >= since }
        for (item in found) store.add(item)
        if (found.isNotEmpty()) Sync.soon(this, 0)
    }

    /** The items a notification holds, each with the id it goes to Weft under. */
    private fun items(sbn: StatusBarNotification): List<JSONObject> {
        val n = sbn.notification
        if (n.flags and (Notification.FLAG_GROUP_SUMMARY or Notification.FLAG_ONGOING_EVENT) != 0) return emptyList()
        val extras = n.extras
        val app = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString() }
            .getOrDefault(sbn.packageName)
        val base = JSONObject().put("kind", "notification").put("app", sbn.packageName).put("appName", app)
        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (!messages.isNullOrEmpty()) {
            val conversation = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
            return messages.filterIsInstance<Bundle>().mapNotNull { m ->
                val text = m.getCharSequence("text")?.toString() ?: return@mapNotNull null
                val time = m.getLong("time", sbn.postTime)
                val sender = sender(m) ?: return@mapNotNull null // no sender: the phone's own user wrote it
                val who = if (conversation != null) "$sender · $conversation" else sender
                JSONObject(base.toString()).put("id", "n:${sbn.packageName}:$time:${hash(sender, conversation, text)}").put("ts", time)
                    .put("text", text.take(10_000)).put("title", who)
            }
        }
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: return emptyList()
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        // The same notification updated with the same words is one item; a new one (its own time) is another.
        return listOf(JSONObject(base.toString()).put("id", "n:${sbn.packageName}:${sbn.id}:${sbn.tag?.let { if (it.length <= 40) "t$it" else "h${hash(it)}" } ?: "-"}:${n.`when`}:${hash(title, text)}")
            .put("ts", sbn.postTime).put("text", text.take(10_000)).also { if (title != null) it.put("title", title) })
    }

    private fun hash(vararg parts: String?) = parts.joinToString("\u0000").hashCode().toUInt().toString(36)

    private fun sender(m: Bundle): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            @Suppress("DEPRECATION") val person = m.getParcelable<Parcelable>("sender_person") as? Person
            person?.name?.let { return it.toString() }
        }
        return m.getCharSequence("sender")?.toString()
    }

    /** The notification's own answer button, as a watch or a car uses it. */
    private fun replyAction(n: Notification): Notification.Action? {
        val all = (n.actions?.toList() ?: emptyList()) + Notification.WearableExtender(n).actions
        val usable = all.filter { a -> a.actionIntent != null && a.remoteInputs?.any { it.allowFreeFormInput } == true }
        return usable.firstOrNull { Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && it.semanticAction == Notification.Action.SEMANTIC_ACTION_REPLY }
            ?: usable.firstOrNull()
    }

    private fun answer(id: String, text: String): String? {
        val app = id.removePrefix("n:").substringBefore(':')
        if (app !in Store.get(this).apps) return "Táto appka už vo Weft Telefóne nie je zaškrtnutá."
        val sbn = runCatching { activeNotifications }.getOrNull().orEmpty()
            .firstOrNull { it.packageName == app && items(it).any { item -> item.getString("id") == id } }
            ?: return "Táto notifikácia už v telefóne nie je. Odpíš priamo v appke."
        val action = replyAction(sbn.notification) ?: return "Na túto notifikáciu sa z telefónu odpovedať nedá."
        val intent = Intent()
        val results = Bundle().apply { for (input in action.remoteInputs) if (input.allowFreeFormInput) putCharSequence(input.resultKey, text) }
        RemoteInput.addResultsToIntent(action.remoteInputs, intent, results)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) RemoteInput.setResultsSource(intent, RemoteInput.SOURCE_FREE_FORM_INPUT)
        return runCatching { action.actionIntent.send(this, 0, intent); null }.getOrElse { "Appka odpoveď neprijala: ${it.message}" }
    }

    companion object {
        @Volatile private var current: Listener? = null

        /** Answers the notification Weft knows by `id`; null when it went, else why not. */
        fun reply(id: String, text: String): String? {
            val listener = current ?: return "Weft Telefón nemá prístup k notifikáciám."
            return listener.answer(id, text)
        }
    }
}
