package sk.karchi.weft.phone

import android.app.Notification
import android.app.Person
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject

/** Notifications of the apps Karchi picked go into the queue: a chat app's messages one by one (MessagingStyle),
 *  anything else as its title and text. An updated notification with the same text is the same item; what came
 *  before the app was ticked (a chat notification keeps earlier messages) stays out. */
class Listener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val store = Store.get(this)
        if (store.token == null || sbn.packageName !in store.apps) return
        val n = sbn.notification
        if (n.flags and (Notification.FLAG_GROUP_SUMMARY or Notification.FLAG_ONGOING_EVENT) != 0) return
        val extras = n.extras
        val app = runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString() }
            .getOrDefault(sbn.packageName)
        val since = store.since(sbn.packageName)
        val base = JSONObject().put("kind", "notification").put("app", sbn.packageName).put("appName", app)
        val messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (!messages.isNullOrEmpty()) {
            val conversation = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
            for (m in messages.filterIsInstance<Bundle>()) {
                val text = m.getCharSequence("text")?.toString() ?: continue
                val time = m.getLong("time", sbn.postTime)
                if (time < since) continue
                val sender = sender(m) ?: extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
                val who = if (conversation != null && sender != null) "$sender · $conversation" else sender ?: conversation
                store.add(JSONObject(base.toString()).put("id", "n:${sbn.packageName}:$time:${hash(sender, conversation, text)}").put("ts", time)
                    .put("text", text.take(10_000)).also { if (who != null) it.put("title", who) })
            }
        } else {
            if (sbn.postTime < since) return
            val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: return
            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            // The same notification updated with the same words is one item; a new one (its own time) is another.
            store.add(JSONObject(base.toString()).put("id", "n:${sbn.packageName}:${sbn.id}:${sbn.tag?.takeIf { it.length <= 40 } ?: hash(sbn.tag)}:${n.`when`}:${hash(title, text)}")
                .put("ts", sbn.postTime).put("text", text.take(10_000)).also { if (title != null) it.put("title", title) })
        }
        Sync.soon(this, 0)
    }

    private fun hash(vararg parts: String?) = parts.joinToString("\u0000").hashCode().toUInt().toString(36)

    private fun sender(m: Bundle): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            @Suppress("DEPRECATION") val person = m.getParcelable<Parcelable>("sender_person") as? Person
            person?.name?.let { return it.toString() }
        }
        return m.getCharSequence("sender")?.toString()
    }
}
