# 3D race map: design

## Intent

Turn the flat track map into a blocky 3D world (Roblox / Minecraft look) that you can watch from above
or ride along in, following one car from a chase or cockpit camera. The surroundings should feel like
the real place, not be a survey of it.

## Goals

- The circuit as a 3D road with its real hills.
- Blocky terrain around it, themed per circuit; street circuits get block buildings in the city's flavour.
- Block-built cars in team colours with the driver's number.
- Three cameras: overview (orbit), chase (third person), cockpit. The followed car is picked in the timing tower.
- The existing flat map stays, behind a 2D / 3D toggle.

## Non-goals

- Real landmarks, real street layouts beyond the track, real building outlines (a later upgrade: approach C).
- Licensed or per-team car shapes. One shape, painted per team.
- Kerbs, grandstands, pit lane geometry, weather, sound.
- The wider visual redesign of the app. That is a separate project, after this one.

## Anti-goals

- No build step, no npm install. The app stays three files served by `server.mjs`, plus one new file.
- Nothing about the 2D map, timing panels or data loading may change behaviour.
- The 3D view must not need any new outside data service.

## Approaches considered

- **A. Everything generated in code (chosen by the user).** Three.js from a CDN; track from the edges the
  app already computes plus the feed's height; generated terrain; a theme table per circuit; box cars.
  Works for every circuit on day one, no new services. Cities are flavour only.
- **B. Real map data voxelised.** Pin each circuit to the globe, download elevation and building outlines.
  Recognisable, but several times the code, a hand-made entry per circuit, two outside services.
- **C. A now, real buildings for street circuits later.** A plus a later upgrade; A does not close it off.

## Decided with the user

- Approach A.
- Blocky is fine; terrain only needs to be semi-accurate for the location.
- Street circuits should resemble the real city.
- Follow a car from cockpit and third-person views.
- Cameras, tower-click selection, the 2D toggle and "live sessions follow the racing line" were proposed
  and not objected to.

## How it works (builder's calls unless marked above)

**Files.** One new file, `map3d.js`, an ES module that imports Three.js from jsDelivr at a pinned version.
It is added to `index.html` and to the fixed `FILES` list in `server.mjs`. It reads the app's existing
state (`S`, `carXY`, `order`, `gone`, `opt`) and exposes one function the frame loop calls instead of
`draw()` when 3D is on. A second canvas sits under the same overlays as `#map`; the toggle shows one.

**Height.** `chunk()` and the reference-lap fetch currently drop the feed's `z`. Keep it: smooth it the same
way as x and y, and add `carXYZ` (or a third element from `carXY`) without changing what 2D callers get.
Track height per station comes from the reference lap's z, blurred round the loop. Live sessions take
height from the reference lap at the car's lap progress.

**Track.** A ribbon mesh between the two edges in `S.road.edges`, each cross-section at its station's
height. Dark tarmac, a white start line, sector lines when the Sectors option is on. Rebuilt when
`S.road` changes (estimated first, surveyed a moment later).

**Terrain.** A square grid of flat-topped columns (one instanced mesh) covering the track's bounding box
plus a margin, cells about 20 m. Each cell's height is the nearest track station's height, minus a small
drop, blended with seeded noise that grows with distance from the track, then snapped to whole steps so
it reads as blocks. The seed is the circuit name, so a circuit always looks the same. Cells under the
road are flattened to just below it.

**Themes.** A table keyed by OpenF1 circuit name: ground colours, hill size, water level (cells below it
become water), scatter (box trees, cacti, rocks, none), and for street circuits a building style (height
range, palette, density). Buildings are boxes on cells a set distance back from the road. Unknown
circuits fall back to a plain grass theme. Starting set: every circuit on the current calendar, grouped
into about six looks (grassland, forest, desert, coast, city by day, city by night).

**Cars.** One group of about a dozen boxes (body, nose, wings, four wheels, halo, helmet), built once and
cloned per driver; body in `team_colour`, the number drawn on a small canvas texture. Position from the
car's x, y, z; heading from where it was 100 ms earlier; hidden when `gone()`. Name tags as sprites when
the Names option is on.

**Cameras.** Overview: OrbitControls, framed on the track. Chase: behind and above the followed car,
eased. Cockpit: at the helmet, looking along the heading, own car's body still visible. A small
Overview / Chase / Cockpit control appears in `#tools` in 3D. Clicking a row in the timing tower sets the
followed car and, from overview, switches to chase. Escape or the Overview button returns. The overtake
close-up in 3D frames the two cars from above; the zoom buttons act on the overview camera.

**Fallback.** If WebGL or the CDN is unavailable, the toggle is hidden and the 2D map stays.

## Left to the builder

Exact colours and proportions, cell size, noise function, camera distances and easing, the theme
assigned to each circuit, and how the 3D toggle is drawn.

## Known limits

- The feed's height is noisy and has occasional dropouts; heavy smoothing may flatten short crests.
- Surveyed track widths exist for 17 circuits; elsewhere the road is an estimated 12 m band.
- Cockpit view at 20x or 60x playback will be uncomfortable; no speed change is forced.
- Phone performance is unmeasured.
