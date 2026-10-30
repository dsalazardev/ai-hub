/*!
 * scroll-film scrub engine — part of rsc-harness (MIT).
 * Scroll position becomes the playhead of a chain of pre-rendered clips.
 * Vanilla JS, no dependencies, no framework. API and wiring: ../references/engine.md
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.ScrollFilm = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function smoothstep(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }

  // Remaps a shot's progress so the camera slows in the middle (where the copy sits) and
  // hurries near the seams. f(0)=0 and f(1)=1 for every strength, so seam frames never move.
  // Monotone up to strength 1, which is a momentary stop at the midpoint.
  function hold(x, strength) {
    var s = clamp(strength || 0, 0, 1);
    if (!s) return x;
    return x + (s * Math.sin(2 * Math.PI * x)) / (2 * Math.PI);
  }

  // Lays the shots end to end on the scroll axis. lengths are in viewport heights.
  function planBands(lengths, viewport) {
    var at = 0;
    return lengths.map(function (len) {
      var band = { start: at, end: at + len * viewport };
      at = band.end;
      return band;
    });
  }

  // A shot dissolves in over `fade` px centred on its start seam, on top of its predecessor,
  // and stays opaque underneath its successor until that one is fully in. So the stack never
  // shows the page through it, and the dissolve blends the two frames the seam handed off.
  function shotOpacity(i, y, bands, fade) {
    var band = bands[i];
    var half = fade / 2;
    var enter = 1;
    if (i > 0) enter = fade > 0 ? smoothstep((y - (band.start - half)) / fade) : (y >= band.start ? 1 : 0);
    var leave = i === bands.length - 1 || y < band.end + half ? 1 : 0;
    return Math.min(enter, leave);
  }

  function mount(container, options) {
    var opts = options || {};
    var shots = (opts.shots || []).filter(Boolean);
    if (!container || !shots.length) throw new Error('scroll-film: mount needs a container and at least one shot');

    var doc = container.ownerDocument;
    var win = doc.defaultView;
    var touch = win.matchMedia(TOUCH_QUERY).matches;
    var phone = touch || win.innerWidth <= (opts.phoneWidth || 860);
    var reduce = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var saveData = !!(win.navigator.connection && win.navigator.connection.saveData);
    var stillsOnly = !!opts.stillsOnly || reduce || saveData;
    var fadeVh = opts.fade == null ? 0.1 : opts.fade;
    var preloadVh = opts.preload == null ? 1.5 : opts.preload;
    var ease = opts.ease == null ? 0.2 : clamp(opts.ease, 0.01, 1);
    var minStep = phone ? 1 / 24 : 1 / 120; // seconds; a phone never seeks for less than a frame

    injectStyles(doc);
    container.classList.add('sf-root');
    var stage = element(doc, 'div', 'sf-stage');
    var layer = element(doc, 'div', 'sf-shots');
    layer.setAttribute('aria-hidden', 'true');
    var overlay = element(doc, 'div', 'sf-overlay');
    stage.appendChild(layer);
    stage.appendChild(overlay);
    var track = element(doc, 'div', 'sf-track');
    container.insertBefore(stage, container.firstChild);
    container.appendChild(track);

    var items = shots.map(function (shot, i) {
      var node = element(doc, 'div', 'sf-shot');
      node.style.zIndex = String(i + 1);
      var img = element(doc, 'img', 'sf-poster');
      img.alt = '';
      img.decoding = 'async';
      node.appendChild(img);
      layer.appendChild(node);
      return {
        shot: shot,
        section: shot.section == null ? i : shot.section,
        node: node,
        img: img,
        poster: (phone && shot.posterMobile) || shot.poster || '',
        src: (phone && shot.srcMobile) || shot.src || '',
        video: null,
        url: '',
        state: 'idle',
        cur: -1,
        target: 0,
        opacity: -1,
      };
    });
    if (items[0].poster) {
      items[0].img.setAttribute('fetchpriority', 'high');
      showPoster(items[0]);
    }

    var aborter = typeof AbortController === 'function' ? new AbortController() : null;
    var destroyed = false;
    var raf = 0;
    var vh = 0;
    var top = 0;
    var laidOutWidth = 0;
    var bands = [];
    var sections = [];
    var lastState = '';

    function showPoster(item) {
      if (item.poster && !item.img.getAttribute('src')) item.img.src = item.poster;
    }

    function load(item) {
      if (stillsOnly || item.state !== 'idle' || !item.src) return;
      item.state = 'loading';
      // A Blob is always fully seekable. Streaming from a host that ignores byte-range
      // requests pins video.seekable to [0, 0] and every seek lands on frame 0.
      win.fetch(item.src, aborter ? { signal: aborter.signal } : undefined)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.blob();
        })
        .then(function (blob) {
          if (destroyed) return;
          var video = doc.createElement('video');
          video.className = 'sf-video';
          video.muted = true;
          video.defaultMuted = true;
          video.playsInline = true;
          video.preload = 'auto';
          // The attributes, not just the properties: iOS reads them to allow inline decode.
          video.setAttribute('muted', '');
          video.setAttribute('playsinline', '');
          video.setAttribute('disablepictureinpicture', '');
          video.setAttribute('disableremoteplayback', '');
          item.url = win.URL.createObjectURL(blob);
          video.addEventListener('loadedmetadata', function () { item.state = 'ready'; wake(); });
          video.addEventListener('seeked', wake);
          video.src = item.url;
          item.node.appendChild(video);
          item.video = video;
          watchFirstPaint(item);
          prime(video);
        })
        .catch(function () {
          if (!destroyed) item.state = 'failed'; // the poster stays up: degraded, never blank
        });
    }

    // Keep the poster until the video has really painted. iOS reports a seek as done on a
    // muted video that never played and still shows nothing, so 'seeked' alone is not proof.
    function watchFirstPaint(item) {
      var live = function () { item.node.classList.add('is-live'); };
      if (typeof item.video.requestVideoFrameCallback === 'function') item.video.requestVideoFrameCallback(live);
      else item.video.addEventListener('seeked', live, { once: true });
    }

    // A muted play()+pause() unlocks decoding on iOS. Rejected before a user gesture in some
    // power modes; the first-gesture handler below retries every loaded clip.
    function prime(video) {
      var p;
      try { p = video.play(); } catch (err) { return; }
      if (p && typeof p.then === 'function') p.then(function () { video.pause(); }, function () {});
      else video.pause();
    }

    function dropGestureListeners() {
      win.removeEventListener('pointerdown', onFirstGesture);
      win.removeEventListener('touchstart', onFirstGesture);
    }

    function onFirstGesture() {
      dropGestureListeners();
      items.forEach(function (item) { if (item.video) prime(item.video); });
    }

    function scrollOffset() { return (win.scrollY || win.pageYOffset || 0) - top; }

    function layout() {
      vh = stage.clientHeight || win.innerHeight;
      laidOutWidth = win.innerWidth;
      bands = planBands(items.map(function (item) { return item.shot.length || 1; }), vh);
      track.style.height = bands[bands.length - 1].end + 'px';
      top = container.getBoundingClientRect().top + (win.scrollY || win.pageYOffset || 0);
      sections = [];
      items.forEach(function (item, i) {
        var s = sections[item.section];
        if (!s) sections[item.section] = { start: bands[i].start, end: bands[i].end };
        else { s.start = Math.min(s.start, bands[i].start); s.end = Math.max(s.end, bands[i].end); }
      });
      wake();
    }

    // Phones fire resize whenever the URL bar slides. Re-laying out on a height-only change
    // rewrites the track height mid-scroll and the page jumps, so touch only reacts to width.
    function onResize() {
      if (touch && win.innerWidth === laidOutWidth) return;
      layout();
    }

    function wake() {
      if (!raf && !destroyed) raf = win.requestAnimationFrame(frame);
    }

    function frame() {
      raf = 0;
      if (destroyed) return;
      var y = scrollOffset();
      var fade = fadeVh * vh;
      var reach = preloadVh * vh;
      var moving = false;

      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var band = bands[i];
        var near = y > band.start - reach && y < band.end + reach;
        if (near) { showPoster(item); load(item); }

        var opacity = shotOpacity(i, y, bands, fade);
        if (opacity !== item.opacity) {
          item.opacity = opacity;
          item.node.style.opacity = String(opacity);
          item.node.style.visibility = opacity > 0 ? 'visible' : 'hidden';
        }

        item.target = hold(clamp((y - band.start) / (band.end - band.start), 0, 1), item.shot.hold);
        if (!near) { item.cur = -1; continue; } // out of reach: snap, don't glide, on return
        if (item.state !== 'ready') continue;

        var video = item.video;
        var duration = video.duration;
        if (!isFinite(duration) || duration <= 0) continue;
        if (item.cur < 0) item.cur = item.target;
        else item.cur += (item.target - item.cur) * ease;
        if (Math.abs(item.target - item.cur) * duration < 0.002) item.cur = item.target;
        if (item.cur !== item.target) moving = true;

        // One seek in flight per clip. Queuing more while the decoder works is what freezes
        // a phone on a fast flick; 'seeked' wakes the loop and it takes the latest target.
        if (video.seeking) { moving = true; continue; }
        var t = Math.min(item.cur * duration, duration - 0.01);
        var gap = Math.abs(video.currentTime - t);
        if (gap >= minStep || (gap > 0.001 && item.cur === item.target)) {
          try { video.currentTime = t; } catch (err) { /* not seekable yet; next frame retries */ }
        }
      }

      report(y);
      if (moving) wake();
    }

    function report(y) {
      if (typeof opts.onChange !== 'function') return;
      var index = 0;
      for (var i = 0; i < bands.length; i++) if (y >= bands[i].start) index = i;
      var section = items[index].section;
      var span = sections[section];
      var total = bands[bands.length - 1].end;
      var state = {
        shot: index,
        section: section,
        sectionProgress: clamp((y - span.start) / (span.end - span.start), 0, 1),
        progress: clamp(y / total, 0, 1),
      };
      var key = [state.shot, state.section, state.sectionProgress.toFixed(4), state.progress.toFixed(4)].join('|');
      if (key === lastState) return;
      lastState = key;
      opts.onChange(state);
    }

    function jumpTo(section) {
      var span = sections[section];
      if (!span) return;
      win.scrollTo({ top: top + (span.start + span.end) / 2, behavior: reduce ? 'auto' : 'smooth' });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) win.cancelAnimationFrame(raf);
      if (aborter) aborter.abort();
      win.removeEventListener('scroll', wake);
      win.removeEventListener('resize', onResize);
      win.removeEventListener('orientationchange', layout);
      win.removeEventListener('load', layout);
      dropGestureListeners();
      items.forEach(function (item) {
        if (item.video) { item.video.removeAttribute('src'); item.video.load(); }
        if (item.url) win.URL.revokeObjectURL(item.url);
      });
      stage.remove();
      track.remove();
      container.classList.remove('sf-root');
    }

    // Passive, and it only requests a frame: the per-frame work happens in rAF. Hosts that
    // already own a scroll source (GSAP ScrollTrigger, motion's useScroll) pass listen:false
    // and call update() from it instead.
    if (opts.listen !== false) win.addEventListener('scroll', wake, { passive: true });
    win.addEventListener('resize', onResize);
    win.addEventListener('orientationchange', layout);
    win.addEventListener('load', layout);
    win.addEventListener('pointerdown', onFirstGesture, { passive: true });
    win.addEventListener('touchstart', onFirstGesture, { passive: true });
    layout();

    return {
      stage: stage,
      overlay: overlay,
      stillsOnly: stillsOnly,
      update: wake,
      relayout: layout,
      jumpTo: jumpTo,
      destroy: destroy,
    };
  }

  function element(doc, tag, className) {
    var node = doc.createElement(tag);
    node.className = className;
    return node;
  }

  // Layered, so any unlayered page rule (theme tokens, focus position) wins without a fight.
  function injectStyles(doc) {
    if (doc.getElementById('scroll-film-css')) return;
    var style = doc.createElement('style');
    style.id = 'scroll-film-css';
    style.textContent = [
      '@layer scroll-film {',
      '.sf-root{position:relative;background:var(--film-bg,#0d0d0f)}',
      '.sf-stage{position:sticky;top:0;height:100vh;height:100lvh;overflow:hidden}',
      '.sf-shots,.sf-shot,.sf-overlay{position:absolute;inset:0}',
      '.sf-shot{opacity:0;visibility:hidden}',
      '.sf-poster,.sf-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:var(--film-focus,50% 45%)}',
      '.sf-video{opacity:0}',
      '.sf-shot.is-live .sf-video{opacity:1}',
      '.sf-overlay{z-index:1000;pointer-events:none}',
      '}',
    ].join('\n');
    doc.head.appendChild(style);
  }

  return { mount: mount, hold: hold, planBands: planBands, shotOpacity: shotOpacity };
});
