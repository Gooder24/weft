package sk.karchi.weft.phone

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

/** What the app keeps: Weft's address, this phone's token and the server's CA (preferences), the picked apps, the
 *  items Weft has not taken yet (a small SQLite queue, so nothing is lost while the phone is offline) and the messages
 *  from Weft it sent. */
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
    /** Beta: what Karchi writes in Weft (SMS, answers to notifications) goes out from this phone. */
    var write: Boolean
        get() = prefs.getBoolean("write", false)
        set(v) = prefs.edit().putBoolean("write", v).apply()
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

    fun has(id: String) = android.database.DatabaseUtils.queryNumEntries(db, "queue", "id = ?", arrayOf(id)) > 0

    fun count(): Long = android.database.DatabaseUtils.queryNumEntries(db, "queue")

    /** Forgets these items; returns how many the queue had. */
    fun done(ids: Collection<String>): Int {
        var gone = 0
        db.beginTransaction()
        try {
            for (id in ids) gone += db.delete("queue", "id = ?", arrayOf(id))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return gone
    }

    /** A message from Weft this phone is taking now: false when it took it before, so nothing goes out twice (also
     *  when its report never reached Weft and Weft hands it out again). */
    @Synchronized
    fun took(id: String): Boolean {
        db.delete("handled", "at < ?", arrayOf((System.currentTimeMillis() - 30 * 86_400_000L).toString()))
        val row = ContentValues().apply { put("id", id); put("at", System.currentTimeMillis()) }
        return db.insertWithOnConflict("handled", null, row, SQLiteDatabase.CONFLICT_IGNORE) != -1L
    }

    /** How it went: a failure wins over a success not yet reported (another part of a long SMS failed). */
    @Synchronized
    fun result(id: String, ok: Boolean, error: String?) {
        val row = ContentValues().apply { put("ok", if (ok) 1 else 0); put("error", error) }
        if (ok) db.update("handled", row, "id = ? AND ok IS NULL", arrayOf(id))
        else db.update("handled", row, "id = ? AND reported = 0", arrayOf(id))
    }

    /** What Weft has not heard yet: {id, ok, error}. */
    fun results(): List<JSONObject> =
        db.rawQuery("SELECT id, ok, error FROM handled WHERE ok IS NOT NULL AND reported = 0 LIMIT 100", null).use { c ->
            buildList {
                while (c.moveToNext()) add(JSONObject().put("id", c.getString(0)).put("ok", c.getInt(1) == 1).also { if (!c.isNull(2)) it.put("error", c.getString(2)) })
            }
        }

    @Synchronized
    fun reported(ids: Collection<String>) {
        for (id in ids) db.update("handled", ContentValues().apply { put("reported", 1) }, "id = ?", arrayOf(id))
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

private class Queue(context: Context) : SQLiteOpenHelper(context, "queue.db", null, 2) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE queue (id TEXT PRIMARY KEY, json TEXT NOT NULL, ts INTEGER NOT NULL)")
        onUpgrade(db, 1, 2)
    }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {
        // What came from Weft to send: kept a month, so the same message never goes twice.
        if (old < 2) db.execSQL("CREATE TABLE handled (id TEXT PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER, error TEXT, reported INTEGER NOT NULL DEFAULT 0)")
    }
}
