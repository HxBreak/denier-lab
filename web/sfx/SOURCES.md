# Sound sources

| File | What | Source | Licence |
|---|---|---|---|
| `snap.mp3` | Five slaps on skin cut from one recording (each trimmed to 116-205 ms, peak-normalised to -3 dB, 25 ms fade), 150 ms of silence between them, high-passed at 120 Hz. `sound.js` splits them at load time and plays a random one (never the same twice running) when the welt snaps back. | "Slap on Skin" by dav0r, https://freesound.org/people/dav0r/sounds/346931/ (cut from the site's high-quality MP3 preview) | CC0 1.0 (public domain dedication), checked on the sound's page on 2026-11-08 |

History (2026-11-08/09): the synthesised snap was called startling, then drum-like. The first recording
tried, "Band Click" by MGA95 (freesound 555743, CC0), turned out to carry a 64 Hz, ~60 ms thump under
the click (8.4% of its energy below 150 Hz), which still sounded like a drum. This one has 0.8% below
150 Hz; its 150-500 Hz part is the body of a hand on skin.
