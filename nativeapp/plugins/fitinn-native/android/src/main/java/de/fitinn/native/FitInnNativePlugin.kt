package de.fitinn.native

import android.Manifest
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.location.Location
import android.os.Build
import android.os.Looper
import android.os.ParcelUuid
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregationResult
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.UUID

/**
 * FitInnNativePlugin (Android) – native Umsetzung des `window.FitInnNative`-Vertrags
 * (siehe docs/NATIVE-BRIDGE.md). Deckt dieselben drei Bereiche ab wie das iOS-Plugin:
 *
 *   1. Health Connect (Google-Fit-Nachfolger): healthAuth / getHealthWorkouts /
 *      getHealthMetrics / saveHealthWorkout
 *   2. Herzfrequenz-Gurt (BLE):                 startHeartRate / stopHeartRate  (+ Event "heartRate")
 *   3. Standort/GPS (Fused Location):           getPosition / watchPosition / clearWatch  (+ Event "location")
 *
 * Die WebView (mitglieder.fit-inn-trier.de) baut sich `window.FitInnNative` selbst aus
 * `Capacitor.Plugins.FitInnNative` (siehe woNativeBind() in mitglieder.html). Dieses
 * Plugin liefert nur die nativen Methoden dahinter – es ist als eigenstaendiges
 * Capacitor-Plugin-Modul registriert (jsName = "FitInnNative"), Capacitor meldet es
 * automatisch an (kein Eintrag in der MainActivity noetig).
 *
 * ⚠️ Gegen den Vertrag geschrieben, NICHT auf Geraet getestet. Health Connect + BLE
 *    laufen nur auf einem echten Android-Geraet (nicht im Emulator ohne HC-Provider).
 *    Auf einem Mac in Android Studio bauen und auf einem echten Handy pruefen.
 */
