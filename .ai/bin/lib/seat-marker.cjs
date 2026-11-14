'use strict';
// Author completion contract: uppercase the seat name, replace every non-ASCII
// alphanumeric character with underscore, then append _DONE for the task footer.
// Other launch roles retain their established markers.
const markerOf = name => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const seatMarker = (name, role) => role === 'author' ? markerOf(name) : name.toUpperCase();
module.exports = { markerOf, seatMarker };
