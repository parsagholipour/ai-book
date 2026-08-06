import { COVER_HEIGHT, COVER_WIDTH } from "./cover.js";
import type { CoverDesign, CoverMotifOptions, CoverPalette } from "./coverDesigns.js";
import type { CoverTemplateId } from "../schemas/book.js";

/**
 * Turns a catalog entry into the artwork layer `renderCoverPng` composites the
 * title over. The output is a self-contained, **text-free** SVG at the cover's
 * own size — Chrome renders it inside the existing `<img class="art">`, which
 * runs SVG in secure static mode, so no scripts and no external references.
 *
 * Everything is seeded off the design id rather than the project, because a
 * re-render of the same book has to produce the same cover.
 *
 * Two things decide whether a design reads at all, and both are easy to get
 * wrong from the code alone — render the catalog with `pnpm covers:preview` and
 * look at it:
 *
 * 1. **Contrast.** The artwork is always seen through a template scrim, so a
 *    mark at low opacity over a dark ground disappears entirely. Paint with
 *    `mid` and `accent`, not with `ground`.
 * 2. **Placement.** Each template darkens the half its text panel sits in —
 *    science and business blacken the top, kids/fiction/romance the bottom. So
 *    every motif takes a `focus` band (see `FOCUS_BY_TEMPLATE`) and puts its
 *    subject there, opposite the type.
 */

const W = COVER_WIDTH;
const H = COVER_HEIGHT;

/**
 * Where a design's subject belongs, as a fraction of the cover height, chosen
 * so it lands away from the template's text panel and its scrim.
 */
const FOCUS_BY_TEMPLATE: Record<Exclude<CoverTemplateId, "auto">, number> = {
  science: 0.64,
  business: 0.64,
  kids: 0.36,
  fiction: 0.36,
  romance: 0.36,
  minimal: 0.44,
  "self-help": 0.44
};

type MotifContext = {
  palette: CoverPalette;
  options: CoverMotifOptions;
  rand: () => number;
  /** 0..1 of the cover height; where the eye should land. */
  focus: number;
};

type MotifArtwork = { defs?: string; body: string };
type Motif = (context: MotifContext) => MotifArtwork;

export function coverDesignSvg(design: CoverDesign): string {
  const artwork = MOTIFS[design.motif]({
    palette: design.palette,
    options: design.motifOptions ?? {},
    rand: seededRandom(design.id),
    focus: FOCUS_BY_TEMPLATE[design.template]
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    artwork.defs ? `<defs>${artwork.defs}</defs>` : "",
    `<rect width="${W}" height="${H}" fill="${design.palette[0]}"/>`,
    artwork.body,
    "</svg>"
  ]
    .filter(Boolean)
    .join("");
}

// --- motifs -----------------------------------------------------------------

const bands: Motif = ({ palette: [ground, mid, accent], options }) => {
  if (options.variant === "diagonal") {
    const drop = Math.tan(((options.angle ?? 26) * Math.PI) / 180) * W;
    const split = H * 0.62;
    const edge = (offset: number) => `0,${n(split + drop / 2 + offset)} ${W},${n(split - drop / 2 + offset)}`;
    return {
      defs: linearGradient("g", ground, mid, 0.15),
      body: [
        `<rect width="${W}" height="${H}" fill="url(#g)"/>`,
        `<polygon points="${edge(0)} ${W},${H} 0,${H}" fill="${accent}"/>`,
        `<polygon points="${edge(-34)} ${edge(0).split(" ").reverse().join(" ")}" fill="${mix(accent, ground, 0.45)}"/>`
      ].join("")
    };
  }
  const count = 9;
  const bars = Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    const fill = t < 0.5 ? mix(ground, mid, t * 2) : mix(mid, accent, (t - 0.5) * 2);
    return `<rect y="${n(H - ((index + 1) * H) / count)}" width="${W}" height="${n(H / count + 1)}" fill="${fill}"/>`;
  });
  return { body: bars.join("") };
};

const wash: Motif = ({ palette: [ground, mid, accent], options, focus }) => {
  if (options.variant === "radial") {
    return {
      defs: `<radialGradient id="g" cx="50%" cy="${n(focus * 100)}%" r="82%"><stop offset="0%" stop-color="${mix(accent, mid, 0.25)}"/><stop offset="44%" stop-color="${mid}"/><stop offset="100%" stop-color="${ground}"/></radialGradient>`,
      body: `<rect width="${W}" height="${H}" fill="url(#g)"/>`
    };
  }
  if (options.variant === "brush") {
    // Ink bleeding into wet paper. Uniform shapes read as a loading skeleton
    // and one big smear reads as a stain, so the blots vary in both axes.
    const blots = [
      [0.3, -0.22, 0.46, 0.1],
      [0.68, -0.08, 0.3, 0.07],
      [0.42, 0.06, 0.54, 0.13],
      [0.24, 0.2, 0.26, 0.06],
      [0.66, 0.26, 0.44, 0.11],
      [0.46, 0.4, 0.34, 0.08]
    ].map(([cx, dy, rx, ry], index) => {
      const fill = index % 3 === 1 ? accent : mid;
      return `<ellipse cx="${n(W * (cx ?? 0.5))}" cy="${n(H * (focus + (dy ?? 0)))}" rx="${n(W * (rx ?? 0.4))}" ry="${n(H * (ry ?? 0.1))}" fill="${fill}" opacity="${index % 3 === 1 ? 0.6 : 0.95}"/>`;
    });
    return {
      defs: `${linearGradient("g", ground, mix(ground, mid, 0.45), 0.4)}${blurFilter("soft", 46)}`,
      body: `<rect width="${W}" height="${H}" fill="url(#g)"/><g filter="url(#soft)">${blots.join("")}</g>`
    };
  }
  if (options.variant === "duotone") {
    return {
      defs: [
        `<linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0%" stop-color="${ground}"/><stop offset="52%" stop-color="${mid}"/><stop offset="100%" stop-color="${accent}"/></linearGradient>`,
        noiseFilter("dither", 0.9, 2, 7)
      ].join(""),
      body: `<rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" filter="url(#dither)" opacity="0.18"/>`
    };
  }
  return {
    defs: `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${ground}"/><stop offset="58%" stop-color="${mid}"/><stop offset="100%" stop-color="${accent}"/></linearGradient>`,
    body: `<rect width="${W}" height="${H}" fill="url(#g)"/>`
  };
};

