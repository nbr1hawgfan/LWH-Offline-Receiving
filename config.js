/*
  LWH Offline Receiving - configuration.
  Change unit fields here once we see the real labels. No other file needs to change.

  Unit field options:
    key       column name sent to the server (letters/numbers only; keep it stable once in use)
    label     what the user sees
    required  must be filled before the unit saves
    unique    warn on duplicates across this receipt and every receipt on the device (serials)
    keep      show a "keep for next unit" box, checked by default when keepDefault is true
              (handy when a whole trailer is the same model)
    type      'text' (default) | 'number' | 'year' | 'vin' (17 chars + check digit) | 'date' (saved as YYYY-MM-DD)
    auto      'vinYear' fills the field from the VIN's 10th character (not in the scan flow; still editable)
    hideSm    hide the column in the unit table on phones (still saved and emailed)
    min/max   limits for number and year fields
    camera    show a Camera scan button
    strip     optional prefixes to remove from scans, e.g. ['P'] or ['S'] for AIAG-style labels,
              or ['1P'] etc. Leave empty until we see a sample label.
*/
window.LWH_CONFIG = {
  appName: 'LWH Offline Receiving',

  // Header weather: use the new site's coordinates once known. Default is Fort Smith, AR.
  weather: { lat: 35.3859, lon: -94.3985, label: 'Fort Smith' },

  /*
    Fields from the CFMOTO unit label (sample: UFORCE U10 Pro Highland, Nov 2026).
    Scan order on the floor: Model, Product, Color are entered on the first unit and kept;
    after that each unit is VIN -> Engine -> Vehicle code -> Production date -> saves.
    Model year fills in automatically from the VIN.
  */
  unitFields: [
    { key: 'model',   label: 'Model number',   required: true, camera: true, keep: true, keepDefault: true },
    { key: 'product', label: 'Product number', camera: true, keep: true, keepDefault: true, hideSm: true },
    { key: 'color',   label: 'Color',          keep: true, keepDefault: true, hideSm: true },
    { key: 'vin',     label: 'VIN',            required: true, camera: true, unique: true, type: 'vin' },
    { key: 'year',    label: 'Model year',     type: 'year', min: 1990, max: 2035, auto: 'vinYear' },
    { key: 'engine',  label: 'Engine number',  camera: true, hideSm: true },
    { key: 'vehicleCode', label: 'Vehicle code', camera: true, hideSm: true },
    { key: 'prodDate', label: 'Production date', type: 'date', hideSm: true },
    { key: 'notes',   label: 'Unit notes (damage, etc.)', hideSm: true }
  ],

  // VIN: 17 characters, no I/O/Q, and the 9th character must match the check digit.
  // Turn off if a manufacturer's VINs ever fail the check while being correct.
  vinCheckDigit: true,

  // Show "Take label photo" for each unit (optional, attached to the email and saved in Drive)
  unitPhoto: true,

  /*
    Optional: one scan that contains several values (for example a 2D code holding
    "MODEL|SERIAL|YEAR"). Return an object of field values, or null to treat the scan normally.
    Called for every scan into any unit field.
  */
  parseCombinedScan: function (text) {
    // Example once we know the format:
    // const p = text.split('|'); if (p.length === 3) return { model: p[0], serial: p[1], year: p[2] };
    return null;
  },

  // Photo compression before upload (keeps sends fast on cellular and under email limits)
  photo: { maxSide: 1800, quality: 0.72, maxPerReceipt: 80 },

  // Sent receipts older than this are removed from the device (they are kept in the Google Sheet and Drive)
  keepSentDays: 30
};
