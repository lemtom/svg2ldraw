'user strict';

/*
  PathSimplification simplifies SVG files. Simplified files consist only of path elements.
 */
UTIL.PathSimplification = function (pointsPerPixel, onWarning, onError) {
  this.pointsPerPixel = pointsPerPixel;
  this.onWarning = onWarning;
  this.onError = onError;

  this.bezierRemover = new UTIL.BezierRemover(pointsPerPixel);
  this.arcRemover = new UTIL.ArcRemover(pointsPerPixel);
  this.groups = {}; // id -> group
  this.styleClasses = {} // class name -> fill
  this.idToStyleClass = {}; // referencing id -> style class name

  this.nodeHandlers = {
    circle: this.handleSvgCircle,
    defs: this.handleSvgDefs,
    ellipse: this.handleSvgEllipse,
    g: this.handleSvgGroup,
    metadata: x => { }, // Ignore 'metadata' nodes.
    path: this.handleSvgPath,
    polygon: this.handleSvgPolygon,
    rect: this.handleSvgRect,
    style: this.handleStyle,
    linearGradient: this.handleLinearGradient
  };
}

UTIL.PathSimplification.prototype.addSimpleGroup = function (id, paths) {
  var g = new UTIL.Group();
  g.paths = paths;
  this.groups[id] = g;
}

UTIL.Group = function (transform) {
  this.refs = []; // [] -> {group,transform}
  this.paths = [];
  this.transform = transform || function (x) { return x; };
}

UTIL.Group.prototype.clone = function () {
  var ret = new UTIL.Group(this.transform);
  ret.refs = this.refs;
  ret.paths.push(...this.paths.map(path => path.clone()));
  return ret;
}

UTIL.Group.prototype.output = function (outputPaths, transform) {
  var self = this;
  var t = function (p) {
    //console.log('group transform ' + p.x + ',' + p.y + ' -> ' + self.transform(p).x + ',' + self.transform(p).y);
    return transform(self.transform(p));
  };
  // Holes are carried along (transformed like the outer ring).
  this.paths.forEach(path => outputPaths.push(new UTIL.Path(path.pts.map(p => t(p)), path.color,
    (path.holes || []).map(h => h.map(p => t(p))))));
  this.refs.forEach(ref => ref.group.output(outputPaths, p => t(ref.transform(p))));
}

/*
  Assumes a path like the following (see https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorial/Paths ):

  <svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">  
    <path d="M10 10 H 90 V 90 H 10 L 10 10"/>
  </svg>

  Returns a structured object with the simplified paths:
  {width, height
 */
UTIL.PathSimplification.prototype.simplifySvg = function (svgAsText) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(svgAsText, "text/xml");
  var svg = doc.children[0];
  return this.simplifySvgDom(svg);
}

UTIL.PathSimplification.prototype.simplifySvgDom = function (svg) {
  console.log('simplifying for ' + this.pointsPerPixel + ' ppp');
  var a = svg.attributes;
  if (!a) {
    this.onError('Invalid SVG file: Missing attributes in svg node!');
    return; // Invalid SVG file.
  }

  var paths = [];
  for (const element of svg.children) {
    var child = element;
    this.handleSvgNode(child, paths, '#000000', p => p);
  }

  var w, h, vb;
  if (a.width === undefined || a.height === undefined) {
    if (!a.viewBox) {
      this.onError('SVG missing viewBox and width/height!');
      return; // Invalid SVG file.
    }
    vb = a.viewBox.value.split(' ').map(x => Number.parseFloat(x));
    w = 400; // Hard coded.
    h = w * vb[3] / vb[2]; // Scale to width.
  }
  else {
    w = Number.parseFloat(a.width.value);
    h = Number.parseFloat(a.height.value);
  }

  if (a.viewBox) {
    vb = vb || a.viewBox.value.split(' ').map(x => Number.parseFloat(x));
    var dx = scaleW = w / vb[2];
    var dy = scaleH = h / vb[3];

    var applyViewBox = function (p) {
      p.x = (p.x - vb[0]) * scaleW;
      p.y = (p.y - vb[1]) * scaleH;
    }
    // Hole rings must be scaled together with the outer ring.
    // (Points shared between paths/groups would be scaled twice, so track visited points.)
    var seen = new Set();
    var applyOnce = function (p) { if (!seen.has(p)) { seen.add(p); applyViewBox(p); } };
    paths.forEach(path => { path.pts.forEach(applyOnce); (path.holes || []).forEach(h => h.forEach(applyOnce)); });
  }

  var svgObj = { width: w, height: h, viewBox: { x: 0, y: 0, width: w, height: h }, paths: paths };
  return svgObj;
}

