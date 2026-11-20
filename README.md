# LWH Offline Receiving (v1.2.0)

Receiving app for a site with cellular but no connection to the LWH network or WMS.
Floor staff capture the BOL info, take photos of the BOL, and scan each unit (model, serial, weight, year).
"Send to office" emails the office a summary, the BOL photos, and a units CSV, and logs everything to a Google Sheet so it can be keyed into the WMS.

- App: https://nbr1hawgfan.github.io/LWH-Offline-Receiving/
- Backend: Google Apps Script web app (`gas/Code.gs`)

## How it works on the floor
1. **Start new receipt**: BOL number, customer, carrier, trailer, PO, seal, units on BOL, notes. Every field accepts a scan.
2. **BOL photos**: Take BOL photo (one per page) and Damage / other photo. Photos are shrunk on the device (about 1800 px JPEG) so they send quickly over cellular.
3. **Scan units** (fields match the CFMOTO unit label):
   - First unit: Model number, Product number and Color. These are kept for the next units.
   - Each unit: **VIN**, then Engine number, Vehicle code and Production date. Enter skips a blank field, and the last field saves the unit.
   - **The VIN is checked as it's scanned**: 17 characters, no I/O/Q, and the check digit must match, so a misread or typo is caught immediately. A leading "I" from VIN barcodes is removed.
   - **Model year fills in from the VIN** (10th character; T = 2026).
   - Production date accepts 2026-05-14, 5/14/2026 or 20260514 and is saved as 2026-05-14.
   - **Take label photo (optional)** attaches a photo to the unit being scanned. It is named with the unit # and VIN in the email and in Drive.
   - Duplicate VINs are blocked (same receipt or any receipt on the device).
   - **Camera** buttons scan with the phone or tablet camera if there's no hardware scanner.
4. **Send to office**: The checklist shows BOL photo, unit count, and BOL count against scanned count.
   The app gets back an office reference (RCV-yymmdd-####) and the receipt locks.

Everything saves on the device as you go, so a dropped signal, closing the app, or a dead battery doesn't lose scans.
If there's no signal at send time, the receipt waits and sends itself when signal returns. The header shows "N to send".
The server ignores a receipt it already has, so retries never double-email.

## Setup: backend (once)
1. Go to script.google.com, create a New project named "LWH Offline Receiving", and paste `gas/Code.gs`.
2. Run `setup()` and approve permissions. The Execution log shows the **ACCESS_KEY**, log sheet link, and photo folder link.
3. Under Project Settings, then Script Properties, set **OFFICE_EMAILS** to the office address(es), comma separated. CC_EMAILS is optional.
4. Deploy, then New deployment, then Web app: execute as **Me**, access **Anyone**. Copy the `/exec` URL.
5. Optional: run `testEmail()` to see the email layout.

After code changes, go to Deploy, then Manage deployments, edit, and pick Version: **New version**. That keeps the same URL.

## Setup: each phone or tablet
Open the app link, then go to **Settings**: your name, site, server link (`/exec` URL), and access key. Tap **Test connection**, then Add to Home Screen.

## Changing fields when we see real labels
Edit `config.js` only:
- `unitFields`: add, rename, require, or reorder fields; set which ones are kept, numeric, or a year. Set `strip` to remove label prefixes such as `['S']` or `['1P']`.
- `parseCombinedScan`: split one 2D barcode that holds several values into fields.
- `weather`: the new site's coordinates for the header weather.

The Units sheet adds a column for any new field automatically. Existing columns don't move.

## Office side
- Email subject: `Received: BOL 12345 | Customer | 24 units | Site | RCV-...`
- **Receipts** tab: one row per trailer, with an **Entered in WMS** checkbox to track keying.
- **Units** tab: one row per unit; serials are stored as text, so leading zeros stay.
- Drive: one folder per receipt with photos and the CSV.

## Updating the app
Bump `APP_VERSION` in app.js and `VERSION` in sw.js together, then push. Devices show a "new version" bar.

## Library
html5-qrcode 2.3.8 (bundled), under its own license.
