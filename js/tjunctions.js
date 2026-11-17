/*
  T-junctions can cause rendering issues. See: https://wiki.ldraw.org/wiki/T-Junction
  The T-junction handler attemps to remove T-junctions from paths by adding points to
  paths where they are shared with points from other paths.
 */
UTIL.TJunctionHandler = function(onWarning) {
    this.onWarning = onWarning || function(type, msg){ console.warn(msg); } ;
}

/*
  This function adds points to the paths.

  Consider the point cloud S from the paths.
  For each path, points from S are added to the path if they lie on the line segments of it.

  Input: Array of UTIL.Path or UTIL.CH objects (both have pts and color as properties)
  Output: Array of UTIL.Path objects.
 */
UTIL.TJunctionHandler.prototype.addPoints = function(paths) {
    // First extract and sort the point cloud S:
    var S = [];
    paths.forEach(path => S.push(...path.pts));
    S.sort(UTIL.PointCompare);
    S = S.filter((p, idx, a) => idx == 0 || (p.x != a[idx-1].x || p.y != a[idx-1].y)); // Filter unique.

    // Handle each path:
    var ret = [];
    // TODO: Maintain window in S while traversing in order to speed up the time for comparing... this is why we sorted the points!
    function handlePath(path) {
        var newPoints = [];
        var prev = path.pts[path.pts.length-1];
        var pts = [prev];
        for(const element of path.pts) {
            var p = element;
            var line = new UTIL.Line(prev, p);

            // Get all points s in S intersecting the line in sorted order.
            // For performance, S is sorted by x, so only the points inside the (padded) bounding box of the line are
            // tested exactly, found by binary search.
            var len = Math.sqrt((p.x-prev.x)*(p.x-prev.x) + (p.y-prev.y)*(p.y-prev.y));
            var pad = 1e-4 + 2*UTIL.EPSILON/Math.max(len, 1e-12); // The exact test is a cross product with tolerance.
            var minX = Math.min(prev.x, p.x) - pad, maxX = Math.max(prev.x, p.x) + pad;
            var minY = Math.min(prev.y, p.y) - pad, maxY = Math.max(prev.y, p.y) + pad;
            var lo = 0, hi = S.length;
            while(lo < hi) { var mid = (lo + hi) >> 1; if(S[mid].x < minX) lo = mid + 1; else hi = mid; }
            var candidates = [];
            for(var k = lo; k < S.length && S[k].x <= maxX; k++) {
                if(S[k].y >= minY && S[k].y <= maxY) candidates.push(S[k]);
            }
            var intersectionPoints = candidates
                .map(function(s) {return {p:s, intersection:line.lineSegmentPointIntersection(s)}})
                .filter(x => 0 < x.intersection && 1 > x.intersection)
                .sort((a, b) => a.intersection - b.intersection)
                .map(x => x.p)
                .filter((p, idx, a) => idx === 0 || !a[idx-1].equals(p));

            newPoints.push(...intersectionPoints);

            prev = p;
            newPoints.push(p);
        }
        ret.push(new UTIL.Path(newPoints, path.color));
    }
    paths.forEach(handlePath);

    return ret;
}
