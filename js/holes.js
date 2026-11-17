'use strict';

/*
  holes.js - Shapes with holes for svg2ldraw.

  WHY THIS FILE EXISTS
  An SVG <path> can contain many subpaths (every 'M'/'m' starts a new one). Drawing programs use that to cut
  holes: an outline drawn as ONE path with the inside of the letters/shapes cut out. The original code turned every
  subpath into its own filled polygon, so holes were filled in again (and the shapes inside them were painted over).

  WHAT IT DOES
  1. UTIL.groupSubpaths   Decides which subpaths are outer boundaries and which are holes, using the SVG fill rule
                          ('evenodd' or 'nonzero') exactly as a browser would.
  2. UTIL.triangulateWithHoles
                          Cuts a polygon with holes into triangles (ear clipping). Every hole is first joined to the
                          outer boundary by a zero-width "bridge", which makes the polygon one weakly simple ring.
  3. UTIL.earClip         Plain ear clipping for one ring. Also used as a safety net by convex_hull_decomposition.js
                          so that a shape is never silently dropped.

  ORIENTATION CONVENTION (same as UTIL.CH / UTIL.orderPathsClockwise in geometry.js)
  A ring is "right turning" when its convex corners are right turns (UTIL.rightTurn). Such a ring has a NEGATIVE
  signed area (UTIL.signedArea). All triangles returned here are right turning, as UTIL.CH expects.
 */

// A triangle whose corner turn is smaller than this is treated as degenerate. Deliberately larger than
// UTIL.EPSILON: UTIL.CH tests its own centroid with UTIL.EPSILON and would throw for slivers just above it.
UTIL.EAR_EPSILON = 1e-6;

/*
  Signed area of a ring (shoelace formula). Negative for right turning rings.
 */
UTIL.signedArea = function(pts) {
    let sum = 0, prev = pts[pts.length-1];
    for(const element of pts) {
        let p = element;
        sum += prev.x*p.y - p.x*prev.y;
        prev = p;
    }
    return sum*0.5;
}

/*
  Is p on the line segment a-b? (Distance based, so it does not depend on the size of the drawing.)
 */
UTIL.onSegment = function(a, b, p) {
    const e = UTIL.EPSILON;
    if(p.x < Math.min(a.x, b.x)-e || p.x > Math.max(a.x, b.x)+e ||
       p.y < Math.min(a.y, b.y)-e || p.y > Math.max(a.y, b.y)+e) {
        return false;
    }
    const len = a.dist(b);
    if(len < e) {
        return a.equals(p);
    }
    return Math.abs(UTIL.getTurn(a, b, p))/len < 1e-6; // Perpendicular distance from the line.
}

/*
  Point in ring: 1 = inside, -1 = outside, 0 = on the boundary. (Ray casting.)
 */
UTIL.pointInRing = function(p, ring) {
    let inside = false, prev = ring[ring.length-1];
    for(const element of ring) {
        const q = element;
        if(UTIL.onSegment(prev, q, p)) {
            return 0;
        }
        if((q.y > p.y) !== (prev.y > p.y)) {
            const x = prev.x + (p.y-prev.y)*(q.x-prev.x)/(q.y-prev.y);
            if(p.x < x) {
                inside = !inside;
            }
        }
        prev = q;
    }
    return inside ? 1 : -1;
}

/*
  Removes consecutive duplicate points and a closing point that repeats the first one.
  Returns null if no fillable area is left (fewer than 3 points, or all points on one line).
  Such rings are what used to make svg2ldraw stop with "Degenerate convex hull with only 1 vertices!".
 */
