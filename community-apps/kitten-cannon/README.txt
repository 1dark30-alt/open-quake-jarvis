Kitten Cannon — drop-in app for open-quake
==========================================

A remake of the classic Kitten Cannon flash game, ported from
https://github.com/TeeJS/kitten-cannon-remake to run on the panel.

Play: aiming and firing are separate. Touch and drag anywhere to point the
barrel at your finger, or hold the round arrow buttons to sweep it; tap the
big FIRE button to launch (power oscillates on the meter, so timing matters).
The speaker button in the top-right corner mutes/unmutes all sound, on every
screen, and remembers its state. On a PC keyboard, W/S or Up/Down aim and
Space fires. Land on trampolines and TNT to keep flying; spikes end the run.
Distance in feet is your score.

Options (editor > App)
----------------------
- Player name        Name your scores are recorded under (default "Player").
- Server URL (advanced)  Base URL of the kitten-cannon score server
                     (default https://scores.doofenshmirtzevil.com). Clear it
                     to play offline: high scores are then kept in this PC's
                     localStorage only.

Score server contract
---------------------
Any server that speaks this HTTP API works (the original project's PHP + MySQL
backend does; a containerized copy of it is the intended host):

  GET  <base>/get_high_score.php?score=<int>
       -> {"success":true,"highScore":<int>,"percentile":<0-100>,"totalScores":<int>}
  GET  <base>/get_personal_high_score.php?userId=<name>
       -> {"success":true,"personalHighScore":<int>}
  POST <base>/save_score.php?t=<timestamp>
       (application/x-www-form-urlencoded: userid=<name>&score=<int>)
       -> {"success":true,...}   NOTE: the field is lowercase "userid".
       Called once per run (every death), not just on new personal bests --
       that history is what the percentile calculation needs.

IMPORTANT: the game page is served from http://127.0.0.1:<port>, so the score
server MUST send CORS headers or every call will be blocked by the browser:

  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, POST, OPTIONS

(and answer OPTIONS preflights with 204). Scores are in feet, stored as integers.
