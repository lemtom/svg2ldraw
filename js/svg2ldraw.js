'use strict';

var SVG2LDRAW = {};
SVG2LDRAW.Precision = 3; // Used for outputting to LDraw
SVG2LDRAW.PrecisionMult = 1000;
SVG2LDRAW.MinDistDiff = 0.002;

/*
  The purpose of this library is to performs SVG to LDraw pattern transformation.
 */
SVG2LDRAW.Svg = function () {

}

/*
  The conversion pipeline, moved here from index.htm so it can be reused and improved.
  Input: simplified SVG ({paths, width, height, viewBox}) as returned by PathSimplification.
  Output: {paths: convex, hole-free, non-overlapping UTIL.CH hulls, width, height, viewBox}.
  Every stage reports problems through onWarning instead of aborting the whole conversion.
 */
SVG2LDRAW.decompose = function (simplified, onWarning) {
  var result = { paths: [], width: simplified.width, height: simplified.height, viewBox: simplified.viewBox };

  // 1. Remove overlapping geometries. Paths are processed top-most first (last in the SVG), and each new
  //    shape is cut against everything already placed, so nothing is output below something else.
  for (var i = simplified.paths.length - 1; i >= 0; i--) {
    try {
      var d = new UTIL.ConvexHullDecomposition([simplified.paths[i]], onWarning);
      d.build();
      var cut = UTIL.cut(result.paths, d.paths, onWarning);
      // push in a loop; spreading a huge array into push() overflows the call stack.
      for (const element of cut) result.paths.push(element);
    }
    catch (exception) {
      onWarning(i, "Error while constructing path " + i + ". Path will be ignored. You can potentially avoid this by changing the settings of 'Points per 100 pixels'. Error message: " + exception);
    }
  }

  // 2. Add points to prevent T-sections and to be able to combine paths:
  var tjHandler = new UTIL.TJunctionHandler();
  try { result.paths = tjHandler.addPoints(result.paths); }
  catch (e) { onWarning('tjunctions', 'T-junction handling failed: ' + e); }

  // 3. Combine paths (merge neighbours of the same colour):
  var before = result.paths;
  try { result.paths = UTIL.combinePaths(result.paths); }
  catch (e) { result.paths = before; onWarning('combine', 'Combining paths failed, output will have more pieces: ' + e); }

  // 4. Ensure all paths are convex again:
  var chd = new UTIL.ConvexHullDecomposition(result.paths, onWarning);
  chd.build();
  result.paths = chd.paths;

  // 5. Re-add points to avoid T-Junctions:
  try { result.paths = tjHandler.addPoints(result.paths); }
  catch (e) { onWarning('tjunctions', 'T-junction handling failed: ' + e); }

  return result;
}

/*
  - Bounds start at +-Infinity. (Number.MIN_VALUE is the smallest POSITIVE number, so negative coordinates broke it.)
  - Centering is exact: x is mapped to (x - midX)*scaleW. The original mirrored x with scalePoints and then
    mirrored again in convert(), which left the output offset from the centre by minX.
  - 'plane' option: 'xz' (default, as before) lays the print flat on top (Y = -thickness), 'xy' stands it
    upright, facing the viewer at -Z (like a torso or head print). Thickness/box is only supported for 'xz'.
 */
