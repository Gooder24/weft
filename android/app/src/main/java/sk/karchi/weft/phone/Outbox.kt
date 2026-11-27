package sk.karchi.weft.phone

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject

/** Beta: what Karchi writes in Weft goes out from here. Weft hands out each message (an SMS to a number, or an answer
 *  to a notification still on the phone) and hears how it went at the next request. Each goes at most once
 *  (`Store.took`). */
object Outbox {
    /** One round with Weft: reports, then what to send; `wait` seconds Weft may hold the request for something new. */
    fun run(context: Context, wait: Int) {
        val store = Store.get(context)
        val server = store.server ?: return
        val token = store.token ?: return
        // Switched off, it still tells Weft what it refused, so Weft says why instead of waiting an hour.
        if (!store.write && store.results().isEmpty()) return
        while (true) {
            val done = store.results()
            val res = Net.post(server, store.ca, "/_connect/phone/outbox",
                JSONObject().put("done", JSONArray(done)).put("wait", if (done.isEmpty() && store.write) wait else 0).put("take", store.write), token)
            store.reported(done.map { it.getString("id") })
            val items = res.getJSONArray("items")
            for (i in 0 until items.length()) handle(context, items.getJSONObject(i))
            if (store.results().isEmpty()) return // a sent SMS is heard later (SentReceiver), then Sync reports it
        }
    }

    private fun handle(context: Context, item: JSONObject) {
        val store = Store.get(context)
        val id = item.getString("id")
        if (!store.took(id)) return
        val kind = item.optString("kind")
        if (!store.write) { // switched off while Weft was answering
            store.result(id, false, "Posielanie z Weftu je v telefóne vypnuté.")
            return
        }
        val error = when (kind) {
            "sms" -> sms(context, id, item.getString("to"), item.getString("text"))
            "reply" -> Listener.reply(item.getString("to"), item.getString("text"))
            else -> "Tejto správe Weft Telefón nerozumie, aktualizuj ho."
        }
        if (error != null) store.result(id, false, error)
        else if (kind == "reply") store.result(id, true, null)
    }

    private fun sms(context: Context, id: String, to: String, text: String): String? {
        if (!Store.get(context).sms) return "SMS sú vo Weft Telefóne vypnuté."
        if (context.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) return "Weft Telefón nesmie posielať SMS. Povoľ to v ňom."
        val manager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) context.getSystemService(SmsManager::class.java)
            else @Suppress("DEPRECATION") SmsManager.getDefault()
        return runCatching {
            val parts = manager.divideMessage(text)
            Store.get(context).parts(id, parts.size)
            val sent = ArrayList(parts.indices.map { i ->
                val intent = Intent(context, SentReceiver::class.java).setData(Uri.parse("weft-sent:${Uri.encode(id)}/$i")).putExtra("id", id)
                PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT)
            })
            // The system keeps the sent SMS in the phone's store; Weft knows it as this message when it comes back.
            manager.sendMultipartTextMessage(to, null, parts, sent, null)
            null
        }.getOrElse { "Telefón SMS neodoslal: ${it.message}" }
    }
}

/** The radio's answer for each part of an SMS from Weft: sent once every part went, failed when one did not. */
class SentReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        val store = Store.get(context)
        when (resultCode) {
            Activity.RESULT_OK -> store.partSent(id)
            SmsManager.RESULT_ERROR_RADIO_OFF -> store.result(id, false, "Telefón je v režime lietadlo.")
            SmsManager.RESULT_ERROR_NO_SERVICE -> store.result(id, false, "Telefón je bez signálu.")
            else -> store.result(id, false, "Sieť SMS neprijala (chyba $resultCode).")
        }
        Sync.soon(context, 0)
    }
}
