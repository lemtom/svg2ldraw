'use strict';

/*
  Clean-up of the polygons that are written to the .dat file, so that:
    - every interior angle of a triangle/quad must be between 0.025 and 179.9 degrees,
    - quads must be convex and (nearly) flat.

  Why? The conversion adds extra points on polygon edges to avoid T-junctions (UTIL.TJunctionHandler).
  Such points sit exactly on a straight edge, so they are collinear vertices.

  This clean-up keeps the T-junction protection but never lets a straight run end up inside one polygon corner:
    1. The convex polygon is triangulated with the vertex set intact, choosing the triangulation that maximises the
       smallest angle (dynamic programming, polygons are small). A point that lies on an edge becomes a triangle
       corner, so the neighbouring polygon that shares that point still fits exactly (no T-junction).
    2. If that is not possible (points so close together that every triangulation has an angle < 0.025 degrees), the
       nearly-collinear points that cause the trouble are dropped one at a time (shortest neighbouring edge first).
       This reintroduces a hairline T-junction of at most a few thousandths of an LDU, which is better than a thin
       sliver that LDraw tools reject.
    3. Neighbouring triangles of the same polygon are merged back into quads when the quad is convex, flat and has
       valid angles, to keep the part small.

  Points are arrays [x, y, z] (already in the final coordinates). The functions work in 3D, so they work for every
  orientation (front plate, tile top, head surface).
 */
var LDCLEAN = {};

LDCLEAN.MIN_ANGLE = 0.025;   // degrees
LDCLEAN.MAX_ANGLE = 179.9;   // degrees
LDCLEAN.MAX_WARP = 1;        // degrees between the normals of the two triangles of a quad
LDCLEAN.SLIVER_HEIGHT = 0.05; // LDU: triangles with an invalid angle that are thinner than this are dropped (0.02 mm)
LDCLEAN.stats = { polygons: 0, triangles: 0, quads: 0, dropped: 0, slivers: 0, unresolved: 0, duplicates: 0 };
LDCLEAN.seen = new Set();

/* Call once at the start of every output file: forgets the polygons of the previous file and resets the counters. */
LDCLEAN.reset = function () {
  LDCLEAN.seen = new Set();
  LDCLEAN.stats = { polygons: 0, triangles: 0, quads: 0, dropped: 0, slivers: 0, unresolved: 0, duplicates: 0 };
}

LDCLEAN.sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
LDCLEAN.dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
LDCLEAN.cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
LDCLEAN.len = a => Math.sqrt(LDCLEAN.dot(a, a));

/* Angle at b in degrees between the directions b->a and b->c. */
LDCLEAN.angle = function (a, b, c) {
  var u = LDCLEAN.sub(a, b), v = LDCLEAN.sub(c, b);
  var lu = LDCLEAN.len(u), lv = LDCLEAN.len(v);
  if (lu === 0 || lv === 0) return 0;
  // atan2 of |cross| and dot is accurate for both tiny and near-180 degree angles:
  return Math.atan2(LDCLEAN.len(LDCLEAN.cross(u, v)), LDCLEAN.dot(u, v)) * 180 / Math.PI;
}

/* Smallest of the three angles of a triangle; 0 when an angle is outside the allowed range. */
LDCLEAN.triScore = function (a, b, c) {
  var x = LDCLEAN.angle(c, a, b), y = LDCLEAN.angle(a, b, c), z = LDCLEAN.angle(b, c, a);
  if (Math.max(x, y, z) > LDCLEAN.MAX_ANGLE) return 0;
  return Math.min(x, y, z);
}

LDCLEAN.round = function (pts, decimals) {
  var m = Math.pow(10, decimals);
  return pts.map(p => p.map(x => Math.round(x * m) / m + 0)); // "+ 0" turns -0 into 0.
}

