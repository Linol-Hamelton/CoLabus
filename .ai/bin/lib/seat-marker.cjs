'use strict';
// Author completion contract: markerOf uppercases the seat name and replaces every character that is not an ASCII
// letter or digit with underscore. It does not append _DONE: the task footer carries the marker followed by _DONE (the
// caller adds it), and the terminal record of the launch wrapper holds the marker without it.
// Other launch roles retain their established markers.
const markerOf = name => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const seatMarker = (name, role) => role === 'author' ? markerOf(name) : name.toUpperCase();
module.exports = { markerOf, seatMarker };
