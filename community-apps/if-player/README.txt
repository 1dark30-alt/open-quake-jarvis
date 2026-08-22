Interactive Fiction
===================

Play Inform / Z-machine text adventures on the panel -- and have the story read
aloud to you, and speak your commands back.

Runs Z-code (.z3-.z8, .zblorb) and Glulx (.ulx, .gblorb), which covers
essentially everything Inform 6 and Inform 7 produce. The interpreter is
Parchment (the one behind iplayif.com); see LICENSES.md.

Install: Settings -> Drop-In Apps -> Add (import .zip), then add a page with
the Interactive Fiction app.


Your story library
------------------
Set the page's "Stories folder" option to any folder on your PC that holds
story files -- click Browse and pick it. Every story in that folder shows up in
the on-screen list; tap one to play. The "Stories" button (top of the rail)
returns to the list at any time to switch games. (Leave the option blank to use
the app's own small bundled folder instead.)

The IF Archive (ifarchive.org) and IFDB (ifdb.org) host thousands of freely
available works. Check a work's own terms before redistributing it; commercial
titles are generally still copyrighted.


Playing
-------
Type on the keyboard exactly as you would in any interpreter -- the game keeps
keyboard focus, and the on-screen controls never steal it.

The Common commands panel provides large touchscreen controls: a compass with
North, South, East, West, Up, Down and Look, plus Take all, Inventory, Again,
and Wait. Save and Restore sit on the right-hand rail. Each control sends the
same command you would type at the story prompt. The panel appears while a
story is playing and stays out of the way while choosing a story.

  Stories     Return to the story list to pick a different game.
  Narration   Reads each new passage aloud through the system TTS voice. The
              command you typed is not read back, only what the game says.
  Listen      Turns on the microphone. Say a command ("go north", "take lamp")
              and it is transcribed and entered for you. It ignores anything it
              hears while the story is being read aloud.
  Hush        Stops reading immediately and drops anything queued.

In-game SAVE / RESTORE work normally.


Voice
-----
Narration and Listen use the system Wyoming TTS/STT servers from
Settings -> TTS/STT -- nothing to configure here. With no TTS configured the
Narration control reads "No TTS" and the game is still fully playable by
keyboard; likewise Listen needs STT. (Developers can override the servers just
for this app under "Advanced / developer overrides" in the page editor.)


Options
-------
  Stories folder        A folder on this PC (Browse to it). Blank = bundled folder.
  Read the story aloud   Start with narration on.
  Voice commands         Show the Listen control.
  Auto-start story        Optional: a filename to open straight into, skipping the list.