LDCLEAN.same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/* Removes repeated points. */
LDCLEAN.dedupe = function (pts) {
  var ret = [];
  pts.forEach(p => { if (ret.length === 0 || !LDCLEAN.same(ret[ret.length - 1], p)) ret.push(p); });
  while (ret.length > 1 && LDCLEAN.same(ret[0], ret[ret.length - 1])) ret.pop();
  return ret;
}

/*
  Best triangulation of a convex polygon (maximises the smallest angle). Returns {tris, score}.
  tris are arrays of 3 points, in the orientation of the input polygon.
 */
LDCLEAN.triangulate = function (pts) {
  var n = pts.length;
  if (n === 3) return { tris: [pts.slice()], score: LDCLEAN.triScore(pts[0], pts[1], pts[2]) };
  var best = [], split = [];
  for (var i = 0; i < n; i++) { best.push(new Array(n).fill(Infinity)); split.push(new Array(n).fill(-1)); }
  for (var len = 2; len < n; len++) {
    for (var i = 0; i + len < n; i++) {
      var j = i + len, bs = -1, bk = -1;
      for (var k = i + 1; k < j; k++) {
        var s = Math.min(LDCLEAN.triScore(pts[i], pts[k], pts[j]), best[i][k], best[k][j]);
        if (s > bs) { bs = s; bk = k; }
      }
      best[i][j] = bs; split[i][j] = bk;
    }
  }
  var tris = [];
  (function collect(i, j) {
    if (j - i < 2) return;
    var k = split[i][j];
    collect(i, k);
    tris.push([pts[i], pts[k], pts[j]]);
    collect(k, j);
  })(0, n - 1);
  return { tris: tris, score: best[0][n - 1] };
}

/* Interior angle at vertex i of a polygon. */
LDCLEAN.vertexAngle = (pts, i) => LDCLEAN.angle(pts[(i + pts.length - 1) % pts.length], pts[i], pts[(i + 1) % pts.length]);

/* Normal direction of a triangle (not normalised). */
LDCLEAN.normal = (a, b, c) => LDCLEAN.cross(LDCLEAN.sub(b, a), LDCLEAN.sub(c, a));

/* True if the quad a,b,c,d has valid angles and the two ways to split it are (nearly) coplanar. */
LDCLEAN.validQuad = function (q) {
  for (var i = 0; i < 4; i++) {
    var ang = LDCLEAN.vertexAngle(q, i);
    if (ang < LDCLEAN.MIN_ANGLE || ang > LDCLEAN.MAX_ANGLE) return false;
  }
  var n = [0, 1, 2, 3].map(i => LDCLEAN.normal(q[i], q[(i + 1) % 4], q[(i + 2) % 4]));
  for (var i = 0; i < 4; i++) {
    if (LDCLEAN.dot(n[i], n[0]) <= 0) return false; // Concave or twisted.
    var c = LDCLEAN.len(LDCLEAN.cross(n[i], n[0])), d = LDCLEAN.dot(n[i], n[0]);
    if (Math.atan2(c, d) * 180 / Math.PI > LDCLEAN.MAX_WARP) return false;
  }
  return true;
}

/* Merges triangles that share an edge into quads where the result is valid. */
LDCLEAN.mergeToQuads = function (tris) {
  var used = new Array(tris.length).fill(false), out = [];
  for (var a = 0; a < tris.length; a++) {
    if (used[a]) continue;
    var merged = null;
    for (var b = a + 1; b < tris.length && !merged; b++) {
      if (used[b]) continue;
      var A = tris[a], B = tris[b];
      for (var i = 0; i < 3 && !merged; i++) {
        var x = A[i], y = A[(i + 1) % 3];
        for (var j = 0; j < 3; j++) {
          // Shared edge: A has x->y, B has y->x.
          if (LDCLEAN.same(B[j], y) && LDCLEAN.same(B[(j + 1) % 3], x)) {
            // A is the cycle (apexA, x, y). Insert B's apex between x and y (replacing the shared edge):
            var q = [A[(i + 2) % 3], x, B[(j + 2) % 3], y];
            if (LDCLEAN.validQuad(q)) { merged = q; }
            break;
          }
        }
      }
      if (merged) { used[b] = true; }
    }
    used[a] = true;
    if (merged) out.push(merged); else out.push(tris[a]);
  }
  return out;
}

