package sk.karchi.weft.phone

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/** Sends the queue to Weft whenever there is a network: at once after a new item, and every 15 minutes (which also
 *  catches sent SMS), then reports and takes what Karchi wrote in Weft (beta). A failure keeps the queue and the job
 *  tries again later; Weft's „Odpojiť“ unpairs the phone. */
class Sync : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread {
            val retry = try {
                run(this)
                false
            } catch (e: Net.HttpError) {
                if (e.code == 401) unpaired(this) else Store.get(this).error = e.message
                e.code != 401
            } catch (e: Exception) {
                Store.get(this).error = e.message ?: e.toString()
                true
            }
            jobFinished(params, retry)
        }
        return true
    }

    override fun onStopJob(params: JobParameters) = true

    companion object {
        private const val NOW = 1
        private const val PERIODIC = 2

        fun run(context: Context) {
            val store = Store.get(context)
            val server = store.server ?: return
            val token = store.token ?: return // unpaired: nothing is read into the queue
            Sms.read(context)
            while (true) {
                val waiting = store.pending(50)
                if (waiting.isEmpty()) break
                val (batch, off) = waiting.partition { wanted(store, it) }
                store.done(off.map { it.getString("id") })
                if (batch.isEmpty()) continue
                val taken = send(store, server, token, batch)
                val gone = store.done(taken)
                store.sent = System.currentTimeMillis()
                store.error = null
                if (gone == 0) break // Weft answered ids this queue does not have: try again later, never in a loop
            }
            Outbox.run(context, 0) // beta: what Karchi wrote in Weft, also when the waiting service is not running
            Waiter.start(context)
        }

        /** Weft no longer knows this phone („Odpojiť“ there): it forgets the pairing and stops. */
        fun unpaired(context: Context) {
            Store.get(context).forget()
            Store.get(context).error = "Vo Wefte odpojený. Spáruj ho znova."
            stop(context)
            Waiter.stop(context)
        }

        /** The ids Weft took. A batch it refuses as a whole (too big, or one item it cannot read) goes one by one, and
         *  an item refused alone is dropped, so one bad item never holds up the queue behind it. */
        private fun send(store: Store, server: String, token: String, batch: List<JSONObject>): List<String> = try {
            val taken = Net.post(server, store.ca, "/_connect/phone/items", JSONObject().put("items", JSONArray(batch)), token).getJSONArray("taken")
            (0 until taken.length()).map { taken.getString(it) }
        } catch (e: Net.HttpError) {
            if (e.code != 400 && e.code != 413) throw e
            if (batch.size == 1) listOf(batch[0].getString("id"))
            else batch.flatMap { if (wanted(store, it) && store.has(it.getString("id"))) send(store, server, token, listOf(it)) else listOf(it.getString("id")) }
        }

        /** SMS switched off or an app unticked after its items came in: they stay on the phone (asked again before each
         *  request). A notification from before its app was last ticked (an older build's queue) stays out too. */
        private fun wanted(store: Store, item: JSONObject) =
            if (item.optString("kind") == "sms") store.sms
            else item.optString("app").let { app -> app in store.apps && item.optLong("ts") >= store.since(app) }

        fun soon(context: Context, delay: Long) {
            val job = JobInfo.Builder(NOW, ComponentName(context, Sync::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setMinimumLatency(delay)
                .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                .build()
            context.getSystemService(JobScheduler::class.java).schedule(job)
        }

        fun periodic(context: Context) {
            val job = JobInfo.Builder(PERIODIC, ComponentName(context, Sync::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60_000L)
                .setPersisted(true)
                .build()
            context.getSystemService(JobScheduler::class.java).schedule(job)
        }

        fun stop(context: Context) = context.getSystemService(JobScheduler::class.java).cancelAll()
    }
}