const grain: Motif = ({ palette: [ground, mid, accent], options, rand, focus }) => {
  const variant = options.variant ?? "paper";
  const pitch = variant === "canvas" ? 26 : variant === "cloth" ? 19 : 15;
  // Whichever end of the palette is furthest from the cloth itself. Drawing the
  // weave in `ground` is right for a dark design and invisible on a light one.
  const thread = contrastingColor(mid, ground, accent);
  const weave: string[] = [];
  if (variant !== "paper") {
    for (let x = 0; x < W; x += pitch) {
      weave.push(`<rect x="${x}" width="${n(pitch * 0.5)}" height="${H}" fill="${thread}" opacity="0.4"/>`);
    }
    for (let y = 0; y < H; y += pitch) {
      weave.push(`<rect y="${y}" width="${W}" height="${n(pitch * 0.5)}" fill="${thread}" opacity="0.26"/>`);
    }
  } else {
    // Paper tooth: short broken fibres rather than a filter nobody can see.
    for (let index = 0; index < 300; index += 1) {
      weave.push(
        `<rect x="${n(rand() * W)}" y="${n(rand() * H)}" width="${n(60 + rand() * 340)}" height="4" fill="${thread}" opacity="${n(0.18 + rand() * 0.34)}"/>`
      );
    }
  }
  const detail =
    variant === "cloth"
      ? // One heavy fold across the cloth, which is what makes it a tablecloth.
        `<polygon points="0,${n(H * (focus + 0.02))} ${W},${n(H * (focus - 0.09))} ${W},${n(H * (focus + 0.05))} 0,${n(H * (focus + 0.16))}" fill="${thread}" opacity="0.5"/>` +
        `<polygon points="0,${n(H * (focus + 0.16))} ${W},${n(H * (focus + 0.05))} ${W},${n(H * (focus + 0.09))} 0,${n(H * (focus + 0.2))}" fill="${mid}" opacity="0.7"/>`
      : variant === "canvas"
        ? `<ellipse cx="${n(W * 0.5)}" cy="${n(H * focus)}" rx="${n(W * 0.66)}" ry="${n(H * 0.26)}" fill="${accent}" opacity="0.3"/>` +
          `<rect x="70" y="70" width="${W - 140}" height="${H - 140}" fill="none" stroke="${thread}" stroke-width="8" opacity="0.34"/>`
        : `<rect x="220" y="${n(H * (focus - 0.12))}" width="${W - 440}" height="9" fill="${thread}" opacity="0.75"/>`;
  return {
    defs: `<radialGradient id="v" cx="50%" cy="${n(focus * 100)}%" r="82%"><stop offset="0%" stop-color="${mid}"/><stop offset="100%" stop-color="${mix(mid, ground, 0.55)}"/></radialGradient>${noiseFilter("noise", 0.85, 3, 11)}`,
    body: `<rect width="${W}" height="${H}" fill="url(#v)"/>${weave.join("")}${detail}<rect width="${W}" height="${H}" filter="url(#noise)" opacity="0.34"/>`
  };
};