@CapacitorPlugin(
    name = "FitInnNative",
    permissions = [
        Permission(
            alias = FitInnNativePlugin.BLE,
            strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT]
        ),
        Permission(
            alias = FitInnNativePlugin.LOCATION,
            strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION]
        )
    ]
)
class FitInnNativePlugin : Plugin() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val provider = HealthConnectClient.DEFAULT_PROVIDER_PACKAGE_NAME

    // ─────────────────────────────────────────────────────────────────────────
    //  Health Connect
    // ─────────────────────────────────────────────────────────────────────────

    private fun hcAvailable(): Boolean = try {
        HealthConnectClient.getSdkStatus(context, provider) == HealthConnectClient.SDK_AVAILABLE
    } catch (e: Exception) { false }

    private fun hc(): HealthConnectClient? = try {
        if (hcAvailable()) HealthConnectClient.getOrCreate(context) else null
    } catch (e: Exception) { null }

    // Alle Berechtigungen, die das Plugin (lesend + schreibend) nutzt.
    private val hcPermissions: Set<String> by lazy {
        setOf(
            HealthPermission.getReadPermission(ExerciseSessionRecord::class),
            HealthPermission.getReadPermission(HeartRateRecord::class),
            HealthPermission.getReadPermission(DistanceRecord::class),
            HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
            HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
            HealthPermission.getReadPermission(StepsRecord::class),
            HealthPermission.getReadPermission(RestingHeartRateRecord::class),
            HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
            HealthPermission.getReadPermission(WeightRecord::class),
            HealthPermission.getReadPermission(BodyFatRecord::class),
            HealthPermission.getReadPermission(Vo2MaxRecord::class),
            HealthPermission.getReadPermission(SleepSessionRecord::class),
            HealthPermission.getWritePermission(ExerciseSessionRecord::class),
            HealthPermission.getWritePermission(ActiveCaloriesBurnedRecord::class),
            HealthPermission.getWritePermission(DistanceRecord::class)
        )
    }

    @PluginMethod
    fun healthAuth(call: PluginCall) {
        val client = hc()
        if (client == null) { call.resolve(authResult(false, false, false)); return }
        scope.launch {
            try {
                val granted = withContext(Dispatchers.IO) { client.permissionController.getGrantedPermissions() }
                if (granted.containsAll(hcPermissions)) {
                    call.resolve(authFrom(granted)); return@launch
                }
                // Fehlende Rechte anfragen: Health Connect zeigt seinen eigenen Freigabe-Dialog.
                val contract = PermissionController.createRequestPermissionResultContract(provider)
                val intent = contract.createIntent(context, hcPermissions)
                startActivityForResult(call, intent, "healthAuthResult")
            } catch (e: Exception) {
                call.resolve(authResult(false, false, false).put("error", e.message ?: "hc_error"))
            }
        }
    }

    @ActivityCallback
    private fun healthAuthResult(call: PluginCall?, result: ActivityResult?) {
        if (call == null) return
        val client = hc()
        if (client == null) { call.resolve(authResult(false, false, false)); return }
        scope.launch {
            val granted = try {
                withContext(Dispatchers.IO) { client.permissionController.getGrantedPermissions() }
            } catch (e: Exception) { emptySet<String>() }
            call.resolve(authFrom(granted))
        }
    }

    private fun authFrom(granted: Set<String>): JSObject {
        val read = granted.any { it.contains("READ") }
        val write = granted.any { it.contains("WRITE") }
        return authResult(read, read, write)
    }

    private fun authResult(ok: Boolean, read: Boolean, write: Boolean): JSObject =
        JSObject().put("ok", ok).put("read", read).put("write", write)

    @PluginMethod
    fun getHealthWorkouts(call: PluginCall) {
        val client = hc()
        if (client == null) { call.resolve(JSObject().put("ok", false).put("workouts", JSArray())); return }
        val sinceMs = call.getDouble("sinceTs") ?: 0.0
        val start = if (sinceMs > 0) Instant.ofEpochMilli(sinceMs.toLong())
                    else Instant.now().minus(90, ChronoUnit.DAYS)
        scope.launch {
            try {
                val arr = withContext(Dispatchers.IO) { readWorkouts(client, start) }
                call.resolve(JSObject().put("ok", true).put("workouts", arr))
            } catch (e: Exception) {
                call.resolve(JSObject().put("ok", false).put("workouts", JSArray()).put("error", e.message ?: "read_failed"))
            }
        }
    }

    // Trainings seit `start` ins Vertrags-Format bringen; Ø/Max-Puls, kcal und Distanz
    // je Einheit ueber den Zeitraum aggregieren.
    private suspend fun readWorkouts(client: HealthConnectClient, start: Instant): JSArray {
        val now = Instant.now()
        val resp = client.readRecords(
            ReadRecordsRequest(ExerciseSessionRecord::class, timeRangeFilter = TimeRangeFilter.between(start, now))
        )
        val out = JSArray()
        for (s in resp.records) {
            val o = JSObject()
            o.put("extId", s.metadata.id)
            o.put("start", s.startTime.toEpochMilli())
            o.put("end", s.endTime.toEpochMilli())
            o.put("durationSec", ChronoUnit.SECONDS.between(s.startTime, s.endTime).toInt())
            o.put("activity", activityKey(s.exerciseType))
            o.put("kind", if (isOutdoor(s.exerciseType)) "outdoor" else "indoor")
            o.put("source", "health")
            try {
                val agg: AggregationResult = client.aggregate(
                    AggregateRequest(
                        metrics = setOf(
                            HeartRateRecord.BPM_AVG,
                            HeartRateRecord.BPM_MAX,
                            ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL,
                            DistanceRecord.DISTANCE_TOTAL
                        ),
                        timeRangeFilter = TimeRangeFilter.between(s.startTime, s.endTime)
                    )
                )
                agg[HeartRateRecord.BPM_AVG]?.let { o.put("avgHr", it.toInt()) }
                agg[HeartRateRecord.BPM_MAX]?.let { o.put("maxHr", it.toInt()) }
                agg[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.let { o.put("kcal", it.inKilocalories.toInt()) }
                agg[DistanceRecord.DISTANCE_TOTAL]?.let { o.put("distanceM", it.inMeters.toInt()) }
            } catch (e: Exception) {
                // Aggregation kann je Einheit fehlschlagen -> Basisfelder trotzdem liefern.
            }
            out.put(o)
        }
        return out
    }

    // Gesundheits-Kennzahlen (jeweils juengster Wert) fuer Vital-Check, Figur-Check & Co.
    // -> { ok, restingHr, hrv, weightKg, bodyFatPct, vo2max, steps (heute), Schlaf (letzte Nacht) }.
    @PluginMethod
    fun getHealthMetrics(call: PluginCall) {
        val client = hc()
        if (client == null) { call.resolve(JSObject().put("ok", false)); return }
        scope.launch {
            val out = JSObject()
            try {
                withContext(Dispatchers.IO) {
                    latestRecord<RestingHeartRateRecord>(client, 60)?.let { out.put("restingHr", it.beatsPerMinute.toInt()) }
                    latestRecord<HeartRateVariabilityRmssdRecord>(client, 60)?.let { out.put("hrv", round1(it.heartRateVariabilityMillis)) }
                    latestRecord<WeightRecord>(client, 365)?.let { out.put("weightKg", round1(it.weight.inKilograms)) }
                    latestRecord<BodyFatRecord>(client, 365)?.let { out.put("bodyFatPct", round1(it.percentage.value)) }
                    latestRecord<Vo2MaxRecord>(client, 365)?.let { out.put("vo2max", round1(it.vo2MillilitersPerMinuteKilogram)) }
                    stepsToday(client)?.let { out.put("steps", it) }
                    sleepLastNight(client, out)
                }
                out.put("ok", true)
                call.resolve(out)
            } catch (e: Exception) {
                call.resolve(JSObject().put("ok", false).put("error", e.message ?: "metrics_failed"))
            }
        }
    }

    // Juengsten Datensatz eines Typs lesen (absteigend, 1 Stueck) innerhalb der letzten `days` Tage.
    private suspend inline fun <reified T : Record> latestRecord(client: HealthConnectClient, days: Long): T? {
        val end = Instant.now()
        val startI = end.minus(days, ChronoUnit.DAYS)
        val resp = client.readRecords(
            ReadRecordsRequest(
                T::class,
                timeRangeFilter = TimeRangeFilter.between(startI, end),
                ascendingOrder = false,
                pageSize = 1
            )
        )
        return resp.records.firstOrNull()
    }

    private suspend fun stepsToday(client: HealthConnectClient): Int? {
        return try {
            val zone = ZoneId.systemDefault()
            val startOfDay = LocalDate.now(zone).atStartOfDay(zone).toInstant()
            val agg = client.aggregate(
                AggregateRequest(
                    metrics = setOf(StepsRecord.COUNT_TOTAL),
                    timeRangeFilter = TimeRangeFilter.between(startOfDay, Instant.now())
                )
            )
            agg[StepsRecord.COUNT_TOTAL]?.toInt()
        } catch (e: Exception) { null }
    }

    // Schlaf der letzten Nacht INKL. Phasen (Tief/REM/Leicht/Wach) – spiegelt die iOS-Logik.
    private suspend fun sleepLastNight(client: HealthConnectClient, out: JSObject) {
        val since = Instant.now().minus(18, ChronoUnit.HOURS)
        val resp = try {
            client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, timeRangeFilter = TimeRangeFilter.between(since, Instant.now())))
        } catch (e: Exception) { return }

        var deep = 0L; var rem = 0L; var light = 0L; var unspec = 0L; var awake = 0L
        var sMin = Long.MAX_VALUE; var sMax = Long.MIN_VALUE

        for (sess in resp.records) {
            if (sess.stages.isEmpty()) {
                // Quelle ohne Phasen -> nur Gesamtschlaf (als "leicht/unspezifisch" gezaehlt).
                unspec += ChronoUnit.SECONDS.between(sess.startTime, sess.endTime)
                sMin = minOf(sMin, sess.startTime.toEpochMilli())
                sMax = maxOf(sMax, sess.endTime.toEpochMilli())
                continue
            }
            for (st in sess.stages) {
                val d = ChronoUnit.SECONDS.between(st.startTime, st.endTime)
                when (st.stage) {
                    SleepSessionRecord.STAGE_TYPE_DEEP -> deep += d
                    SleepSessionRecord.STAGE_TYPE_REM -> rem += d
                    SleepSessionRecord.STAGE_TYPE_LIGHT -> light += d
                    SleepSessionRecord.STAGE_TYPE_SLEEPING -> unspec += d
                    SleepSessionRecord.STAGE_TYPE_AWAKE,
                    SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> awake += d
                    SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> { /* im Bett, aber nicht als Schlaf/Wach gewertet */ }
                    else -> unspec += d
                }
                val realSleep = st.stage != SleepSessionRecord.STAGE_TYPE_AWAKE &&
                    st.stage != SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED &&
                    st.stage != SleepSessionRecord.STAGE_TYPE_OUT_OF_BED
                if (realSleep) {
                    sMin = minOf(sMin, st.startTime.toEpochMilli())
                    sMax = maxOf(sMax, st.endTime.toEpochMilli())
                }
            }
        }

        val asleep = deep + rem + light + unspec
        if (asleep > 0 || awake > 0) {
            out.put("sleepMin", (asleep / 60).toInt())
            out.put("sleepDeepMin", (deep / 60).toInt())
            out.put("sleepRemMin", (rem / 60).toInt())
            out.put("sleepLightMin", ((light + unspec) / 60).toInt())
            out.put("sleepAwakeMin", (awake / 60).toInt())
            if (sMax > sMin) {
                out.put("sleepStart", sMin.toDouble())
                out.put("sleepEnd", sMax.toDouble())
            }
        }
    }

    @PluginMethod
    fun saveHealthWorkout(call: PluginCall) {
        val client = hc()
        if (client == null) { call.resolve(JSObject().put("ok", false)); return }
        val startMs = (call.getDouble("start") ?: 0.0).toLong()
        val endMs = (call.getDouble("end") ?: 0.0).toLong()
        if (startMs <= 0 || endMs <= startMs) { call.resolve(JSObject().put("ok", false).put("error", "bad_dates")); return }
        val activity = call.getString("activity") ?: "studio"
        val kcal = call.getInt("kcal") ?: 0
        val distanceM = call.getInt("distanceM") ?: 0
        val startI = Instant.ofEpochMilli(startMs)
        val endI = Instant.ofEpochMilli(endMs)
        val zo = ZoneId.systemDefault().rules.getOffset(startI)
        scope.launch {
            try {
                val records = mutableListOf<Record>()
                records.add(
                    ExerciseSessionRecord(
                        startTime = startI, startZoneOffset = zo,
                        endTime = endI, endZoneOffset = zo,
                        exerciseType = hcType(activity),
                        title = null, notes = null,
                        metadata = Metadata()
                    )
                )
                if (kcal > 0) {
                    records.add(
                        ActiveCaloriesBurnedRecord(
                            startTime = startI, startZoneOffset = zo,
                            endTime = endI, endZoneOffset = zo,
                            energy = Energy.kilocalories(kcal.toDouble()),
                            metadata = Metadata()
                        )
                    )
                }
                if (distanceM > 0) {
                    records.add(
                        DistanceRecord(
                            startTime = startI, startZoneOffset = zo,
                            endTime = endI, endZoneOffset = zo,
                            distance = Length.meters(distanceM.toDouble()),
                            metadata = Metadata()
                        )
                    )
                }
                val res = withContext(Dispatchers.IO) { client.insertRecords(records) }
                val id = res.recordIdsList.firstOrNull() ?: ""
                call.resolve(JSObject().put("ok", true).put("extId", id))
            } catch (e: Exception) {
                call.resolve(JSObject().put("ok", false).put("error", e.message ?: "write_failed"))
            }
        }
    }

    // Health-Connect-Aktivitaet -> unsere Aktivitaets-Keys (siehe lib/workouts.js ACTIVITIES).
    private fun activityKey(t: Int): String = when (t) {
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "laufen"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING,
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "radfahren"
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "gehen"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "wandern"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING,
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "kraft"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING,
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL,
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING -> "cardio"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA,
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES -> "kurs"
        else -> if (isOutdoor(t)) "outdoor" else "studio"
    }

    private fun isOutdoor(t: Int): Boolean = when (t) {
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING,
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING,
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> true
        else -> false
    }

    private fun hcType(key: String): Int = when (key) {
        "laufen" -> ExerciseSessionRecord.EXERCISE_TYPE_RUNNING
        "radfahren" -> ExerciseSessionRecord.EXERCISE_TYPE_BIKING
        "gehen" -> ExerciseSessionRecord.EXERCISE_TYPE_WALKING
        "wandern" -> ExerciseSessionRecord.EXERCISE_TYPE_HIKING
        "kraft" -> ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING
        "cardio" -> ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING
        "kurs" -> ExerciseSessionRecord.EXERCISE_TYPE_YOGA
        else -> ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT
    }

    private fun round1(v: Double): Double = Math.round(v * 10.0) / 10.0

    // ─────────────────────────────────────────────────────────────────────────
    //  Herzfrequenz-Gurt (BLE)
    // ─────────────────────────────────────────────────────────────────────────

    private var btGatt: BluetoothGatt? = null
    private var scanner: BluetoothLeScanner? = null
    private var hrScanCallback: ScanCallback? = null
    private var hrCall: PluginCall? = null

    @PluginMethod
    fun startHeartRate(call: PluginCall) {
        hrCall = call
        val alias = if (Build.VERSION.SDK_INT >= 31) BLE else LOCATION
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias, call, "hrPermCallback")
            return
        }
        beginHrScan()
    }

    @PermissionCallback
    private fun hrPermCallback(call: PluginCall) {
        val alias = if (Build.VERSION.SDK_INT >= 31) BLE else LOCATION
        if (getPermissionState(alias) == PermissionState.GRANTED) beginHrScan()
        else hrResolve(false, "bluetooth_permission_denied")
    }

    private fun beginHrScan() {
        val mgr = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = mgr?.adapter
        if (adapter == null || !adapter.isEnabled) { hrResolve(false, "bluetooth_off"); return }
        val sc = adapter.bluetoothLeScanner
        if (sc == null) { hrResolve(false, "bluetooth_unavailable"); return }
        scanner = sc
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(HR_SERVICE)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                try { scanner?.stopScan(this) } catch (e: Exception) {}
                connectHr(result.device)
            }
            override fun onScanFailed(errorCode: Int) { hrResolve(false, "scan_failed") }
        }
        hrScanCallback = cb
        try { sc.startScan(listOf(filter), settings, cb) }
        catch (e: SecurityException) { hrResolve(false, "bluetooth_permission_denied") }
    }

    private fun connectHr(device: BluetoothDevice) {
        try {
            btGatt = device.connectGatt(context, false, object : BluetoothGattCallback() {
                override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        try { gatt.discoverServices() } catch (e: SecurityException) { hrResolve(false, "bluetooth_permission_denied") }
                    }
                }
                override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                    val svc = gatt.getService(HR_SERVICE) ?: run { hrResolve(false, "no_hr_service"); return }
                    val ch = svc.getCharacteristic(HR_CHAR) ?: run { hrResolve(false, "no_hr_char"); return }
                    try {
                        gatt.setCharacteristicNotification(ch, true)
                        val desc = ch.getDescriptor(CCC_DESC)
                        if (desc != null) {
                            if (Build.VERSION.SDK_INT >= 33) {
                                gatt.writeDescriptor(desc, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                            } else {
                                @Suppress("DEPRECATION")
                                desc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                                @Suppress("DEPRECATION")
                                gatt.writeDescriptor(desc)
                            }
                        }
                        hrResolve(true, null)   // Verbindung steht; Messwerte kommen ab jetzt als "heartRate"-Events.
                    } catch (e: SecurityException) { hrResolve(false, "bluetooth_permission_denied") }
                }
                // Android 13+ (API 33): Wert wird direkt uebergeben.
                override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
                    if (characteristic.uuid == HR_CHAR) emitHr(value)
                }
                // Aeltere Android-Versionen: Wert aus der Characteristic lesen.
                @Deprecated("Ab API 33 die Variante mit ByteArray")
                override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                    if (characteristic.uuid == HR_CHAR) {
                        @Suppress("DEPRECATION")
                        val v = characteristic.value ?: return
                        emitHr(v)
                    }
                }
            })
        } catch (e: SecurityException) { hrResolve(false, "bluetooth_permission_denied") }
    }

    // 0x2A37 Heart Rate Measurement parsen: Flags -> BPM (8/16 bit) + optionale RR-Intervalle (ms).
    private fun emitHr(bytes: ByteArray) {
        if (bytes.size < 2) return
        val flags = bytes[0].toInt() and 0xFF
        var idx = 1
        val bpm: Int
        if (flags and 0x01 == 0) { bpm = bytes[idx].toInt() and 0xFF; idx += 1 }
        else { bpm = (bytes[idx].toInt() and 0xFF) or ((bytes[idx + 1].toInt() and 0xFF) shl 8); idx += 2 }
        if (flags and 0x08 != 0) idx += 2   // Energy Expended vorhanden -> ueberspringen
        val rr = JSArray()
        if (flags and 0x10 != 0) {
            while (idx + 1 < bytes.size) {
                val raw = (bytes[idx].toInt() and 0xFF) or ((bytes[idx + 1].toInt() and 0xFF) shl 8)
                rr.put((raw / 1024.0 * 1000.0).toInt())   // 1/1024 s -> ms
                idx += 2
            }
        }
        if (bpm > 0) {
            notifyListeners("heartRate", JSObject().put("bpm", bpm).put("rr", rr))
        }
    }

    @PluginMethod
    fun stopHeartRate(call: PluginCall) {
        try { hrScanCallback?.let { scanner?.stopScan(it) } } catch (e: Exception) {}
        try { btGatt?.disconnect() } catch (e: Exception) {}
        try { btGatt?.close() } catch (e: Exception) {}
        btGatt = null
        hrScanCallback = null
        hrCall = null
        call.resolve()
    }

    // Den offenen startHeartRate-Call GENAU EINMAL aufloesen.
    private fun hrResolve(ok: Boolean, error: String?) {
        val c = hrCall ?: return
        hrCall = null
        val o = JSObject().put("ok", ok)
        if (error != null) o.put("error", error)
        c.resolve(o)
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Standort / GPS (Fused Location)
    // ─────────────────────────────────────────────────────────────────────────

    private var fused: FusedLocationProviderClient? = null
    private val watchCallbacks = HashMap<Int, LocationCallback>()

    private fun fusedClient(): FusedLocationProviderClient {
        val f = fused ?: LocationServices.getFusedLocationProviderClient(context).also { fused = it }
        return f
    }

    @PluginMethod
    fun getPosition(call: PluginCall) {
        if (getPermissionState(LOCATION) != PermissionState.GRANTED) {
            requestPermissionForAlias(LOCATION, call, "geoOneShotPerm")
            return
        }
        doGetPosition(call)
    }

    @PermissionCallback
    private fun geoOneShotPerm(call: PluginCall) {
        if (getPermissionState(LOCATION) == PermissionState.GRANTED) doGetPosition(call)
        else call.reject("location_permission_denied")
    }

    private fun doGetPosition(call: PluginCall) {
        try {
            val token = CancellationTokenSource()
            fusedClient().getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, token.token)
                .addOnSuccessListener { loc -> if (loc != null) call.resolve(locJson(loc)) else fallbackLast(call) }
                .addOnFailureListener { call.reject("location_failed") }
        } catch (e: SecurityException) { call.reject("location_permission_denied") }
    }

    private fun fallbackLast(call: PluginCall) {
        try {
            fusedClient().lastLocation
                .addOnSuccessListener { loc -> if (loc != null) call.resolve(locJson(loc)) else call.reject("no_location") }
                .addOnFailureListener { call.reject("location_failed") }
        } catch (e: SecurityException) { call.reject("location_permission_denied") }
    }

    @PluginMethod
    fun watchPosition(call: PluginCall) {
        if (getPermissionState(LOCATION) != PermissionState.GRANTED) {
            requestPermissionForAlias(LOCATION, call, "geoWatchPerm")
            return
        }
        startWatch(call)
    }

    @PermissionCallback
    private fun geoWatchPerm(call: PluginCall) {
        if (getPermissionState(LOCATION) == PermissionState.GRANTED) startWatch(call)
        else call.resolve(JSObject().put("ok", false).put("error", "location_permission_denied"))
    }

    private fun startWatch(call: PluginCall) {
        val id = call.getInt("watchId") ?: 0
        val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2000L)
            .setMinUpdateIntervalMillis(1000L)
            .build()
        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val loc = result.lastLocation ?: return
                val d = locJson(loc); d.put("watchId", id)
                notifyListeners("location", d)
            }
        }
        watchCallbacks[id] = cb
        try {
            fusedClient().requestLocationUpdates(req, cb, Looper.getMainLooper())
            call.resolve(JSObject().put("ok", true).put("watchId", id))
        } catch (e: SecurityException) {
            watchCallbacks.remove(id)
            call.resolve(JSObject().put("ok", false).put("error", "location_permission_denied"))
        }
    }

    @PluginMethod
    fun clearWatch(call: PluginCall) {
        val id = call.getInt("watchId")
        if (id != null) {
            watchCallbacks.remove(id)?.let { try { fusedClient().removeLocationUpdates(it) } catch (e: Exception) {} }
        }
        call.resolve()
    }

    private fun locJson(loc: Location): JSObject {
        val o = JSObject()
        o.put("lat", loc.latitude)
        o.put("lng", loc.longitude)
        if (loc.hasAltitude()) o.put("alt", loc.altitude)
        if (loc.hasAccuracy()) o.put("acc", loc.accuracy.toDouble())
        return o
    }

    // ─────────────────────────────────────────────────────────────────────────

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        try { btGatt?.close() } catch (e: Exception) {}
        try {
            watchCallbacks.values.forEach { fusedClient().removeLocationUpdates(it) }
            watchCallbacks.clear()
        } catch (e: Exception) {}
        try { scope.cancel() } catch (e: Exception) {}
    }

    companion object {
        const val BLE = "ble"
        const val LOCATION = "location"

        // Heart Rate Service 0x180D, Measurement 0x2A37, Client Characteristic Config 0x2902.
        private val HR_SERVICE: UUID = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
        private val HR_CHAR: UUID = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb")
        private val CCC_DESC: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
