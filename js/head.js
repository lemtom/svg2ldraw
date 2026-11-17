'use strict';

/*
  Minifig head (3626-style, radius 13) pipeline.

  The head surface is modelled like LDraw's own primitives: 16 facets of 22.5 degrees around, and a ring profile
  from top to bottom (rounded top edge, straight wall y 4..17, rounded bottom edge). Every facet cell is a flat
  trapezoid. A face is drawn on a flat template ("unwrapped" head): U runs across the facets, V runs along the
  surface profile (arc length). Shapes are decomposed (holes, overlaps, base-colour fill) in that flat frame, clipped
  to the cells, and mapped onto the cells. Each polygon lies in the plane of its cell: no floating, no z-fighting.

  Three modes:
    'one'        one face on the front: 4 facets (90 degrees), wall only by default.
    'two'        front and back faces: 6 facets (135 degrees) each, the sides keep their normal parts.
    'continuous' one pattern that wraps around the full circle: 16 facets (seam at the back).
 */
var HEAD = {};

HEAD.FACET_DEG = 22.5;
HEAD.R_WALL = 13;
HEAD.FACET_W = 2 * HEAD.R_WALL * Math.sin(HEAD.FACET_DEG / 2 * Math.PI / 180); // Chord width at the wall.
HEAD.PX_PER_LDU = 10;
HEAD.BASE = 'BASE_COLOUR';

// (radius, y) of the 10 rings from top to bottom, as in the LDraw torus primitives.
HEAD.RINGS = [[8.0, 0.0], [9.9136, 0.3046], [11.5352, 1.1718], [12.6192, 2.4691], [13.0, 4.0],
[13.0, 17.0], [12.6192, 18.5309], [11.5352, 19.8282], [9.9136, 20.6954], [8.0, 21.0]];

HEAD.MODES = {
  one: { label: 'One-sided face', facets: 4, defaultBand: 'wall', rimExtra: 2, faces: [{ name: 'Face', center: 0 }] },
  two: { label: 'Two-sided face', facets: 6, defaultBand: 'full', faces: [{ name: 'Front', center: 0 }, { name: 'Back', center: 180 }] },
  continuous: { label: 'Continuous pattern', facets: 16, defaultBand: 'full', faces: [{ name: 'Pattern', center: 0 }] }
};

/*
  Base parts per mode: everything that is NOT printed. The 'continuous' preset assumes s\3626bs02.dat alone is enough when
  every facet is printed.
 */
/*
  One-sided preset, split into parts, because which rim pieces remain depends on the band:
    - the two quarter torus pieces per rim (t04o6250) cover the whole FRONT half (90 degrees to each side of the face);
    - the two 1-8cyli pieces cover the wall from 45 to 90 degrees on each side.
  When the print band includes a rim (see HEAD.band), the converter prints that rim itself over the full front half
  (the face in the middle 90 degrees, plain base colour for the 45 degrees on each side), so the matching two torus
  pieces must NOT be in the base lines, or the surfaces would be doubled.
 */
HEAD.BASE_ONE = {
  common:
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3626bs02.dat\n' +
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3626bs04.dat\n',
  top:
    '1 16 0 4 0 0 0 -8 0 -6.4 0 -8 0 0 t04o6250.dat\n' +
    '1 16 0 4 0 8 0 0 0 -6.4 0 0 0 -8 t04o6250.dat\n',
  bottom:
    '1 16 0 17 0 0 0 8 0 6.4 0 -8 0 0 t04o6250.dat\n' +
    '1 16 0 17 0 -8 0 0 0 6.4 0 0 0 -8 t04o6250.dat\n',
  wall:
    '1 16 0 4 0 13 0 0 0 13 0 0 0 -13 1-8cyli.dat\n' +
    '1 16 0 4 0 -13 0 0 0 13 0 0 0 -13 1-8cyli.dat\n'
};

/* Base lines for a mode and band. */
HEAD.baseLines = function (mode, band) {
  if (mode !== 'one') return HEAD.BASE_LINES[mode];
  var b = HEAD.band(band), B = HEAD.BASE_ONE;
  return B.common + (b.hasTop ? '' : B.top) + (b.hasBottom ? '' : B.bottom) + B.wall;
}