/*
  Splits one convex polygon into valid triangles/quads. 'pts' is a ring of [x,y,z]. 'decimals' is the output precision
  (points are rounded first, as the checks must see what ends up in the file).
  Returns an array of polygons (3 or 4 points each).
 */
LDCLEAN.split = function (pts, decimals) {
  var S = LDCLEAN.stats;
  S.polygons++;
  pts = LDCLEAN.dedupe(LDCLEAN.round(pts, decimals === undefined ? 4 : decimals));
  if (pts.length < 3) return [];

  var result = LDCLEAN.triangulate(pts);
  // Drop nearly-collinear vertices (shortest neighbouring edges first) until every angle is valid.
  while (result.score < LDCLEAN.MIN_ANGLE && pts.length > 3) {
    var cand = -1, candLen = Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (LDCLEAN.vertexAngle(pts, i) >= LDCLEAN.MAX_ANGLE) {
        var l = Math.min(LDCLEAN.len(LDCLEAN.sub(pts[i], pts[(i + pts.length - 1) % pts.length])),
          LDCLEAN.len(LDCLEAN.sub(pts[i], pts[(i + 1) % pts.length])));
        if (l < candLen) { candLen = l; cand = i; }
      }
    }
    if (cand < 0) break;
    pts = pts.slice(0, cand).concat(pts.slice(cand + 1));
    S.dropped++;
    result = LDCLEAN.triangulate(pts);
  }
  var tris = result.tris;
  if (result.score < LDCLEAN.MIN_ANGLE) {
    // Triangles that still have an invalid angle: if they are practically invisible (zero-area lines or hairs),
    // drop them. Larger ones are kept (changing the shape would be worse) and counted as unresolved.
    tris = tris.filter(function (t) {
      if (LDCLEAN.triScore(t[0], t[1], t[2]) >= LDCLEAN.MIN_ANGLE) return true;
      // Thinness = smallest altitude = 2 * area / longest side.
      var twiceArea = LDCLEAN.len(LDCLEAN.normal(t[0], t[1], t[2]));
      var longest = Math.max(LDCLEAN.len(LDCLEAN.sub(t[0], t[1])), LDCLEAN.len(LDCLEAN.sub(t[1], t[2])), LDCLEAN.len(LDCLEAN.sub(t[2], t[0])));
      if (longest === 0 || twiceArea / longest < LDCLEAN.SLIVER_HEIGHT) { S.slivers++; return false; }
      S.unresolved++;
      return true;
    });
  }

  var out = tris.length > 1 ? LDCLEAN.mergeToQuads(tris) : tris;
  // Identical polygons are not allowed in a part file: keep only the first of each.
  out = out.filter(function (p) {
    var key = p.map(q => q.join(',')).sort().join('|');
    if (LDCLEAN.seen.has(key)) { S.duplicates++; return false; }
    LDCLEAN.seen.add(key);
    return true;
  });
  out.forEach(p => { if (p.length === 4) S.quads++; else S.triangles++; });
  return out;
}

/* One line for the page: what the clean-up did (empty when nothing notable happened). */
LDCLEAN.summary = function () {
  var S = LDCLEAN.stats, parts = [];
  if (S.dropped) parts.push(S.dropped + ' nearly-collinear point(s) removed');
  if (S.slivers) parts.push(S.slivers + ' invisible sliver(s) dropped');
  if (S.duplicates) parts.push(S.duplicates + ' duplicate polygon(s) dropped');
  if (S.unresolved) parts.push(S.unresolved + ' thin triangle(s) could not be fixed');
  return parts.length ? ' Clean-up: ' + parts.join(', ') + '.' : '';
}