UTIL.cleanRing = function(pts) {
    let ret = [];
    for(const element of pts) {
        if(ret.length === 0 || !ret[ret.length-1].equals(element)) {
            ret.push(element);
        }
    }
    while(ret.length > 1 && ret[0].equals(ret[ret.length-1])) {
        ret.pop();
    }
    if(ret.length < 3) {
        return null;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ret.forEach(p => {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });
    const w = maxX-minX, h = maxY-minY;
    // Area relative to the size of the ring itself, so tiny and huge drawings are treated the same:
    if(Math.abs(UTIL.signedArea(ret)) <= 1e-9*(w*w + h*h) + 1e-12) {
        return null;
    }
    return ret;
}

/*
  Groups the subpaths (rings) of ONE <path> element into filled shapes with holes.

  rings:   Array of rings (arrays of UTIL.Point), already cleaned with UTIL.cleanRing.
  evenOdd: true for fill-rule="evenodd", false for "nonzero" (the SVG default).

  Returns [{outer:[points], holes:[[points], ...]}, ...]

  How: ring B is nested in ring A if A is larger and B lies inside A. For every ring the filled-ness of the region
  directly inside it (but outside its own children) follows from the fill rule:
   - evenodd: filled if the number of rings around it (including itself) is odd.
   - nonzero: filled if the winding number is not 0. The winding number is the sum of the directions (+1/-1) of
              all rings around it, including itself. Holes drawn in the opposite direction cancel the outer ring.
  A filled ring whose parent is not filled starts a shape. Its unfilled children are its holes.
  A filled child of a filled parent (nonzero rule, same direction) is already covered by the parent, so it is skipped.
 */
UTIL.groupSubpaths = function(rings, evenOdd) {
    const n = rings.length;
    if(n === 1) {
        return [{outer:rings[0], holes:[]}];
    }

    const info = rings.map(function(pts) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        pts.forEach(p => {
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        });
        const area = UTIL.signedArea(pts);
        return {pts:pts, area:area, absArea:Math.abs(area), dir:(area < 0 ? -1 : 1),
                minX:minX, minY:minY, maxX:maxX, maxY:maxY, containers:[], parent:-1, filled:false};
    });

    // Does ring a contain ring b? Rings of a valid drawing do not cross, so a vote over the vertices of b is
    // enough. Vertices of b that touch the boundary of a count for neither side.
    function contains(a, b) {
        if(a.absArea <= b.absArea) return false;
        if(b.minX < a.minX || b.maxX > a.maxX || b.minY < a.minY || b.maxY > a.maxY) return false;
        let inside = 0, outside = 0;
        for(const element of b.pts) {
            const r = UTIL.pointInRing(element, a.pts);
            if(r > 0) inside++; else if(r < 0) outside++;
        }
        return inside > outside;
    }

    for(let i = 0; i < n; i++) {
        for(let j = 0; j < n; j++) {
            if(i !== j && contains(info[j], info[i])) {
                info[i].containers.push(j);
            }
        }
        // The smallest container is the direct parent.
        let best = -1;
        info[i].containers.forEach(j => { if(best < 0 || info[j].absArea < info[best].absArea) best = j; });
        info[i].parent = best;
    }

    for(let i = 0; i < n; i++) {
        const r = info[i];
        if(evenOdd) {
            r.filled = (r.containers.length % 2) === 0; // Odd count including itself.
        }
        else {
            let winding = r.dir;
            r.containers.forEach(j => winding += info[j].dir);
            r.filled = winding !== 0;
        }
    }

    const children = info.map(() => []);
    info.forEach((r, i) => { if(r.parent >= 0) children[r.parent].push(i); });

    let ret = [];
    for(let i = 0; i < n; i++) {
        const r = info[i];
        if(!r.filled || (r.parent >= 0 && info[r.parent].filled)) {
            continue; // Not the start of a shape.
        }
        let holes = [];
        (function collect(idx) {
            children[idx].forEach(c => {
                if(info[c].filled) collect(c); else holes.push(info[c].pts);
            });
        })(i);
        ret.push({outer:r.pts, holes:holes});
    }
    return ret;
}

/*
  Triangulates ONE ring by ear clipping. The ring may be weakly simple (the same point twice, as produced by
  hole bridges). Returns right turning triangles [[p, q, r], ...].

  An "ear" is a convex corner whose triangle contains no other vertex of the ring. Cutting it off leaves a smaller ring.
  If no ear can be found (nearly collinear points, rounding), the function removes flat corners, and as a last resort
  cuts the first convex corner anyway, so that it always terminates and never throws.
 */