const arcs: Motif = ({ palette: [ground, mid, accent], options, focus }) => {
  if (options.variant === "paired") {
    // Leaning toward each other with a gap — crossing them reads as an X.
    const y = H * focus;
    return {
      defs: linearGradient("g", ground, mid, 0.5),
      body: [
        `<rect width="${W}" height="${H}" fill="url(#g)"/>`,
        `<path d="M ${n(W * -0.05)} ${n(y + 660)} Q ${n(W * 0.3)} ${n(y - 340)} ${n(W * 0.38)} ${n(y - 520)}" fill="none" stroke="${accent}" stroke-width="140" stroke-linecap="round"/>`,
        `<path d="M ${n(W * 1.05)} ${n(y + 660)} Q ${n(W * 0.7)} ${n(y - 340)} ${n(W * 0.62)} ${n(y - 520)}" fill="none" stroke="${mix(accent, ground, 0.45)}" stroke-width="140" stroke-linecap="round"/>`
      ].join("")
    };
  }
  if (options.variant === "tide") {
    const shapes = Array.from({ length: 7 }, (_, index) => {
      const t = index / 7;
      const y = H * (focus - 0.06) + index * 200;
      return `<path d="M 0 ${n(y)} Q ${n(W / 2)} ${n(y - 170)} ${W} ${n(y)} L ${W} ${H} L 0 ${H} Z" fill="${mix(accent, mid, t)}" opacity="${n(0.95 - t * 0.45)}"/>`;
    });
    return { defs: linearGradient("g", ground, mid, 0.6), body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${shapes.join("")}` };
  }
  // Three arches standing side by side on a shared floor.
  const floor = H * (focus + 0.3);
  const columns = [0.2, 0.5, 0.8].map((position, index) => {
    const radius = 300 - index * 40;
    const cx = W * position;
    const top = floor - 640 + index * 90;
    return [
      `<path d="M ${n(cx - radius)} ${n(floor)} L ${n(cx - radius)} ${n(top)} a ${radius} ${radius} 0 0 1 ${radius * 2} 0 L ${n(cx + radius)} ${n(floor)} Z" fill="${mix(accent, mid, index / 3)}" opacity="${n(0.95 - index * 0.16)}"/>`
    ].join("");
  });
  return {
    defs: linearGradient("g", ground, mid, 0.55),
    body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${columns.join("")}<rect y="${n(floor)}" width="${W}" height="${n(H - floor)}" fill="${ground}" opacity="0.5"/>`
  };
};

const rings: Motif = ({ palette: [ground, mid, accent], options, focus }) => {
  const cx = W * 0.56;
  const cy = H * focus;
  if (options.variant === "elliptical") {
    const orbits = Array.from({ length: 6 }, (_, index) => {
      const rx = 330 + index * 195;
      return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(rx * 0.4)}" fill="none" stroke="${mix(accent, mid, index / 6)}" stroke-width="${n(8 - index * 0.8)}" opacity="${n(0.95 - index * 0.1)}" transform="rotate(${18 + index * 24} ${n(cx)} ${n(cy)})"/>`;
    });
    return {
      defs: `${radialGradient("g", mid, ground, focus, 0.35)}${blurFilter("glow", 52)}`,
      body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${orbits.join("")}<circle cx="${n(cx)}" cy="${n(cy)}" r="130" fill="${accent}" opacity="0.55" filter="url(#glow)"/><circle cx="${n(cx)}" cy="${n(cy)}" r="38" fill="${accent}"/>`
    };
  }
  const circles = Array.from({ length: 15 }, (_, index) => {
    const radius = 95 + index * 122;
    return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(radius)}" fill="none" stroke="${mix(accent, mid, index / 15)}" stroke-width="7" opacity="${n(0.95 - index * 0.052)}"/>`;
  });
  return {
    defs: radialGradient("g", mid, ground, focus, 0.6),
    body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${circles.join("")}<circle cx="${n(cx)}" cy="${n(cy)}" r="52" fill="${accent}" opacity="0.9"/>`
  };
};

const grid: Motif = ({ palette: [ground, mid, accent], options, focus }) => {
  const measured = options.variant === "measured";
  const step = measured ? 104 : 92;
  const lines: string[] = [];
  for (let x = step; x < W; x += step) {
    const heavy = measured && (x / step) % 5 === 0;
    lines.push(`<rect x="${x}" width="${heavy ? 6 : 3}" height="${H}" fill="${accent}" opacity="${heavy ? 0.72 : 0.42}"/>`);
  }
  for (let y = step; y < H; y += step) {
    const heavy = measured && (y / step) % 5 === 0;
    lines.push(`<rect y="${y}" width="${W}" height="${heavy ? 6 : 3}" fill="${accent}" opacity="${heavy ? 0.72 : 0.42}"/>`);
  }
  if (measured) {
    for (let x = step; x < W; x += step) {
      lines.push(`<rect x="${x}" y="${H - 84}" width="5" height="54" fill="${accent}" opacity="0.9"/>`);
    }
    for (let y = step; y < H; y += step) {
      lines.push(`<rect x="26" y="${y}" width="54" height="5" fill="${accent}" opacity="0.9"/>`);
    }
  }
  return {
    defs: radialGradient("g", mid, ground, focus, 0.95),
    body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${lines.join("")}`
  };
};

