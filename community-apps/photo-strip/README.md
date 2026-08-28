# Photo Strip

Photo Strip is an ambient local-photo slideshow designed specifically for the open-quake
1920×480 panel. Add it as a drop-in app page, then choose one or more folders in that page's
App settings.

The renderer never receives folder paths and has no filesystem access. The app-local
`server.js` scans only the configured folders, returns opaque image IDs, and validates each
requested image against the cached scan and its selected root before reading it. Scans are
asynchronous, cached for five minutes, manually refreshable, and bounded to 10,000 images and
2,000 directories.

JPEG, PNG, WebP, and GIF files are supported. GIFs use Chromium's normal image rendering, so an
animated GIF plays while it is the current slide and restarts if it is evicted and loaded again;
Photo Strip does not attempt frame-level timing or animation control.

The panel knob rotates through photos. A single press pauses or resumes, and a double press opens
the settings summary. Touch or click the photograph to reveal the temporary control overlay.

Photo deletion is off by default. Enable **Allow deleting photos** in the page's App settings to
show a Delete control. The panel asks for confirmation each time, then requests that the host move
the original file to the operating system Recycle Bin or Trash. Photo Strip never falls back to a
permanent delete if that facility is unavailable.