UTIL.earClip = function(pts, onWarning) {
    onWarning = onWarning || function(){};
    if(pts.length < 3) {
        return [];
    }
    let ring = pts.slice();
    if(UTIL.signedArea(ring) > 0) {
        ring.reverse(); // Make it right turning.
    }
    const m = ring.length;
    const EE = UTIL.EAR_EPSILON;
    let next = [], prev = [];
    for(let i = 0; i < m; i++) {
        next.push((i+1) % m);
        prev.push((i+m-1) % m);
    }

    function isEar(i) {
        const a = ring[prev[i]], b = ring[i], c = ring[next[i]];
        if(UTIL.getTurn(a, b, c) >= -EE) {
            return false; // Reflex or flat.
        }
        const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x);
        const minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);
        for(let j = next[next[i]]; j !== prev[i]; j = next[j]) {
            const p = ring[j];
            if(p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
            if(p.equals(a) || p.equals(b) || p.equals(c)) continue; // Coincident copies (hole bridges) do not block.
            // Inside or on the border of the triangle blocks the ear:
            if(UTIL.getTurn(a, b, p) <= UTIL.EPSILON && UTIL.getTurn(b, c, p) <= UTIL.EPSILON &&
               UTIL.getTurn(c, a, p) <= UTIL.EPSILON) {
                return false;
            }
        }
        return true;
    }

    let triangles = [];
    let remaining = m;
    let cur = 0;
    let failures = 0;
    let forced = false;

    function clip(i) {
        triangles.push([ring[prev[i]], ring[i], ring[next[i]]]);
        remove(i);
    }
    function remove(i) {
        const p = prev[i], q = next[i];
        next[p] = q;
        prev[q] = p;
        remaining--;
        cur = q;
        failures = 0;
    }

    while(remaining > 3) {
        if(isEar(cur)) {
            clip(cur);
            continue;
        }
        cur = next[cur];
        if(++failures < remaining) {
            continue;
        }

        // A full round without finding an ear. 1) Remove a flat corner or a spike (no area is lost):
        let v = cur, found = -1;
        for(let k = 0; k < remaining; k++, v = next[v]) {
            if(Math.abs(UTIL.getTurn(ring[prev[v]], ring[v], ring[next[v]])) <= EE) {
                found = v;
                break;
            }
        }
        if(found >= 0) {
            remove(found);
            continue;
        }
        // 2) Cut any convex corner. The result may be slightly off for a broken polygon, but it terminates.
        v = cur;
        for(let k = 0; k < remaining; k++, v = next[v]) {
            if(UTIL.getTurn(ring[prev[v]], ring[v], ring[next[v]]) < -EE) {
                found = v;
                break;
            }
        }
        if(found < 0) {
            onWarning('earclip_stuck', 'Could not triangulate a shape completely. Part of it is left out. ' +
                      'The shape probably crosses itself.');
            return triangles;
        }
        if(!forced) {
            forced = true;
            onWarning('earclip_forced', 'A shape is almost degenerate. It was triangulated with reduced accuracy.');
        }
        clip(found);
    }
    if(remaining === 3) {
        const a = ring[prev[cur]], b = ring[cur], c = ring[next[cur]];
        if(UTIL.getTurn(a, b, c) < -EE) {
            triangles.push([a, b, c]);
        }
    }
    return triangles;
}

/*
  Triangulates a polygon with holes. outer and each hole are arrays of UTIL.Point (any orientation).
  Returns right turning triangles [[p, q, r], ...].

  Hole bridging (the classic method of David Eberly's "Triangulation by Ear Clipping"):
  Holes are handled from left to right. For each hole a visible connection (a "bridge") is searched between a vertex
  of the hole and a vertex of the polygon built so far. The ring is then walked
     ... polygon vertex, hole vertex, around the hole, hole vertex again, polygon vertex again, ...
  which turns outer ring + hole into one ring that touches itself along the bridge, and that ring is ear clipped.
 */
