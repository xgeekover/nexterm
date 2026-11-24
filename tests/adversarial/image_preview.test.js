/**
 * Image tabs (Orca bundle 5, B4), page side: the browser mock of
 * `fs_read_image` (src/lib/ipc.js) held to the backend's shape and words
 * (src-tauri/src/fs/preview.rs, read here as source), and the pure model of
 * the image view (src/lib/imagePreview.js).
 *
 *   AC-B4-3  the mock answers `{ mime, data, bytes, width, height }` as the
 *            backend's ImagePreview, and refuses in the backend's fixed words
 *            and limits — read from preview.rs, so that a change on either
 *            side fails here (IP-01..12)
 *   AC-B4-4  imagePreview.js: the extension list, the data: URI, the fit
 *            scale (never above 1), zoom clamped to 10%–800%, the label
 *            '1920 × 1080 · 2.4 MB' (and an SVG's without dimensions), and
 *            the reason text for each refusal (IP-20..29)
 */
import { readFileSync } from 'node:fs';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import { invoke, mockBridge } from '../../src/lib/ipc.js';
import {
  IMAGE_EXTENSIONS,
  IMAGE_MAX_BYTES,
  IMAGE_MIMES,
  IMAGE_REFUSALS,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  canZoomIn,
  canZoomOut,
  clampZoom,
  fitScale,
  formatImageBytes,
  imageAltText,
  imageDataUri,
  imageFailureReason,
  imageRefusalKind,
  imageSizeLabel,
  isImagePath,
  zoomIn,
  zoomLabel,
  zoomOut,
} from '../../src/lib/imagePreview.js';

/** A source file of the repository, line endings as LF whatever the checkout made them. */
const source = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const MB = 1024 * 1024;

/** The backend's image reader, as source. */
const rust = () => source('src-tauri/src/fs/preview.rs');

/** preview.rs's `pub const NAME: &str = "…";` strings, by name. */
const rustWords = () => Object.fromEntries(
  [...rust().matchAll(/^pub const (\w+): &str = "([^"]*)";$/gm)].map(([, name, text]) => [name, text])
);

