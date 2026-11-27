package sk.karchi.weft.phone

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.WindowInsets
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import kotlin.concurrent.thread

/** One screen: pairing with Weft (its address and the code from Settings → Účty → Telefón), then what goes there:
 *  SMS and the notifications of the apps ticked here, and whether what Karchi writes in Weft goes out from here
 *  (beta). Nothing is sent anywhere else. */
class MainActivity : Activity() {
    private val store by lazy { Store.get(this) }
    private val ticker = Handler(Looper.getMainLooper())
    private var status: TextView? = null

    override fun onResume() {
        super.onResume()
        draw()
        tick()
    }

    override fun onPause() {
        super.onPause()
        ticker.removeCallbacksAndMessages(null)
    }

    /** The status line follows the queue while the screen is open. */
    private fun tick() {
        status?.text = statusText()
        ticker.postDelayed({ tick() }, 3_000)
    }

    private fun statusText(): String {
        val ago = (System.currentTimeMillis() - store.sent) / 60_000
        val sent = when {
            store.sent == 0L -> "ešte nič"
            ago < 1 -> "pred chvíľou"
            ago < 60 -> "pred $ago min"
            ago < 24 * 60 -> "pred ${ago / 60} h"
            else -> "pred ${ago / (24 * 60)} dňami"
        }
        return "Spojený s ${store.server}\nNaposledy odoslané: $sent · čaká: ${store.count()}" + (store.error?.let { "\nChyba: $it" } ?: "")
    }

