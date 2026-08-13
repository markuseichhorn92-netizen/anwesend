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
        /**
         * Datenschutzerklaerung der APP (nicht die der Studio-Website).
         *
         * Drei Bedingungen muessen erfuellt bleiben, sonst scheitert das Play-Review:
         *  1. erreichbar OHNE Login - ein Google-Pruefer hat kein Mitgliedskonto
         *     (die Route ist dafuer in mitglieder.html freigegeben, PUBLIC_LEGAL),
         *  2. sie benennt Health Connect samt der gelesenen Datenarten ausdruecklich,
         *  3. sie sagt, dass die Daten nicht fuer Werbung genutzt oder verkauft werden.
         *
         * Die Website-Erklaerung (fit-inn-trier.de) erfuellt (2) NICHT und darf hier
         * deshalb nicht stehen. Dieselbe Adresse gehoert in die Play-Console-Erklaerung,
         * siehe docs/PLAY-HEALTH-CONNECT.md.
         */
        private const val PRIVACY_URL = "https://mitglieder.fit-inn-trier.de/datenschutz"
    }
}
