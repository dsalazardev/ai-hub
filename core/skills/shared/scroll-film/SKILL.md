---
name: scroll-film
description: "Use when a page's hero is a pre-rendered camera flight the visitor scrubs by scrolling, Apple-style: AI clips chained frame to frame so seams never pop, encoded for seeking, mounted with an engine that holds up on phones. NOT scroll reveals or pinning (that is `design`), NOT a finished MP4 (that is `ai-media`)."
tags: [scroll-scrub, scroll-video, scrollytelling, landing-hero, image-to-video, camera-flight, seamless-video]
recommends: [ai-media, fal, replicate-images, landing-copy, design, performance]
profiles: [full]
origin: dsalazardev
---

# scroll-film — the camera moves, the scroll is the playhead

The page plays nothing. It holds a chain of pre-rendered clips and maps the scroll position to
their playhead, so the visitor flies through scenes — outside a building, inside it, on to the
next — without a cut. Three parts must be right, and each fails in its own way: the **chain**
(seams), the **encode** (seeking) and the **page** (phones). This skill owns all three.

**Not this skill — delegate:**
- Scroll-linked reveals, parallax, pinned sections, a horizontal pan, with no video → `../design/SKILL.md`.
- A finished MP4 with voice and music → `../ai-media/SKILL.md`.
- The call to the model endpoint (queue, webhooks, cost per call) → `../fal/SKILL.md` or `../replicate/SKILL.md`.
- The scene stills themselves → `../replicate-images/SKILL.md`.
- The words over the film → `../landing-copy/SKILL.md`. A video rendered from code → `../remotion-video/SKILL.md`.

## 1. The gate: nothing renders before the user agrees to a number

A chain is many clips, each one slow and billed. Interview, price it, then wait for a yes.

1. **Subject.** Ask it as an open question: what the world is about, in a sentence. A menu of
   industries decides their business for them.
2. **Scenes.** 4 to 7, in the order the camera visits them, proposed from their own value chain and
   edited by them. The last one carries the call to action.
3. **Look.** One art direction, written once as a style preamble and pasted unchanged into every
   still prompt. Identical text is what makes separate renders read as one world.
4. **Camera feel.** Always ask. It picks the chain shape (section 3).
5. **Phones.** Always ask. A real phone version is a second chain (section 6) and doubles the video bill.
6. **Brand.** 4 to 6 hex colours, a name, a tone. The page background is the scene background.

Then the bill:

| | Forward take (A) | Dive and hop (B) |
| --- | --- | --- |
| Video clips, desktop only | N | 2N − 1 |
| Video clips, with the phone chain | 2N | 4N − 2 |

Estimate = clips × seconds per clip × today's price per second, plus about 20% for re-rolls, plus N
stills. Read the price from the provider at build time; it moves (reading cost per call →
`../fal/SKILL.md`). State the total against the balance and wait for the yes. When money is tight,
offer a previz pass: the whole chain on the **same** model at its lowest resolution, approve the
journey, then render the finals.

## 2. The model must continue a shot, not just start one

A seam holds only if the model starts a clip on an exact frame you hand it. That capability, not
quality or price, qualifies a model.

- Every clip needs a **start-frame** input. Hops (shape B) also need an **end-frame** input. Field
  names vary by endpoint (`image_url`, `start_image`, `first_frame`; `end_image_url`,
  `tail_image_url`, `last_frame`): read the input schema before batching. Model landscape →
  `../ai-media/SKILL.md`.
- A **reference-image** input does not qualify. It steers the style; frame 0 is still a new
  render, and the seam pops.
- **Probe once before the batch**, with one cheap clip from a real still prepared at the clip's
  aspect (16:9, or 9:16 for phones). Frame 0 must match the still and the bill must match the
  advertised price. For hop duty, add an end frame from another still: the last frame must land on
  that composition. A near miss is normal; the engine's dissolve covers it. Commands →
  `references/chain.md`.
- **One model for the whole chain.** Each model has its own grain, colour and motion; a swap
  mid-chain keeps positions continuous and still pops. The one exception is a single clip a content
  filter keeps blocking (`references/chain.md`).

## 3. Pick the chain shape from the camera feel

| The user says | Shape | Clip k starts on | Clip k ends on | Fits |
| --- | --- | --- | --- | --- |
| "one continuous walkthrough", "one fixed angle gliding over it" | **A — forward take** | leg k−1's real last frame (leg 0: the first still) | nothing — no end frame | photoreal, interiors, product, real estate |
| "fly from one island to the next" | **B — dive and hop** | dive: its still. hop: dive k's real last frame | hop: dive k+1's real first frame | miniature, diorama, map-like worlds |