UTIL.triangulateWithHoles = function(outer, holes, onWarning) {
    onWarning = onWarning || function(){};
    let poly = outer.slice();
    if(UTIL.signedArea(poly) > 0) {
        poly.reverse(); // Outer ring: right turning (negative area).
    }
    if(!holes || holes.length === 0) {
        return UTIL.earClip(poly, onWarning);
    }

    // Holes must run the other way around, so that the polygon area is always on the same side of the walk.
    let pending = holes.map(h => {
        h = h.slice();
        if(UTIL.signedArea(h) < 0) {
            h.reverse();
        }
        return h;
    });
    function leftMost(h) {
        return h.reduce((a, p) => (p.x < a.x || (p.x === a.x && p.y < a.y)) ? p : a, h[0]);
    }
    pending.sort((a, b) => {
        const pa = leftMost(a), pb = leftMost(b);
        return pa.x !== pb.x ? pa.x-pb.x : pa.y-pb.y;
    });

    // Is the direction from vertex 'at' (of ring) to q inside the polygon corner at 'at'?
    // (Needed because a vertex can occur twice in the ring once bridges exist, with a different corner each time.)
    function inCone(ring, k, q) {
        const a0 = ring[(k+ring.length-1) % ring.length], a = ring[k], a1 = ring[(k+1) % ring.length];
        const R = (p1, p2, p3) => UTIL.getTurn(p1, p2, p3) < -UTIL.EPSILON;
        const ROn = (p1, p2, p3) => UTIL.getTurn(p1, p2, p3) <= UTIL.EPSILON;
        if(ROn(a, a1, a0)) { // Convex corner.
            return R(a, q, a0) && R(q, a, a1);
        }
        return !(ROn(a, q, a1) && ROn(q, a, a0)); // Reflex corner.
    }

    // Does the segment p-q avoid all edges of the given rings (edges that share an end point with it are ignored)?
    function segmentFree(p, q, rings) {
        for(const element of rings) {
            const ring = element;
            for(let i = 0, prev = ring[ring.length-1]; i < ring.length; prev = ring[i++]) {
                const b = ring[i];
                if(prev.equals(p) || prev.equals(q) || b.equals(p) || b.equals(q)) continue;
                const d1 = UTIL.getTurn(p, q, prev), d2 = UTIL.getTurn(p, q, b);
                const d3 = UTIL.getTurn(prev, b, p), d4 = UTIL.getTurn(prev, b, q);
                if(((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
                    return false; // Proper crossing.
                }
                if(UTIL.onSegment(p, q, prev) || UTIL.onSegment(p, q, b) ||
                   UTIL.onSegment(prev, b, p) || UTIL.onSegment(prev, b, q)) {
                    return false; // Touching.
                }
            }
        }
        return true;
    }

    while(pending.length > 0) {
        const hole = pending.shift();
        const others = pending; // Holes that are not merged yet must not be crossed either.
        const obstacles = [poly, hole].concat(others);

        // Hole vertices to try: left most first (it always has a visible polygon vertex).
        const holeOrder = hole.map((p, idx) => idx).sort((i, j) => hole[i].x !== hole[j].x ? hole[i].x-hole[j].x : hole[i].y-hole[j].y);

        let bridge = null;
        for(let h = 0; h < holeOrder.length && !bridge; h++) {
            const hi = holeOrder[h], hp = hole[hi];
            // Polygon vertices, nearest first:
            const order = poly.map((p, idx) => idx).sort((i, j) => {
                const di = (poly[i].x-hp.x)*(poly[i].x-hp.x) + (poly[i].y-hp.y)*(poly[i].y-hp.y);
                const dj = (poly[j].x-hp.x)*(poly[j].x-hp.x) + (poly[j].y-hp.y)*(poly[j].y-hp.y);
                return di-dj;
            });
            for(const element of order) {
                const k = element, pp = poly[k];
                if(pp.equals(hp)) continue;
                if(!inCone(poly, k, hp)) continue;
                if(!segmentFree(pp, hp, obstacles)) continue;
                const mid = new UTIL.Point((pp.x+hp.x)*0.5, (pp.y+hp.y)*0.5);
                if(UTIL.pointInRing(mid, poly) <= 0) continue;
                if(UTIL.pointInRing(mid, hole) >= 0) continue;
                if(others.some(oh => UTIL.pointInRing(mid, oh) >= 0)) continue;
                bridge = {k:k, hi:hi};
                break;
            }
        }
        if(!bridge) {
            onWarning('hole_bridge', 'A hole could not be connected to its shape and is ignored.');
            continue;
        }

        // Splice: poly[0..k], hole walked from hi all the way round and back to hi, poly[k..end]:
        let walk = [];
        for(let i = 0; i <= hole.length; i++) {
            walk.push(hole[(bridge.hi+i) % hole.length]);
        }
        poly = poly.slice(0, bridge.k+1).concat(walk, [poly[bridge.k]], poly.slice(bridge.k+1));
    }
    return UTIL.earClip(poly, onWarning);
}
