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
    type      'text' (default) | 'number' | 'year'
    min/max   limits for number and year fields
    camera    show a Camera scan button
    strip     optional prefixes to remove from scans, e.g. ['P'] or ['S'] for AIAG-style labels,
              or ['1P'] etc. Leave empty until we see a sample label.
*/
window.LWH_CONFIG = {
  appName: 'LWH Offline Receiving',

  // Header weather: use the new site's coordinates once known. Default is Fort Smith, AR.
  weather: { lat: 35.3859, lon: -94.3985, label: 'Fort Smith' },

  unitFields: [
    { key: 'model',  label: 'Model number',  required: true,  camera: true, keep: true, keepDefault: true, strip: [] },
    { key: 'serial', label: 'Serial number', required: true,  camera: true, unique: true, strip: [] },
    { key: 'weight', label: 'Unit weight (lbs)', type: 'number', min: 0, max: 20000, camera: true, keep: true },
    { key: 'year',   label: 'Model / production year', type: 'year', min: 1990, max: 2035, camera: true, keep: true },
    { key: 'notes',  label: 'Unit notes (damage, etc.)' }
  ],

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
  photo: { maxSide: 1800, quality: 0.72, maxPerReceipt: 12 },

  // Sent receipts older than this are removed from the device (they are kept in the Google Sheet and Drive)
  keepSentDays: 30
};