/** preview.rs's `pub const NAME: u64|u32 = …;` numbers, by name: `20 * 1024 * 1024` and `32_768` worked out. */
const rustLimits = () => Object.fromEntries(
  [...rust().matchAll(/^pub const (\w+): u(?:32|64) = ([0-9_ *]+);$/gm)].map(([, name, expr]) => [
    name,
    expr.split('*').map((part) => Number(part.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1),
  ])
);

/** Every `<why>` the backend gives after "File is not an image NexTerm can show (". */
const rustWhys = () => [...rust().matchAll(/not_an_image\(path_str, "([^"]*)"\)/g)].map(([, why]) => why);

/** What `fs_read_image` on the mock rejected with, as text; fails the test when it answered. */
async function refusal(path) {
  try {
    await mockBridge.invoke('fs_read_image', { path });
  } catch (err) {
    return err.message;
  }
  assert.fail(`the mock read ${path} as an image`);
  return '';
}

/** Run `fn` with `images` among the mock's images, and take them out again. */
async function withImages(images, fn) {
  const before = new Map(mockBridge.images);
  for (const [path, image] of Object.entries(images)) mockBridge.images.set(path, image);
  try {
    return await fn();
  } finally {
    mockBridge.images.clear();
    for (const [path, image] of before) mockBridge.images.set(path, image);
  }
}

/** Run `fn` with `files` among the mock's text files, and take them out again. */
async function withFiles(files, fn) {
  for (const [path, text] of Object.entries(files)) mockBridge.files.set(path, text);
  try {
    return await fn();
  } finally {
    for (const path of Object.keys(files)) mockBridge.files.delete(path);
  }
}

/** Run `fn` while the page claims to be inside Tauri, with no runtime behind it. */
async function pretendingToBeInTauri(fn) {
  globalThis.window = globalThis.window || {};
  const had = Object.prototype.hasOwnProperty.call(window, '__TAURI_INTERNALS__');
  const previous = window.__TAURI_INTERNALS__;
  window.__TAURI_INTERNALS__ = {};
  try {
    return await fn();
  } finally {
    if (had) window.__TAURI_INTERNALS__ = previous;
    else delete window.__TAURI_INTERNALS__;
  }
}

/** `data`, standard base64, as bytes. */
const bytesOf = (data) => Uint8Array.from(Buffer.from(data, 'base64'));

/** A PNG entry for the mock declaring `width` × `height`: its signature and IHDR, as the backend reads them. */
function pngOf(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return { mime: 'image/png', data: bytes.toString('base64'), width, height };
}

const PNG = '/workspace/assets/logo.png';
const SVG = '/workspace/assets/logo.svg';

describe('Image tabs: the browser mock of fs_read_image against the backend (AC-B4-3)', () => {
  test('IP-01: the fixed words and the limits are the backend\'s — in the mock\'s source, in imagePreview.js, and in what the mock answers', async () => {
    const words = rustWords();
    assert.deepEqual(
      { NOT_FOUND: words.NOT_FOUND, NOT_AN_IMAGE: words.NOT_AN_IMAGE, TOO_LARGE: words.TOO_LARGE },
      { NOT_FOUND: 'File not found', NOT_AN_IMAGE: 'File is not an image NexTerm can show', TOO_LARGE: 'Image is too large to preview' },
      'the backend\'s words, as the Rust test the_refusal_words_are_fixed pins them'
    );
    const limits = rustLimits();
    assert.deepEqual(
      { MAX_IMAGE_BYTES: limits.MAX_IMAGE_BYTES, MAX_IMAGE_SIDE: limits.MAX_IMAGE_SIDE, MAX_IMAGE_PIXELS: limits.MAX_IMAGE_PIXELS },
      { MAX_IMAGE_BYTES: 20 * MB, MAX_IMAGE_SIDE: 32768, MAX_IMAGE_PIXELS: 32 * MB }
    );

    // The mock restates them, importing nothing of the app's.
    const ipc = source('src/lib/ipc.js');
    const mockConst = (name) => {
      const found = ipc.match(new RegExp(`^const ${name} = (?:'([^']*)'|([0-9 *]+));$`, 'm'));
      assert.ok(found, `${name} in src/lib/ipc.js`);
      return found[1] ?? found[2].split('*').map(Number).reduce((a, b) => a * b, 1);
    };
    assert.equal(mockConst('MOCK_IMAGE_NOT_FOUND'), words.NOT_FOUND);
    assert.equal(mockConst('MOCK_IMAGE_NOT_AN_IMAGE'), words.NOT_AN_IMAGE);
    assert.equal(mockConst('MOCK_IMAGE_TOO_LARGE'), words.TOO_LARGE);
    assert.equal(mockConst('MOCK_IMAGE_MAX_BYTES'), limits.MAX_IMAGE_BYTES);
    assert.equal(mockConst('MOCK_IMAGE_MAX_SIDE'), limits.MAX_IMAGE_SIDE);
    assert.equal(mockConst('MOCK_IMAGE_MAX_PIXELS'), limits.MAX_IMAGE_PIXELS);

    // So does the view, which tells the refusals apart by them.
    assert.deepEqual(IMAGE_REFUSALS, { notFound: words.NOT_FOUND, notAnImage: words.NOT_AN_IMAGE, tooLarge: words.TOO_LARGE });
    assert.equal(IMAGE_MAX_BYTES, limits.MAX_IMAGE_BYTES);

    // And the mock's answers start with them.
    assert.equal(await refusal('/workspace/nope.png'), `${words.NOT_FOUND}: /workspace/nope.png`);
    assert.ok((await refusal('/workspace/README.md')).startsWith(`${words.NOT_AN_IMAGE} (`));
    await withImages({ '/w/big.png': { ...pngOf(8, 8), bytes: 25 * MB } }, async () => {
      assert.ok((await refusal('/w/big.png')).startsWith(`${words.TOO_LARGE} (`));
    });
  });

  test('IP-02: nothing at the path, a mock text file asked for as an image, and a folder — each refused in the backend\'s words', async () => {
    const whys = rustWhys();
    assert.deepEqual(whys, [
      'it is not a file',
      'it is no PNG, JPEG, GIF, WebP or SVG',
      'its header is cut short',
      'its header is not valid',
      'it is an SVG that is not UTF-8',
    ], 'the backend\'s reasons, as P1 fixed them');
    assert.equal(await refusal('/workspace/gone.png'), 'File not found: /workspace/gone.png');
    assert.equal(
      await refusal('/workspace/README.md'),
      `File is not an image NexTerm can show (${whys[1]}): /workspace/README.md`
    );
    assert.equal(await refusal('/workspace/src'), `File is not an image NexTerm can show (${whys[0]}): /workspace/src`);
    // A folder the mock knows only by the files in it is one too.
    await withImages({ '/w/pics/a.png': pngOf(2, 2) }, async () => {
      assert.equal(await refusal('/w/pics'), `File is not an image NexTerm can show (${whys[0]}): /w/pics`);
    });
    // A format the backend does not tell, and a raster image with no valid size.
    await withImages({ '/w/a.bmp': { mime: 'image/bmp', data: 'Qk0=' }, '/w/z.png': { ...pngOf(1, 1), width: 0 } }, async () => {
      assert.equal(await refusal('/w/a.bmp'), `File is not an image NexTerm can show (${whys[1]}): /w/a.bmp`);
      assert.equal(await refusal('/w/z.png'), `File is not an image NexTerm can show (${whys[3]}): /w/z.png`);
    });
  });

  test('IP-03: an over-size file is refused by its size, before its format is looked at, in the backend\'s rounding', async () => {
    const text = rust();
    // The backend's own test literals: 25 MB exactly, and one byte past 20 MB.
    assert.ok(text.includes('format!("Image is too large to preview (25.0 MB; the limit is 20 MB): {}"'), 'the 25 MB literal in preview.rs');
    assert.ok(text.includes('err.contains("(20.1 MB; the limit is 20 MB)")'), 'the 20 MB + 1 literal in preview.rs');
    await withImages({
      '/w/big.png': { ...pngOf(8, 8), bytes: 25 * MB },
      '/w/just-over.png': { ...pngOf(8, 8), bytes: 20 * MB + 1 },
      '/w/at-limit.png': { ...pngOf(64, 64), bytes: 20 * MB },
      '/w/big.bmp': { mime: 'image/bmp', data: '', bytes: 21 * MB },
    }, async () => {
      assert.equal(await refusal('/w/big.png'), 'Image is too large to preview (25.0 MB; the limit is 20 MB): /w/big.png');
      assert.equal(await refusal('/w/just-over.png'), 'Image is too large to preview (20.1 MB; the limit is 20 MB): /w/just-over.png');
      assert.equal(await refusal('/w/big.bmp'), 'Image is too large to preview (21.0 MB; the limit is 20 MB): /w/big.bmp', 'size first');
      const atLimit = await mockBridge.invoke('fs_read_image', { path: '/w/at-limit.png' });
      assert.deepEqual([atLimit.bytes, atLimit.width], [20 * MB, 64], 'exactly at the limit is read');
    });
    // A text file over the limit, too.
    const path = '/workspace/huge.txt';
    await withFiles({ [path]: 'x'.repeat(20 * MB + 1) }, async () => {
      assert.equal(await refusal(path), `Image is too large to preview (20.1 MB; the limit is 20 MB): ${path}`);
    });
  });

  test('IP-04: a header declaring too many pixels is refused in the backend\'s words; exactly at the limits is shown', async () => {
    const huge = '/w/huge.png';
    const literal = 'format!("Image is too large to preview (100000 × 100000; the limit is 32768 px per side and 32 Mi pixels): {huge}")';
    assert.ok(rust().includes(literal), 'the backend\'s own test literal');
    await withImages({
      [huge]: pngOf(100000, 100000),
      '/w/wide.png': pngOf(32769, 1),
      '/w/tall.png': pngOf(1, 32769),
      '/w/area.png': pngOf(8193, 4096),
      '/w/side.png': pngOf(32768, 1024),
      '/w/square.png': pngOf(5792, 5792),
    }, async () => {
      assert.equal(
        await refusal(huge),
        `Image is too large to preview (100000 \u{00d7} 100000; the limit is 32768 px per side and 32 Mi pixels): ${huge}`
      );
      for (const path of ['/w/wide.png', '/w/tall.png', '/w/area.png']) {
        assert.ok((await refusal(path)).startsWith('Image is too large to preview ('), path);
      }
      // 32768 × 1024 is 32 Mi pixels exactly, and 32768 is the longest side.
      const side = await mockBridge.invoke('fs_read_image', { path: '/w/side.png' });
      assert.deepEqual([side.width, side.height], [32768, 1024]);
      assert.equal((await mockBridge.invoke('fs_read_image', { path: '/w/square.png' })).width, 5792);
    });
  });

  test('IP-05: an answer has the backend\'s shape — the five fields of ImagePreview, the bytes as standard base64, the header\'s size', async () => {
    const models = source('src-tauri/src/models.rs');
    const struct = models.match(/pub struct ImagePreview \{\n([\s\S]*?)\n\}/);
    assert.ok(struct, 'ImagePreview in models.rs');
    const fields = [...struct[1].matchAll(/^\s*pub (\w+): /gm)].map(([, name]) => name);
    assert.deepEqual(fields, ['mime', 'data', 'bytes', 'width', 'height']);

    const png = await mockBridge.invoke('fs_read_image', { path: PNG });
    assert.deepEqual(Object.keys(png), fields);
    assert.equal(png.mime, 'image/png');
    assert.match(png.data, /^[A-Za-z0-9+/]+={0,2}$/);
    const bytes = bytesOf(png.data);
    assert.equal(png.bytes, bytes.length);
    // What the backend would read: the signature and IHDR's size.
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(Buffer.from(bytes.subarray(12, 16)).toString('latin1'), 'IHDR');
    const view = new DataView(bytes.buffer);
    assert.deepEqual([png.width, png.height], [view.getUint32(16), view.getUint32(20)]);
    assert.deepEqual([png.width, png.height], [4, 3]);

    const svg = await mockBridge.invoke('fs_read_image', { path: SVG });
    assert.deepEqual(Object.keys(svg), fields);
    assert.equal(svg.mime, 'image/svg+xml');
    assert.equal(svg.width, null, 'null, not left out');
    assert.equal(svg.height, null);
    const text = Buffer.from(svg.data, 'base64').toString('utf8');
    assert.equal(svg.bytes, Buffer.byteLength(text));
    assert.match(text, /^<svg[ >]/);

    // A copy each time: what a caller changes is not the mock's file.
    png.width = 999;
    assert.equal((await mockBridge.invoke('fs_read_image', { path: PNG })).width, 4);
  });

  test('IP-06: a text file that starts as an SVG is one — after a BOM, a prolog, comments and a doctype — and <svgfoo> or <SVG> is not', async () => {
    const files = {
      '/w/plain.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      '/w/prolog.svg': '\u{feff}<?xml version="1.0"?>\n<!-- é -->\n<!DOCTYPE svg [ <!ENTITY a "x>y"> ]>\n<svg>\u{d55c}</svg>',
      '/w/notes.txt': '\n\t<svg\nwidth="1"/>',
      '/w/foo.svg': '<svgfoo/>',
      '/w/upper.svg': '<SVG/>',
      '/w/html.svg': '<html><svg/></html>',
      '/w/open.svg': '<!-- never closed <svg/>',
    };
    await withFiles(files, async () => {
      for (const path of ['/w/plain.svg', '/w/prolog.svg', '/w/notes.txt']) {
        const image = await mockBridge.invoke('fs_read_image', { path });
        assert.deepEqual([image.mime, image.width, image.height], ['image/svg+xml', null, null], path);
        const utf8 = new TextEncoder().encode(files[path]);
        assert.equal(image.bytes, utf8.length, path);
        assert.deepEqual([...bytesOf(image.data)], [...utf8], `${path}: its UTF-8 bytes, BOM and all`);
      }
      for (const path of ['/w/foo.svg', '/w/upper.svg', '/w/html.svg', '/w/open.svg']) {
        assert.equal(await refusal(path), `File is not an image NexTerm can show (it is no PNG, JPEG, GIF, WebP or SVG): ${path}`);
      }
    });
  });

  test('IP-07: the argument is checked as Tauri checks it, and fs_read_file on a mock image answers as the backend\'s would', async () => {
    await assert.rejects(() => mockBridge.invoke('fs_read_image', {}), /^Error: invalid args `path` for command `fs_read_image`: command fs_read_image missing required key path$/);
    await assert.rejects(() => mockBridge.invoke('fs_read_image', { filePath: PNG }), /missing required key path/);
    await assert.rejects(() => mockBridge.invoke('fs_read_image', { path: 7 }), /invalid type: expected a string/);
    await assert.rejects(() => mockBridge.invoke('fs_read_file', { path: PNG }), new Error(`File is not UTF-8 text: ${PNG}`));
    const text = await mockBridge.invoke('fs_read_file', { path: SVG });
    assert.ok(text.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.equal(Buffer.from(text).toString('base64'), (await mockBridge.invoke('fs_read_image', { path: SVG })).data);
  });

  test('IP-08: the backend\'s command takes exactly `path`, off the IPC thread, and is registered beside fs_read_file', () => {
    const main = source('src-tauri/src/main.rs');
    const handler = main.slice(main.indexOf('generate_handler!['), main.indexOf('])', main.indexOf('generate_handler![')));
    assert.ok(handler.includes('commands::fs::fs_read_file,\n            commands::fs::fs_read_image,'), 'in generate_handler!, after fs_read_file');
    const fsRs = source('src-tauri/src/commands/fs.rs');
    assert.match(
      fsRs,
      /#\[tauri::command\(async, rename_all = "snake_case"\)\]\npub fn fs_read_image\(state: State<AppState>, path: String\) -> Result<ImagePreview, String> \{\n/
    );
    // The key the mock reads is that parameter's name.
    assert.match(source('src/lib/ipc.js'), /case 'fs_read_image': \{\n\s*const path = mockStringArg\(command, args, 'path'\);/);
  });

  test('IP-09: inside Tauri the backend answers or rejects — never the mock\'s pictures', async () => {
    await pretendingToBeInTauri(async () => {
      await assert.rejects(() => invoke('fs_read_image', { path: PNG }));
    });
    // Outside it, the mock serves.
    assert.equal((await invoke('fs_read_image', { path: PNG })).mime, 'image/png');
  });

  test('IP-10: the mock\'s own images are not in its tree, its file list or its search — every suite\'s view of the mock is what it was', async () => {
    const tree = JSON.stringify(await mockBridge.invoke('fs_read_dir', { path: '/workspace' }));
    assert.equal(tree.includes('/workspace/assets'), false);
    const { files } = await mockBridge.invoke('fs_list_files', {});
    assert.equal(files.some((p) => p.startsWith('/workspace/assets/')), false);
    const found = await mockBridge.invoke('fs_search', { query: 'iVBORw0KGgo' });
    assert.equal(found.files.length, 0);
  });
});

describe('Image tabs: the image view\'s model, src/lib/imagePreview.js (AC-B4-4)', () => {
  test('IP-20: the extensions opened as an image, whatever their case — and nothing else', () => {
    assert.deepEqual([...IMAGE_EXTENSIONS], ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
    assert.ok(Object.isFrozen(IMAGE_EXTENSIONS));
    for (const path of [
      '/w/logo.png', '/w/LOGO.PNG', '/w/a.JpEg', '/w/a.jpg', '/w/anim.Gif', '/w/p.webp', '/w/icon.SVG',
      'C:\\pics\\shot.WEBP', 'relative/a.b.png', 'x.png',
    ]) {
      assert.equal(isImagePath(path), true, path);
    }
    for (const path of [
      '/w/a.bmp', '/w/a.ico', '/w/a.tiff', '/w/a.svgz', '/w/a.avif', '/w/a.heic', '/w/a.png.txt', '/w/png',
      '/w/.png', '/w/README.md', '/w/a.', '', null, undefined, 42, { path: 'a.png' },
    ]) {
      assert.equal(isImagePath(path), false, String(path));
    }
  });

  test('IP-21: a data: URI only for the five formats and standard base64 — never another type, never injected text', async () => {
    const png = await mockBridge.invoke('fs_read_image', { path: PNG });
    assert.equal(imageDataUri(png), `data:image/png;base64,${png.data}`);
    const svg = await mockBridge.invoke('fs_read_image', { path: SVG });
    assert.ok(imageDataUri(svg).startsWith('data:image/svg+xml;base64,PHN2Zy'));
    assert.deepEqual([...IMAGE_MIMES], ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
    for (const mime of IMAGE_MIMES) assert.equal(imageDataUri({ mime, data: 'AAAA' }), `data:${mime};base64,AAAA`);

    const data = png.data;
    for (const [what, image] of [
      ['text/html', { mime: 'text/html', data }],
      ['a parameter', { mime: 'image/svg+xml;charset=utf-8', data }],
      ['upper case', { mime: 'IMAGE/PNG', data }],
      ['bmp', { mime: 'image/bmp', data }],
      ['no type', { data }],
      ['no data', { mime: 'image/png' }],
      ['empty data', { mime: 'image/png', data: '' }],
      ['a quote', { mime: 'image/png', data: `${data.slice(0, -4)}"><x` }],
      ['a space', { mime: 'image/png', data: 'AA AA' }],
      ['a comma', { mime: 'image/png', data: 'AA,A' }],
      ['url-safe', { mime: 'image/png', data: 'AA-_' }],
      ['not padded', { mime: 'image/png', data: 'AAAAA' }],
      ['padding inside', { mime: 'image/png', data: 'A=AA' }],
      ['not a string', { mime: 'image/png', data: ['AAAA'] }],
      ['over the limit', { mime: 'image/png', data: 'A'.repeat(4 * Math.ceil(IMAGE_MAX_BYTES / 3) + 4) }],
    ]) {
      assert.equal(imageDataUri(image), null, what);
    }
    // At the limit is one.
    assert.ok(imageDataUri({ mime: 'image/png', data: 'A'.repeat(4 * Math.ceil(IMAGE_MAX_BYTES / 3)) }));
    for (const nothing of [null, undefined, 'data:image/png;base64,AAAA', 7]) assert.equal(imageDataUri(nothing), null);
  });

  test('IP-22: the fit scale shrinks a large image to the pane and never enlarges a small one', () => {
    assert.equal(fitScale({ width: 4, height: 3 }, { width: 800, height: 600 }), 1, 'a small image stays at 100%');
    assert.equal(fitScale({ width: 800, height: 600 }, { width: 800, height: 600 }), 1, 'exactly the pane');
    assert.equal(fitScale({ width: 1920, height: 1080 }, { width: 960, height: 1080 }), 0.5, 'by the width');
    assert.equal(fitScale({ width: 1000, height: 4000 }, { width: 800, height: 600 }), 0.15, 'by the height');
    // A very large image is fitted whole, below the zoom buttons' 10%.
    const tiny = fitScale({ width: 32768, height: 1024 }, { width: 800, height: 600 });
    assert.equal(tiny, 800 / 32768);
    assert.ok(tiny < ZOOM_MIN);
    for (const width of [1, 7, 799, 800, 801, 3000, 32768]) {
      for (const height of [1, 5, 599, 600, 601, 2000, 32768]) {
        const scale = fitScale({ width, height }, { width: 800, height: 600 });
        assert.ok(scale > 0 && scale <= 1, `${width} × ${height}: ${scale}`);
        assert.ok(width * scale <= 800 + 1e-9 && height * scale <= 600 + 1e-9, `${width} × ${height} fits`);
      }
    }
    // Nothing to fit to or by: 100%.
    for (const [image, pane] of [
      [{ width: null, height: null }, { width: 800, height: 600 }],
      [{ width: 0, height: 10 }, { width: 800, height: 600 }],
      [{ width: Number.NaN, height: 10 }, { width: 800, height: 600 }],
      [{ width: -5, height: 10 }, { width: 800, height: 600 }],
      [{ width: 4000, height: 3000 }, { width: 0, height: 0 }],
      [{ width: 4000, height: 3000 }, { width: Infinity, height: 600 }],
      [{ width: '4000', height: 3000 }, { width: 800, height: 600 }],
      [null, { width: 800, height: 600 }],
      [{ width: 4000, height: 3000 }, undefined],
    ]) {
      assert.equal(fitScale(image, pane), 1, JSON.stringify([image, pane]));
    }
  });

  test('IP-23: the zoom buttons step between 10% and 800% and stay there; zoom out never enlarges a fit below 10%', () => {
    assert.deepEqual([ZOOM_MIN, ZOOM_MAX], [0.1, 8]);
    assert.deepEqual([ZOOM_STEPS[0], ZOOM_STEPS.at(-1)], [ZOOM_MIN, ZOOM_MAX]);
    assert.ok(ZOOM_STEPS.includes(1), '100% is a step');
    assert.deepEqual([...ZOOM_STEPS], [...ZOOM_STEPS].sort((a, b) => a - b), 'smallest first');
    assert.equal(new Set(ZOOM_STEPS).size, ZOOM_STEPS.length);

    // Up from 100% to 800%, then no further.
    const up = [1];
    while (canZoomIn(up.at(-1))) up.push(zoomIn(up.at(-1)));
    assert.deepEqual(up, ZOOM_STEPS.slice(ZOOM_STEPS.indexOf(1)));
    assert.equal(zoomIn(ZOOM_MAX), ZOOM_MAX);
    // Down from 100% to 10%, then no further.
    const down = [1];
    while (canZoomOut(down.at(-1))) down.push(zoomOut(down.at(-1)));
    assert.deepEqual(down, ZOOM_STEPS.slice(0, ZOOM_STEPS.indexOf(1) + 1).reverse());
    assert.equal(zoomOut(ZOOM_MIN), ZOOM_MIN);

    // Between steps, and floating-point noise on one.
    assert.deepEqual([zoomIn(0.3), zoomOut(0.3)], [0.5, 0.25]);
    assert.deepEqual([zoomIn(0.7500000001), zoomOut(0.7499999999)], [1, 0.5]);
    // A fit below 10%: in goes to 10%, out stays.
    assert.deepEqual([zoomIn(0.024), zoomOut(0.024), canZoomOut(0.024), canZoomIn(0.024)], [0.1, 0.024, false, true]);
    // Out of range, or not a number.
    assert.deepEqual([zoomIn(50), zoomOut(50), canZoomIn(50)], [ZOOM_MAX, ZOOM_MAX, false]);
    assert.deepEqual([zoomIn(Number.NaN), zoomOut(undefined)], [zoomIn(1), zoomOut(1)]);
    for (let scale = 0.1; scale <= 8; scale += 0.05) {
      for (const next of [zoomIn(scale), zoomOut(scale)]) assert.ok(next >= ZOOM_MIN && next <= ZOOM_MAX, `${scale} -> ${next}`);
      assert.ok(zoomIn(scale) >= scale - 1e-9 && zoomOut(scale) <= scale + 1e-9, `${scale}: in never shrinks, out never enlarges`);
    }

    assert.deepEqual([0.01, 0.1, 0.5, 8, 100].map(clampZoom), [0.1, 0.1, 0.5, 8, 8]);
    assert.deepEqual([Number.NaN, Infinity, -Infinity, '2', null].map(clampZoom), [1, 1, 1, 1, 1]);
    assert.deepEqual([1, 0.25, 8, 0.1, 1.5, 800 / 32768, 0.004].map(zoomLabel), ['100%', '25%', '800%', '10%', '150%', '2%', '<1%']);
  });

  test('IP-24: the label says "1920 × 1080 · 2.4 MB", and an SVG\'s has no dimensions', () => {
    assert.equal(imageSizeLabel({ mime: 'image/png', width: 1920, height: 1080, bytes: Math.round(2.4 * MB) }), '1920 \u{00d7} 1080 \u{00b7} 2.4 MB');
    assert.equal(imageSizeLabel({ mime: 'image/png', width: 1920, height: 1080, bytes: Math.round(2.4 * MB) }), '1920 × 1080 · 2.4 MB');
    assert.equal(imageSizeLabel({ mime: 'image/svg+xml', width: null, height: null, bytes: 3174 }), 'SVG \u{00b7} 3.1 KB');
    assert.equal(imageSizeLabel({ mime: 'image/png', width: 4, height: 3, bytes: 80 }), '4 \u{00d7} 3 \u{00b7} 80 B');
    assert.equal(imageSizeLabel({ mime: 'image/gif', width: 980, height: 442 }), '980 \u{00d7} 442', 'no size on disk known');
    assert.equal(imageSizeLabel({ mime: 'image/png', width: 0, height: 3, bytes: 80 }), '80 B', 'no valid dimensions');
    assert.equal(imageSizeLabel({ mime: 'image/png', width: 1.5, height: 3 }), '');
    assert.equal(imageSizeLabel(null), '');
    assert.equal(imageSizeLabel({}), '');

    assert.deepEqual(
      [0, 1, 1023, 1024, 1536, 1048524, 1048575, MB, 20 * MB, 20 * MB + 1, 1024 * MB].map(formatImageBytes),
      ['0 B', '1 B', '1023 B', '1.0 KB', '1.5 KB', '1023.9 KB', '1.0 MB', '1.0 MB', '20.0 MB', '20.0 MB', '1.0 GB']
    );
    for (const odd of [-1, 1.5, Number.NaN, Infinity, '5', null, undefined, 2 ** 60]) assert.equal(formatImageBytes(odd), '', String(odd));
  });

  test('IP-25: the reason for each refusal is the backend\'s words without the path — told by the words even when the path is the resolved one', () => {
    const words = rustWords();
    const asked = '/w/pics/logo.png';
    const resolved = '/Volumes/Work/pics/Logo.png';
    const cases = [
      [`${words.NOT_FOUND}: ${resolved}`, words.NOT_FOUND, 'not-found'],
      ...rustWhys().map((why) => [`${words.NOT_AN_IMAGE} (${why}): ${resolved}`, `${words.NOT_AN_IMAGE} (${why})`, 'not-an-image']),
      [`${words.TOO_LARGE} (25.0 MB; the limit is 20 MB): ${resolved}`, `${words.TOO_LARGE} (25.0 MB; the limit is 20 MB)`, 'too-large'],
      [
        `${words.TOO_LARGE} (100000 \u{00d7} 100000; the limit is 32768 px per side and 32 Mi pixels): ${resolved}`,
        `${words.TOO_LARGE} (100000 \u{00d7} 100000; the limit is 32768 px per side and 32 Mi pixels)`,
        'too-large',
      ],
    ];
    for (const [text, reason, kind] of cases) {
      assert.equal(imageFailureReason(text, asked), reason, text);
      assert.equal(imageFailureReason(new Error(text), asked), reason, 'an Error, as the mock rejects');
      assert.equal(imageFailureReason(text), reason, 'no path given');
      assert.equal(imageRefusalKind(text), kind, text);
    }
    // A path that itself holds ": " and brackets.
    const odd = '/w/a (copy): b.png';
    assert.equal(imageFailureReason(`${words.NOT_AN_IMAGE} (its header is not valid): ${odd}`, odd), `${words.NOT_AN_IMAGE} (its header is not valid)`);
    assert.equal(imageFailureReason(`${words.NOT_FOUND}: ${odd}`, '/elsewhere'), words.NOT_FOUND);
  });

  test('IP-26: the confinement\'s words stay readable, a failed read says why, and someone else\'s characters never reach the line', () => {
    assert.equal(imageFailureReason('No folder is open', '/w/a.png'), 'No folder is open');
    assert.equal(imageFailureReason('Path is outside the workspace root (/work): ../x.png', '../x.png'), 'Path is outside the workspace root (/work)');
    assert.equal(
      imageFailureReason('Path goes through a broken link (/work/l): /work/l/x.png', '/work/l/x.png'),
      'Path goes through a broken link (/work/l)'
    );
    assert.equal(imageRefusalKind('No folder is open'), 'failed');
    assert.equal(
      imageFailureReason("Failed to read file '/w/a.png': Permission denied (os error 13)", '/elsewhere'),
      'Failed to read file: Permission denied (os error 13)'
    );
    assert.equal(imageRefusalKind("Failed to read file '/w/a.png': Permission denied (os error 13)"), 'failed');
    // The fixed words count only where a refusal starts with them.
    assert.equal(imageRefusalKind('Path is outside the workspace root (/large): ../Image is too large to preview (1).png'), 'failed');
    assert.equal(imageRefusalKind(' File not found: /w/a.png'), 'not-found', 'white space around it is not part of it');
    assert.equal(imageRefusalKind('File not found'), 'failed', 'no path: not the backend\'s refusal');
    // Not the path asked for and none of the fixed words: shown whole.
    assert.equal(imageFailureReason('Path is on another machine or a device: //h/s/a.png', '/w/a.png'), 'Path is on another machine or a device: //h/s/a.png');
    for (const nothing of ['', '   ', null, undefined, new Error('')]) assert.equal(imageFailureReason(nothing, '/w/a.png'), 'Unknown error');

    // ESC, BEL, a bidi override and a zero-width space in a folder's name.
    const root = '/work/\u{1b}[31mred\u{7}\u{202e}gnp.exe\u{200b}';
    const reason = imageFailureReason(`Path is outside the workspace root (${root}): ../x.png`, '../x.png');
    assert.equal(reason, 'Path is outside the workspace root (/work/[31mredgnp.exe)');
    assert.equal(/[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/u.test(reason), false);
    assert.ok(imageFailureReason(`${'x'.repeat(5000)}`).length <= 300, 'cut at 300 characters');
    // A refusal with someone else's characters in it is cleaned too.
    assert.equal(imageFailureReason(`${rustWords().NOT_FOUND}\u{202e}: /x`, '/x'), 'File not found');
  });

  test('IP-27: the mock\'s every refusal reads as its words without the path', async () => {
    await withImages({ '/w/big.png': { ...pngOf(8, 8), bytes: 25 * MB }, '/w/huge.png': pngOf(100000, 100000) }, async () => {
      for (const path of ['/workspace/nope.png', '/workspace/README.md', '/workspace/src', '/w/big.png', '/w/huge.png']) {
        let err = null;
        try {
          await mockBridge.invoke('fs_read_image', { path });
        } catch (e) {
          err = e;
        }
        assert.ok(err, path);
        assert.equal(imageFailureReason(err, path), err.message.slice(0, -(path.length + 2)), path);
        assert.notEqual(imageRefusalKind(err), 'failed', path);
      }
    });
  });

  test('IP-28: the alt text is the file name, cleaned', () => {
    assert.equal(imageAltText('/w/pics/logo.png'), 'logo.png');
    assert.equal(imageAltText('C:\\pics\\Shot 1.WEBP'), 'Shot 1.WEBP');
    assert.equal(imageAltText('/w/\u{1b}]0;x\u{7}evil\u{202e}gnp.exe\u{200b}.png'), ']0;xevilgnp.exe.png');
    assert.ok(imageAltText(`/w/${'a'.repeat(500)}.png`).length <= 120);
    for (const nothing of ['', '/', null, undefined, 3]) assert.equal(imageAltText(nothing), 'Image', String(nothing));
  });
});
