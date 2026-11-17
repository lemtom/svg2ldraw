'use strict';

/*
  Printed tile pipeline.

  A tile top is a flat rectangle at Y = 0, seen from above. The SVG template is the full tile footprint
  (10 px = 1 LDU, so a 1x1 tile is 200 x 200 px). The mapping to LDraw is:
     SVG x  ->  LDraw X  (centred, right)
     SVG y  ->  LDraw -Z (centred; "up" on the template is +Z, which is "up" in a top view of LDraw)
  The tile body is a subpart (s\3070bs01.dat, ...) that is referenced as is. The output adds the top face:
  the print shapes plus all remaining area of the face in the base colour (16), cut so nothing overlaps.

  Winding: every polygon is checked with the Newell normal and flipped if needed, so that it faces up (-Y).
 */
var TILE = {};

TILE.PX_PER_LDU = 10;
TILE.BASE = 'BASE_COLOUR';
TILE.STUD = 20;

/*
  Presets. w/d are in studs (w along X, d along Z). 'print' is the printable region in LDU as half-extents
  (the whole footprint when omitted; no preset uses it now, a rim seen in some official parts is pattern-specific).
  'baseLines' are the fixed LDraw lines that are copied into the output: the body subpart.
 */
TILE.PRESETS = {
    '1x1': {w:1, d:1, name:'3070bpXX.dat', desc:'Tile 1 x 1 with Custom Pattern',
            baseLines: '1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3070bs01.dat\n'},
    '1x2': {w:2, d:1, name:'3069bpXX.dat', desc:'Tile 1 x 2 with Custom Pattern',
            baseLines: '1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3069bs01.dat\n'},
    '2x2': {w:2, d:2, name:'3068bpXX.dat', desc:'Tile 2 x 2 with Custom Pattern',
            baseLines: '1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3068bs01.dat\n'},
    'custom': {w:1, d:4, name:'tilepXX.dat', desc:'Tile with Custom Pattern', baseLines: ''}
};

/* Geometry of a configuration: footprint (hx, hz half-extents in LDU) and printable half-extents. */
TILE.geometry = function(w, d, print) {
    var hx = w*TILE.STUD/2, hz = d*TILE.STUD/2;
    return {hx:hx, hz:hz, px:print ? print.x : hx, pz:print ? print.z : hz};
}

/* Downloadable template: footprint 'tile-outline', printable area 'tile-print-area' (both guides, fill="none"). */
TILE.templateSvg = function(w, d, print) {
    var g = TILE.geometry(w, d, print), s = TILE.PX_PER_LDU;
    var W = g.hx*2*s, H = g.hz*2*s;
    var inner = (g.px < g.hx || g.pz < g.hz) ?
'    <rect id="tile-print-area" x="' + ((g.hx-g.px)*s) + '" y="' + ((g.hz-g.pz)*s) + '" width="' + (g.px*2*s) + '" height="' + (g.pz*2*s) + '" fill="none" stroke="#e00000" stroke-width="1.5" stroke-dasharray="8 4"/>\n' : '';
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n' +
'     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"\n' +
'     width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">\n' +
'  <!-- Tile top template: 10 px = 1 LDU (' + (g.hx*2) + ' x ' + (g.hz*2) + ' LDU), seen from above.\n' +
'       Draw on the "Print" layer with FILLED shapes in flat colours. Convert strokes and text to paths.\n' +
'       Anything outside the red area is clipped; whatever you do not cover becomes the base colour. -->\n' +
'  <g id="tile-guide" inkscape:groupmode="layer" inkscape:label="Guide (not printed, locked)" sodipodi:insensitive="true">\n' +
'    <rect id="tile-outline" x="0" y="0" width="' + W + '" height="' + H + '" fill="none" stroke="#808080" stroke-width="1"/>\n' + inner +
'    <path id="tile-centre" d="M' + (W/2) + ' 0 V' + H + ' M0 ' + (H/2) + ' H' + W + '" fill="none" stroke="#0080ff" stroke-width="1" stroke-dasharray="3 6"/>\n' +
'  </g>\n' +
'  <g id="print" inkscape:groupmode="layer" inkscape:label="Print (draw here)">\n' +
'  </g>\n' +
'</svg>\n';
}

TILE.stripGuides = function(svg) {
    var doomed = [];
    svg.querySelectorAll('*').forEach(function(e) {
        var id = e.getAttribute('id') || '';
        if(id === 'tile-guide' || id === 'tile-outline' || id === 'tile-print-area' || id === 'tile-centre' ||
           e.nodeName === 'sodipodi:namedview' || e.nodeName === 'title' || e.nodeName === 'desc') {
            doomed.push(e);
        }
    });
    doomed.forEach(e => { if(e.parentNode) e.parentNode.removeChild(e); });
}

