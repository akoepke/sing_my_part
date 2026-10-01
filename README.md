# Sing my part

A browser app for practising your own line in choral music. Load a MusicXML score, pick your part and the bars you want to sing, and sing along. The app follows your voice through the microphone and colours each note green, amber, or red depending on how well you hit it. The other parts can play along.

**Try it:** https://akoepke.github.io/sing_my_part/

**Beta:** https://akoepke.github.io/sing_my_part/beta/ has new features being tried out: playing back what you sang (with the score following along, the other parts, Autotune, and an MP3 download), practising against your own recordings, and a correction for your device's audio delay. It shares the scores in `assets/` and keeps its own settings.

## Features

- Load any MusicXML score (`.musicxml`, `.xml`, `.mxl`, or a `.zip` containing one), or pick one of the built-in samples: two Bach motets (BWV 225, BWV 228), Frank Bridge's *Music, when soft voices die*, John Amner's *Come, let's rejoice*, Louis Lewandowski's *Hallelujah* (Psalm 150), and several hundred four-part Bach chorales.
- Choose your part and a range of bars. The full score is shown a page at a time, with the note you should be singing highlighted.
- The music moves on in time, with a count-in and an optional metronome; pause, resume, or tap a bar to carry on from there.
- Play-along for the other parts with separate volume controls, an optional fade for the other parts, and an adjustable reference pitch.
- Three sounds for playback: a simple tone, a soft sung "oo", or a recorded grand piano.
- Every setting can be changed while you sing; the app keeps your place where it can.
- Generated sight-singing exercises with a choice of key, clef, difficulty, and length.

Headphones give the best results with play-along. Without them, the app ignores sounds that match the other parts, which helps but is not perfect.

MuseScore, Sibelius, Finale, and Dorico can all export MusicXML. [CPDL](https://www.cpdl.org) and [IMSLP](https://imslp.org) have free choral editions, many with MusicXML downloads.

## Running locally

The app is a static page with no build step: `index.html` (the page), `style.css` (the styling) and `app.js` (the code), plus the scores in `assets/`. Because it loads the scores from `assets/`, serve the folder over HTTP rather than opening the file directly:

```bash
python3 -m http.server
```

Then open http://localhost:8000. Microphone access requires `localhost` or HTTPS.

## Credits

- Score rendering: [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org)
- Unzipping `.mxl` and `.zip` files: [JSZip](https://stuk.github.io/jszip/)
- Grand piano: [Splendid Grand Piano](https://github.com/sfzinstruments/SplendidGrandPiano) samples, played with [smplr](https://github.com/danigb/smplr)
- Bach chorales in `assets/`: the [music21](https://github.com/cuthbertLab/music21) corpus
- *Music, when soft voices die*: a [MuseScore transcription](https://musescore.com/user/3099636/scores/21293776)
- *Hallelujah* (Lewandowski): a [MuseScore arrangement by Rinatya Nessim](https://musescore.com/user/1132046/scores/9953701)

## License

The code in this repository is licensed under [CC BY 4.0](LICENSE) © 2026 A. Sophia Koepke.

The bundled scores (the BWV 225 and BWV 228 motets, *Music, when soft voices die*, *Come, let's rejoice*, *Hallelujah*, and the chorales in `assets/`) are not covered by this license and remain under the terms of their original sources.
