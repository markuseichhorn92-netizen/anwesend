import Foundation
import Capacitor
import HealthKit
import CoreBluetooth
import CoreLocation

/**
 * FitInnNativePlugin – native Umsetzung des `window.FitInnNative`-Vertrags
 * (siehe docs/NATIVE-BRIDGE.md). Deckt drei Bereiche ab:
 *
 *   1. Apple Health (HealthKit): healthAuth / getHealthWorkouts / saveHealthWorkout
 *   2. Herzfrequenz-Gurt (CoreBluetooth): startHeartRate / stopHeartRate  (+ Event „heartRate")
 *   3. Standort/GPS (CoreLocation):     getPosition / watchPosition / clearWatch  (+ Event „location")
 *
 * Die WebView (mitglieder.fit-inn-trier.de) spricht NICHT dieses Plugin direkt an,
 * sondern das globale `window.FitInnNative`. Der Shim `fitinn-native-bridge.js`
 * verbindet beides und wird in load() als WKUserScript injiziert.
 *
 * ⚠️ Dieses Gerüst ist gegen den Vertrag geschrieben, aber NICHT auf Gerät getestet.
 *    Auf einem Mac in Xcode kompilieren und auf einem echten iPhone prüfen.
 *    HealthKit + Bluetooth laufen NICHT im iOS-Simulator.
 *
 * Das globale window.FitInnNative (der Shim) wird von MainViewController.swift in die
 * WebView eingespielt – dieses Plugin liefert nur die nativen Methoden dahinter.
 */
@objc(FitInnNativePlugin)
public class FitInnNativePlugin: CAPPlugin, CBCentralManagerDelegate, CBPeripheralDelegate, CLLocationManagerDelegate {

    // MARK: - Apple Health (HealthKit)

    private let healthStore = HKHealthStore()

    private func hkReadTypes() -> Set<HKObjectType> {
        var s: Set<HKObjectType> = [HKObjectType.workoutType()]
        [.heartRate, .distanceWalkingRunning, .distanceCycling, .activeEnergyBurned].forEach {
            if let t = HKObjectType.quantityType(forIdentifier: $0) { s.insert(t) }
        }
        return s
    }
    private func hkShareTypes() -> Set<HKSampleType> {
        var s: Set<HKSampleType> = [HKObjectType.workoutType()]
        [.activeEnergyBurned, .distanceWalkingRunning, .distanceCycling].forEach {
            if let t = HKObjectType.quantityType(forIdentifier: $0) { s.insert(t) }
        }
        return s
    }

