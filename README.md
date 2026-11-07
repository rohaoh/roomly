# Roomly

Arduino Uno + HC-06 room environment dashboard with Gemini AI summaries.

- Version: 1.0.0
- Creator: Oh Roha
- Runtime: Electron + Node.js

## Run

1. In PowerShell, open this folder and run:

```powershell
npm.cmd start
```

The app sends aggregate sensor summaries directly to Gemini. No API server or invite codes are required.

## Build Windows installer

Run `npm.cmd run dist` from PowerShell. The Windows x64 installer and unpacked app are written to `dist/`.

## API key warning

The Gemini API key is currently embedded in the Electron app source and can be extracted from a distributed build. Anyone who gets the app can use that key and consume the project's Gemini quota. Keep this build limited to trusted testers and rotate the key if it is exposed. Gemini free-tier models still have project-specific rate limits and daily quotas.

## Arduino input

Pair each HC-06 in Windows and choose its virtual COM port in **Settings → Arduino connection**. Roomly can keep multiple COM ports open at once; add each port separately and optionally give it a display name. Each device has its own live reading stream, stored samples, alert state, and reconnect loop. Thresholds, calibration offsets, and sampling settings are currently shared across connected devices. The default serial rate is 9600 baud. Send one reading per line from each device, for example:

```text
{"temperature":24.5,"humidity":48}
```

The app also accepts `24.5,48` or `T:24.5,H:48`. The first value is Celsius and the second is relative humidity percent.

## Measurement limits and hardware notes

- The app accepts temperature and humidity plus optional 10-bit `gasRaw` and `lightRaw` values. A raw gas ADC value is not a concentration in ppm and must not be used as a safety alarm. The current LDR-to-lux calculation is an estimate that depends on the resistor, sensor, wiring, and calibration.
- The project does not include Arduino firmware, so confirm the exact sensor part numbers and pin wiring before uploading a sketch. The current `FC-22` label is only a UI label; it does not identify or calibrate the connected gas sensor.
- On an Uno + HC-06 connection, share ground. Protect the HC-06 RX input from the Uno's 5 V TX signal with a suitable level shifter or resistor divider; connect the module TX output to the Uno RX input.
- For better temperature and humidity measurements, consider an SHT31 digital sensor. For actual CO₂ readings, use a CO₂ sensor such as the Sensirion SCD41; it reports CO₂ directly, unlike a generic analog gas sensor. For light, a BH1750 digital lux sensor avoids estimating lux from an LDR divider. These replacements require matching Arduino firmware and app protocol changes.
- Keep the sensor away from the Uno regulator, direct sunlight, vents, and damp surfaces. If measurements must continue while the PC is off or Bluetooth disconnects, add a real-time clock and SD-card logger on the device.

Sensor references: [SHT3x datasheet](https://sensirion.com/media/documents/213E6A3B/63A5A569/Datasheet_SHT3x_DIS.pdf), [SCD4x datasheet](https://sensirion.com/media/documents/E0F04247/631EF271/CD_DS_SCD40_SCD41_Datasheet_D1.pdf), [BH1750 guide](https://learn.adafruit.com/adafruit-bh1750-ambient-light-sensor/overview).

## Local history storage

Incoming sensor frames are checked for alerts as they arrive. By default, the app persists one sample every 30 seconds plus alert-state changes, keeping the 100,000-row ceiling large enough for about 30 days at the default rate. The sample interval and retention window can be changed in settings; faster sampling can reach the row ceiling sooner. Old data is compacted to the configured retention window and the row limit. Settings and reports remain in `room-data.json`; readings are appended to `room-readings.jsonl`. Existing installations with readings in the old settings file are migrated on startup.

## Features

- Live temperature and humidity cards, recent 24-hour graph and local history
- CSV export of local measurements
- Editable threshold alerts with defaults of 18–28 °C and 30–65%, plus reset to defaults
- Manual AI summaries for 24 hours, 7 days, 30 days, or a custom date range
- One daily AI summary after 8 AM while the app is open and sensor data is available
- Configurable sample interval and retention, temperature/humidity offsets, sustained-alert delay, recovery alerts, and serial reconnect retries

Detailed sensor readings remain on the user's PC. Analysis sends the selected period's aggregate summary and thresholds directly to Gemini. AI reports are environmental reference information, not health diagnoses.
