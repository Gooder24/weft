package sk.karchi.weft.phone

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** Weft on asus speaks https with Caddy's own CA. Pairing fetches that CA once (over Tailscale); every request after
 *  trusts only it, so nothing but that server gets the phone's items. */
object Net {
    class HttpError(val code: Int, message: String) : Exception(message)

    fun fetchCa(server: String): String? {
        if (!server.startsWith("https://")) return null
        val conn = URL("$server/_connect/phone/ca.crt").openConnection() as HttpsURLConnection
        conn.sslSocketFactory = SSLContext.getInstance("TLS").apply { init(null, arrayOf(Anything), null) }.socketFactory
        conn.setHostnameVerifier { _, _ -> true } // only for the CA itself; it is checked by the claim right after
        conn.connectTimeout = 15_000
        conn.readTimeout = 15_000
        val code = conn.responseCode
        if (code != 200) throw HttpError(code, "CA: $code")
        val pem = conn.inputStream.bufferedReader().use { it.readText() }
        if (!pem.startsWith("-----BEGIN CERTIFICATE-----")) throw HttpError(0, "CA is not a certificate")
        return pem
    }

    fun post(server: String, ca: String?, path: String, body: JSONObject, token: String?): JSONObject {
        val conn = URL(server + path).openConnection() as HttpURLConnection
        if (conn is HttpsURLConnection && ca != null) conn.sslSocketFactory = pinned(ca).socketFactory
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        conn.setRequestProperty("Content-Type", "application/json")
        if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = conn.responseCode
        val text = (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code >= 400) throw HttpError(code, "$code ${text.take(200)}")
        return JSONObject(text)
    }

    private fun pinned(pem: String): SSLContext {
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream())
        val keys = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("weft", cert) }
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(keys) }
        return SSLContext.getInstance("TLS").apply { init(null, trust.trustManagers, null) }
    }

    private object Anything : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, type: String) {}
        override fun checkServerTrusted(chain: Array<X509Certificate>, type: String) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