    private fun draw() {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 32, 48, 64) }
        status = null
        if (store.token == null) pairing(root) else paired(root)
        val scroll = ScrollView(this).apply { addView(root) }
        // Android 15 draws under the status and navigation bars: the content keeps clear of them.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) scroll.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(scroll)
    }

    private fun pairing(root: LinearLayout) {
        root.addView(text("Vo Wefte: Nastavenia → Účty → Telefón → Pridať telefón. Prepíš sem adresu a kód. Tailscale musí byť zapnutý."))
        val url = EditText(this).apply {
            hint = "napr. https://100.…:8443"; setHintTextColor(0x66888888); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI; setText(store.server ?: "")
        }
        val code = EditText(this).apply {
            hint = "napr. ABCD-EFGH"; setHintTextColor(0x66888888); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        root.addView(text("Adresa Weftu (celá, ako ju ukazuje Weft)"))
        root.addView(url)
        root.addView(text("Kód"))
        root.addView(code)
        root.addView(Button(this).apply {
            text = "Spojiť"
            setOnClickListener { pair(url.text.toString().trim().trimEnd('/'), code.text.toString().trim()); isEnabled = false }
        })
        store.error?.let { root.addView(text(it)) }
    }

    private fun pair(server: String, code: String) = thread {
        val result = runCatching {
            val ca = Net.fetchCa(server)
            val res = Net.post(server, ca, "/_connect/phone/claim",
                JSONObject().put("code", code).put("name", "${Build.MANUFACTURER} ${Build.MODEL}"), null)
            store.server = server
            store.ca = ca
            store.token = res.getString("token")
            store.error = null
            Sync.periodic(this)
            Sync.soon(this, 0)
        }
        runOnUiThread {
            result.exceptionOrNull()?.let {
                val why = if (it is Net.HttpError && it.code == 403) "Kód nesedí alebo už neplatí. Vypýtaj si vo Wefte nový." else "Weft sa nedá zastihnúť: ${it.message}"
                Toast.makeText(this, why, Toast.LENGTH_LONG).show()
            }
            draw()
        }
    }

    private fun paired(root: LinearLayout) {
        status = text(statusText()).also { root.addView(it) }
        root.addView(LinearLayout(this).apply {
            addView(Button(this@MainActivity).apply { text = "Odoslať teraz"; setOnClickListener { Sync.soon(this@MainActivity, 0); Toast.makeText(this@MainActivity, "Odosiela sa", Toast.LENGTH_SHORT).show() } })
            addView(Button(this@MainActivity).apply {
                text = "Odpojiť"
                setOnClickListener {
                    AlertDialog.Builder(this@MainActivity).setMessage("Odpojiť od Weftu? Prestane posielať; chaty vo Wefte ostanú.")
                        .setNegativeButton("Nie", null)
                        .setPositiveButton("Odpojiť") { _, _ -> unpair() }.show()
                }
            })
        })

        root.addView(text("SMS", 18f, bold = true))
        root.addView(Switch(this).apply {
            text = "Posielať SMS do Weftu (prijaté aj odoslané, najprv posledných 30 dní)"
            isChecked = store.sms && checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
            setOnCheckedChangeListener { _, on ->
                if (!on) { store.sms = false; return@setOnCheckedChangeListener }
                requestPermissions(arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_CONTACTS), SMS)
            }
        })

        root.addView(text("Z Weftu do telefónu (beta)", 18f, bold = true))
        root.addView(Switch(this).apply {
            text = "Posielať z Weftu: SMS a odpovede na notifikácie"
            isChecked = store.write
            setOnCheckedChangeListener { _, on ->
                if (!on) { store.write = false; Waiter.stop(this@MainActivity); return@setOnCheckedChangeListener }
                val ask = listOfNotNull(Manifest.permission.SEND_SMS,
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.POST_NOTIFICATIONS else null)
                requestPermissions(ask.toTypedArray(), WRITE)
            }
        })
        root.addView(text("Čo napíšeš vo Wefte do chatu SMS, odíde z tohto telefónu ako SMS. V chate appky odpovedáš na konkrétnu správu a odíde cez tlačidlo Odpovedať jej notifikácie, kým je notifikácia ešte v telefóne. Telefón musí byť zapnutý a na internete. Beta: zatiaľ neodskúšané na skutočnom telefóne.", 13f))

        root.addView(text("Notifikácie", 18f, bold = true))
        if (listening()) root.addView(text("Prístup k notifikáciám: povolený."))
        else {
            root.addView(text("Weft Telefón zatiaľ nesmie čítať notifikácie."))
            root.addView(Button(this).apply { text = "Povoliť prístup k notifikáciám"; setOnClickListener { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) } })
            root.addView(text("Ak je tam Weft Telefón sivý (obmedzené nastavenie): Nastavenia → Aplikácie → Weft Telefón → ⋮ → Povoliť obmedzené nastavenia, potom znova.", 13f))
        }
        root.addView(text("Appky, ktorých notifikácie pôjdu do Weftu (každá do vlastného chatu). Zaškrtnuté sú hore:"))
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(launcher, 0)
            .map { it.activityInfo.packageName to it.loadLabel(packageManager).toString() }
            .filter { it.first != packageName }.distinctBy { it.first }
            .sortedWith(compareBy<Pair<String, String>> { it.first !in store.apps }.thenBy { it.second.lowercase() })
        for ((pkg, label) in apps) root.addView(CheckBox(this).apply {
            text = label
            isChecked = pkg in store.apps
            setOnCheckedChangeListener { _, on -> store.pick(pkg, on) }
        })
    }

    /** Weft forgets this phone's token too (best effort: offline, Weft's own „Odpojiť“ still does it). */
    private fun unpair() {
        val server = store.server
        val token = store.token
        val ca = store.ca
        store.forget()
        Sync.stop(this)
        Waiter.stop(this)
        draw()
        if (server != null && token != null) thread { runCatching { Net.post(server, ca, "/_connect/phone/forget", JSONObject(), token) } }
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        if (code == WRITE) {
            // Answers to notifications go without SMS permission; an SMS then says in Weft why it did not go.
            store.write = true
            val power = getSystemService(PowerManager::class.java)
            if (!power.isIgnoringBatteryOptimizations(packageName)) runCatching {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            }
            Waiter.start(this)
            draw()
            return
        }
        if (code != SMS) return
        if (checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED) {
            store.sms = true
            Sync.soon(this, 0)
        } else {
            Toast.makeText(this, "Bez povolenia SMS sa SMS neposielajú. Ak je obmedzené: Nastavenia → Aplikácie → Weft Telefón → ⋮ → Povoliť obmedzené nastavenia.", Toast.LENGTH_LONG).show()
        }
        draw()
    }

    private fun listening() = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")?.contains(packageName) == true

    private fun text(s: String, size: Float = 15f, bold: Boolean = false) = TextView(this).apply {
        text = s; textSize = size; setPadding(0, 16, 0, 8)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private companion object {
        const val SMS = 1
        const val WRITE = 2
    }
}