- A renders one leg at a time, because each needs the previous one's last frame. B renders every
  dive in parallel, then every hop.
- Never give an A leg a wide establishing shot as its end frame. The camera pulls back to meet it,
  and the take reverses.
- **The velocity rule.** Inside one clip the camera is free: orbit, rise, push in and ease back.
  Across a seam it never reverses. Position matches, the motion flips, and it reads as a rewind,
  in both scroll directions. So every leg ends by settling into a slow forward drift, and the next
  one begins inside it. B reverses at every seam on purpose (pull out, hop, dive): charming over a
  miniature map, a stutter in a realistic walkthrough. If the user picks B for a photoreal look, say
  so before rendering.

Prompt templates (still, leg, dive, hop), the camera-move table by concept, the fixed-angle clause
and the batch loops → `references/chain.md`.

## 4. The seam law: hand off pixels, not descriptions

Every render redraws its scene a little differently. A hop that ends on the *original still* of
scene 3 meets a dive that starts on *its own render* of scene 3: two pictures of one place, and the
seam pops. So both ends of every clip come from the neighbours' actual renders.

```bash
# The true last frame: -update 1 overwrites per decoded frame, so the final one is what stays.
ffmpeg -v error -y -sseof -1 -i leg_02.mp4 -update 1 -q:v 2 leg_02_last.png
ffmpeg -v error -y -i dive_03.mp4 -frames:v 1 -q:v 2 dive_03_first.png
```

A plain `-sseof -0.15 -frames:v 1` stops a few frames short of the end: 15 dB PSNR from the real
last frame on a 24 fps test clip. The engine parks the outgoing clip on its real last frame, so a
handoff from the earlier one starts the seam already off.

- Look at each last frame before chaining the next clip. In A, one bad handoff poisons every leg
  after it: re-roll that leg.
- The engine dissolves over a tenth of a viewport at each seam. That hides an end frame that landed
  close. It cannot hide a different picture.

## 5. Encode for seeking, not for playback

Scrubbing seeks on every frame, and each seek decodes every frame since the last keyframe. The
keyframe interval sets how smooth the scrub feels.

```bash
# Desktop: native resolution (never upscale), a keyframe every 8 frames, no audio, index first.
ffmpeg -i leg_01.mp4 -an -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart assets/vid/shot-01.mp4
# Phone: 720 wide, a keyframe every 4 frames; a phone decoder pays more per frame.
ffmpeg -i leg_01_portrait.mp4 -an -vf scale=720:-2 -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p \
  -g 4 -keyint_min 4 -sc_threshold 0 -movflags +faststart assets/vid/shot-01-m.mp4
# Poster: the clip's first frame. It is the LCP image and the reduced-motion fallback.
ffmpeg -v error -i assets/vid/shot-01.mp4 -frames:v 1 -c:v libwebp -quality 82 assets/shot-01.webp
```

One recipe for every clip in the chain. All-intra (`-g 1`) is the last resort for a low-end phone
that still stutters, at about three times the size.

## 6. Phones get their own chain, not a crop

A 16:9 film on a portrait phone shows its middle quarter. When the user asked for phones, render
the chain again at 9:16, frame-locked to its own renders. A landscape frame inside the portrait
chain pops on both sides. Start images: each still composited onto a 1080×1920 canvas in the page
background colour. The encodes are the `-m.mp4` files above, and each portrait clip's first frame is
its `posterMobile`.

No budget for it: the engine crops the landscape film with `object-fit: cover`, steered by
`--film-focus`. Tell the user this is a stopgap. Never ship it as "the mobile version".

## 7. Mount the page

Copy `assets/scrub-engine.js` and `assets/page-template.html` into the project. The template is a
working page: its copy is real HTML that reads without JavaScript, and the script moves it onto the
film once the engine mounts.

```js
const film = ScrollFilm.mount(document.getElementById('film'), {
  shots: [
    { section: 0, src: 'assets/vid/shot-01.mp4', srcMobile: 'assets/vid/shot-01-m.mp4',
      poster: 'assets/shot-01.webp', posterMobile: 'assets/shot-01-m.webp', length: 1.4, hold: 0.4 },
    { section: 0, src: 'assets/vid/hop-01.mp4', poster: 'assets/hop-01.webp', length: 0.9 },
    // one entry per clip, in chain order
  ],
  onChange: ({ section, sectionProgress }) => { /* fade the copy block for `section` */ },
});
```

What the engine does, and the failure each part prevents:

