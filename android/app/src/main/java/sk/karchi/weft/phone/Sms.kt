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
 *  later ones what came after, looking 20 rows back for a message that was still being sent. */
object Sms {
    private const val BACK = 30L * 86_400_000
    private const val INBOX = 1
    private const val SENT = 2

    fun read(context: Context) {
        val store = Store.get(context)
        if (!store.sms || context.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) return
        val last = store.smsLast
        val (where, arg) = if (last < 0) "date > ?" to (System.currentTimeMillis() - BACK).toString() else "_id > ?" to (last - 20).toString()
        val names = HashMap<String, String?>()
        var newest = maxOf(last, 0)
        context.contentResolver.query(Uri.parse("content://sms"), arrayOf("_id", "address", "date", "body", "type"),
            "$where AND type IN ($INBOX, $SENT)", arrayOf(arg), "_id")?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                newest = maxOf(newest, id)
                val address = c.getString(1) ?: continue
                val item = JSONObject().put("id", "sms:$id").put("kind", "sms").put("ts", c.getLong(2))
                    .put("address", address).put("text", c.getString(3) ?: "").put("out", c.getInt(4) == SENT)
                names.getOrPut(address) { contact(context, address) }?.let { item.put("name", it) }
                store.add(item)
            }
        }
        store.smsLast = newest
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
