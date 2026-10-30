# The scrub engine — options, wiring, pacing

`assets/scrub-engine.js` is plain JavaScript with no dependencies. Loaded as a script it defines
`window.ScrollFilm`; under a bundler it also exports the same object. `assets/page-template.html` is
a complete page that uses it.

## Mounting

```js
const film = ScrollFilm.mount(container, options);
```

`container` is the element the film lives in, usually a `<section>`. The engine adds a sticky stage
(the clips and an overlay slot for your copy) and a spacer that gives the section its scroll length.
Content after the section scrolls normally once the film ends.

### `options`

| Option | Default | What it does |
| --- | --- | --- |
| `shots` | required | The clips in chain order (fields below). |
| `fade` | `0.1` | Width of the seam dissolve, in viewport heights. |
| `preload` | `1.5` | A clip is fetched when the scroll comes this many viewports from it. |
| `ease` | `0.2` | How fast the playhead catches up with the scroll each frame (1 = instantly). |
| `phoneWidth` | `860` | At or below this width, or on any touch-only device, the phone sources are used. |
| `stillsOnly` | `false` | Posters only, no video. Also forced by reduced motion and by Save-Data. |
| `listen` | `true` | `false` = the engine adds no scroll listener; call `film.update()` from your own scroll source. |
| `onChange` | none | Called with the state object whenever the position changes. |

### Fields of each shot

| Field | What it is |
| --- | --- |
| `src` | The desktop clip (`-g 8` encode). |
| `srcMobile` | The phone clip (`-m.mp4`, 9:16, `-g 4`). Optional; falls back to `src`. |
| `poster` / `posterMobile` | The clip's first frame. Shown until the video paints, and as the fallback. |
| `length` | Scroll distance in viewport heights. More length, longer dwell. Default 1. |
| `hold` | 0 to 1. Slows the camera mid-shot and speeds it near the seams; the seam frames never move. Above 0.6 the stop starts to read as a stall. |
| `section` | Which copy block this clip belongs to. A dive and the hop that leaves it share a section. Defaults to the shot's index. |

### What `mount` returns

| Member | Use |
| --- | --- |
| `overlay` | Append your copy here; it rides the sticky stage above the clips. |
| `stage` | The sticky element, for styling. |
| `stillsOnly` | Whether this visitor gets posters only. |
| `update()` | Re-read the scroll position. Needed only with `listen: false`. |
| `relayout()` | Recompute positions after content above the film changes height (a late banner, a font swap). |
| `jumpTo(section)` | Smooth-scroll to the middle of a section; instant under reduced motion. |
| `destroy()` | Remove listeners, cancel fetches, release the Blob URLs, remove the added nodes. |

### The state object passed to `onChange`

```js
{ shot: 2, section: 1, sectionProgress: 0.42, progress: 0.37 }
```

`sectionProgress` runs 0 to 1 across every clip of that section. Fade a section's copy in over its
first 15% and out over its last 15%; let the first block start visible and the last one hold its
call to action. The template does exactly this.

## Pacing

- The hero and the finale earn more `length` (1.4 to 1.6) and a `hold` of 0.3 to 0.5, so the camera
  settles while the copy is readable.
- Hops are transit: `length` 0.8 to 1.0, no `hold`.
- Expressive camera work belongs in the clip, restraint in the scroll mapping. Both compound.

## Theming and layout

- `--film-bg` is the colour behind the stage; set it to the scene background so posters and
  dissolves sit on it. `--film-focus` (default `50% 45%`) is where `object-fit: cover` keeps the
  subject when the viewport crops a clip.
- The engine's own CSS sits in `@layer scroll-film`, so any unlayered page rule wins without
  specificity tricks.
- The stage is `position: sticky`. Any ancestor with `overflow: hidden` breaks it; use
  `overflow-x: clip` on `body` if the page needs to stop horizontal overflow.
- The stage is `100lvh` tall: the film fills the screen when the URL bar is hidden, and the bottom
  edge sits under the bar while it shows. Keep copy clear of the bottom with `svh` units and
  `env(safe-area-inset-bottom)`, as the template does, and add `viewport-fit=cover` to the
  viewport meta tag.

## Wiring it into a framework

React or Next.js, in a client component (the effect never runs on the server):

```tsx
'use client';
import { useEffect, useRef } from 'react';

export function Film({ shots }: { shots: object[] }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    let film: { destroy(): void } | undefined;
    let cancelled = false;
    import('./scrub-engine.js').then((mod) => {
      const ScrollFilm = (mod as any).default ?? (window as any).ScrollFilm;
      if (!cancelled && ref.current) film = ScrollFilm.mount(ref.current, { shots });
    });
    return () => { cancelled = true; film?.destroy(); };
  }, [shots]);
  return <section ref={ref} aria-label="The journey" />;
}
```

The `cancelled` flag matters: a component that unmounts before the import resolves would otherwise
mount a film nobody can destroy. Keep `shots` stable (a module constant or `useMemo`) or every
render rebuilds the film.

Vue: mount in `onMounted`, keep the returned object, call `destroy()` in `onBeforeUnmount`. A
server-rendered page in any other stack: serve the assets and add two `<script>` tags, as the
template does.

To drive it from a scroll source the page already owns:

```js
const film = ScrollFilm.mount(el, { shots, listen: false });
ScrollTrigger.create({ trigger: el, start: 'top top', end: 'bottom bottom', onUpdate: () => film.update() });
```

## Accessibility and weight

- The clip layer is `aria-hidden`. Everything a visitor needs is in the copy, which is ordinary
  HTML in reading order, available to screen readers and search engines with or without the film.
- The template adds a skip link past the film and, when keyboard focus enters a faded copy block,
  scrolls to that block's section.
- Preload the first poster with `fetchpriority="high"`; it is the LCP element. Clips load by
  proximity, so first paint costs one image and one or two clips, not the whole chain.
- Measure the chain before shipping (`du -ch assets/vid/*.mp4`). A 1080p clip of several seconds
  at GOP 8 runs to megabytes, so a whole chain runs to tens of them. That is why the phone chain is
  720 wide and why a clip is fetched only when the scroll gets near it.