SVG2LDRAW.Svg.prototype.toLDraw = function (decomposition, scaleW, scaleH, thickness, c, plane) {
  plane = plane || 'xz';
  if (plane === 'xy' && thickness > 0) {
    thickness = 0; // The box is built for the flat orientation only.
    if (typeof console !== 'undefined') console.warn('Thickness is not supported for the upright (xy) plane and is ignored.');
  }
  var minX = Infinity, minY = Infinity;
  var maxX = -Infinity, maxY = -Infinity;

  decomposition.paths.forEach(path => path.pts.forEach(function (p) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }));
  const w = maxX - minX, h = maxY - minY;
  const midX = (maxX + minX) * 0.5, midY = (maxY + minY) * 0.5;

  // Maps an SVG coordinate to a centred, scaled LDraw coordinate (as a short string).
  // 'flip' negates the value: for 'xz' the SVG y axis (down) becomes -Z (screen-up in a top view).
  function convert(x, mid, scale, flip) {
    x = (((flip ? mid - x : x - mid)) * scale).toFixed(SVG2LDRAW.Precision);
    for (var i = 0; i < SVG2LDRAW.Precision; i++) {
      var tmp = Number.parseFloat(x).toFixed(i);
      if (Number.parseFloat(tmp) === Number.parseFloat(x)) {
        return tmp; // Don't output too many '0's.
      }
    }
    return x;
  }

  var reverse = (scaleW < 0) !== (scaleH < 0);

  var cnt = 0;
  if (typeof LDCLEAN !== 'undefined') LDCLEAN.reset();
  var ret = '0 Name: ' + (decomposition.name ? decomposition.name : 'INSERT_NAME_HERE');
  ret += `
0 Author: svg2ldraw
0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt
0 BFC CERTIFY CCW
`;
  // 'depth' is the coordinate along the plane normal: Y for 'xz', Z for 'xy'.
  function outputPath(pts, lDrawColor, depth) {
    // 3D points in output order:
    var p3 = [];
    for (var j = 0; j < pts.length; j++) {
      var k = reverse ? pts.length - 1 - j : j;
      var cx = parseFloat(convert(pts[k].x, midX, scaleW, false));
      if (plane === 'xy') {
        // Upright: X right, Y down (same as SVG), seen from -Z. Winding stays CCW as seen from there.
        p3.push([cx, parseFloat(convert(pts[k].y, midY, scaleH, false)), depth]);
      }
      else {
        p3.push([cx, depth, parseFloat(convert(pts[k].y, midY, scaleH, true))]);
      }
    }
    // IMPROVEMENT: LDCLEAN (ldraw_clean.js) splits the polygon into valid triangles/quads: no collinear
    // vertices from T-junction points, no slivers (LDraw.org part rules). Without it, the old fan split is used.
    var polys;
    if (typeof LDCLEAN !== 'undefined') {
      polys = LDCLEAN.split(p3, SVG2LDRAW.Precision);
    }
    else {
      polys = [];
      (function fan(q) {
        if (q.length > 4) { fan(q.slice(0, 4)); fan([q[0]].concat(q.slice(3))); }
        else polys.push(q);
      })(p3);
    }
    polys.forEach(function (q) {
      ret += q.length + " " + lDrawColor;
      q.forEach(p => ret += " " + String(parseFloat(p[0].toFixed(SVG2LDRAW.Precision))) + " " +
        String(parseFloat(p[1].toFixed(SVG2LDRAW.Precision))) + " " +
        String(parseFloat(p[2].toFixed(SVG2LDRAW.Precision))));
    ret += '\n';
    cnt++;
    });
  }

  // Round to the output precision, so neighbouring shapes keep sharing identical vertices.
  // (No mirroring here any more, see the comment at the top.)
  function scalePoints(pts) {
    return pts.map(p => new UTIL.Point(
      Math.round(p.x * SVG2LDRAW.PrecisionMult) / SVG2LDRAW.PrecisionMult,
      Math.round(p.y * SVG2LDRAW.PrecisionMult) / SVG2LDRAW.PrecisionMult
    ));
  }
  decomposition.paths.forEach(path => path.pts = scalePoints(path.pts));

  let allPoints = [];
  decomposition.paths.forEach(path => allPoints.push(...path.pts));
  decomposition.paths.forEach(path => outputPath(path.pts, path.lDrawColor, plane === 'xy' ? 0 : -thickness));

  // Add box if thickness > 0:
  if (thickness > 0) {
    let ch = new UTIL.GeneralConvexHull(allPoints);

    let pts = ch.points.map(p => {
      return {
        x: convert(p.x, midX, scaleW, false),
        y: convert(p.y, midY, scaleH, true)
      };
    });
    let prev = pts[pts.length - 1];
    let segments = [];
    pts.forEach(p => { segments.push({ p1: prev, p2: p }); prev = p; });

    var t = -thickness;
    function outputLine(coords) {
      ret += "2 24";
      coords.forEach(coord => ret += " " + coord);
      ret += '\n';
    }
    function outputQuad(coords, andLines) {
      ret += "4 " + c;
      coords.forEach(coord => ret += " " + coord);
      ret += '\n';
      cnt++;
    }

    // Sides:
    segments.forEach(line => outputQuad([line.p1.x, 0, line.p1.y, line.p1.x, t, line.p1.y,
    line.p2.x, t, line.p2.y, line.p2.x, 0, line.p2.y]));
    // Lines above:
    segments.forEach(line => outputLine([line.p1.x, 0, line.p1.y, line.p2.x, 0, line.p2.y]));
    // Lines below:
    segments.forEach(line => outputLine([line.p1.x, t, line.p1.y, line.p2.x, t, line.p2.y]));
    // Lines on sides
    segments.forEach(line => outputLine([line.p1.x, 0, line.p1.y, line.p1.x, t, line.p1.y]));
    // Below:
    outputPath(ch.points, c, 0);
  }

  return ret;
}