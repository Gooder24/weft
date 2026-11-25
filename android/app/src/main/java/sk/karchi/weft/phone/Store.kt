package sk.karchi.weft.phone

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

/** What the app keeps: Weft's address, this phone's token and the server's CA (preferences), the picked apps, and the
 *  items Weft has not taken yet (a small SQLite queue, so nothing is lost while the phone is offline). */
class Store private constructor(context: Context) {
    private val prefs = context.getSharedPreferences("weft", Context.MODE_PRIVATE)
    private val db = Queue(context).writableDatabase

    var server: String?
        get() = prefs.getString("server", null)
        set(v) = prefs.edit().putString("server", v).apply()
    var token: String?
        get() = prefs.getString("token", null)
        set(v) = prefs.edit().putString("token", v).apply()
    var ca: String? // PEM of the server's own CA; null for a plain-http test server
        get() = prefs.getString("ca", null)
        set(v) = prefs.edit().putString("ca", v).apply()
    var apps: Set<String>
        get() = prefs.getStringSet("apps", emptySet())!!.toSet()
        set(v) = prefs.edit().putStringSet("apps", v).apply()

    /** Ticking an app: only what comes from now on goes to Weft, not what its notifications already hold. */
    fun pick(app: String, on: Boolean) {
        apps = if (on) apps + app else apps - app
        if (on) prefs.edit().putLong("since:$app", System.currentTimeMillis()).apply()
        else drop("n:$app:") // unticked while offline: what waited stays on the phone
    }
    fun since(app: String) = prefs.getLong("since:$app", 0)
    var sms: Boolean
        get() = prefs.getBoolean("sms", false)
        set(v) {
            prefs.edit().putBoolean("sms", v).apply()
            if (!v) drop("sms:")
        }
    var smsLast: Long // SMS rows up to this one are read; -1: not yet, the first read takes the last 30 days
        get() = prefs.getLong("smsLast", -1)
        set(v) = prefs.edit().putLong("smsLast", v).apply()
    var sent: Long // when Weft last took items
        get() = prefs.getLong("sent", 0)
        set(v) = prefs.edit().putLong("sent", v).apply()
    var error: String?
        get() = prefs.getString("error", null)
        set(v) = prefs.edit().putString("error", v).apply()

    fun add(item: JSONObject) {
        val row = ContentValues().apply {
            put("id", item.getString("id")); put("json", item.toString()); put("ts", item.getLong("ts"))
        }
        db.insertWithOnConflict("queue", null, row, SQLiteDatabase.CONFLICT_IGNORE)
    }

    fun pending(limit: Int): List<JSONObject> =
        db.rawQuery("SELECT json FROM queue ORDER BY ts LIMIT $limit", null).use { c ->
            buildList { while (c.moveToNext()) add(JSONObject(c.getString(0))) }
        }

    private fun drop(prefix: String) = db.delete("queue", "substr(id, 1, ?) = ?", arrayOf(prefix.length.toString(), prefix))

    fun count(): Long = android.database.DatabaseUtils.queryNumEntries(db, "queue")

    fun done(ids: Collection<String>) {
        db.beginTransaction()
        try {
            for (id in ids) db.delete("queue", "id = ?", arrayOf(id))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** Unpaired: the token, the CA and what was waiting go; the picked apps stay for the next pairing. */
    fun forget() {
        prefs.edit().remove("token").remove("ca").remove("smsLast").remove("error").remove("sent").apply()
        db.delete("queue", null, null)
    }

    companion object {
        @Volatile private var one: Store? = null
        fun get(context: Context) = one ?: synchronized(this) { one ?: Store(context.applicationContext).also { one = it } }
    }
}

private class Queue(context: Context) : SQLiteOpenHelper(context, "queue.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) =
        db.execSQL("CREATE TABLE queue (id TEXT PRIMARY KEY, json TEXT NOT NULL, ts INTEGER NOT NULL)")
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {}
}
