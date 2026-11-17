'use strict';

/*
  Torso pipeline.

  A torso front is a fixed shape, so instead of centring and scaling a drawing freely, the SVG is drawn on a TEMPLATE
  whose frame has fixed proportions. The frame maps 1:1 onto the front face of s\973s01.dat:
     x: -19 .. 19 LDU, y: 0 .. 32 LDU, plane z = -10 (viewed from -Z, X right, Y down).
  The output is a part that references the torso body (s\973s01.dat) and adds the front plate:
  the print shapes, plus the remaining outline area filled in the base colour (16), cut so nothing overlaps.
 */
var TORSO = {};

TORSO.Z = -10;                 // The front face plane of s\973s01.dat.
TORSO.FRAME = { x: -19, y: 0, w: 38, h: 32 }; // Front face bounding box in LDU.
TORSO.PX_PER_LDU = 10;         // Template scale: 380 x 320 px.
TORSO.BASE = 'BASE_COLOUR';    // Sentinel 'colour' of the fill shape.

// The torso front outline in LDU, as read from the torso base file (quads at y 0-2, 2-29 and 29-32).
TORSO.OUTLINE = [[-12, 0], [12, 0], [14.345, 2], [19, 29], [19, 32], [-19, 32], [-19, 29], [-14.345, 2]];

/*
  The downloadable template. Guides sit on a locked Inkscape layer and are drawn with fill="none", which
  svg2ldraw ignores. The converter additionally removes the guide layer by its id. The converter expects the
  template: its frame (whatever its pixel size) is mapped onto the 38 x 32 LDU front face.
 */
TORSO.templateSvg = function () {
  var s = TORSO.PX_PER_LDU, F = TORSO.FRAME;
  var d = TORSO.OUTLINE.map((p, i) => (i === 0 ? 'M' : 'L') + ((p[0] - F.x) * s) + ' ' + ((p[1] - F.y) * s)).join(' ') + ' Z';
  var w = F.w * s, h = F.h * s;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n' +
    '     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"\n' +
    '     width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">\n' +
    '  <!-- Minifig torso front template: 10 px = 1 LDU (38 x 32 LDU).\n' +
    '       Draw on the "Print" layer with FILLED shapes in flat colours. Convert strokes and text to paths\n' +
    '       (Path > Stroke to Path / Object to Path). Anything outside the red outline is clipped.\n' +
    '       Everything inside the outline that you do not cover becomes the base colour of the torso. -->\n' +
    '  <g id="torso-guide" inkscape:groupmode="layer" inkscape:label="Guide (not printed, locked)" sodipodi:insensitive="true">\n' +
    '    <path id="torso-outline" d="' + d + '" fill="none" stroke="#e00000" stroke-width="1.5" stroke-dasharray="8 4"/>\n' +
    '    <path id="torso-centre" d="M' + (w / 2) + ' 0 V' + h + '" fill="none" stroke="#0080ff" stroke-width="1" stroke-dasharray="3 6"/>\n' +
    '  </g>\n' +
    '  <g id="print" inkscape:groupmode="layer" inkscape:label="Print (draw here)">\n' +
    '  </g>\n' +
    '</svg>\n';
}

/* Removes elements that must not be converted: guides and editor metadata. Works on the parsed DOM. */
TORSO.stripGuides = function (svg) {
  var doomed = [];
  svg.querySelectorAll('*').forEach(function (e) {
    var id = e.getAttribute('id') || '';
    if (id === 'torso-guide' || id === 'torso-outline' ||
      e.nodeName === 'sodipodi:namedview' || e.nodeName === 'title' || e.nodeName === 'desc') {
      doomed.push(e);
    }
  });
  doomed.forEach(e => { if (e.parentNode) e.parentNode.removeChild(e); });
}

/*
  Clips a ring against a CONVEX clip ring (Sutherland-Hodgman). Both must be right-turning (negative UTIL.signedArea).
  The convex pieces from the decomposition stay convex, so no further decomposition is needed.
 */
TORSO.clipConvex = function (subject, clip) {
  var out = subject;
  for (var i = 0; i < clip.length && out.length > 0; i++) {
    var a = clip[i], b = clip[(i + 1) % clip.length];
    var inside = p => UTIL.getTurn(a, b, p) <= UTIL.EPSILON; // Interior is on the right of a->b.
    var input = out;
    out = [];
    for (var j = 0; j < input.length; j++) {
      var cur = input[j], prev = input[(j + input.length - 1) % input.length];
      var curIn = inside(cur), prevIn = inside(prev);
      if (curIn !== prevIn) { // The edge prev->cur crosses the clip line: add the crossing.
        var tp = UTIL.getTurn(a, b, prev), tc = UTIL.getTurn(a, b, cur);
        var t = tp / (tp - tc);
        out.push(new UTIL.Point(prev.x + t * (cur.x - prev.x), prev.y + t * (cur.y - prev.y)));
      }
      if (curIn) out.push(cur);
    }
  }
  return out;
}