const swirl: Motif = ({ palette: [ground, mid, accent], options, rand, focus }) => {
  if (options.variant === "cloud") {
    const band = H * (focus + 0.14);
    const blobs = Array.from({ length: 11 }, (_, index) => {
      const cx = rand() * W;
      const cy = H * (focus - 0.3) + rand() * H * 0.44;
      return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(400 + rand() * 340)}" ry="${n(150 + rand() * 140)}" fill="${index % 3 === 0 ? mid : mix(mid, ground, 0.55)}" opacity="0.95"/>`;
    });
    return {
      defs: `${linearGradient("g", ground, mid, 0.6)}${blurFilter("soft", 66)}`,
      body: [
        `<rect width="${W}" height="${H}" fill="url(#g)"/>`,
        `<g filter="url(#soft)">${blobs.join("")}</g>`,
        // Painted last: a break in the weather covered by its own cloud is not
        // a break in the weather.
        `<rect y="${n(band)}" width="${W}" height="120" fill="${accent}" opacity="0.92"/>`,
        `<rect y="${n(band - 60)}" width="${W}" height="240" fill="${accent}" opacity="0.3" filter="url(#soft)"/>`
      ].join("")
    };
  }
  if (options.variant === "circuit") {
    const traces: string[] = [];
    for (let index = 0; index < 34; index += 1) {
      let x = 60 + rand() * (W - 120);
      let y = H * (focus - 0.24) + rand() * H * 0.5;
      const points = [`${n(x)},${n(y)}`];
      for (let step = 0; step < 5; step += 1) {
        if (step % 2 === 0) {
          x += (rand() > 0.5 ? 1 : -1) * (110 + rand() * 240);
        } else {
          y += (rand() > 0.5 ? 1 : -1) * (110 + rand() * 220);
        }
        points.push(`${n(x)},${n(y)}`);
      }
      traces.push(
        `<polyline points="${points.join(" ")}" fill="none" stroke="${mix(accent, mid, rand() * 0.7)}" stroke-width="6" opacity="${n(0.45 + rand() * 0.5)}"/>`,
        `<circle cx="${n(x)}" cy="${n(y)}" r="13" fill="${accent}" opacity="0.95"/>`
      );
    }
    return { defs: radialGradient("g", mid, ground, focus, 0.6), body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${traces.join("")}` };
  }
  const currents = Array.from({ length: 26 }, (_, index) => {
    const y = -220 + index * 110 + rand() * 60;
    const sway = 220 + rand() * 280;
    return `<path d="M -100 ${n(y)} C ${n(W * 0.3)} ${n(y - sway)} ${n(W * 0.7)} ${n(y + sway)} ${W + 100} ${n(y)}" fill="none" stroke="${mix(mid, accent, rand())}" stroke-width="${n(18 + rand() * 48)}" opacity="${n(0.45 + rand() * 0.5)}" stroke-linecap="round"/>`;
  });
  return {
    defs: `${linearGradient("g", ground, mid, 0.45)}${blurFilter("soft", 14)}`,
    body: `<rect width="${W}" height="${H}" fill="url(#g)"/><g filter="url(#soft)">${currents.join("")}</g>`
  };
};

const horizon: Motif = ({ palette: [ground, mid, accent], options, rand, focus }) => {
  const variant = options.variant ?? "empty";
  const line = H * (focus + 0.3);
  const orbY = H * (focus - 0.06);
  const orbX = W * 0.6;
  const radius = variant === "moon" ? 300 : variant === "orb" ? 200 : 240;
  const sky = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${ground}"/><stop offset="62%" stop-color="${mid}"/><stop offset="100%" stop-color="${mix(mid, accent, 0.62)}"/></linearGradient>`;
  const parts = [`<rect width="${W}" height="${n(line)}" fill="url(#sky)"/>`];

  if (variant === "orb" || variant === "moon") {
    parts.push(
      `<circle cx="${n(orbX)}" cy="${n(orbY)}" r="${n(radius * 1.7)}" fill="${accent}" opacity="0.22" filter="url(#glow)"/>`,
      `<circle cx="${n(orbX)}" cy="${n(orbY)}" r="${radius}" fill="${accent}"/>`
    );
  }
  if (variant === "sun") {
    parts.push(
      `<circle cx="${n(W * 0.5)}" cy="${n(line)}" r="${n(radius * 2)}" fill="${accent}" opacity="0.3" filter="url(#glow)"/>`,
      `<path d="M ${n(W * 0.5 - radius)} ${n(line)} a ${radius} ${radius} 0 0 1 ${radius * 2} 0 Z" fill="${accent}"/>`
    );
    for (let index = 0; index < 6; index += 1) {
      parts.push(
        `<rect y="${n(line - 110 - index * 118)}" width="${W}" height="34" fill="${accent}" opacity="${n(0.44 - index * 0.06)}"/>`
      );
    }
  }
  if (variant === "empty") {
    // Nothing in the sky, so the light itself has to be the subject.
    parts.push(`<ellipse cx="${n(W * 0.5)}" cy="${n(line)}" rx="${n(W * 0.9)}" ry="260" fill="${accent}" opacity="0.4" filter="url(#glow)"/>`);
  }

  const ground_ =
    variant === "moon"
      ? `<path d="M 0 ${n(line + 70)} Q ${n(W * 0.5)} ${n(line - 190)} ${W} ${n(line + 70)} L ${W} ${H} L 0 ${H} Z" fill="${ground}"/>`
      : `<rect y="${n(line)}" width="${W}" height="${n(H - line)}" fill="${mix(ground, mid, 0.28)}"/>`;
  parts.push(ground_);

  if (variant === "orb") {
    // Painted after the water, or the water would cover the reflection.
    for (let index = 0; index < 18; index += 1) {
      const y = line + 24 + index * 34;
      const width = 300 - index * 11 + rand() * 110;
      parts.push(
        `<rect x="${n(orbX - width / 2)}" y="${n(y)}" width="${n(width)}" height="11" rx="5" fill="${accent}" opacity="${n(0.7 - index * 0.035)}"/>`
      );
    }
  }
  return { defs: `${sky}${blurFilter("glow", 88)}`, body: parts.join("") };
};

const silhouette: Motif = ({ palette: [ground, mid, accent], options, rand, focus }) => {
  const variant = options.variant ?? "forest";
  const sky = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${ground}"/><stop offset="55%" stop-color="${mid}"/><stop offset="100%" stop-color="${mix(mid, accent, 0.5)}"/></linearGradient>`;
  const backdrop = `<rect width="${W}" height="${H}" fill="url(#sky)"/>`;
  const glow = (cx: number, cy: number, r: number, opacity = 0.6) =>
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${accent}" opacity="${opacity}" filter="url(#glow)"/>`;
  const defs = `${sky}${blurFilter("glow", 108)}`;
  const base = H * (focus + 0.34);

  switch (variant) {
    case "tower": {
      const x = W * 0.56;
      return {
        defs,
        body: [
          backdrop,
          glow(x, H * (focus - 0.06), 460, 0.42),
          `<circle cx="${n(x + 210)}" cy="${n(H * (focus - 0.12))}" r="120" fill="${accent}" opacity="0.85"/>`,
          `<rect x="${n(x - 60)}" y="${n(base - 700)}" width="120" height="700" fill="${ground}"/>`,
          `<polygon points="${n(x - 108)},${n(base - 700)} ${n(x + 108)},${n(base - 700)} ${n(x)},${n(base - 880)}" fill="${ground}"/>`,
          `<path d="M 0 ${H} L 0 ${n(base + 120)} Q ${n(W * 0.32)} ${n(base - 110)} ${n(x)} ${n(base)} Q ${n(W * 0.86)} ${n(base + 90)} ${W} ${n(base - 40)} L ${W} ${H} Z" fill="${ground}"/>`
        ].join("")
      };
    }
    case "road": {
      const vanishing = H * focus;
      const marks = Array.from({ length: 9 }, (_, index) => {
        const t = (index + 1) / 10;
        const y = vanishing + (H - vanishing) * t * t;
        const width = 10 + t * 54;
        return `<rect x="${n(W / 2 - width / 2)}" y="${n(y)}" width="${n(width)}" height="${n(16 + t * 78)}" fill="${accent}" opacity="0.9"/>`;
      });
      return {
        defs,
        body: [
          backdrop,
          glow(W * 0.5, vanishing, 420, 0.55),
          `<rect y="${n(vanishing)}" width="${W}" height="${n(H - vanishing)}" fill="${ground}" opacity="0.42"/>`,
          `<polygon points="${n(W * 0.47)},${n(vanishing)} ${n(W * 0.53)},${n(vanishing)} ${n(W * 1.34)},${H} ${n(W * -0.34)},${H}" fill="${mix(ground, mid, 0.34)}"/>`,
          marks.join("")
        ].join("")
      };
    }
    case "forest": {
      const trees: string[] = [];
      for (let x = -60; x < W + 60; x += 62) {
        const height = 420 + rand() * 560;
        const top = base + 100 + rand() * 70;
        const half = 42 + rand() * 26;
        trees.push(`<polygon points="${n(x)},${n(top)} ${n(x + half)},${n(top - height)} ${n(x + half * 2)},${n(top)}" fill="${ground}"/>`);
      }
      return {
        defs,
        body: `${backdrop}${glow(W * 0.5, H * focus, 560, 0.4)}${trees.join("")}<rect y="${n(base + 150)}" width="${W}" height="${n(H)}" fill="${ground}"/>`
      };
    }
    case "city": {
      const buildings: string[] = [];
      const rain: string[] = [];
      for (let x = -40; x < W + 40; x += 116) {
        const height = 460 + rand() * 780;
        buildings.push(`<rect x="${n(x)}" y="${n(H - height)}" width="102" height="${n(height)}" fill="${ground}"/>`);
        for (let row = 0; row < Math.floor(height / 130); row += 1) {
          if (rand() > 0.42) {
            buildings.push(
              `<rect x="${n(x + 22 + (rand() > 0.5 ? 42 : 0))}" y="${n(H - height + 60 + row * 130)}" width="30" height="46" fill="${accent}" opacity="${n(0.45 + rand() * 0.5)}"/>`
            );
          }
        }
      }
      for (let index = 0; index < 170; index += 1) {
        rain.push(
          `<rect x="${n(rand() * W)}" y="${n(rand() * H)}" width="4" height="${n(50 + rand() * 110)}" fill="${accent}" opacity="0.2"/>`
        );
      }
      return { defs, body: `${backdrop}${glow(W * 0.34, H * focus, 420, 0.42)}${buildings.join("")}${rain.join("")}` };
    }
    case "lantern": {
      const columns: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const inset = 40 + index * 96;
        const height = H * (0.62 + index * 0.055);
        columns.push(
          `<rect x="${n(inset - 40)}" y="${n(H - height)}" width="${n(120 - index * 10)}" height="${n(height)}" fill="${ground}" opacity="${n(1 - index * 0.05)}"/>`,
          `<rect x="${n(W - inset - 80 + index * 10)}" y="${n(H - height)}" width="${n(120 - index * 10)}" height="${n(height)}" fill="${ground}" opacity="${n(1 - index * 0.05)}"/>`
        );
      }
      return {
        defs,
        body: [
          backdrop,
          glow(W * 0.5, H * focus, 480, 0.7),
          columns.join(""),
          `<circle cx="${n(W * 0.5)}" cy="${n(H * focus)}" r="64" fill="${accent}"/>`,
          `<rect y="${n(H * 0.9)}" width="${W}" height="${n(H * 0.1)}" fill="${ground}"/>`
        ].join("")
      };
    }
    case "doorway": {
      const top = H * (focus - 0.36);
      return {
        defs,
        body: [
          `<rect width="${W}" height="${H}" fill="${ground}"/>`,
          `<polygon points="${n(W * 0.32)},${n(top)} ${n(W * 0.62)},${n(top)} ${n(W * 0.9)},${H} ${n(W * 0.12)},${H}" fill="${accent}" opacity="0.26" filter="url(#glow)"/>`,
          `<polygon points="${n(W * 0.4)},${n(top)} ${n(W * 0.56)},${n(top)} ${n(W * 0.74)},${H} ${n(W * 0.28)},${H}" fill="${accent}" opacity="0.7"/>`,
          `<rect x="${n(W * 0.38)}" y="${n(top)}" width="16" height="${n(H * 0.62)}" fill="${mid}" opacity="0.7"/>`
        ].join("")
      };
    }
    case "lamp": {
      const post = W * 0.36;
      const head = H * (focus - 0.06);
      return {
        defs,
        body: [
          `<rect width="${W}" height="${H}" fill="${mix(ground, mid, 0.55)}"/>`,
          glow(post, head, 340, 0.8),
          `<rect x="${n(post - 10)}" y="${n(head)}" width="20" height="${n(H - head)}" fill="${ground}" opacity="0.92"/>`,
          `<rect x="${n(post - 46)}" y="${n(head - 34)}" width="92" height="58" rx="16" fill="${ground}" opacity="0.92"/>`,
          `<rect y="${n(head + 240)}" width="${W}" height="${n(H)}" fill="${mid}" opacity="0.6" filter="url(#glow)"/>`
        ].join("")
      };
    }
    case "arrow": {
      const cx = W * 0.5;
      const top = H * (focus - 0.16);
      const bottom = H * (focus + 0.34);
      return {
        defs,
        body: [
          backdrop,
          glow(cx, H * focus, 500, 0.32),
          `<polygon points="${n(cx)},${n(top)} ${n(cx + 320)},${n(top + 400)} ${n(cx + 132)},${n(top + 400)} ${n(cx + 132)},${n(bottom)} ${n(cx - 132)},${n(bottom)} ${n(cx - 132)},${n(top + 400)} ${n(cx - 320)},${n(top + 400)}" fill="${accent}"/>`
        ].join("")
      };
    }
    default: {
      // "window": light through a frame onto a plain wall.
      const width = W * 0.5;
      const height = H * 0.4;
      const x = (W - width) / 2;
      const y = H * (focus - 0.26);
      return {
        defs,
        body: [
          `<rect width="${W}" height="${H}" fill="${mix(ground, mid, 0.6)}"/>`,
          `<polygon points="${n(x)},${n(y + height)} ${n(x + width)},${n(y + height)} ${n(x + width * 1.44)},${H} ${n(x - width * 0.44)},${H}" fill="${accent}" opacity="0.5" filter="url(#glow)"/>`,
          `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" fill="${accent}" opacity="0.95"/>`,
          `<rect x="${n(x + width / 2 - 11)}" y="${n(y)}" width="22" height="${n(height)}" fill="${ground}"/>`,
          `<rect x="${n(x)}" y="${n(y + height / 2 - 11)}" width="${n(width)}" height="22" fill="${ground}"/>`,
          `<rect x="${n(x - 30)}" y="${n(y - 30)}" width="${n(width + 60)}" height="${n(height + 60)}" fill="none" stroke="${ground}" stroke-width="30"/>`
        ].join("")
      };
    }
  }
};

const scatter: Motif = ({ palette: [ground, mid, accent], options, rand, focus }) => {
  const variant = options.variant ?? "chips";
  const count = Math.round((options.density ?? 0.6) * 130) + 34;
  const marks: string[] = [];
  const gradient = linearGradient("g", ground, mid, 0.85);

  if (variant === "nodes") {
    const nodes = Array.from({ length: 48 }, () => ({ x: rand() * W, y: rand() * H }));
    for (const [index, node] of nodes.entries()) {
      const previous = nodes[index === 0 ? nodes.length - 1 : index - 1];
      if (previous && Math.hypot(node.x - previous.x, node.y - previous.y) < 640) {
        marks.push(
          `<line x1="${n(previous.x)}" y1="${n(previous.y)}" x2="${n(node.x)}" y2="${n(node.y)}" stroke="${accent}" stroke-width="4" opacity="0.45"/>`
        );
      }
      marks.push(`<circle cx="${n(node.x)}" cy="${n(node.y)}" r="${n(14 + rand() * 26)}" fill="${accent}" opacity="${n(0.55 + rand() * 0.45)}"/>`);
    }
    return { defs: gradient, body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${marks.join("")}` };
  }

  const chips = variant === "chips";
  for (let index = 0; index < count; index += 1) {
    const x = rand() * W;
    // Bias toward the focus band so the field is densest away from the type.
    const y = clamp(H * focus + (rand() - 0.5) * H * 1.15, 20, H - 20);
    const size = (chips ? 42 : 20) + rand() * (chips ? 74 : 52);
    const fill = rand() > 0.62 ? accent : rand() > 0.4 ? mid : mix(accent, mid, 0.5);
    const opacity = n(0.7 + rand() * 0.3);
    switch (variant) {
      case "petals":
        marks.push(
          `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(size)}" ry="${n(size * 0.42)}" fill="${fill}" opacity="${opacity}" transform="rotate(${n(rand() * 360)} ${n(x)} ${n(y)})"/>`
        );
        break;
      case "balloons":
        marks.push(
          `<path d="M ${n(x)} ${n(y + size)} Q ${n(x + size * 0.6)} ${n(y + size * 2.6)} ${n(x)} ${n(y + size * 4.2)}" fill="none" stroke="${accent}" stroke-width="4" opacity="0.5"/>`,
          `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(size * 0.84)}" ry="${n(size)}" fill="${fill}" opacity="${opacity}"/>`
        );
        break;
      case "stars":
        marks.push(
          `<path d="${starPath(x, y, size, size * 0.44)}" fill="${fill}" opacity="${opacity}" stroke="${fill}" stroke-width="${n(size * 0.28)}" stroke-linejoin="round"/>`
        );
        break;
      default:
        marks.push(
          `<rect x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size * 0.68)}" rx="${n(size * 0.22)}" fill="${fill}" opacity="${opacity}" transform="rotate(${n(rand() * 90)} ${n(x)} ${n(y)})"/>`
        );
    }
  }
  return { defs: gradient, body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${marks.join("")}` };
};

const halftone: Motif = ({ palette: [ground, mid, accent], options, focus }) => {
  const step = options.variant === "coarse" ? 96 : 66;
  const dots: string[] = [];
  for (let y = step / 2; y < H; y += step) {
    for (let x = step / 2; x < W; x += step) {
      // Densest at the focus band, fading away from it in both directions.
      const t = clamp(1 - Math.abs(y / H - focus) * 1.7, 0.04, 1);
      const radius = (step / 2 - 3) * t;
      if (radius > 1.5) {
        dots.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(radius)}" fill="${mix(mid, accent, t)}" opacity="${n(0.45 + t * 0.55)}"/>`);
      }
    }
  }
  return { defs: linearGradient("g", ground, mix(ground, mid, 0.75), 1), body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${dots.join("")}` };
};

const blocks: Motif = ({ palette: [ground, mid, accent], options, rand, focus }) => {
  const variant = options.variant ?? "stacked";
  const shapes: string[] = [];
  switch (variant) {
    case "tumbled":
      // Opaque and kept off the type band; translucent bricks read as a smudge.
      for (let index = 0; index < 12; index += 1) {
        const width = 250 + rand() * 240;
        const x = rand() * (W - width - 80) + 40;
        const y = clamp(H * focus + (rand() - 0.5) * H * 0.72, 60, H * (focus + 0.36));
        const fill = index % 3 === 0 ? accent : index % 3 === 1 ? mid : mix(accent, mid, 0.5);
        shapes.push(
          `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(width * (0.5 + rand() * 0.5))}" rx="30" fill="${fill}" transform="rotate(${n(-22 + rand() * 44)} ${n(x)} ${n(y)})"/>`
        );
      }
      break;
    case "ascending":
      for (let index = 0; index < 8; index += 1) {
        const height = 240 + index * 195;
        shapes.push(
          `<rect x="${n(118 + index * 200)}" y="${n(H - 190 - height)}" width="152" height="${n(height)}" rx="14" fill="${mix(mid, accent, index / 7)}"/>`
        );
      }
      break;
    case "panels":
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          const inset = 26;
          shapes.push(
            `<rect x="${n(column * (W / 2) + inset)}" y="${n(row * (H / 4) + inset)}" width="${n(W / 2 - inset * 2)}" height="${n(H / 4 - inset * 2)}" rx="6" fill="${mix(mid, accent, (row + column) % 2 === 0 ? 0.04 : 0.2)}" opacity="${n(0.6 + row * 0.12)}"/>`
          );
        }
      }
      shapes.push(`<rect y="${n(H * focus)}" width="${W}" height="16" fill="${accent}"/>`);
      break;
    case "stones": {
      const top = H * (focus - 0.3);
      for (let index = 0; index < 5; index += 1) {
        const x = index % 2 === 0 ? W * 0.34 : W * 0.66;
        const y = top + index * 290;
        shapes.push(
          `<ellipse cx="${n(x)}" cy="${n(y + 128)}" rx="300" ry="40" fill="${ground}" opacity="0.6"/>`,
          `<ellipse cx="${n(x)}" cy="${n(y + 60)}" rx="290" ry="88" fill="${mix(mid, accent, index / 5)}"/>`
        );
      }
      // Still water: closely ruled bands, so the stones sit on a surface.
      for (let index = 0; index < 26; index += 1) {
        shapes.unshift(
          `<rect y="${n(index * (H / 26))}" width="${W}" height="18" fill="${accent}" opacity="${n(0.1 + index * 0.012)}"/>`
        );
      }
      break;
    }
    default:
      for (let index = 0; index < 6; index += 1) {
        shapes.push(
          `<rect x="${n(150 + index * 54)}" y="${n(H * (focus - 0.3) + index * 210)}" width="${n(W - 340 - index * 60)}" height="180" rx="10" fill="${mix(mid, accent, index / 6)}"/>`
        );
      }
  }
  return { defs: linearGradient("g", ground, mix(ground, mid, 0.6), 1), body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${shapes.join("")}` };
};

const mesh: Motif = ({ palette: [ground, mid, accent], options, rand, focus }) => {
  const blobs = Array.from({ length: 8 }, (_, index) => {
    const cx = rand() * W;
    const cy = clamp(H * focus + (rand() - 0.5) * H * 0.9, 0, H);
    return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(430 + rand() * 440)}" fill="${index % 2 === 0 ? mid : accent}" opacity="${n(0.55 + rand() * 0.4)}"/>`;
  });
  const stars =
    options.variant === "nebula"
      ? Array.from({ length: 240 }, () =>
          `<circle cx="${n(rand() * W)}" cy="${n(rand() * H)}" r="${n(1.5 + rand() * 4)}" fill="#ffffff" opacity="${n(0.25 + rand() * 0.6)}"/>`
        ).join("")
      : "";
  return {
    defs: blurFilter("soft", 175),
    body: `<rect width="${W}" height="${H}" fill="${ground}"/><g filter="url(#soft)">${blobs.join("")}</g>${stars}`
  };
};