/*
  Normalizes any SVG/CSS colour to the '#rrggbb' form used by the rest of the pipeline.
  Supports: #rgb, #rrggbb, rgb(r,g,b) and rgba(r,g,b,a) (numbers or percentages, also the
  space-separated CSS4 form) and CSS colour names (resolved by the browser).
  'none', 'url(...)' and anything unknown is returned unchanged.
*/
UTIL.normalizeColor = function (c) {
  if (typeof c !== 'string') {
    return c;
  }
  c = c.trim();
  var hex = c.match(/^#([0-9a-fA-F]{3})$/);
  if (hex) {
    var h = hex[1];
    return ('#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toUpperCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(c)) {
    return c.toUpperCase();
  }
  var rgb = c.match(/^rgba?\(\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*(?:[,\/]\s*[\d.]+%?\s*)?\)$/i);
  if (rgb) {
    var out = '#';
    for (var i = 0; i < 3; i++) {
      var v = Number.parseFloat(rgb[1 + 2 * i]);
      if (rgb[2 + 2 * i] === '%') {
        v = v * 2.55;
      }
      v = Math.max(0, Math.min(255, Math.round(v)));
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out.toUpperCase();
  }
  if (/^[a-zA-Z]+$/.test(c) && c !== 'none' && typeof document !== 'undefined') {
    // Named colour: let the browser resolve it.
    var span = document.createElement('span');
    span.style.color = '';
    span.style.color = c;
    if (span.style.color !== '') { // Browser accepted the name.
      document.body.appendChild(span);
      var computed = getComputedStyle(span).color; // 'rgb(r, g, b)'
      document.body.removeChild(span);
      var n = computed.match(/^rgba?\(/) ? UTIL.normalizeColor(computed) : c;
      return n;
    }
  }
  return c;
}

UTIL.PathSimplification.prototype.handleSvgNode = function (node, output, fill, transformation) {
  // Fill color: 'style' takes precedence over 'fill'. Both overwrite inherited value.
  var a = node.attributes;
  if (a) {
    if (node.attributes['class']) {
      var className = node.attributes['class'].value;
      if (this.styleClasses.hasOwnProperty(className)) {
        fill = this.styleClasses[className];
      }
    }
    if (node.attributes.fill) {
      fill = UTIL.normalizeColor(node.attributes.fill.value);
    }
    if (node.attributes.style) {
      var style = node.attributes.style.value;
      var fillMatches = style.match(/(?:^|;)\s*fill\s*:\s*(rgba?\([^)]*\)|[\w\#]+)\s*(?:;|$)/);
      if (fillMatches) {
        fill = UTIL.normalizeColor(fillMatches[1]);
      }
    }
    if (fill === 'none') {
      this.onWarning('fill_none', 'fill:none; is not yet supported. SVG elements with this property will be ignored.');
      return;
    }
  }

  if (this.nodeHandlers.hasOwnProperty(node.nodeName)) {
    //console.log('Handling element of type ' + node.nodeName);
    var f = this.nodeHandlers[node.nodeName];
    f.call(this, node, output, fill, transformation);
  }
  else {
    this.onWarning(node.nodeName, 'Unsupported SVG element type: ' + node.nodeName + '. This element will be ignored.');
  }
}

/*
  Parses a full SVG transform list, e.g. "translate(-234.99,-121.87) scale(2) rotate(30 10 10)".
  The original only understood a single transform and had a substring bug for scale().
  Per the SVG spec the list is applied right-to-left to a point (the last transform is applied first), and the
  result is then passed on to the parent's transformation (baseTransformation).
 */
UTIL.PathSimplification.prototype.getTransformation = function (txt, baseTransformation) {
  var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  var match, list = [], consumed = 0;
  while ((match = re.exec(txt)) !== null) {
    var name = match[1];
    var a = match[2].trim().split(/[\s,]+/).filter(x => x.length > 0).map(x => Number.parseFloat(x));
    var m; // Affine matrix [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f
    if (name === 'matrix' && a.length === 6) {
      m = a;
    }
    else if (name === 'translate' && a.length >= 1) {
      m = [1, 0, 0, 1, a[0], a.length > 1 ? a[1] : 0]; // ty defaults to 0
    }
    else if (name === 'scale' && a.length >= 1) {
      var sy = a.length > 1 ? a[1] : a[0]; // sy defaults to sx
      m = [a[0], 0, 0, sy, 0, 0];
    }
    else if (name === 'rotate' && a.length >= 1) {
      var r = a[0] * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
      var cx = a.length >= 3 ? a[1] : 0, cy = a.length >= 3 ? a[2] : 0; // optional rotation centre
      m = [cs, sn, -sn, cs, cx - cs * cx + sn * cy, cy - sn * cx - cs * cy];
    }
    else if (name === 'skewX' && a.length === 1) {
      m = [1, 0, Math.tan(a[0] * Math.PI / 180), 1, 0, 0];
    }
    else if (name === 'skewY' && a.length === 1) {
      m = [1, Math.tan(a[0] * Math.PI / 180), 0, 1, 0, 0];
    }
    else {
      this.onWarning(txt, 'Invalid transformation "' + match[0] + '". It will be ignored.');
      continue;
    }
    list.push(m);
  }
  if (list.length === 0) {
    this.onWarning(txt, 'Unsupported transformation "' + txt + '". SVG groups with this type of transformation will be ignored.');
    return baseTransformation;
  }
  return function (p) {
    var x = p.x, y = p.y;
    for (var i = list.length - 1; i >= 0; i--) { // Rightmost transform is applied first.
      var m = list[i];
      var nx = m[0] * x + m[2] * y + m[4];
      var ny = m[1] * x + m[3] * y + m[5];
      x = nx; y = ny;
    }
    return baseTransformation(new UTIL.Point(x, y));
  };
}

UTIL.PathSimplification.prototype.handleStyle = function (g, outputPaths, fill, transformation) {
  var content = g.innerHTML;
  var match;
  var re = /\.([a-zA-Z0-9\_]+)\s*\{[^}]*?\bfill\s*:\s*(rgba?\([^)]*\)|\#[0-9a-fA-F]+)\s*[;}]/g;
  while (match = re.exec(content)) {
    var className = match[1];
    var fill = UTIL.normalizeColor(match[2]);
    this.styleClasses[className] = fill;
  }

  //    re = /\.([a-zA-Z0-9\_]+)\{fill\:\s*url\(\#([0-9a-fA-F\_]+)\)/g;
  re = /\.([a-zA-Z0-9\_]+)\{fill\:url\(\#([0-9a-zA-Z\_]+)\)/g;
  while (match = re.exec(content)) {
    var className = match[1];
    var url = match[2];
    this.idToStyleClass[url] = className;
  }
}

UTIL.PathSimplification.prototype.handleLinearGradient = function (g, outputPaths, fill, transformation) {
  var id = g.id;
  if (!id) {
    this.onWarning('linearGradientID', 'LinearGradient element without ID will be ignored.');
    return;
  }
  var styleClassName = this.idToStyleClass[id];
  if (!styleClassName) {
    this.onWarning(styleClassName, 'Unknown style class name: "' + styleClassName + '". Skipping linearGradient element.');
    return;
  }

  for (const element of g.children) {
    var child = element;
    if (child.nodeName === 'stop') {
      var childA = child.attributes;
      var childStyle = childA['style'];
      if (!childStyle) {
        this.onWarning('lg_style', 'Missing style attribute in linearGradient stop element. Element will be ignored.');
        continue;
      }
      childStyle = childStyle.value;
      if (childStyle.length !== 18) {
        this.onWarning('lg_color', 'Expecting stop style of length 18. Element will be ignored.');
        continue;
      }
      var c = childStyle.substring(11); // Expect value like 'stop-color:#05102E'
      this.styleClasses[styleClassName] = c;
      break; // No read to set the value multiple times.
    }
  }
  // TODO: Proper handling of gradients.
}

UTIL.PathSimplification.prototype.handleSvgGroup = function (g, outputPaths, fill, transformation) {
  var a = g.attributes;
  var groupTransformation = transformation;
  if (a.transform) {
    groupTransformation = this.getTransformation(a.transform.value, transformation);
  }
  var group = new UTIL.Group(groupTransformation);
  var overloadedOutputPaths = {};
  overloadedOutputPaths.push = function (outputPath) {
    outputPaths.push(outputPath);
    group.paths.push(outputPath);
  }
  for (const element of g.children) {
    var child = element;
    if (child.nodeName === 'use') {
      var childA = child.attributes;
      var ref = childA['xlink:href'] || childA['href'];
      if (!ref) {
        this.onWarning('href', 'Missing xlink:href or href attribute in "use" element. Output for this will be skipped.');
        continue;
      }
      ref = ref.value.substring(1);
      if (!this.groups.hasOwnProperty(ref)) {
        this.onWarning(ref, 'Unknown ID: "' + ref + '". Skipping "use" element.');
        continue;
      }
      ref = this.groups[ref].clone();
      if (childA.fill) {
        var childFill = UTIL.normalizeColor(childA.fill.value);
        ref.paths.forEach(path => path.color = childFill);
      }

      // Transform:
      const x = childA.x ? Number.parseFloat(childA.x.value) : 0;
      const y = childA.y ? Number.parseFloat(childA.y.value) : 0;
      var childT = function (p) {
        return groupTransformation(new UTIL.Point(p.x + x, p.y + y));
      };

      group.refs.push({ group: ref, transform: childT });
      ref.output(outputPaths, p => childT(p));
    }
    else {
      this.handleSvgNode(child, overloadedOutputPaths, fill, groupTransformation);
    }
  }
  if (a.id) {
    this.groups[a.id.value] = group;
  }
}

UTIL.PathSimplification.prototype.handleSvgDefs = function (g, outputPaths, fill, transformation) {
  var a = g.attributes;
  if (!a.id) {
    this.onWarning('defs', 'defs element without ID has no effect and will be ignored.');
    return;
  }
  var groupTransformation = transformation;
  if (a.transform) {
    groupTransformation = this.getTransformation(a.transform.value, transformation);
  }
  var group = new UTIL.Group(groupTransformation);

  for (const element of g.children) {
    var child = element;
    if (child.nodeName === 'use') {
      var childA = child.attributes;
      var ref = childA['xlink:href'];
      if (!ref) {
        this.onWarning('xlink:href', 'Missing xlink:href attribute in "use" element. Output for this will be skipped.');
        continue;
      }
      ref = ref.value.substring(1);
      if (!this.groups.hasOwnProperty(ref)) {
        this.onWarning(ref, 'Unknown ID: "' + ref + '". Skipping "use" element.');
        continue;
      }
      ref = this.groups[ref];

      // Transform:
      const x = childA.x ? Number.parseFloat(childA.x.value) : 0;
      const y = childA.y ? Number.parseFloat(childA.y.value) : 0;
      var childT = function (p) {
        return groupTransformation(new UTIL.Point(p.x + x, p.y + y));
      };

      group.refs.push({ group: ref, transform: childT });
    }
    else {
      this.handleSvgNode(child, group.paths, fill, groupTransformation);
    }
  }
  this.groups[a.id.value] = group;
}

UTIL.PathSimplification.prototype.handleSvgRect = function (rect, outputPaths, color, transformation) {
  var a = rect.attributes;
  var x = a.x ? Number.parseFloat(a.x.value) : 0;
  var y = a.y ? Number.parseFloat(a.y.value) : 0;
  var w = Number.parseFloat(a.width.value);
  var h = Number.parseFloat(a.height.value);

  var points = [new UTIL.Point(x, y), new UTIL.Point(x + w, y),
  new UTIL.Point(x + w, y + h), new UTIL.Point(x, y + h)].map(transformation);
  outputPaths.push(new UTIL.Path(points, color));
  if (a.id)
    this.addSimpleGroup(a.id.value, [points]);
}

UTIL.PathSimplification.prototype.handleSvgPolygon = function (poly, outputPaths, color, transformation) {
  const a = poly.attributes;
  const pts = a.points;
  if (!pts) {
    this.onWarning('polygon_missing_points', 'Polygon is missing its "points" attribute and cannot be drawn.');
    return;
  }
  const coordinates = pts.value.split(/[\,\s]+/).map(x => Number.parseFloat(x));

  var points = [];
  for (var i = 0; i < coordinates.length - 1; i += 2) {
    var x = coordinates[i];
    var y = coordinates[i + 1];
    points.push(new UTIL.Point(x, y));
  }
  points = points.map(transformation);

  outputPaths.push(new UTIL.Path(points, color));
  if (a.id)
    this.addSimpleGroup(a.id.value, [points]);
}

UTIL.PathSimplification.prototype.handleSvgCircle = function (c, outputPaths, color, transformation) {
  var a = c.attributes;
  var cx = a.cx ? Number.parseFloat(a.cx.value) : 0;
  var cy = a.cy ? Number.parseFloat(a.cy.value) : 0;
  var r = Number.parseFloat(a.r.value);

  var points = [];
  var pointsPerCircle = Math.max(5, Math.floor(this.pointsPerPixel * Math.PI * 2 * r));
  for (var i = 0; i < pointsPerCircle; i++) {
    var angle = Math.PI * 2 * i / pointsPerCircle;
    points.push(new UTIL.Point(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r));
  }

  points = points.map(transformation);
  outputPaths.push(new UTIL.Path(points, color));
  if (a.id) {
    this.addSimpleGroup(a.id.value, [points]);
  }
}

UTIL.PathSimplification.prototype.handleSvgEllipse = function (e, outputPaths, color, transformation) {
  var a = e.attributes;
  var cx = a.cx ? Number.parseFloat(a.cx.value) : 0;
  var cy = a.cy ? Number.parseFloat(a.cy.value) : 0;
  var rx = Number.parseFloat(a.rx.value);
  var ry = Number.parseFloat(a.ry.value);

  var points = [];
  var pointsPerCircle = Math.max(3, Math.floor(this.pointsPerPixel * Math.PI * (rx + ry))); // At least 3 points.
  for (var i = 0; i < pointsPerCircle; i++) {
    var angle = Math.PI * 2 * i / pointsPerCircle;
    points.push(new UTIL.Point(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry));
  }

  points = points.map(transformation);
  outputPaths.push(new UTIL.Path(points, color));
  if (a.id) {
    this.addSimpleGroup(a.id.value, [points]);
  }
}

UTIL.PathSimplification.prototype.svgObjToSvg = function (svgObj) {
  var ret = '<svg width="' + svgObj.width + '" height="' + svgObj.height + '"';
  ret += ' viewBox="' + svgObj.viewBox.x + ' ' + svgObj.viewBox.y + ' ' + svgObj.viewBox.width + ' ' + svgObj.viewBox.height + '"';
  ret += ' xmlns="http://www.w3.org/2000/svg">\n';

  function shorten(x) {
    if (x === Math.floor(x))
      return x;
    return x.toFixed(3);
  }

  svgObj.paths.forEach(function (path) {
    var p = path.pts;
    ret += '  <path d="M ' + shorten(p[0].x) + ' ' + shorten(p[0].y) + ' ';

    for (var j = 1; j < p.length; j++) {
      var x = shorten(p[j].x);
      var y = shorten(p[j].y);
      ret += 'L ' + x + ' ' + y + ' ';
    }
    ret += 'Z" fill="' + path.color + '"/>\n';
  });

  ret += '</svg>';
  return ret;
}

/*
  Path handler.
  - Character-level scanner handles exponents ("1e-5"), numbers glued together ("10-5", "1.5.5"), and arc flags written without separators ("a1 1 0 01.5 2").
  - Implicit command repetition (extra coordinate pairs after M become L, etc.).
  - Support for Q/q/T/t (quadratic Beziers) in addition to M L H V C S A Z.
  - The current position is kept in UNtransformed coordinates; transformation is applied only when a point is
    stored. (The original continued from a transformed point after 'z', which broke grouped paths.)
  - Subpaths are NOT emitted as separate filled shapes any more. They are collected and grouped into
    outer rings and holes according to the fill-rule (evenodd / nonzero), see UTIL.groupSubpaths in holes.js.
 */
UTIL.PathSimplification.prototype.handleSvgPath = function (path, outputPaths, color, transformation) {
  var a = path.attributes;
  if (!a.d) {
    return;
  }
  var d = a.d.value;

  // fill-rule can be an attribute or part of the style. SVG default is nonzero.
  var fillRule = 'nonzero';
  if (a['fill-rule']) {
    fillRule = a['fill-rule'].value;
  }
  if (a.style) {
    var frm = a.style.value.match(/fill-rule\s*:\s*(\w+)/);
    if (frm) {
      fillRule = frm[1];
    }
  }
  var evenOdd = fillRule === 'evenodd';

  var group = a.id ? new UTIL.Group() : null;
  var self = this;

  // ---- Scanner ----
  var pos = 0;
  var numRe = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y; // Sticky: matches only at lastIndex.
  function skipSep() {
    while (pos < d.length && (d[pos] === ' ' || d[pos] === ',' || d[pos] === '\t' || d[pos] === '\n' || d[pos] === '\r')) pos++;
  }
  function hasNumber() {
    skipSep();
    if (pos >= d.length) return false;
    var c = d[pos];
    return (c >= '0' && c <= '9') || c === '-' || c === '+' || c === '.';
  }
  function number() {
    skipSep();
    numRe.lastIndex = pos;
    var m = numRe.exec(d);
    if (!m) throw new Error('Expected number at position ' + pos + ' in path data');
    pos = numRe.lastIndex;
    return Number.parseFloat(m[0]);
  }
  function flag() { // Arc flags are single characters '0' or '1' and may not be separated from what follows.
    skipSep();
    var c = d[pos++];
    if (c !== '0' && c !== '1') throw new Error('Expected arc flag at position ' + (pos - 1));
    return c === '1';
  }

  // ---- Subpath collection ----
  var rings = [];  // Finished subpaths (arrays of UTIL.Point, already transformed).
  var ring = [];   // Current subpath.
  var x = 0, y = 0;       // Current position (untransformed).
  var startX = 0, startY = 0; // Start of current subpath (untransformed).

  function push(px, py) { // Store a (transformed) point, skipping consecutive duplicates.
    var np = transformation(new UTIL.Point(px, py));
    if (ring.length > 0 && ring[ring.length - 1].equals(np)) {
      return;
    }
    ring.push(np);
  }
  function finishRing() {
    if (ring.length > 0) {
      rings.push(ring);
    }
    ring = [];
  }

  try {
    var cmd = null, prevCmd = null;
    var lastCtrlX = 0, lastCtrlY = 0; // Last control point for S/T reflection (untransformed).
    while (true) {
      skipSep();
      if (pos >= d.length) break;
      var c = d[pos];
      if (/[a-zA-Z]/.test(c)) {
        cmd = c; pos++;
      }
      else if (cmd === null || cmd === 'Z' || cmd === 'z' || !hasNumber()) {
        throw new Error('Unexpected character "' + c + '" at position ' + pos + ' in path data');
      }
      // else: implicit repetition of cmd.

      var rel = cmd === cmd.toLowerCase();
      var C = cmd.toUpperCase();
      var ox = rel ? x : 0, oy = rel ? y : 0; // Offset for relative commands.
      var x0 = x, y0 = y;
      var ctrlX = null, ctrlY = null; // Set by curve commands.

      switch (C) {
        case 'M':
          finishRing(); // A new subpath starts.
          x = ox + number(); y = oy + number();
          startX = x; startY = y;
          push(x, y);
          cmd = rel ? 'l' : 'L'; // Further pairs are implicit line-tos.
          break;
        case 'Z':
          finishRing();
          x = startX; y = startY; // Current point returns to start of subpath.
          break;
        case 'L':
          x = ox + number(); y = oy + number();
          push(x, y);
          break;
        case 'H':
          x = ox + number();
          push(x, y);
          break;
        case 'V':
          y = oy + number();
          push(x, y);
          break;
        case 'C': case 'S': {
          var x1, y1;
          if (C === 'C') {
            x1 = ox + number(); y1 = oy + number();
          }
          else { // Smooth: first control point is the reflection of the previous second control point.
            if (prevCmd === 'C' || prevCmd === 'S') {
              x1 = 2 * x0 - lastCtrlX; y1 = 2 * y0 - lastCtrlY;
            } else {
              x1 = x0; y1 = y0;
            }
          }
          var x2 = ox + number(), y2 = oy + number();
          var x3 = ox + number(), y3 = oy + number();
          self.bezierRemover.handleCurve(x0, y0, x1, y1, x2, y2, x3, y3).forEach(q => push(q.x, q.y));
          x = x3; y = y3;
          ctrlX = x2; ctrlY = y2;
          push(x, y);
          break;
        }
        case 'Q': case 'T': {
          // IMPROVEMENT: Quadratic curves are converted to the equivalent cubic curve.
          var qx, qy;
          if (C === 'Q') {
            qx = ox + number(); qy = oy + number();
          } else {
            if (prevCmd === 'Q' || prevCmd === 'T') {
              qx = 2 * x0 - lastCtrlX; qy = 2 * y0 - lastCtrlY;
            } else {
              qx = x0; qy = y0;
            }
          }
          var ex = ox + number(), ey = oy + number();
          var cx1 = x0 + 2 / 3 * (qx - x0), cy1 = y0 + 2 / 3 * (qy - y0);
          var cx2 = ex + 2 / 3 * (qx - ex), cy2 = ey + 2 / 3 * (qy - ey);
          self.bezierRemover.handleCurve(x0, y0, cx1, cy1, cx2, cy2, ex, ey).forEach(q => push(q.x, q.y));
          x = ex; y = ey;
          ctrlX = qx; ctrlY = qy;
          push(x, y);
          break;
        }
        case 'A': {
          var rx = number(), ry = number();
          var rot = Math.PI * 2 / 360 * number();
          var large = flag(), sweep = flag();
          var ax = ox + number(), ay = oy + number();
          self.arcRemover.handle(x0, y0, rx, ry, rot, large, sweep, ax, ay).forEach(q => push(q.x, q.y));
          x = ax; y = ay;
          push(x, y);
          break;
        }
        default:
          self.onWarning(cmd, 'Unsupported path command "' + cmd + '". The path will be skipped.');
          return;
      }
      if (ctrlX !== null) { lastCtrlX = ctrlX; lastCtrlY = ctrlY; }
      prevCmd = C;
    }
    finishRing();
  }
  catch (e) {
    // Malformed path data skips this path with a warning instead of aborting everything.
    this.onWarning('path_syntax', 'Skipping path with invalid path data: ' + e.message);
    return;
  }

  // ---- Group subpaths into shapes with holes ----
  // cleanRing removes duplicate points, the closing duplicate point and degenerate rings.
  var cleaned = rings.map(r => UTIL.cleanRing(r)).filter(r => r !== null);
  UTIL.groupSubpaths(cleaned, evenOdd).forEach(function (shape) {
    var p = new UTIL.Path(shape.outer, color, shape.holes);
    outputPaths.push(p);
    if (group) {
      group.paths.push(p);
    }
  });

  if (group) {
    this.groups[a.id.value] = group;
  }
}