    @objc func healthAuth(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.resolve(["ok": false, "read": false, "write": false]); return
        }
        healthStore.requestAuthorization(toShare: hkShareTypes(), read: hkReadTypes()) { success, error in
            if let error = error {
                call.resolve(["ok": false, "read": false, "write": false, "error": error.localizedDescription]); return
            }
            // Lesezugriff meldet iOS aus Datenschutzgründen NICHT zurück -> nach erfolgreichem
            // Dialog optimistisch als erteilt behandeln. Schreibrecht ist abfragbar.
            let canWrite = self.healthStore.authorizationStatus(for: HKObjectType.workoutType()) == .sharingAuthorized
            call.resolve(["ok": success, "read": success, "write": canWrite])
        }
    }

    @objc func getHealthWorkouts(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(["ok": false, "workouts": []]); return }
        let sinceMs = call.getDouble("sinceTs") ?? 0
        let start = sinceMs > 0 ? Date(timeIntervalSince1970: sinceMs / 1000.0)
                                : Date().addingTimeInterval(-90 * 24 * 3600)
        let pred = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
        let query = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: pred,
                                  limit: 200, sortDescriptors: [sort]) { _, samples, error in
            guard error == nil, let workouts = samples as? [HKWorkout] else {
                call.resolve(["ok": false, "workouts": []]); return
            }
            self.mapWorkouts(workouts) { arr in call.resolve(["ok": true, "workouts": arr]) }
        }
        healthStore.execute(query)
    }

    // Jede Einheit ins Vertrags-Format bringen; Ø/Max-Puls per Statistik-Abfrage über den Zeitraum.
    private func mapWorkouts(_ workouts: [HKWorkout], _ done: @escaping ([[String: Any]]) -> Void) {
        guard let hrType = HKObjectType.quantityType(forIdentifier: .heartRate) else { done([]); return }
        let bpmUnit = HKUnit.count().unitDivided(by: .minute())
        let group = DispatchGroup()
        var result = [[String: Any]?](repeating: nil, count: workouts.count)

        for (i, w) in workouts.enumerated() {
            var dict: [String: Any] = [
                "extId": w.uuid.uuidString,
                "start": w.startDate.timeIntervalSince1970 * 1000,
                "end": w.endDate.timeIntervalSince1970 * 1000,
                "durationSec": Int(w.duration),
                "activity": Self.activityKey(w.workoutActivityType),
                "kind": Self.isOutdoor(w.workoutActivityType) ? "outdoor" : "indoor",
                "source": "health"
            ]
            if let kcal = w.totalEnergyBurned?.doubleValue(for: .kilocalorie()) { dict["kcal"] = Int(kcal) }
            if let dist = w.totalDistance?.doubleValue(for: .meter()) { dict["distanceM"] = Int(dist) }

            group.enter()
            let pred = HKQuery.predicateForSamples(withStart: w.startDate, end: w.endDate, options: .strictStartDate)
            let stat = HKStatisticsQuery(quantityType: hrType, quantitySamplePredicate: pred,
                                         options: [.discreteAverage, .discreteMax]) { _, stats, _ in
                if let avg = stats?.averageQuantity()?.doubleValue(for: bpmUnit) { dict["avgHr"] = Int(avg) }
                if let mx = stats?.maximumQuantity()?.doubleValue(for: bpmUnit) { dict["maxHr"] = Int(mx) }
                result[i] = dict
                group.leave()
            }
            self.healthStore.execute(stat)
        }
        group.notify(queue: .main) { done(result.compactMap { $0 }) }
    }

    @objc func saveHealthWorkout(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.resolve(["ok": false]); return }
        let startMs = call.getDouble("start") ?? 0
        let endMs = call.getDouble("end") ?? 0
        guard startMs > 0, endMs > startMs else { call.resolve(["ok": false, "error": "bad_dates"]); return }
        let start = Date(timeIntervalSince1970: startMs / 1000.0)
        let end = Date(timeIntervalSince1970: endMs / 1000.0)
        let activity = call.getString("activity") ?? "studio"

        let cfg = HKWorkoutConfiguration()
        cfg.activityType = Self.hkType(activity)
        cfg.locationType = Self.isOutdoor(cfg.activityType) ? .outdoor : .indoor
        let builder = HKWorkoutBuilder(healthStore: healthStore, configuration: cfg, device: .local())

        builder.beginCollection(withStart: start) { ok, err in
            guard ok else { call.resolve(["ok": false, "error": err?.localizedDescription ?? "begin_failed"]); return }

            var samples: [HKSample] = []
            if let kcal = call.getInt("kcal"), kcal > 0,
               let et = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned) {
                let q = HKQuantity(unit: .kilocalorie(), doubleValue: Double(kcal))
                samples.append(HKCumulativeQuantitySample(type: et, quantity: q, start: start, end: end))
            }
            if let dist = call.getInt("distanceM"), dist > 0 {
                let idType: HKQuantityTypeIdentifier = (cfg.activityType == .cycling) ? .distanceCycling : .distanceWalkingRunning
                if let dt = HKQuantityType.quantityType(forIdentifier: idType) {
                    let q = HKQuantity(unit: .meter(), doubleValue: Double(dist))
                    samples.append(HKCumulativeQuantitySample(type: dt, quantity: q, start: start, end: end))
                }
            }

            let finish = {
                builder.endCollection(withEnd: end) { ok2, err2 in
                    guard ok2 else { call.resolve(["ok": false, "error": err2?.localizedDescription ?? "end_failed"]); return }
                    builder.finishWorkout { workout, err3 in
                        if let w = workout { call.resolve(["ok": true, "extId": w.uuid.uuidString]) }
                        else { call.resolve(["ok": false, "error": err3?.localizedDescription ?? "finish_failed"]) }
                    }
                }
            }
            if samples.isEmpty { finish() }
            else { builder.add(samples) { _, _ in finish() } }
        }
    }

    // HealthKit-Aktivität -> unsere Aktivitäts-Keys (siehe lib/workouts.js ACTIVITIES).
    static func activityKey(_ t: HKWorkoutActivityType) -> String {
        switch t {
        case .running: return "laufen"
        case .cycling: return "radfahren"
        case .walking: return "gehen"
        case .hiking: return "wandern"
        case .traditionalStrengthTraining, .functionalStrengthTraining, .coreTraining: return "kraft"
        case .highIntensityIntervalTraining, .mixedCardio, .elliptical, .rowing, .stairClimbing, .crossTraining: return "cardio"
        case .yoga, .pilates, .flexibility, .barre: return "kurs"
        default: return Self.isOutdoor(t) ? "outdoor" : "studio"
        }
    }
    static func isOutdoor(_ t: HKWorkoutActivityType) -> Bool {
        switch t { case .running, .cycling, .walking, .hiking: return true; default: return false }
    }
    static func hkType(_ key: String) -> HKWorkoutActivityType {
        switch key {
        case "laufen": return .running
        case "radfahren": return .cycling
        case "gehen": return .walking
        case "wandern": return .hiking
        case "kraft": return .traditionalStrengthTraining
        case "cardio": return .mixedCardio
        case "kurs": return .yoga
        case "outdoor": return .other
        default: return .functionalStrengthTraining
        }
    }

    // MARK: - Herzfrequenz-Gurt (CoreBluetooth)

    private var central: CBCentralManager?
    private var hrPeripheral: CBPeripheral?
    private var hrCall: CAPPluginCall?
    private let hrServiceUUID = CBUUID(string: "180D")   // Heart Rate Service
    private let hrCharUUID = CBUUID(string: "2A37")      // Heart Rate Measurement

    @objc func startHeartRate(_ call: CAPPluginCall) {
        hrCall = call
        if central == nil {
            central = CBCentralManager(delegate: self, queue: nil)   // löst centralManagerDidUpdateState aus
        } else if central?.state == .poweredOn {
            startHrScan()
        }
    }
    @objc func stopHeartRate(_ call: CAPPluginCall) {
        central?.stopScan()
        if let p = hrPeripheral { central?.cancelPeripheralConnection(p) }
        hrPeripheral = nil
        call.resolve()
    }
    private func startHrScan() { central?.scanForPeripherals(withServices: [hrServiceUUID], options: nil) }
    private func resolveHr(_ payload: [String: Any]) { hrCall?.resolve(payload); hrCall = nil }

    public func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn: startHrScan()
        case .unauthorized, .unsupported: resolveHr(["ok": false, "error": "bluetooth_unavailable"])
        case .poweredOff: resolveHr(["ok": false, "error": "bluetooth_off"])
        default: break
        }
    }
    public func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                               advertisementData: [String: Any], rssi RSSI: NSNumber) {
        central?.stopScan()
        hrPeripheral = p
        p.delegate = self
        central?.connect(p, options: nil)
    }
    public func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices([hrServiceUUID])
    }
    public func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        resolveHr(["ok": false, "error": "connect_failed"])
    }
    public func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = p.services?.first(where: { $0.uuid == hrServiceUUID }) else {
            resolveHr(["ok": false, "error": "no_hr_service"]); return
        }
        p.discoverCharacteristics([hrCharUUID], for: svc)
    }
    public func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let ch = service.characteristics?.first(where: { $0.uuid == hrCharUUID }) else {
            resolveHr(["ok": false, "error": "no_hr_char"]); return
        }
        p.setNotifyValue(true, for: ch)
        resolveHr(["ok": true])   // Verbindung steht; Messwerte kommen ab jetzt als „heartRate"-Events.
    }
    public func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard ch.uuid == hrCharUUID, let data = ch.value else { return }
        let parsed = Self.parseHR(data)
        if let bpm = parsed.bpm { notifyListeners("heartRate", data: ["bpm": bpm, "rr": parsed.rr]) }
    }

    // 0x2A37 Heart Rate Measurement parsen: Flags -> BPM (8/16 bit) + optionale RR-Intervalle (ms).
    static func parseHR(_ data: Data) -> (bpm: Int?, rr: [Int]) {
        let bytes = [UInt8](data)
        guard bytes.count >= 2 else { return (nil, []) }
        let flags = bytes[0]
        var idx = 1
        var bpm = 0
        if flags & 0x01 == 0 { bpm = Int(bytes[idx]); idx += 1 }
        else { bpm = Int(bytes[idx]) | (Int(bytes[idx + 1]) << 8); idx += 2 }
        if flags & 0x08 != 0 { idx += 2 }   // Energy Expended vorhanden -> überspringen
        var rr: [Int] = []
        if flags & 0x10 != 0 {
            while idx + 1 < bytes.count {
                let raw = Int(bytes[idx]) | (Int(bytes[idx + 1]) << 8)
                rr.append(Int(Double(raw) / 1024.0 * 1000.0))   // 1/1024 s -> ms
                idx += 2
            }
        }
        return (bpm > 0 ? bpm : nil, rr)
    }

    // MARK: - Standort / GPS (CoreLocation)

    private var locManager: CLLocationManager?
    private var watchIds = Set<Int>()
    private var oneShotCalls: [CAPPluginCall] = []

    private func ensureLocation() {
        if locManager == nil {
            let m = CLLocationManager()
            m.delegate = self
            m.desiredAccuracy = kCLLocationAccuracyBest
            locManager = m
        }
        locManager?.requestWhenInUseAuthorization()
    }
    @objc func getPosition(_ call: CAPPluginCall) {
        ensureLocation()
        if let loc = locManager?.location { call.resolve(Self.locDict(loc)); return }
        oneShotCalls.append(call)
        locManager?.requestLocation()
    }
    @objc func watchPosition(_ call: CAPPluginCall) {
        ensureLocation()
        let id = call.getInt("watchId") ?? 0
        watchIds.insert(id)
        locManager?.startUpdatingLocation()
        call.resolve(["ok": true, "watchId": id])
    }
    @objc func clearWatch(_ call: CAPPluginCall) {
        if let id = call.getInt("watchId") { watchIds.remove(id) }
        if watchIds.isEmpty { locManager?.stopUpdatingLocation() }
        call.resolve()
    }
    public func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        guard let loc = locs.last else { return }
        if !oneShotCalls.isEmpty {
            let pending = oneShotCalls; oneShotCalls.removeAll()
            pending.forEach { $0.resolve(Self.locDict(loc)) }
        }
        for id in watchIds {
            var d = Self.locDict(loc); d["watchId"] = id
            notifyListeners("location", data: d)
        }
    }
    public func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        if !oneShotCalls.isEmpty {
            let pending = oneShotCalls; oneShotCalls.removeAll()
            pending.forEach { $0.reject("location_failed") }
        }
    }
    static func locDict(_ loc: CLLocation) -> [String: Any] {
        return ["lat": loc.coordinate.latitude,
                "lng": loc.coordinate.longitude,
                "alt": loc.altitude,
                "acc": loc.horizontalAccuracy]
    }
}
