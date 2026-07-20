package de.fitinn.nativeplugin

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * Pflicht-Activity fuer Health Connect.
 *
 * Health Connect verlangt, dass eine App, die Gesundheitsberechtigungen anfragt,
 * eine Activity mit Intent-Filter `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE`
 * (bzw. ab Android 14 `VIEW_PERMISSION_USAGE` + Kategorie `HEALTH_PERMISSIONS`)
 * bereitstellt. Wird sie im Health-Connect-Freigabeschirm auf „Datenschutz" getippt,
 * oeffnet diese Activity die veroeffentlichte Datenschutzerklaerung und schliesst sich.
 *
 * OHNE diese Activity erscheint die App im Health-Connect-Berechtigungsschirm NICHT
 * und die Freigabe schlaegt fehl.
 */
class HealthConnectRationaleActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_URL))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
        } catch (e: Exception) {
            // Kein Browser vorhanden o. ae. – nicht abstuerzen, einfach schliessen.
        }
        finish()
    }

    companion object {
        // Veroeffentlichte Datenschutzerklaerung von Fit-Inn Trier. Muss die Nutzung der
        // Health-Connect-/Gesundheitsdaten benennen (Voraussetzung fuers Play-Review).
        private const val PRIVACY_URL = "https://www.fit-inn-trier.de/datenschutz"
    }
}