const contours: Motif = ({ palette: [ground, mid, accent], rand, focus }) => {
  const cx = W * 0.5;
  const cy = H * focus;
  const lines = Array.from({ length: 20 }, (_, index) => {
    const radius = 100 + index * 100;
    const points: string[] = [];
    for (let step = 0; step <= 52; step += 1) {
      const angle = (step / 52) * Math.PI * 2;
      const wobble = 1 + Math.sin(angle * 3 + index) * 0.12 + Math.cos(angle * 5 - index) * 0.08;
      points.push(`${n(cx + Math.cos(angle) * radius * wobble)},${n(cy + Math.sin(angle) * radius * wobble * 1.3)}`);
    }
    return `<polygon points="${points.join(" ")}" fill="none" stroke="${mix(accent, mid, index / 20)}" stroke-width="${n(5 + rand() * 4)}" opacity="${n(0.9 - index * 0.03)}"/>`;
  });
  return {
    defs: `${radialGradient("g", mid, ground, focus, 0.85)}${noiseFilter("noise", 0.8, 3, 13)}`,
    body: `<rect width="${W}" height="${H}" fill="url(#g)"/>${lines.join("")}<rect width="${W}" height="${H}" filter="url(#noise)" opacity="0.2"/>`
  };
};

const thread: Motif = ({ palette: [ground, mid, accent], rand, focus }) => {
  const points: Array<[number, number]> = [];
  for (let index = 0; index <= 9; index += 1) {
    points.push([170 + rand() * (W - 340), H * (focus - 0.32) + (index / 9) * H * 0.68]);
  }
  const path = points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${n(x)} ${n(y)}`).join(" ");
  const pins = points.map(([x, y]) => `<circle cx="${n(x)}" cy="${n(y)}" r="22" fill="${accent}"/>`).join("");
  return {
    defs: radialGradient("g", mid, ground, focus, 0.8),
    body: `<rect width="${W}" height="${H}" fill="url(#g)"/><path d="${path}" fill="none" stroke="${accent}" stroke-width="12" stroke-linejoin="round"/>${pins}`
  };
};

const MOTIFS: Record<CoverDesign["motif"], Motif> = {
  bands,
  wash,
  grain,
  arcs,
  rings,
  grid,
  swirl,
  horizon,
  silhouette,
  scatter,
  halftone,
  blocks,
  mesh,
  contours,
  thread
};

// --- helpers ----------------------------------------------------------------

function linearGradient(id: string, from: string, to: string, amount: number): string {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0.25" y2="1"><stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${mix(from, to, amount)}"/></linearGradient>`;
}