HEAD.BASE_LINES = {
  one: '', // Depends on the band: use HEAD.baseLines('one', band).
  two:
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3626bs02.dat\n' +
    '1 16 0 4 0 8 0 0 0 -6.4 0 0 0 -8 t04o6250.dat\n' +
    '1 16 0 4 0 8 0 0 0 -6.4 0 0 0 8 t08o6250.dat\n' +
    '1 16 0 4 0 -8 0 0 0 -6.4 0 0 0 8 t04o6250.dat\n' +
    '1 16 0 4 0 -8 0 0 0 -6.4 0 0 0 -8 t08o6250.dat\n' +
    '1 16 0 4 0 12.01043 0 4.97488 0 13 0 -4.97488 0 12.01043 1-8cyli.dat\n' +
    '1 16 0 4 0 -12.01043 0 -4.97488 0 13 0 4.97488 0 -12.01043 1-8cyli.dat\n' +
    '1 16 0 17 0 7.39104 0 3.06147 0 6.4 0 3.06147 0 -7.39104 t04o6250.dat\n' +
    '1 16 0 17 0 7.39104 0 -3.06147 0 6.4 0 3.06147 0 7.39104 t08o6250.dat\n' +
    '1 16 0 17 0 -7.39104 0 -3.06147 0 6.4 0 -3.06147 0 7.39104 t04o6250.dat\n' +
    '1 16 0 17 0 -7.39104 0 3.06147 0 6.4 0 -3.06147 0 -7.39104 t08o6250.dat\n',
  continuous:
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3626bs02.dat\n'
};

