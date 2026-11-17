# svg2ldraw

svg2ldraw is a library for converting SVG files to LDraw. This can be used for pattern, such as stickers and prints, where vector-based drawings are preferred. Try it out by downloading the source from here, or directly at [c-mt.dk/software/svg2ldraw](https://c-mt.dk/software/svg2ldraw/)

![svg2ldraw converts SVG files to LDraw files, allowing photorealistic renders of models with stickers](https://c-mt.dk/software/svg2ldraw/splash_w800.png)

## Getting started

test.htm provides an overview of basic functionality for developers.

`index.htm` contains the full app with the following steps and functionalities:

0. Upload SVG file either by URL, file, or by pasting the content into the text area.

1. Select size and precision.

2. Adjust colors after the automatic selection has done its best.

3. Download the LDraw file.

`torso.html`, `head.html` and `tile.html` offer an easy SVG templates to start drawing in with a software like Inkscape for these specific parts, reducing the need for further adjustments afterwards.

## License

svg2ldraw.js is in the Public Domain.

The LDraw library and ldconfig.ldr (on which js/color.js is based) is redistributable under CCAL version 2.0 : see CAreadme.txt.