- **Loads each clip as a Blob.** On a host that ignores byte-range requests, a streamed `<video>`
  reports `seekable` as [0, 0] and every seek lands on frame 0. A Blob is always seekable.
- **Keeps one seek in flight per clip.** Queued seeks are what freeze a phone on a fast flick.
- **Keeps the poster up until a frame has painted**, and primes each clip with a muted play and
  pause, again on the first touch. iOS paints nothing for a seeked video that never played.
- **Picks phone sources at mount**, ignores height-only resizes on touch (the URL bar sliding), and
  re-lays out on rotation.
- **Reduced motion or Save-Data:** no video is fetched; posters dissolve with the scroll and the
  copy still works.
- **Fetches a clip once**, when the scroll comes within 1.5 viewports of it.
- **`destroy()`** removes everything it added. Call it from the effect cleanup in React or Vue.

`design` bans raw scroll listeners for animation. This one is passive and only requests a frame. If
the page already owns a scroll source (ScrollTrigger, `useScroll`), pass `listen: false` and call
`film.update()` from it. All options, the state object, theming, pacing and the Next.js and Vue
wiring → `references/engine.md`.

The film layer is `aria-hidden`; the meaning lives in the copy. Its words → `../landing-copy/SKILL.md`.
Its type, colour and spacing → `../design/SKILL.md`.

## 8. Verify before calling it done

1. **The chain, by script.** Pass the clips in chain order:

   ```bash
   bash <skill-dir>/scripts/verify.sh --frames qa/seams \
     assets/vid/shot-01.mp4 assets/vid/hop-01.mp4 assets/vid/shot-02.mp4
   bash <skill-dir>/scripts/verify.sh --gop 4 --portrait \
     assets/vid/shot-01-m.mp4 assets/vid/hop-01-m.mp4 assets/vid/shot-02-m.mp4
   ```

   It checks each clip's encode (H.264, yuv420p, no audio, index first, keyframe interval), that
   the chain shares one size and frame rate, and scores every seam against the clips' own
   frame-to-frame step. A fixed SSIM threshold cannot tell: on a soft landscape photo, a cut to a
   different picture still scored 0.76 and a fresh render of the same scene 0.92. Measured against
   the step (0.98 there), the frame-locked seam passed at 0.987 and both others were flagged. Open
   every flagged pair in `qa/seams/` and judge by what you see: a wrong seam shows different objects.
2. **In a browser.** Scroll slowly across each seam on desktop. Then emulate a phone at 4 to 6× CPU
   throttle and flick fast. Turn reduced motion on: posters only. In the Network panel, the phone
   gets the `-m.mp4` files and the desktop gets the masters.
3. **On a real iPhone**, if phones shipped: the first scene shows at once and no scene goes blank.

## Anti-patterns

| Failure mode | Usually | Fix |
| --- | --- | --- |
| A visible pop at one seam | The hop's end frame was the original still, or came from `-sseof` a few frames early | Extract the true frames from the neighbouring renders (section 4) |
| The camera seems to rewind at every seam | Velocity reverses across the seam: B in a realistic walkthrough, or an A leg given a wide end frame | Shape A with the settle-into-drift clauses and no end frame |
| Stuck on the first frame in production, fine locally | The host ignores byte ranges | Load as Blob; keep it when porting the engine to a framework |
| A phone freezes on a fast flick | A 1080p, 8-frame-GOP master on a phone decoder, plus queued seeks | `-m.mp4` encodes at GOP 4; keep one seek in flight |
| Black scenes on iPhone until the first touch | The poster was hidden on `loadedmetadata`, or `muted`/`playsinline` lost in a port | Keep the poster until a frame paints; keep both attributes |
| The film scrolls away instead of sticking | An ancestor has `overflow: hidden`, often `body { overflow-x: hidden }` | `overflow-x: clip` |
| A cheaper model "just for the hops" | Each model renders its own grain and motion | One model for the chain; previz on the same model at low resolution |
| A content filter blocks a harmless interior | Words like bed, pool, spa or wine in the prompt | Re-roll, neutral wording, then the remedies in `references/chain.md` |

## Orientación (siempre)

Habla con la voz de `orient`: frases cortas, una idea por frase, y cada respuesta se entiende sola. Registro técnico o con analogías según `technical_level` en `docs/harness/user-profile.md`. Cierra cada turno con el **bloque-brújula** (📍 dónde estás · ➡️ siguiente, terminando en pregunta; ✅ y 🧭 cuando hay algo hecho o decidido). **Nunca termines en seco.** Protocolo completo: skill `orient` → `skills/orient/references/orientation-contract.md`. (Defiere a `suggest` el "¿instalo la skill que falta?".)
