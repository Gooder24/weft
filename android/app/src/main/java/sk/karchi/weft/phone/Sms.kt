package sk.karchi.weft.phone

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import org.json.JSONObject

/** SMS, received and sent, read from the phone's own SMS store into the queue. The first read takes the last 30 days;
 *  later ones the rows after the last read, and again from a message that was still being sent (for a day at most). */
object Sms {
    private const val DAY = 86_400_000L
    private const val BACK = 30 * DAY
    private const val INBOX = 1
    private const val SENT = 2
    private const val OUTBOX = 4
    private const val QUEUED = 6

    fun read(context: Context) {
        val store = Store.get(context)
        if (!store.sms || context.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) return
        val now = System.currentTimeMillis()
        val last = store.smsLast
        val names = HashMap<String, String?>()
        var newest = maxOf(last, 0)
        var hold = Long.MAX_VALUE // a row still being sent: read again from it next time
        context.contentResolver.query(Uri.parse("content://sms"), arrayOf("_id", "address", "date", "body", "type"),
            "_id > ?", arrayOf(last.toString()), "_id")?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                val date = c.getLong(2)
                val type = c.getInt(4)
                newest = maxOf(newest, id)
                if ((type == OUTBOX || type == QUEUED) && date > now - DAY) hold = minOf(hold, id - 1)
                if (type != INBOX && type != SENT || date < now - BACK) continue
                val address = c.getString(1) ?: continue
                val item = JSONObject().put("id", "sms:$id").put("kind", "sms").put("ts", date)
                    .put("address", address).put("text", (c.getString(3) ?: "").take(10_000)).put("out", type == SENT)
                names.getOrPut(address) { contact(context, address) }?.let { item.put("name", it) }
                store.add(item)
            }
        }
        store.smsLast = minOf(newest, hold)
    }

    /** The contact's name on the phone, when Weft Telefón may read contacts. */
    private fun contact(context: Context, address: String): String? {
        if (context.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) return null
        val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(address))
        return runCatching {
            context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null }
        }.getOrNull()
    }
}

/** A new SMS: read the store a moment later, once the SMS app has written it there. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Store.get(context).sms) Sync.soon(context, 5_000)
    }
}
