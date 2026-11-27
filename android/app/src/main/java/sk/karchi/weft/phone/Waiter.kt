package sk.karchi.weft.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import kotlin.concurrent.thread

/** Beta: while „Posielať z Weftu“ is on, a quiet notification keeps this running, and it waits on Weft for what
 *  Karchi writes there (one request held up to 50 s, then the next), so a message goes out in seconds, not at the
 *  next 15-minute sync. Without a network it tries again later, up to every 5 minutes. */
class Waiter : Service() {
    @Volatile private var running = false

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // In the foreground first, always: a service started so that stops before it crashes the app on Android 8–11.
        val shown = runCatching { foreground() }.isSuccess // refused from the background: the sync still sends
        val store = Store.get(this)
        if (!shown || store.token == null || !store.write) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!running) {
            running = true
            thread { loop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun loop() {
        var pause = 5_000L
        while (running) {
            val store = Store.get(this)
            if (store.token == null || !store.write) break
            try {
                val began = System.currentTimeMillis()
                Outbox.run(this, 50)
                pause = 5_000L
                // Weft answers at once only with something to send; never a tight loop if it keeps doing so.
                if (System.currentTimeMillis() - began < 2_000) Thread.sleep(2_000)
            } catch (e: Net.HttpError) {
                if (e.code == 401) {
                    Sync.unpaired(this)
                    break
                }
                Thread.sleep(pause).also { pause = minOf(pause * 2, 300_000L) }
            } catch (e: Exception) {
                Thread.sleep(pause).also { pause = minOf(pause * 2, 300_000L) }
            }
        }
        running = false
        stopSelf()
    }

    private fun foreground() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Posielanie z Weftu", NotificationManager.IMPORTANCE_MIN))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val note = Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle("Weft Telefón").setContentText("Čaká na správy, ktoré napíšeš vo Wefte (beta)")
            .setOngoing(true).setContentIntent(open).build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) startForeground(1, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(1, note)
    }

    companion object {
        private const val CHANNEL = "waiter"

        /** Best effort: Android may refuse a start from the background; the 15-minute sync still sends then. */
        fun start(context: Context) {
            val store = Store.get(context)
            if (store.token == null || !store.write) return
            runCatching { context.startForegroundService(Intent(context, Waiter::class.java)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, Waiter::class.java))
        }
    }
}

/** After a restart: waiting on Weft again. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) Waiter.start(context)
    }
}