/*
  Full conversion. Returns {hulls:[{pts, lDrawColor, hex, svgColor}], ...}; points are in LDU on the front face.
  options: {pointsPer100px, colorTransformation, onWarning, onError, onColorMapped, baseId, baseHex}
 */
TORSO.convert = function (svgText, o) {
  var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  var svg = doc.documentElement;
  if (!svg || svg.nodeName !== 'svg' || doc.querySelector('parsererror')) {
    o.onError('This is not a valid SVG file.');
    return null;
  }
  TORSO.stripGuides(svg);

  var simplifier = new UTIL.PathSimplification(o.pointsPer100px / 100, o.onWarning, o.onError);
  var simplified = simplifier.simplifySvgDom(svg);
  if (!simplified) return null;

  // Map the SVG frame (0..width, 0..height) onto the torso front face in LDU:
  var F = TORSO.FRAME, sx = F.w / simplified.width, sy = F.h / simplified.height;
  var seen = new Set();
  var mapPt = function (p) { if (!seen.has(p)) { seen.add(p); p.x = F.x + p.x * sx; p.y = F.y + p.y * sy; } };
  simplified.paths.forEach(path => { path.pts.forEach(mapPt); path.holes.forEach(h => h.forEach(mapPt)); });

  // The outline (right-turning) is the bottom-most shape, filled with the base colour.
  var outline = TORSO.OUTLINE.map(p => new UTIL.Point(p[0], p[1]));
  if (UTIL.signedArea(outline) > 0) outline.reverse();
  var fill = new UTIL.Path(outline.map(p => p.clone()), TORSO.BASE);

  // Paths are processed from the end (top-most) to the start, so the fill goes first in the list.
  var input = { paths: [fill].concat(simplified.paths), width: F.w, height: F.h, viewBox: simplified.viewBox };
  var result = SVG2LDRAW.decompose(input, o.onWarning);

  var ct = o.colorTransformation, hulls = [];
  result.paths.forEach(function (path) {
    // Clip to the outline (prints that stick out), round to the output precision, drop slivers.
    var ring = TORSO.clipConvex(path.pts, outline).map(p => new UTIL.Point(
      Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000));
    ring = UTIL.cleanRing(ring);
    if (!ring) return;
    if (UTIL.signedArea(ring) > 0) ring.reverse(); // Keep right-turning = facing -Z.
    var id, hex;
    if (path.color === TORSO.BASE) { id = o.baseId; hex = o.baseHex; }
    else {
      var m = ct.transform(path.color, o.onColorMapped);
      id = m.id; hex = m.hex;
    }
    hulls.push({ pts: ring, lDrawColor: id, hex: hex, svgColor: path.color });
  });
  return { hulls: hulls, outline: outline };
}

/*
  A plain base-colour face: the outline as one convex polygon. Used when no print SVG is given.
 */
TORSO.emptyFace = function (o) {
  var outline = TORSO.OUTLINE.map(p => new UTIL.Point(p[0], p[1]));
  if (UTIL.signedArea(outline) > 0) outline.reverse();
  return { hulls: [{ pts: outline.map(p => p.clone()), lDrawColor: o.baseId, hex: o.baseHex, svgColor: TORSO.BASE }], outline: outline };
}

/*
  Writes the LDraw part: header, the torso body as subpart, then the front plate at z = -10 and the back plate at z = +10.
  Both faces are converted in the same local frame (template, x right, y down). The back template is drawn as seen
  from BEHIND, so on the back plate local x is mirrored (X = -x). That mirroring also flips the polygon winding,
  which makes the back polygons face +Z (towards a viewer behind the torso), as required.
 */
TORSO.toLDraw = function (frontHulls, backHulls, name, description, subpart) {
  function num(x) { return String(parseFloat(x.toFixed(3))); }
  LDCLEAN.reset();
  var ret = '0 ' + description + '\n0 Name: ' + name + '\n0 Author: svg2ldraw\n' +
    '0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt\n0 BFC CERTIFY CCW\n\n' +
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 ' + subpart + '\n';
  function out(pts, color, back) {
    // LDCLEAN splits the convex polygon into valid triangles/quads (no collinear vertices, no slivers).
    var pts3 = pts.map(p => [back ? -p.x : p.x, p.y, back ? -TORSO.Z : TORSO.Z]);
    LDCLEAN.split(pts3, 3).forEach(poly =>
      ret += poly.length + ' ' + color + ' ' + poly.map(p => p.map(num).join(' ')).join(' ') + '\n');
  }
  // The neck mark (a cylinder piece at the neck opening), found missing when checking in LD Part Editor.
  ret += '\n0 // Neck mark\n1 16 0 -4 0 4.243 0 -4.243 0 -8 0 -4.243 0 -4.243 1-4cyli.dat\n';
  ret += '\n0 // front\n';
  frontHulls.forEach(h => out(h.pts, h.lDrawColor, false));
  ret += '\n0 // back\n';
  backHulls.forEach(h => out(h.pts, h.lDrawColor, true));
  return ret;
}