/* The printable region as a right-turning ring in template coordinates (LDU, centred, y down). */
TILE.region = function(g) {
    var r = [[-g.px,-g.pz],[g.px,-g.pz],[g.px,g.pz],[-g.px,g.pz]].map(p => new UTIL.Point(p[0], p[1]));
    if(UTIL.signedArea(r) > 0) r.reverse();
    return r;
}

/*
  Full conversion. Returns {hulls:[{pts, lDrawColor, hex, svgColor}], region} with points in centred template
  coordinates (x right, y down, in LDU). options: {w, d, print, pointsPer100px, colorTransformation, onWarning,
  onError, onColorMapped, baseId, baseHex}
 */
TILE.convert = function(svgText, o) {
    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var svg = doc.documentElement;
    if(!svg || svg.nodeName !== 'svg' || doc.querySelector('parsererror')) {
        o.onError('This is not a valid SVG file.');
        return null;
    }
    TILE.stripGuides(svg);

    var g = TILE.geometry(o.w, o.d, o.print);
    var simplifier = new UTIL.PathSimplification(o.pointsPer100px / 100, o.onWarning, o.onError);
    var simplified = simplifier.simplifySvgDom(svg);
    if(!simplified) return null;

    // Map the SVG frame (0..width, 0..height) onto the whole tile footprint, centred.
    var sx = 2*g.hx / simplified.width, sy = 2*g.hz / simplified.height;
    var seen = new Set();
    var mapPt = function(p) { if(!seen.has(p)) { seen.add(p); p.x = -g.hx + p.x*sx; p.y = -g.hz + p.y*sy; } };
    simplified.paths.forEach(path => { path.pts.forEach(mapPt); path.holes.forEach(h => h.forEach(mapPt)); });

    var region = TILE.region(g);
    var fill = new UTIL.Path(region.map(p => p.clone()), TILE.BASE);
    var input = {paths:[fill].concat(simplified.paths), width:2*g.hx, height:2*g.hz, viewBox:simplified.viewBox};
    var result = SVG2LDRAW.decompose(input, o.onWarning);

    var ct = o.colorTransformation, hulls = [];
    result.paths.forEach(function(path) {
        var ring = TORSO.clipConvex(path.pts, region).map(p => new UTIL.Point(
            Math.round(p.x*1000)/1000, Math.round(p.y*1000)/1000));
        ring = UTIL.cleanRing(ring);
        if(!ring) return;
        var id, hex;
        if(path.color === TILE.BASE) { id = o.baseId; hex = o.baseHex; }
        else { var m = ct.transform(path.color, o.onColorMapped); id = m.id; hex = m.hex; }
        hulls.push({pts:ring, lDrawColor:id, hex:hex, svgColor:path.color});
    });
    return {hulls:hulls, region:region};
}

/* Plain base-colour face when no SVG is given. */
TILE.emptyFace = function(o) {
    var region = TILE.region(TILE.geometry(o.w, o.d, o.print));
    return {hulls:[{pts:region.map(p => p.clone()), lDrawColor:o.baseId, hex:o.baseHex, svgColor:TILE.BASE}], region:region};
}

/*
  Writes the LDraw part. 'baseLines' are copied verbatim. Template (x, y) becomes LDraw (x, 0, -y); the winding is
  made CCW seen from above (the normal must point to -Y) using the Newell normal.
 */
TILE.toLDraw = function(hulls, name, description, baseLines) {
    function num(x) { return String(parseFloat(x.toFixed(3))); }
    LDCLEAN.reset();
    var ret = '0 ' + description + '\n0 Name: ' + name + '\n0 Author: svg2ldraw\n' +
              '0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt\n0 BFC CERTIFY CCW\n\n';
    if(baseLines) ret += baseLines.replace(/\s+$/, '') + '\n';
    ret += '\n';
    function out(pts, color) {
        // 3D points (X = x, Z = -y); the Newell normal's Y component is -(sum of (z_i - z_j)(x_i + x_j)).
        var P = pts.map(p => ({x:p.x, z:-p.y}));
        var ny = 0;
        for(var i = 0; i < P.length; i++) {
            var a = P[i], b = P[(i+1) % P.length];
            ny += (a.z - b.z) * (a.x + b.x);
        }
        // For a CCW polygon in the (x, z) plane (seen from -Y, z up) the normal points to -Y, which is ny < 0.
        if(ny > 0) P.reverse();
        // LDCLEAN splits the convex polygon into valid triangles/quads (no collinear vertices, no slivers).
        LDCLEAN.split(P.map(p => [p.x, 0, p.z]), 3).forEach(poly =>
            ret += poly.length + ' ' + color + ' ' + poly.map(p => p.map(num).join(' ')).join(' ') + '\n');
    }
    hulls.forEach(h => out(h.pts, h.lDrawColor));
    return ret;
}
