Stream Deck Host
================

Run Elgato Stream Deck plugins on the open-quake panel. The app implements
Elgato's documented plugin protocol (the same approach as OpenDeck), so
unmodified *.sdPlugin packages work: the host launches each plugin, and the
on-screen key grid shows the images and titles the plugin draws. Tap a key
to press it.

SECURITY: Stream Deck plugins are real programs that run on your PC with
your user rights. Only add plugins you trust, exactly as you would any
downloaded software. (open-quake also warns once when importing this app,
because it contains a host-side server module.)

Setup
-----
1. Install the app (Settings -> Drop-In Apps -> Browse... or import the zip)
   and add a page for it.
2. Make a folder anywhere on your PC and put your *.sdPlugin folders in it
   (each looks like com.example.something.sdPlugin and contains a
   manifest.json). Get plugins from their developers' releases.
3. Set that folder as the page's "Plugins folder" option. The header shows
   how many plugins are running; the Plugins button shows status and offers
   a restart.

Using the deck
--------------
- Tapping a key presses it (finger down = key down, lift = key up, just
  like the hardware). Tap "Edit", then tap ANY key -- assigned or empty --
  to assign, move, clear, or configure it (settings are raw JSON;
  property-inspector UIs aren't rendered yet). Tap "Done" when finished.
- Profiles (left rail): separate key layouts. "+ Profile" adds one (tap
  twice -- stray-tap protection); in Edit mode a profile's X removes it.
  Rename/add/remove is also in the PC editor on this page's options.
  Turning the knob cycles profiles.
- Key layout (5x3 / 8x3 / 10x4) is a page option; it is also the device
  size reported to plugins.
- Assignments and settings persist in deck-host.json next to your plugins
  folder, so they survive app updates.

What works / what doesn't (yet)
-------------------------------
Works: Keypad actions from native (.exe) and Node.js plugins -- key images
(setImage), titles, states, alerts/OK ticks, per-key and global settings,
crash auto-restart.
Not yet: property-inspector configuration pages, plugins whose CodePath is
an HTML file (they need Elgato's embedded browser runtime), dial/Encoder
actions, multi-actions, setFeedback layouts.
