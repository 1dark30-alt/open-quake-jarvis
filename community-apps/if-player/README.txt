Interactive Fiction
===================

Play Inform / Z-machine text adventures on the panel -- and have the story read
aloud to you, and speak your commands back.

Runs Z-code (.z3-.z8, .zblorb) and Glulx (.ulx, .gblorb), which covers
essentially everything Inform 6 and Inform 7 produce. The interpreter is
Parchment (the one behind iplayif.com); see LICENSES.md.

Install: Settings -> Drop-In Apps -> Add (import .zip), then add a page with
the Interactive Fiction app.


Getting a story
---------------
No stories ship with the app -- their authors hold the rights to them. Put your
own into the app's stories/ folder and they appear on the picker, or set the
page's "Story file" option to a filename or a full http(s):// URL.

The IF Archive (ifarchive.org) and IFDB (ifdb.org) host thousands of freely
available works. Note that Infocom titles such as Zork are still copyrighted
and are not free to redistribute.


Playing
-------
Type on the keyboard exactly as you would in any interpreter -- the game keeps
keyboard focus, and the on-screen controls never steal it.

  Narration   Reads each new passage aloud through your TTS voice. The command
              you typed is not read back, only what the game says.
  Listen      Turns on the microphone. Say a command ("go north", "take lamp")
              and it is transcribed and entered for you. It ignores anything it
              hears while the story is being read aloud, so narration can't talk
              to itself.
  Hush        Stops reading immediately and drops anything queued.

Your position is auto-saved, so if the panel rotates away or reloads you come
back where you left off. In-game SAVE / RESTORE work normally too.


Voice setup
-----------
Narration and Listen use the same Wyoming TTS/STT servers as the rest of
open-quake, picked up automatically from Settings -> TTS/STT. Nothing to
configure here if voice already works elsewhere in the app.

If you want this page to use different servers, the advanced options
(TTS host/port, STT host/port) override the global ones. Leave them blank to
inherit. With no TTS configured the Narration control reads "No TTS" and the
game is still fully playable by keyboard; the same goes for Listen and STT.


Options
-------
  Story file            Filename in stories/, or a full http(s):// URL. Blank
                        shows the picker.
  Read the story aloud  Start with narration on.
  Voice commands        Show the Listen control.
  TTS/STT host+port     Advanced overrides; blank inherits the global setting.
