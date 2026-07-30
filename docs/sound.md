<!-- What the kitchen sounds like, and why there are no audio files. -->

# Sound

A kitchen you cannot hear is a kitchen where the only thing that ever tells you
something has gone wrong is the thing you are not looking at. Frying happens
behind you; so does a customer arriving, and so does a pizza turning black.

`M` mutes it, and the setting is remembered per browser.

## No audio files

Every sound in the game is **synthesised at play time** from a row in
`audio/voices.ts`: a waveform, a start pitch, a pitch to glide to, a duration
and a level. There are no assets to load, license, or keep in step with the art.

This is the same argument as the models. Primitive shapes give a coherent look
with zero illustration; oscillator envelopes give a coherent *kitchen* with zero
sound design. Both are placeholders that turned out to be a style, and both have
one table to replace on the day somebody with real skill turns up.

Keeping voices as **rows rather than functions** is what makes them tunable: a
bin should be lower than a plate, a refusal should be the only buzz in the game,
and those are comparisons you can only make when the numbers are side by side.

## The split: what happens, and what it sounds like

```
audio/
  cues.ts      pure: the world -> a list of sound names
  voices.ts    pure: the sound names -> what they are made of
  synth.ts     WebAudio: a voice -> a noise
  index.ts     KitchenAudio: the observer the shell calls once a frame
```

`SoundWatcher` never touches an `AudioContext`, which is the whole point:
"does a burn fire once or sixty times a second" is a question worth an answer,
and it is unanswerable from inside a browser's audio graph. It is
[tested](../src/audio/cues.test.ts) like any other pure module.

`KitchenAudio` is an **observer of the world exactly like the renderer** — it
reads, it never writes, and the simulation has no idea it exists. The
[layering test](../src/sim/layering.test.ts) covers `src/audio` alongside
`src/render` and `src/ui` for both halves of that.

## Cues, and watched state

Sounds come from two places, and the difference is about latency.

- **Effect cues** — `served`, `tipped`, `binned`, `walkout`, `spent`,
  `refused` — are things the *simulation announced*. They are suppressed inside
  a prediction (see [multiplayer.md](multiplayer.md)), so online they arrive
  with the frame that confirms them. That is right for money and for walkouts:
  they are facts about the room, and a sound claiming you were paid before the
  server agrees is a sound that has to be taken back.
- **Watched state** — what you are carrying, what is burning, who has walked in,
  what phase it is — is read from the world being *drawn*, which your own chef
  is predicted in. So your pickup clicks on the frame you pressed the button
  rather than a round trip later. **A sound that lags your own hands is worse
  than no sound**, which is the whole reason this is two mechanisms and not one.

Three rules keep it from becoming a rattle:

- **Hand sounds are yours only.** With four cooks in a kitchen, hearing
  everybody else's pickups is noise with no information in it — the other three
  are on screen, and what they are doing is already visible.
- **One of each per frame.** Three customers arriving on the same tick is one
  door chime. The same voice played three times a millisecond apart is not three
  sounds, it is one loud, phased, unpleasant one.
- **The first look is silent.** A fresh watcher has no idea what is new, so
  nothing is. Joining a kitchen mid-service must not replay the day at you.

Muting stops the *playing*, not the *watching*. The watcher keeps running and
its answers are thrown away, because otherwise pressing `M` twice would fire a
backlog of everything that happened in between.

## The browser's rules

An `AudioContext` created outside a user gesture starts suspended and swallows
everything silently. So the context is built lazily on the first sound, resumed
on every play, and `unlock()`ed from the join screen's click — the first real
gesture in any session, and the one immediately before anything can make a
noise. A tab returning from the background comes back suspended too, which the
same resume covers.

## What is deliberately missing

- **Continuous sound.** No sizzle loop, no music, no room tone. Everything is a
  one-shot under half a second, because a loop needs a mixer, a duck, and an
  opinion about what happens when six of them overlap.
- **Positional audio.** WebAudio has a panner and the kitchen has coordinates,
  so this is a hundred lines away — but the camera frames most of the room most
  of the time, and stereo panning on a screen you can see all of buys very
  little.
- **Volume, as a number.** It is on or off. A slider needs a settings screen,
  and the game does not have one.

---

Next:

- [art-direction.md](art-direction.md) — the other half of what the kitchen tells you
- [architecture.md](architecture.md) — where the layer sits

[Back to the README](../README.md).