/* Ring indices and cumulative profile arc length for the chosen band ('wall' = y 4..17, 'full' = y 0..21). */
HEAD.band = function (band) {
  // 'wall' = y 4..17; 'top' adds the rounded top (y 0..17); 'bottom' adds the rounded bottom (y 4..21); 'full' = y 0..21.
  // The frame always starts at the first ring of the band, so with 'bottom' the wall keeps its position at the top of
  // the template and the extra height is added below it.
  var rings = { wall: [4, 5], top: [0, 1, 2, 3, 4, 5], bottom: [4, 5, 6, 7, 8, 9] }[band] || [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  var S = [0];
  for (var k = 1; k < rings.length; k++) {
    var a = HEAD.RINGS[rings[k - 1]], b = HEAD.RINGS[rings[k]];
    S.push(S[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { rings: rings, S: S, H: S[S.length - 1], hasTop: rings[0] < 4, hasBottom: rings[rings.length - 1] > 5 };
}

/* A row (between rings[k] and rings[k+1]) is a rim row when it lies on the rounded top or bottom. */
HEAD.isRimRow = function (b, k) { return b.rings[k + 1] <= 4 || b.rings[k] >= 5; }

HEAD.frame = function (mode, band) {
  var b = HEAD.band(band);
  return { W: HEAD.MODES[mode].facets * HEAD.FACET_W, H: b.H };
}

/* Template SVG for a mode and band (10 px = 1 LDU). Guides are on a locked layer and ignored when converting. */
HEAD.templateSvg = function (mode, band) {
  var f = HEAD.frame(mode, band), s = HEAD.PX_PER_LDU, m = HEAD.MODES[mode];
  var w = +(f.W * s).toFixed(2), h = +(f.H * s).toFixed(2), b = HEAD.band(band);
  var g = '    <rect id="head-frame" x="0" y="0" width="' + w + '" height="' + h + '" fill="none" stroke="#e00000" stroke-width="1.5" stroke-dasharray="8 4"/>\n';
  for (var i = 1; i < m.facets; i++) { // Facet borders.
    var x = +(i * HEAD.FACET_W * s).toFixed(2);
    g += '    <path d="M' + x + ' 0 V' + h + '" fill="none" stroke="#e08080" stroke-width="0.7" stroke-dasharray="2 6"/>\n';
  }
  for (var k = 1; k < b.rings.length - 1; k++) { // Ring borders (edges of the rounded parts, wall edges).
    var y = +(b.S[k] * s).toFixed(2);
    g += '    <path d="M0 ' + y + ' H' + w + '" fill="none" stroke="#80a0e0" stroke-width="0.7" stroke-dasharray="2 6"/>\n';
  }
  g += '    <path d="M' + (w / 2) + ' 0 V' + h + '" fill="none" stroke="#0080ff" stroke-width="1" stroke-dasharray="3 6"/>\n';
  var note = mode === 'continuous' ? 'Centre line = front; the left and right edges meet at the back (seam).' :
    mode === 'two' ? 'Draw the front and the back in two files from this template. The back is drawn as seen from behind.' :
      'Centre line = middle of the face.';
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n' +
    '     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"\n' +
    '     width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">\n' +
    '  <!-- Minifig head template (' + m.label + ', band ' + band + '): ' + m.facets + ' facets, 10 px = 1 LDU.\n' +
    '       ' + note + '\n' +
    '       Draw FILLED flat-colour shapes on the "Print" layer. Convert strokes and text to paths.\n' +
    '       Anything you leave empty becomes the base colour. -->\n' +
    '  <g id="head-guide" inkscape:groupmode="layer" inkscape:label="Guide (not printed, locked)" sodipodi:insensitive="true">\n' + g +
    '  </g>\n' +
    '  <g id="print" inkscape:groupmode="layer" inkscape:label="Print (draw here)">\n  </g>\n</svg>\n';
}

HEAD.stripGuides = function (svg) {
  var doomed = [];
  svg.querySelectorAll('*').forEach(function (e) {
    var id = e.getAttribute('id') || '';
    if (id === 'head-guide' || id === 'head-frame' || e.nodeName === 'sodipodi:namedview' || e.nodeName === 'title' || e.nodeName === 'desc')
      doomed.push(e);
  });
  doomed.forEach(e => { if (e.parentNode) e.parentNode.removeChild(e); });
}

HEAD.rect = function (W, H) { // Right-turning rectangle (negative signed area) in (x right, y down).
  return [new UTIL.Point(0, 0), new UTIL.Point(0, H), new UTIL.Point(W, H), new UTIL.Point(W, 0)];
}

/* Converts one face SVG into convex polygons in the flat frame. Returns {hulls:[{pts,lDrawColor,hex}], W, H}. */
HEAD.convert = function (svgText, frame, o) {
  var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  var svg = doc.documentElement;
  if (svg?.nodeName !== 'svg' || doc.querySelector('parsererror')) { o.onError('This is not a valid SVG file.'); return null; }
  HEAD.stripGuides(svg);

  var simplifier = new UTIL.PathSimplification(o.pointsPer100px / 100, o.onWarning, o.onError);
  var simplified = simplifier.simplifySvgDom(svg);
  if (!simplified) return null;

  // Map the SVG frame onto the flat head frame (LDU):
  var sx = frame.W / simplified.width, sy = frame.H / simplified.height;
  var seen = new Set();
  var mapPt = function (p) { if (!seen.has(p)) { seen.add(p); p.x *= sx; p.y *= sy; } };
  simplified.paths.forEach(path => { path.pts.forEach(mapPt); path.holes.forEach(h => h.forEach(mapPt)); });

  // The whole frame is the bottom-most shape in the base colour; everything above cuts it.
  var fill = new UTIL.Path(HEAD.rect(frame.W, frame.H), HEAD.BASE);
  var result = SVG2LDRAW.decompose({
    paths: [fill].concat(simplified.paths), width: frame.W, height: frame.H,
    viewBox: simplified.viewBox
  }, o.onWarning);
  return HEAD.finish(result.paths, frame, o);
}

HEAD.emptyFace = function (frame, o) {
  return HEAD.finish([{ pts: HEAD.rect(frame.W, frame.H), color: HEAD.BASE }], frame, o);
}

HEAD.finish = function (paths, frame, o) {
  var frameRing = HEAD.rect(frame.W, frame.H), hulls = [];
  paths.forEach(function (path) {
    var ring = TORSO.clipConvex(path.pts, frameRing); // Art outside the frame is dropped.
    ring = UTIL.cleanRing(ring);
    if (!ring) return;
    if (UTIL.signedArea(ring) > 0) ring.reverse();
    var id, hex;
    if (path.color === HEAD.BASE) { id = o.baseId; hex = o.baseHex; }
    else { var m = o.colorTransformation.transform(path.color, o.onColorMapped); id = m.id; hex = m.hex; }
    hulls.push({ pts: ring, lDrawColor: id, hex: hex });
  });
  return { hulls: hulls, W: frame.W, H: frame.H };
}

HEAD.ringPoint = function (j, aDeg) { // 0 degrees = front (-Z), positive towards +X.
  var r = HEAD.RINGS[j][0], y = HEAD.RINGS[j][1], a = aDeg * Math.PI / 180;
  return [r * Math.sin(a), y, -r * Math.cos(a)];
}
HEAD.lerp = function (p, q, t) { return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]; }

/*
  Maps the flat polygons of one face onto the facet cells. Returns 3D polygons [{pts:[[x,y,z]...], color}].
  Winding is made counter-clockwise as seen from outside (outward normal).
 */
HEAD.mapFace = function (face, nFacets, aCenter, band, rimExtra, baseId) {
  var b = HEAD.band(band), out = [];
  var first = aCenter - nFacets * HEAD.FACET_DEG / 2;
  rimExtra = rimExtra || 0;
  // Facets outside the printed window (i < 0 or i >= nFacets) are only generated for rim rows, in the base colour.
  for (var i = -rimExtra; i < nFacets + rimExtra; i++) {
    var outside = i < 0 || i >= nFacets;
    var a0 = first + i * HEAD.FACET_DEG, a1 = a0 + HEAD.FACET_DEG, U0 = i * HEAD.FACET_W, U1 = U0 + HEAD.FACET_W;
    for (var k = 0; k < b.rings.length - 1; k++) {
      if (outside && !HEAD.isRimRow(b, k)) continue;
      var ja = b.rings[k], jb = b.rings[k + 1], V0 = b.S[k], V1 = b.S[k + 1];
      var A0 = HEAD.ringPoint(ja, a0), A1 = HEAD.ringPoint(ja, a1), B0 = HEAD.ringPoint(jb, a0), B1 = HEAD.ringPoint(jb, a1);
      var cell = [new UTIL.Point(U0, V0), new UTIL.Point(U0, V1), new UTIL.Point(U1, V1), new UTIL.Point(U1, V0)];
      var cellHulls = outside ? [{ pts: cell, lDrawColor: baseId }] : face.hulls;
      cellHulls.forEach(function (h) {
        var ring = UTIL.cleanRing(TORSO.clipConvex(h.pts, cell));
        if (!ring) return;
        var pts = ring.map(function (p) {
          var s = (p.x - U0) / HEAD.FACET_W, t = (p.y - V0) / (V1 - V0);
          return HEAD.lerp(HEAD.lerp(A0, A1, s), HEAD.lerp(B0, B1, s), t);
        });
        // Newell normal; reverse if it points inwards (towards the head axis).
        var n = [0, 0, 0], c = [0, 0, 0];
        for (var m = 0; m < pts.length; m++) {
          var p = pts[m], q = pts[(m + 1) % pts.length];
          n[0] += (p[1] - q[1]) * (p[2] + q[2]); n[1] += (p[2] - q[2]) * (p[0] + q[0]); n[2] += (p[0] - q[0]) * (p[1] + q[1]);
          c[0] += p[0]; c[2] += p[2];
        }
        if (Math.hypot(n[0], n[1], n[2]) < 1e-6) return; // Sliver.
        if (n[0] * c[0] + n[2] * c[2] < 0) pts.reverse();
        out.push({ pts: pts, color: h.lDrawColor });
      });
    }
  }
  return out;
}

/* Conditional lines on every facet border (meridian) of a face, for each ring cell, like LDraw's primitives. */
HEAD.conditionalLines = function (nFacets, aCenter, band, closed, rimExtra) {
  var b = HEAD.band(band), first = aCenter - nFacets * HEAD.FACET_DEG / 2, lines = [];
  rimExtra = rimExtra || 0;
  var n = closed ? nFacets : nFacets + 1; // A closed (full circle) pattern has no extra meridian.
  function f(p) { return p.map(x => String(parseFloat(x.toFixed(4)))).join(' '); }
  for (var m = -rimExtra; m < n + rimExtra; m++) {
    var a = first + m * HEAD.FACET_DEG;
    for (var k = 0; k < b.rings.length - 1; k++) {
      if ((m < 0 || m >= n) && !HEAD.isRimRow(b, k)) continue; // Outside the printed window: rim rows only.
      var ja = b.rings[k], jb = b.rings[k + 1];
      lines.push('5 24 ' + f(HEAD.ringPoint(ja, a)) + ' ' + f(HEAD.ringPoint(jb, a)) + ' ' +
        f(HEAD.ringPoint(ja, a - HEAD.FACET_DEG)) + ' ' + f(HEAD.ringPoint(ja, a + HEAD.FACET_DEG)));
    }
  }
  return lines;
}

HEAD.toLDraw = function (o) { // o: {mode, band, faces:[face...], name, description, baseLines}
  var m = HEAD.MODES[o.mode];
  LDCLEAN.reset();
  function num(x) { return String(parseFloat(x.toFixed(4))); }
  var ret = '0 ' + o.description + '\n0 Name: ' + o.name + '\n0 Author: svg2ldraw\n' +
    '0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt\n0 BFC CERTIFY CCW\n\n' +
    o.baseLines.trim() + '\n';
  function emit(pts, color) {
    // LDCLEAN splits the convex polygon into valid triangles/quads (no collinear vertices, no slivers).
    LDCLEAN.split(pts, 4).forEach(poly =>
      ret += poly.length + ' ' + color + ' ' + poly.map(p => p.map(num).join(' ')).join(' ') + '\n');
  }
  var cond = [];
  m.faces.forEach(function (fd, idx) {
    ret += '\n0 // ' + fd.name + '\n';
    HEAD.mapFace(o.faces[idx], m.facets, fd.center, o.band, m.rimExtra, o.baseId).forEach(poly => emit(poly.pts, poly.color));
    cond = cond.concat(HEAD.conditionalLines(m.facets, fd.center, o.band, m.facets === 16, m.rimExtra));
  });
  ret += '\n0 // Conditional Lines\n' + cond.join('\n') + '\n';
  return ret;
}