function radialGradient(id: string, from: string, to: string, focus: number, amount: number): string {
  return `<radialGradient id="${id}" cx="50%" cy="${n(focus * 100)}%" r="86%"><stop offset="0%" stop-color="${mix(to, from, amount)}"/><stop offset="100%" stop-color="${to}"/></radialGradient>`;
}

function blurFilter(id: string, deviation: number): string {
  return `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${deviation}"/></filter>`;
}

function noiseFilter(id: string, frequency: number, octaves: number, seed: number): string {
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`;
}

function starPath(cx: number, cy: number, outer: number, inner: number): string {
  const points: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = (Math.PI / 5) * index - Math.PI / 2;
    points.push(`${n(cx + Math.cos(angle) * radius)},${n(cy + Math.sin(angle) * radius)}`);
  }
  return `M ${points.join(" L ")} Z`;
}

/** Keeps the serialized SVG small; a tenth of a pixel is invisible at 1800px. */
function n(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The candidate whose luminance is furthest from `base`. */
function contrastingColor(base: string, ...candidates: string[]): string {
  const target = luminance(base);
  return candidates.reduce((best, candidate) =>
    Math.abs(luminance(candidate) - target) > Math.abs(luminance(best) - target) ? candidate : best
  ) as string;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mix(from: string, to: string, amount: number): string {
  const t = clamp(amount, 0, 1);
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  return `#${channel(r1, r2, t)}${channel(g1, g2, t)}${channel(b1, b2, t)}`;
}

function channel(from: number, to: number, t: number): string {
  return Math.round(from + (to - from) * t)
    .toString(16)
    .padStart(2, "0");
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? `${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}` : value;
  return [
    Number.parseInt(full.slice(0, 2), 16) || 0,
    Number.parseInt(full.slice(2, 4), 16) || 0,
    Number.parseInt(full.slice(4, 6), 16) || 0
  ];
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
