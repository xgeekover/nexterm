/**
 * Terminal themes from outside the app (spec P5): what an imported file may
 * contain, what is made of it, and how every place that draws a terminal
 * finds a theme by id.
 *
 * A theme file is something a user downloaded from somewhere and hands to the
 * app, so these cases treat it as hostile: too big, not text, an XML document
 * that declares entities (the "billion laughs" shape), numbers that are not
 * numbers, colours that are not colours, names with bidirectional overrides.
 * Every refusal must say why in words a user can act on — a theme that is
 * silently not imported reads as a broken button.
 *
 * The parsers are pure (src/lib/themeImport.js); the resolver is pure
 * (src/lib/terminalThemes.js). The registry's use of them is held by slicing
 * its functions out of the source, as the other registry cases do: the
 * registry itself imports @xterm, which needs a canvas.
 */
import { readFileSync } from 'node:fs';
import { cleanBranchName } from '../../src/lib/terminalStatus.js';
import { describe, test, assert } from '../e2e/harness/testFramework.js';
import {
  THEME_FILE_MAX_BYTES,
  addCustomTheme,
  cleanThemeName,
  customThemeId,
  normalizeHexColor,
  parsePlist,
  readThemeFile,
  relativeLuminance,
  removeCustomTheme,
  sanitizeCustomThemes,
  shownName,
} from '../../src/lib/themeImport.js';
import {
  ANSI_COLOR_KEYS,
  DEFAULT_TERMINAL_THEME_ID,
  MAX_CUSTOM_THEMES,
  THEME_COLOR_KEYS,
  TERMINAL_THEMES,
  TERMINAL_THEME_IDS,
  getTerminalThemeEntry,
  shownTerminalThemeId,
  terminalThemeChoices,
  themeColorsOf,
} from '../../src/lib/terminalThemes.js';

// ---- Fixtures ------------------------------------------------------------------

const DRACULA_PALETTE = [
  '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
  '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff',
];

/** A complete Ghostty theme file, as Ghostty's own theme directory ships them. */
const GHOSTTY_FULL = [
  ...DRACULA_PALETTE.map((hex, i) => `palette = ${i}=${hex}`),
  'background = #282a36',
  'foreground = #f8f8f2',
  'cursor-color = #f8f8f2',
  'cursor-text = #282a36',
  'selection-background = #44475a',
  'selection-foreground = #ffffff',
].join('\n');

/** One Windows Terminal scheme — note `purple`, not `magenta`. */
const WT_CAMPBELL = {
  name: 'Campbell',
  background: '#0C0C0C',
  foreground: '#CCCCCC',
  cursorColor: '#FFFFFF',
  selectionBackground: '#FFFFFF',
  black: '#0C0C0C',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  purple: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightPurple: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2',
};
const WT_ONE_HALF_LIGHT = { ...WT_CAMPBELL, name: 'One Half Light', background: '#FAFAFA', foreground: '#383A42' };
const WT_ONE_HALF_DARK = { ...WT_CAMPBELL, name: 'One Half Dark', background: '#282C34', foreground: '#DCDFE4' };

const DOCTYPE = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';

/** An iTerm2 colour dictionary, as iTerm2 writes it — `Color Space` and `Alpha` included. */
function itermColor([r, g, b], { space = 'sRGB', alpha = 1 } = {}) {
  return [
    '\t<dict>',
    '\t\t<key>Alpha Component</key>',
    `\t\t<real>${alpha}</real>`,
    '\t\t<key>Blue Component</key>',
    `\t\t<real>${b}</real>`,
    ...(space === null ? [] : ['\t\t<key>Color Space</key>', `\t\t<string>${space}</string>`]),
    '\t\t<key>Green Component</key>',
    `\t\t<real>${g}</real>`,
    '\t\t<key>Red Component</key>',
    `\t\t<real>${r}</real>`,
    '\t</dict>',
  ].join('\n');
}

const hexToFloats = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** A whole .itermcolors file. `colors` maps iTerm2 keys to [r, g, b] floats or raw XML. */
function itermFile(colors, { doctype = DOCTYPE, declaration = '<?xml version="1.0" encoding="UTF-8"?>', space } = {}) {
  const body = Object.entries(colors)
    .map(([key, value]) => `\t<key>${key}</key>\n${typeof value === 'string' ? value : itermColor(value, { space })}`)
    .join('\n');
  return [declaration, doctype, '<plist version="1.0">', '<dict>', body, '</dict>', '</plist>', '']
    .filter((line) => line !== null)
    .join('\n');
}

function itermDracula(extra = {}, options) {
  const colors = {};
  DRACULA_PALETTE.forEach((hex, i) => {
    colors[`Ansi ${i} Color`] = hexToFloats(hex);
  });
  colors['Background Color'] = hexToFloats('#282a36');
  colors['Foreground Color'] = hexToFloats('#f8f8f2');
  colors['Cursor Color'] = hexToFloats('#f8f8f2');
  colors['Cursor Text Color'] = hexToFloats('#282a36');
  colors['Selection Color'] = hexToFloats('#44475a');
  return itermFile({ ...colors, ...extra }, options);
}

/** The one scheme of a file that holds one, or a failure naming why there is none. */
function only(result) {
  assert.ok(result.ok, `refused: ${result.error}`);
  assert.equal(result.schemes.length, 1, 'expected exactly one scheme');
  return result.schemes[0];
}

/** The refusal of a file, failing if it was accepted. */
function refusal(result) {
  assert.equal(result.ok, false, `accepted what should be refused: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 10, `a refusal must say why: "${result.error}"`);
  return result.error;
}

// ---- Ghostty --------------------------------------------------------------------

describe('Theme import: Ghostty theme files', () => {
  test('TI-01: a complete Ghostty theme becomes a complete xterm theme, named after its file', () => {
    const scheme = only(readThemeFile(GHOSTTY_FULL, 'Dracula'));
    assert.equal(readThemeFile(GHOSTTY_FULL, 'Dracula').format, 'ghostty');
    assert.equal(scheme.ok, true);
    assert.equal(scheme.name, 'Dracula');
    ANSI_COLOR_KEYS.forEach((key, i) => assert.equal(scheme.theme[key], DRACULA_PALETTE[i], key));
    assert.equal(scheme.theme.background, '#282a36');
    assert.equal(scheme.theme.foreground, '#f8f8f2');
    assert.equal(scheme.theme.cursor, '#f8f8f2');
    assert.equal(scheme.theme.cursorAccent, '#282a36');
    assert.equal(scheme.theme.selectionBackground, '#44475a');
    assert.deepEqual(scheme.filled, [], 'nothing was missing');
    for (const key of Object.keys(scheme.theme)) assert.ok(THEME_COLOR_KEYS.includes(key), `stray key ${key}`);
  });

  test('TI-02: comments, CRLF, quotes, short and bare hex, case, duplicates, other settings', () => {
    const text = [
      '# a comment = not a setting',
      '',
      '   palette = 1 = #F55   ',
      'palette = 2="#50FA7B"',
      'palette = 3=f1fa8c',
      'palette = 200=#000000',
      'font-family = "JetBrains Mono"',
      'background = #111111',
      'background = #282A36',
      'foreground=#f8f8f2',
    ].join('\r\n');
    const scheme = only(readThemeFile(text, 'mixed.conf'));
    assert.equal(scheme.name, 'mixed', 'a known extension is not part of the name');
    assert.equal(scheme.theme.red, '#ff5555', '#rgb is widened');
    assert.equal(scheme.theme.green, '#50fa7b', 'quoted and upper case');
    assert.equal(scheme.theme.yellow, '#f1fa8c', 'Ghostty takes hex without #');
    assert.equal(scheme.theme.background, '#282a36', 'the last of a repeated key wins, as in Ghostty');
    assert.equal(scheme.theme.cursor, '#f8f8f2', 'no cursor-color: the cursor is the foreground');
    assert.equal(scheme.theme.cursorAccent, '#282a36', 'no cursor-text: the background');
    assert.ok(!('font-family' in scheme.theme));
  });

  test('TI-03: colours the file leaves out are listed, and filled from the default theme where it is drawn', () => {
    const scheme = only(readThemeFile('background = #1e1e2e\nforeground = #cdd6f4\npalette = 1=#f38ba8', 'partial'));
    assert.deepEqual(
      scheme.filled,
      THEME_COLOR_KEYS.filter((k) => !['background', 'foreground', 'red', 'cursor', 'cursorAccent'].includes(k)),
      'filled lists exactly what came from the default, in a stable order'
    );
    for (const key of scheme.filled) assert.ok(!(key in scheme.theme), `${key} is stored though the file never gave it`);
    const app = Object.fromEntries(THEME_COLOR_KEYS.map((k) => [k, `token:${k}`]));
    const drawn = themeColorsOf({ custom: true, theme: scheme.theme }, app);
    assert.equal(drawn.red, '#f38ba8');
    assert.equal(drawn.green, 'token:green', 'a missing colour is the default theme\'s');
    for (const key of THEME_COLOR_KEYS) assert.ok(drawn[key], `${key} is not drawn at all`);
  });

  test('TI-04: a colour that is not a colour refuses the theme and names it', () => {
    for (const [line, mention] of [
      ['palette = 1=red', 'palette 1'],
      ['background = #12345', 'background'],
      ['foreground = #ggg', 'foreground'],
      ['cursor-color = rgb(1,2,3)', 'cursor-color'],
      ['background =', 'background'],
      ['palette = 99999999999999999999=#000000', 'palette'],
      ['palette = x=#000000', 'palette'],
      ['palette = -1=#000000', 'palette'],
    ]) {
      const error = refusal(readThemeFile(`foreground = #ffffff\n${line}`, 'bad'));
      assert.ok(error.includes(mention), `"${line}" refused without naming ${mention}: ${error}`);
    }
  });

  test('TI-05: nothing to read, or not text at all', () => {
    assert.match(refusal(readThemeFile('', 'empty')), /empty/i);
    assert.match(refusal(readThemeFile('   \n\n', 'blank')), /empty/i);
    assert.match(refusal(readThemeFile('hello world\nthis is a letter', 'letter.txt')), /No terminal colours/);
    assert.match(refusal(readThemeFile('background = #000000\u{0}\u{1}', 'binary')), /not a text file/);
    assert.match(refusal(readThemeFile(null, 'nothing')), /empty|not a text file/);
  });
});

// ---- Windows Terminal ---------------------------------------------------------

describe('Theme import: Windows Terminal color schemes', () => {
  test('TI-06: one scheme object; purple is magenta, cursorColor the cursor', () => {
    const result = readThemeFile(JSON.stringify(WT_CAMPBELL, null, 2), 'campbell.json');
    assert.equal(result.format, 'windows-terminal');
    const scheme = only(result);
    assert.equal(scheme.name, 'Campbell', 'the scheme\'s own name, not the file\'s');
    assert.equal(scheme.theme.magenta, '#881798');
    assert.equal(scheme.theme.brightMagenta, '#b4009e');
    assert.equal(scheme.theme.cursor, '#ffffff');
    assert.equal(scheme.theme.selectionBackground, '#ffffff');
    assert.equal(scheme.theme.background, '#0c0c0c', 'stored lower case');
    assert.deepEqual(scheme.filled, []);
  });

  test('TI-07: a schemes list offers each scheme, a light one refused with its reason', () => {
    const result = readThemeFile(JSON.stringify({ schemes: [WT_CAMPBELL, WT_ONE_HALF_LIGHT, WT_ONE_HALF_DARK, 7, null] }), 'settings.json');
    assert.ok(result.ok, result.error);
    assert.deepEqual(result.schemes.map((s) => s.ok), [true, false, true, false, false]);
    assert.deepEqual(result.schemes.slice(0, 3).map((s) => s.name), ['Campbell', 'One Half Light', 'One Half Dark']);
    assert.match(result.schemes[1].error, /light background/);
    assert.match(result.schemes[3].error, /not a color scheme/);
    // A bare array of schemes is the same thing.
    const bare = readThemeFile(JSON.stringify([WT_CAMPBELL, WT_ONE_HALF_DARK]), 'list.json');
    assert.deepEqual(bare.schemes.map((s) => s.name), ['Campbell', 'One Half Dark']);
    // One scheme in a list is just that scheme.
    assert.equal(only(readThemeFile(JSON.stringify({ schemes: [WT_ONE_HALF_DARK] }), 's.json')).name, 'One Half Dark');
  });

  test('TI-08: a whole settings.json, comments and trailing commas included', () => {
    const text = `// This file was initially generated by Windows Terminal
{
    "$schema": "https://aka.ms/terminal-profiles-schema", // a URL is not a comment
    "defaultProfile": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}",
    /* the profiles,
       several lines */
    "profiles": { "list": [ { "name": "cmd", "commandline": "cmd.exe /k \\"echo //\\"", }, ], },
    "schemes": [
        ${JSON.stringify({ ...WT_ONE_HALF_DARK, name: 'Slash // Star /* Name' })},
    ],
}`;
    const scheme = only(readThemeFile(text, 'settings.json'));
    assert.equal(scheme.name, 'Slash // Star /* Name', 'comment markers inside a string are text');
    assert.equal(scheme.theme.background, '#282c34');
    // A trailing comma with a comment between it and the bracket.
    const commented = `{ "schemes": [ ${JSON.stringify(WT_ONE_HALF_DARK)}, // the last one\n /* and a note */ ], /* end */ }`;
    assert.equal(only(readThemeFile(commented, 'c.json')).name, 'One Half Dark');
  });

  test('TI-09: broken JSON, wrong types and hostile shapes are refused, never thrown', () => {
    assert.match(refusal(readThemeFile('{ "background": "#000000", ', 'cut.json')), /not valid JSON/);
    assert.match(refusal(readThemeFile('{"profiles": {}}', 'no-schemes.json')), /No Windows Terminal color scheme/);
    assert.match(refusal(readThemeFile('"just a string"', 'string.json')), /No Windows Terminal color scheme/);
    for (const [bad, key] of [
      [{ background: 12 }, 'background'],
      [{ black: ['#000000'] }, 'black'],
      [{ red: { r: 1 } }, 'red'],
      [{ green: '#12345' }, 'green'],
      [{ blue: 'blue' }, 'blue'],
      [{ cursorColor: true }, 'cursorColor'],
    ]) {
      const error = refusal(readThemeFile(JSON.stringify({ ...WT_CAMPBELL, ...bad }), 'bad.json'));
      assert.ok(error.includes(key), `refused without naming ${key}: ${error}`);
    }
    // A name that is not text falls back to the file's.
    assert.equal(only(readThemeFile(JSON.stringify({ ...WT_CAMPBELL, name: { evil: 1 } }), 'Fallback.json')).name, 'Fallback');
    // `__proto__` is an own key of what JSON.parse returns; nothing may reach Object.prototype.
    const proto = readThemeFile(`{"__proto__": {"background": "#ffffff"}, ${JSON.stringify(WT_CAMPBELL).slice(1)}`, 'proto.json');
    assert.ok(proto.ok);
    assert.equal({}.background, undefined, 'Object.prototype was polluted');
    // Deep nesting and huge numbers.
    assert.equal(readThemeFile(`${'['.repeat(20000)}${']'.repeat(20000)}`, 'deep.json').ok, false);
    assert.match(refusal(readThemeFile('{"background": 1e999, "foreground": "#ffffff"}', 'huge.json')), /background/);
    // Hundreds of schemes: offered, but not without end.
    const many = readThemeFile(JSON.stringify({ schemes: Array.from({ length: 500 }, (_, i) => ({ ...WT_CAMPBELL, name: `S${i}` })) }), 'many.json');
    assert.ok(many.ok && many.schemes.length <= 100, `offered ${many.schemes?.length} schemes`);
  });
});

// ---- iTerm2 -------------------------------------------------------------------

describe('Theme import: iTerm2 .itermcolors', () => {
  test('TI-10: an .itermcolors file as iTerm2 writes it — declaration, Apple DOCTYPE, Color Space', () => {
    const result = readThemeFile(itermDracula(), 'Dracula.itermcolors');
    assert.equal(result.format, 'iterm2');
    const scheme = only(result);
    assert.equal(scheme.name, 'Dracula');
    ANSI_COLOR_KEYS.forEach((key, i) => assert.equal(scheme.theme[key], DRACULA_PALETTE[i], key));
    assert.equal(scheme.theme.background, '#282a36');
    assert.equal(scheme.theme.cursorAccent, '#282a36');
    assert.equal(scheme.theme.selectionBackground, '#44475a');
    assert.deepEqual(scheme.filled, []);
    // Older iTerm2 wrote "Apple Computer" in the DOCTYPE, and no Color Space at all.
    const older = itermDracula({}, { doctype: DOCTYPE.replace('Apple//', 'Apple Computer//'), space: null });
    assert.equal(only(readThemeFile(older, 'Old.itermcolors')).theme.red, '#ff5555');
    // No declaration and no DOCTYPE is fine too.
    assert.equal(only(readThemeFile(itermDracula({}, { doctype: '', declaration: '' }), 'Bare.itermcolors')).theme.red, '#ff5555');
  });

  test('TI-11: Color Space is read, not tripped over — P3 is converted to sRGB', () => {
    const gray = only(readThemeFile(itermFile({ 'Background Color': [0.2, 0.2, 0.2] }, { space: 'P3' }), 'p3.itermcolors'));
    assert.equal(gray.theme.background, '#333333', 'a grey is the same grey in both spaces');
    const red = only(readThemeFile(itermFile({ 'Background Color': [0.1, 0.1, 0.1], 'Ansi 1 Color': [0.8, 0.2, 0.2] }, { space: 'P3' }), 'p3.itermcolors'));
    const [r, g] = [parseInt(red.theme.red.slice(1, 3), 16), parseInt(red.theme.red.slice(3, 5), 16)];
    assert.ok(r > 0xcc && g < 0x33, `P3 red was read as sRGB: ${red.theme.red}`);
    for (const space of ['Calibrated', 'Device', 'something new', '']) {
      const scheme = only(readThemeFile(itermFile({ 'Background Color': [0.2, 0.2, 0.2] }, { space }), 's.itermcolors'));
      assert.equal(scheme.theme.background, '#333333', `Color Space "${space}"`);
    }
    // A Color Space that is not even a string is ignored, not fatal.
    const odd = itermFile({ 'Background Color': itermColor([0.2, 0.2, 0.2]).replace('<string>sRGB</string>', '<integer>7</integer>') });
    assert.equal(only(readThemeFile(odd, 'odd.itermcolors')).theme.background, '#333333');
  });

  test('TI-12: DOCTYPE with declarations, entities and processing instructions are refused', () => {
    const laughs = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE plist [',
      '  <!ENTITY lol "lol">',
      '  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
      '  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">',
      ']>',
      '<plist version="1.0"><dict><key>&lol3;</key><string>x</string></dict></plist>',
    ].join('\n');
    assert.match(refusal(readThemeFile(laughs, 'laughs.itermcolors')), /document type of its own, with declarations in it/);
    // The one DOCTYPE let through, once and only before the document.
    assert.match(refusal(readThemeFile(itermDracula({}, { doctype: `${DOCTYPE}\n${DOCTYPE}` }), 'x.itermcolors')), /document type of its own/);
    assert.match(refusal(readThemeFile(itermDracula().replace('<dict>', `<dict>${DOCTYPE}`), 'x.itermcolors')), /document type of its own/);
    assert.match(refusal(readThemeFile(itermDracula({}, { doctype: '<!DOCTYPE plist SYSTEM "file:///etc/passwd">' }), 'x.itermcolors')), /document type/);
    assert.match(refusal(readThemeFile(itermDracula({}, { doctype: `${DOCTYPE}\n<!ENTITY x "y">` }), 'x.itermcolors')), /entit/);
    assert.match(refusal(readThemeFile(itermDracula().replace('<key>Ansi 0 Color</key>', '<key>Ansi &x; Color</key>'), 'x.itermcolors')), /entity "&x;"/);
    assert.match(refusal(readThemeFile(itermDracula().replace('<plist', '<?xml-stylesheet href="evil.xsl"?>\n<plist'), 'x.itermcolors')), /processing instruction/);
    assert.match(refusal(readThemeFile(itermDracula({}, { declaration: '' }).replace('<dict>', '<dict><?php echo 1 ?>'), 'x.itermcolors')), /processing instruction/);
    // A second declaration, after the first, is a processing instruction.
    assert.match(refusal(readThemeFile(itermDracula().replace('<plist', '<?xml version="1.0"?><plist'), 'x.itermcolors')), /processing instruction/);
    assert.match(refusal(readThemeFile(itermDracula().replace('<string>sRGB</string>', '<string><![CDATA[sRGB]]></string>'), 'x.itermcolors')), /CDATA/);
    // The five XML entities and character references are text, not declarations.
    const named = itermDracula().replace('<string>sRGB</string>', '<string>s&#x52;GB &amp; &lt;&gt;&quot;&apos; &#65;</string>');
    assert.equal(only(readThemeFile(named, 'ok.itermcolors')).theme.red, '#ff5555');
    assert.match(refusal(readThemeFile(itermDracula().replace('<string>sRGB</string>', '<string>&#xFFFFFFF;</string>'), 'x.itermcolors')), /character reference/);
  });

  test('TI-13: components that are not numbers in 0–1, and structures that are not plists', () => {
    for (const [raw, why] of [
      ['NaN', 'number'],
      ['nan', 'number'],
      ['1e999', 'between 0 and 1'],
      ['-0.5', 'between 0 and 1'],
      ['1.5', 'between 0 and 1'],
      ['abc', 'number'],
      ['', 'number'],
      ['0x1', 'number'],
      ['Infinity', 'number'],
    ]) {
      const file = itermDracula({ 'Background Color': itermColor([0.1, 0.1, 0.1]).replace('<real>0.1</real>', `<real>${raw}</real>`) });
      const error = refusal(readThemeFile(file, 'x.itermcolors'));
      assert.ok(error.includes('Background Color'), `"${raw}" refused without naming the colour: ${error}`);
      assert.ok(error.includes(why), `"${raw}": ${error}`);
    }
    // Float noise from iTerm2's own conversions is not a reason to refuse.
    const noise = itermFile({ 'Background Color': [1.0000000000000002e-7, -1e-9, 0.1] });
    assert.equal(only(readThemeFile(noise, 'n.itermcolors')).theme.background, '#00001a');
    const asString = itermDracula({ 'Background Color': itermColor([0.1, 0.1, 0.1]).replace('<real>0.1</real>', '<string>0.1</string>') });
    assert.match(refusal(readThemeFile(asString, 'x.itermcolors')), /Background Color/);
    const missing = itermDracula({ 'Background Color': '\t<dict><key>Red Component</key><real>0.1</real></dict>' });
    assert.match(refusal(readThemeFile(missing, 'x.itermcolors')), /Background Color.*(Green|Blue) Component/);
    const notDict = itermDracula({ 'Background Color': '\t<string>#000000</string>' });
    assert.match(refusal(readThemeFile(notDict, 'x.itermcolors')), /Background Color/);

    const deep = `<plist version="1.0">${'<dict><key>a</key>'.repeat(60)}<true/>${'</dict>'.repeat(60)}</plist>`;
    assert.match(refusal(readThemeFile(deep, 'deep.itermcolors')), /nested/);
    // Refused by the parser itself, each for its own reason — not merely for
    // holding no colours, which would pass this case with the parser broken.
    assert.ok(parsePlist('<plist version="1.0"><dict><key>a</key><true/></dict></plist>').ok, 'setup: the well-formed one');
    for (const [broken, why] of [
      ['<plist version="1.0"><dict><key>a</key></dict></plist>', /key with no value/],
      ['<plist version="1.0"><dict><string>a</string><true/></dict></plist>', /value where a key belongs/],
      ['<plist version="1.0"><dict><key>a</key><key>b</key></dict></plist>', /key where a value belongs/],
      ['<plist version="1.0"><dict><key>a</key><true/></array></plist>', /closes <dict>/],
      ['<plist version="1.0"><dict>loose text<key>a</key><true/></dict></plist>', /text outside a value/],
      ['<plist version="1.0"><dict><key>a</key><script>x</script></dict></plist>', /<script> element/],
      ['<plist version="1.0"><dict><key>a</key><true/></dict>', /ends before <plist> is closed/],
      ['<plist version="1.0"><dict><key>a</key><true>yes</true></dict></plist>', /text outside a value/],
      ['<plist version="1.0"><dict></dict></plist><plist/>', /second <plist>/],
      ['<plist version="1.0"><dict></dict><dict></dict></plist>', /exactly one value/],
      ['<html><body>hi</body></html>', /<html> element/],
      ['<dict><key>a</key><true/></dict>', /outside <plist>/],
      ['<plist version="1.0"><dict><key a="1>2">a</key><true/></dict></plist>', /attributes/],
      ['<plist version="1.0"><dict><key>a</key><true/></dict></plist', /end tag that cannot be read/],
      ['<plist version="1.0"><array><key>a</key></array></plist>', /<key> is outside a <dict>/],
      ['<plist version="1.0"><dict><key>a<string>b</string></key></dict></plist>', /<string> is inside <key>/],
      ['<plist version="1.0"><dict><key>a & b</key><true/></dict></plist>', /"&" that starts no entity/],
      ['<plist version="1.0"><!-- never closed <dict/></plist>', /comment is never closed/],
      ['<?xml version="2.0" bogus="1"?><plist version="1.0"><dict/></plist>', /XML declaration/],
      [`<plist version="1.0">${'<array>'.repeat(5)}${'<true/>'.repeat(30000)}${'</array>'.repeat(5)}</plist>`, /more elements/],
    ]) {
      const parsed = parsePlist(broken);
      assert.equal(parsed.ok, false, `accepted: ${broken.slice(0, 80)}`);
      assert.match(parsed.error, why);
    }
    assert.match(refusal(readThemeFile('<plist version="1.0"><array><true/></array></plist>', 'a.itermcolors')), /not an iTerm2 color preset/);
    assert.match(refusal(readThemeFile('<plist version="1.0"><dict><key>a</key><true/></dict></plist>', 'a.itermcolors')), /No terminal colours/);
  });

  test('TI-14: parsePlist builds values without touching any prototype', () => {
    const parsed = parsePlist(
      '<plist version="1.0"><dict><key>__proto__</key><dict><key>polluted</key><true/></dict>' +
        '<key>constructor</key><string>c</string><key>list</key><array><integer>-3</integer><real>.5</real><false/><string/></array>' +
        '<key>empty</key><dict/></dict></plist>'
    );
    assert.ok(parsed.ok, parsed.error);
    assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
    assert.equal(Object.getPrototypeOf(parsed.value), null, 'a dict must not inherit from Object.prototype');
    assert.equal(parsed.value.__proto__.polluted, true, '__proto__ is an ordinary key');
    assert.equal(parsed.value.constructor, 'c');
    assert.deepEqual(parsed.value.list, [-3, 0.5, false, '']);
  });
});

// ---- Every format -----------------------------------------------------------------

describe('Theme import: rules for every format', () => {
  test('TI-15: more than 256 KB is refused before it is parsed, whatever it holds', () => {
    assert.equal(THEME_FILE_MAX_BYTES, 256 * 1024);
    const pad = (text, size) => text + '\n'.repeat(size - text.length);
    for (const [text, name] of [
      [GHOSTTY_FULL, 'Dracula'],
      [JSON.stringify(WT_CAMPBELL), 'c.json'],
      [itermDracula(), 'd.itermcolors'],
    ]) {
      assert.ok(readThemeFile(pad(text, THEME_FILE_MAX_BYTES), name).ok, `${name} at exactly the limit`);
      assert.match(refusal(readThemeFile(pad(text, THEME_FILE_MAX_BYTES + 1), name)), /256 KB/);
    }
    // Counted in bytes as the file has them, not in UTF-16 units.
    const wide = `# ${'\u{AC00}'.repeat(90000)}\n${GHOSTTY_FULL}`;
    assert.ok(wide.length < THEME_FILE_MAX_BYTES, 'setup');
    assert.match(refusal(readThemeFile(wide, 'wide')), /256 KB/);
  });

  test('TI-16: a light background is refused, saying the app is dark-only', () => {
    assert.ok(relativeLuminance('#a9a9a9') <= 0.4 && relativeLuminance('#aaaaaa') > 0.4, 'setup: the boundary');
    assert.ok(only(readThemeFile('background = #a9a9a9\nforeground = #000000', 'grey')).ok);
    const error = refusal(readThemeFile('background = #aaaaaa\nforeground = #000000', 'Pale'));
    assert.match(error, /"Pale" has a light background \(#aaaaaa\)/);
    assert.match(error, /dark/);
    assert.match(refusal(readThemeFile(JSON.stringify(WT_ONE_HALF_LIGHT), 'l.json')), /light background \(#fafafa\)/);
    assert.match(refusal(readThemeFile(itermFile({ 'Background Color': [0.99, 0.96, 0.89] }), 'Solarized Light.itermcolors')), /light background/);
  });

  test('TI-17: names lose control and direction characters and stop at 60 characters', () => {
    assert.equal(cleanThemeName('  My\tTheme \n'), 'My Theme');
    assert.equal(cleanThemeName('evil\u{202E}txt.exe'), 'eviltxt.exe');
    assert.equal(cleanThemeName('a\u{2066}b\u{2069}c\u{200E}d\u{200F}e\u{061C}f\u{200B}g\u{FEFF}h'), 'abcdefgh');
    assert.equal(cleanThemeName('bell\u{7}\u{1B}[31mred\u{9B}'), 'bell [31mred');
    assert.equal(cleanThemeName('x'.repeat(100)).length, 60);
    const emoji = cleanThemeName('\u{1F600}'.repeat(70));
    assert.equal(Array.from(emoji).length, 60, 'cut by characters');
    assert.ok(!/[\u{D800}-\u{DFFF}]/u.test(emoji.replace(/\u{1F600}/gu, '')), 'a surrogate half was left');
    assert.equal(cleanThemeName(42), '');
    assert.equal(cleanThemeName('\u{202E}\u{200B}  '), '');
    // A file whose scheme name cleans to nothing takes the file's name, then a plain one.
    assert.equal(only(readThemeFile(JSON.stringify({ ...WT_CAMPBELL, name: '\u{202E}' }), 'From File.json')).name, 'From File');
    assert.equal(only(readThemeFile(GHOSTTY_FULL, '\u{202E}')).name, 'Imported Theme');
  });

  test('TI-18: colour values', () => {
    assert.equal(normalizeHexColor('#ABC'), '#aabbcc');
    assert.equal(normalizeHexColor('#AbCdEf'), '#abcdef');
    for (const bad of ['abc', '#abcd', '#abcdefa', '#12345', '', null, 12, '#ggg', ' #abc', '#abc ', '#\u{FF10}\u{FF10}\u{FF10}']) {
      assert.equal(normalizeHexColor(bad), null, JSON.stringify(bad));
    }
    assert.equal(normalizeHexColor('abcdef', { bare: true }), '#abcdef');
    assert.equal(relativeLuminance('#000000'), 0);
    assert.equal(relativeLuminance('#ffffff'), 1);
  });
});

// ---- Stored themes ----------------------------------------------------------------

const dark = (name) => ({ ok: true, name, theme: { background: '#101010', foreground: '#eeeeee' }, filled: [] });

describe('Imported themes: the list that is kept', () => {
  test('TI-20: an id is custom:<slug>; a clash gets a suffix, and so does a name already shown', () => {
    let themes = [];
    const add = (scheme) => {
      const result = addCustomTheme(themes, scheme);
      assert.ok(result.ok, result.error);
      themes = result.themes;
      return result.entry;
    };
    assert.deepEqual(add(dark('Tokyo Night')), { id: 'custom:tokyo-night', label: 'Tokyo Night', theme: { background: '#101010', foreground: '#eeeeee' } });
    assert.equal(add(dark('Tokyo Night')).id, 'custom:tokyo-night-2');
    assert.equal(themes[1].label, 'Tokyo Night (2)');
    assert.equal(add(dark('tokyo night')).id, 'custom:tokyo-night-3');
    assert.equal(add(dark('Dracula')).label, 'Dracula (2)', 'a built-in name is taken too');
    assert.equal(add(dark('Café Noir')).id, 'custom:cafe-noir');
    assert.equal(add(dark('\u{D55C}\u{AE00}')).id, 'custom:theme');
    assert.equal(customThemeId('x'.repeat(200), []).length <= 'custom:'.length + 40, true);
    assert.ok(themes.every((t) => getTerminalThemeEntry(t.id, themes).label === t.label), 'every id resolves to its own entry');
  });

  test('TI-21: at most 20; the next one is refused with the reason', () => {
    assert.equal(MAX_CUSTOM_THEMES, 20);
    let themes = [];
    for (let i = 0; i < 20; i += 1) themes = addCustomTheme(themes, dark(`T${i}`)).themes;
    assert.equal(themes.length, 20);
    const result = addCustomTheme(themes, dark('One more'));
    assert.equal(result.ok, false);
    assert.match(result.error, /20 imported themes/);
    assert.match(result.error, /Delete one/);
    assert.equal(addCustomTheme(themes, { ok: false, name: 'x', error: 'no' }).ok, false, 'a refused scheme is never added');
  });

  test('TI-22: removing one leaves the rest in order', () => {
    let themes = [];
    for (const name of ['A', 'B', 'C']) themes = addCustomTheme(themes, dark(name)).themes;
    assert.deepEqual(removeCustomTheme(themes, 'custom:b').map((t) => t.label), ['A', 'C']);
    assert.equal(removeCustomTheme(themes, 'custom:nope'), themes, 'nothing to remove: the same list');
  });

  test('TI-23: a hand-edited list is cleaned on load — bad entries dropped, never a crash', () => {
    const good = { id: 'custom:good', label: 'Good', theme: { background: '#101010', red: '#FF0000', bogus: 'x' } };
    const cleaned = sanitizeCustomThemes([
      good,
      null,
      7,
      'custom:x',
      [],
      { id: 'dracula', label: 'Not custom', theme: { background: '#000000' } },
      { id: 'custom:UPPER', label: 'Upper', theme: { background: '#000000' } },
      { id: 'custom:../../etc', label: 'Path', theme: { background: '#000000' } },
      { id: `custom:${'a'.repeat(80)}`, label: 'Long', theme: { background: '#000000' } },
      { id: 'custom:good', label: 'Duplicate', theme: { background: '#000000' } },
      { id: 'custom:nolabel', theme: { background: '#000000' } },
      { id: 'custom:emptylabel', label: '\u{202E}', theme: { background: '#000000' } },
      { id: 'custom:notheme', label: 'No theme' },
      { id: 'custom:arraytheme', label: 'Array', theme: ['#000000'] },
      { id: 'custom:badcolour', label: 'Bad', theme: { background: '#000000', red: 'red' } },
      { id: 'custom:numcolour', label: 'Num', theme: { background: 0 } },
      { id: 'custom:light', label: 'Light', theme: { background: '#ffffff' } },
      { id: 'custom:nocolours', label: 'Nothing', theme: { bogus: '#000000' } },
      { id: 'custom:bidi', label: 'Bi\u{202E}di', theme: { foreground: '#ffffff' } },
    ]);
    assert.deepEqual(cleaned, [
      { id: 'custom:good', label: 'Good', theme: { background: '#101010', red: '#ff0000' } },
      { id: 'custom:bidi', label: 'Bidi', theme: { foreground: '#ffffff' } },
    ]);
    for (const value of [undefined, null, {}, 'x', 1, true, { length: 3 }]) assert.deepEqual(sanitizeCustomThemes(value), []);
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `custom:t${i}`, label: `T${i}`, theme: { background: '#000000' } }));
    assert.equal(sanitizeCustomThemes(many).length, 20);
    const proto = JSON.parse('[{"id":"custom:p","label":"P","theme":{"__proto__":{"x":1},"background":"#000000"}}]');
    assert.deepEqual(sanitizeCustomThemes(proto), [{ id: 'custom:p', label: 'P', theme: { background: '#000000' } }]);
  });
});

// ---- One resolver ------------------------------------------------------------------

describe('Terminal themes: one resolver for built-in and imported themes', () => {
  const customs = [{ id: 'custom:mine', label: 'Mine', theme: { background: '#0a0b0c', red: '#ff0000' } }];

  test('TR-01: built-in, imported and unknown ids', () => {
    assert.equal(getTerminalThemeEntry('nord', customs), TERMINAL_THEMES.nord);
    assert.equal(getTerminalThemeEntry('nord'), TERMINAL_THEMES.nord, 'no list: still the built-ins');
    const mine = getTerminalThemeEntry('custom:mine', customs);
    assert.equal(mine.label, 'Mine');
    assert.equal(mine.custom, true);
    assert.equal(mine.theme.background, '#0a0b0c');
    for (const unknown of [undefined, null, '', 'light-modern', 'solarized-light', 'custom:gone', 'custom:mine ', '__proto__', 'constructor', 'toString']) {
      assert.equal(getTerminalThemeEntry(unknown, customs), TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_ID], `"${unknown}" did not fall back`);
    }
    for (const list of [undefined, null, 'x', [null, 7, { id: 'custom:mine' }]]) {
      assert.equal(getTerminalThemeEntry('custom:mine', list), TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_ID]);
    }
  });

  test('TR-02: what a theme draws with', () => {
    const app = Object.fromEntries(THEME_COLOR_KEYS.map((k) => [k, `token:${k}`]));
    assert.equal(themeColorsOf(TERMINAL_THEMES.nord, app), TERMINAL_THEMES.nord.theme);
    assert.equal(themeColorsOf(TERMINAL_THEMES['dark-modern'], app), app);
    const drawn = themeColorsOf(getTerminalThemeEntry('custom:mine', customs), app);
    assert.equal(drawn.background, '#0a0b0c');
    assert.equal(drawn.red, '#ff0000');
    assert.equal(drawn.green, 'token:green');
  });

  test('TR-03: the gallery\'s list, and the theme on screen', () => {
    const choices = terminalThemeChoices(customs);
    assert.deepEqual(choices.map((c) => c.id), [...TERMINAL_THEME_IDS, 'custom:mine']);
    assert.ok(choices.every((c) => typeof c.label === 'string' && c.label));
    assert.deepEqual(choices.map((c) => Boolean(c.custom)), [...TERMINAL_THEME_IDS.map(() => false), true]);
    assert.deepEqual(terminalThemeChoices(undefined).map((c) => c.id), TERMINAL_THEME_IDS);
    assert.equal(shownTerminalThemeId({ terminalTheme: 'nord', terminalThemePreview: null }), 'nord');
    assert.equal(shownTerminalThemeId({ terminalTheme: 'nord', terminalThemePreview: 'dracula' }), 'dracula');
    assert.equal(shownTerminalThemeId({ terminalTheme: 'nord' }), 'nord');
  });

  test('TR-04: the registry resolves through it, shows the preview, and applies only colours', () => {
    const src = readFileSync(new URL('../../src/components/terminal/terminalRegistry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const cut = (head) => {
      const start = src.indexOf(head);
      assert.ok(start >= 0, `the registry has no ${head}`);
      const end = src.indexOf('\n}\n', start) + 3;
      return src.slice(start, end).replace(/^export /, '');
    };
    const body = [
      cut('export function resolveTerminalTheme('),
      cut('export function shownTerminalTheme('),
      cut('function applyShownTerminalTheme('),
      'return { resolveTerminalTheme, shownTerminalTheme, applyShownTerminalTheme };',
    ].join('\n');
    const state = { terminalTheme: 'nord', terminalThemePreview: null, terminalCustomThemes: customs };
    const instances = new Map([
      ['a', { term: { options: { theme: null, fontSize: 12 } } }],
      ['b', { term: { options: { theme: null, fontSize: 12 } } }],
    ]);
    const app = { background: 'token:bg', red: 'token:red', green: 'token:green' };
    const make = new Function('getTerminalThemeEntry', 'themeColorsOf', 'shownTerminalThemeId', 'readTheme', 'useSettingsStore', 'instances', body);
    const reg = make(getTerminalThemeEntry, themeColorsOf, shownTerminalThemeId, () => app, { getState: () => state }, instances);
    assert.equal(reg.resolveTerminalTheme('nord'), TERMINAL_THEMES.nord.theme);
    assert.equal(reg.resolveTerminalTheme('custom:mine').red, '#ff0000', 'the store\'s imported themes are known by default');
    assert.equal(reg.resolveTerminalTheme('custom:mine').green, 'token:green');
    assert.equal(reg.resolveTerminalTheme('custom:gone'), app, 'unknown: the default, which follows the app');
    reg.applyShownTerminalTheme();
    for (const entry of instances.values()) assert.equal(entry.term.options.theme, TERMINAL_THEMES.nord.theme);
    state.terminalThemePreview = 'custom:mine';
    reg.applyShownTerminalTheme();
    for (const entry of instances.values()) assert.equal(entry.term.options.theme.background, '#0a0b0c', 'the preview is not on every terminal');
    state.terminalThemePreview = null;
    reg.applyShownTerminalTheme();
    for (const entry of instances.values()) assert.equal(entry.term.options.theme, TERMINAL_THEMES.nord.theme, 'the chosen theme did not come back');
    // A theme key is not a font key: previewing must not refit every terminal.
    const keys = /const LIVE_TERMINAL_SETTINGS_KEYS = \[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
    assert.ok(keys && !/terminalTheme/.test(keys), 'a theme change still refits and re-reports every terminal');
    const themeKeys = /const THEME_SETTINGS_KEYS = \[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
    for (const key of ['terminalTheme', 'terminalThemePreview', 'terminalCustomThemes']) {
      assert.ok(themeKeys.includes(`'${key}'`), `${key} does not repaint the terminals`);
    }
    const create = src.slice(src.indexOf('export function getOrCreateTerminal('));
    assert.match(create.slice(0, create.indexOf('const fitAddon')), /theme: shownTerminalTheme\(settingsState\),/, 'a new terminal does not start in the theme on screen');
  });
});

// ---- Kept between launches ------------------------------------------------------------

describe('Imported themes: saved, read back, and never a preview', () => {
  const KEY = 'nexterm.settings';
  const backing = new Map();
  const ownStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
    clear: () => backing.clear(),
  };
  /** Storage of its own, handed back in `finally` — the harness skips afterEach after a failure. */
  const withOwnStorage = (fn) => async () => {
    const borrowed = globalThis.localStorage;
    globalThis.localStorage = ownStorage;
    backing.clear();
    try {
      await fn();
    } finally {
      globalThis.localStorage = borrowed;
    }
  };
  /** A fresh store module, which reads storage as it is created — the app starting. */
  const launch = () => import(`../../src/stores/settingsStore.js?themes=${Math.random()}`);
  const saved = () => {
    const raw = backing.get(KEY);
    return raw == null ? {} : JSON.parse(raw).data;
  };
  /** A settings payload as the app writes it (persistence.js's SCHEMA_VERSION 2), edited by hand. */
  const write = (data) => backing.set(KEY, JSON.stringify({ version: 2, data }));
  const mine = { id: 'custom:mine', label: 'Mine', theme: { background: '#0a0b0c', red: '#ff0000' } };

  test(
    'TS-01: imported themes and the choice of one survive a restart',
    withOwnStorage(async () => {
      const first = (await launch()).useSettingsStore;
      assert.deepEqual(first.getState().terminalCustomThemes, [], 'the default is no imported themes');
      first.getState().setSetting('terminalCustomThemes', [mine]);
      first.getState().setSetting('terminalTheme', 'custom:mine');
      assert.deepEqual(saved(), { terminalCustomThemes: [mine], terminalTheme: 'custom:mine' });
      const next = (await launch()).useSettingsStore.getState();
      assert.deepEqual(next.terminalCustomThemes, [mine]);
      assert.equal(next.terminalTheme, 'custom:mine');
      // Emptied again, it is the default and leaves storage.
      next.setSetting('terminalCustomThemes', []);
      assert.equal('terminalCustomThemes' in saved(), false);
    })
  );

  test(
    'TS-02: a hand-edited list loads what is sound and drops the rest, without failing to start',
    withOwnStorage(async () => {
      write({
        terminalTheme: 'custom:gone',
        terminalCustomThemes: [mine, { id: 'custom:light', label: 'Light', theme: { background: '#ffffff' } }, 'junk', { id: 'x' }],
      });
      const store = (await launch()).useSettingsStore.getState();
      assert.deepEqual(store.terminalCustomThemes, [mine]);
      assert.equal(getTerminalThemeEntry(store.terminalTheme, store.terminalCustomThemes), TERMINAL_THEMES[DEFAULT_TERMINAL_THEME_ID], 'a theme that is gone draws as the default');
      for (const garbage of [{ a: 1 }, 'themes', 7, null, true]) {
        write({ terminalCustomThemes: garbage, editorWordWrap: true });
        const other = (await launch()).useSettingsStore.getState();
        assert.deepEqual(other.terminalCustomThemes, [], `${JSON.stringify(garbage)} was trusted`);
        assert.equal(other.editorWordWrap, true, 'the rest of the settings were lost with it');
      }
    })
  );

  test(
    'TS-03: a preview is never saved, and does not come back',
    withOwnStorage(async () => {
      const first = (await launch()).useSettingsStore;
      first.getState().setSetting('terminalTheme', 'nord');
      first.getState().previewTerminalTheme('dracula');
      assert.equal(shownTerminalThemeId(first.getState()), 'dracula', 'setup: the preview is on screen');
      assert.deepEqual(saved(), { terminalTheme: 'nord' }, 'the preview reached storage');
      // Saved for some other reason while a preview is up: still not saved.
      first.getState().setSetting('editorWordWrap', true);
      assert.deepEqual(saved(), { terminalTheme: 'nord', editorWordWrap: true });
      const next = (await launch()).useSettingsStore.getState();
      assert.equal(next.terminalThemePreview, null);
      assert.equal(shownTerminalThemeId(next), 'nord');
      // Letting go puts the chosen one back; the same preview twice is one change.
      let changes = 0;
      const stop = first.subscribe(() => {
        changes += 1;
      });
      first.getState().previewTerminalTheme('dracula');
      first.getState().previewTerminalTheme(null);
      stop();
      assert.equal(changes, 1, 'an unchanged preview still woke every subscriber');
      assert.equal(shownTerminalThemeId(first.getState()), 'nord');
    })
  );
});

// ---- Found in review ------------------------------------------------------------------

describe('Theme import: what the review found', () => {
  test('TI-30: comments, strings and nesting cost one pass, whatever the file is made of (T4)', () => {
    // Each comment used to send the scan back to look for the next quote from
    // where it was: 256 KB of "//" lines took 190 ms, a long task that froze
    // the window. Linear, each of these is a few milliseconds; the bound is
    // generous for a slow CI machine and still far below the quadratic cost.
    const fill = (unit, head = '', tail = '') => head + unit.repeat(Math.floor((THEME_FILE_MAX_BYTES - head.length - tail.length) / unit.length)) + tail;
    const worst = {
      'line comments': [fill('//\n'), 'x.json'],
      'block comments': [fill('/**/'), 'x.json'],
      'comments between strings': [fill('"a"//\n', '['), 'x.json'],
      'escaped quotes': [fill('"\\\\\\"",', '[', '""]'), 'x.json'],
      'trailing commas': [fill(',', '[1', ']'), 'x.json'],
      'plist comments': [fill('<!---->', '<plist>', '</plist>'), 'x.itermcolors'],
      'plist entities': [fill('&amp;', '<plist><dict><key>', '</key><true/></dict></plist>'), 'x.itermcolors'],
      'Ghostty lines': [fill('a=b\n'), 'x'],
    };
    for (const [what, [text, name]] of Object.entries(worst)) {
      assert.ok(text.length <= THEME_FILE_MAX_BYTES, `setup: ${what}`);
      let best = Infinity;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        readThemeFile(text, name);
        best = Math.min(best, performance.now() - started);
      }
      assert.ok(best < 60, `${what}: ${best.toFixed(1)} ms`);
    }
  });

  test('TI-31: bytes are counted before decoding, and text that is not UTF-8 says so (T8)', () => {
    const invalid = new Uint8Array(100 * 1024).fill(0xc0);
    assert.match(refusal(readThemeFile(invalid, 'binary100k.bin')), /not UTF-8 text/);
    const latin1 = new Uint8Array([...Buffer.from('background = #101010\nforeground = #eeeeee\n# caf'), 0xe9]);
    assert.match(refusal(readThemeFile(latin1, 'latin1')), /not UTF-8 text/);
    assert.match(refusal(readThemeFile(new Uint8Array(THEME_FILE_MAX_BYTES + 1).fill(0x20), 'big')), /256 KB/);
    // 255 KB of valid UTF-8 — three bytes a character — is within the cap.
    const korean = Buffer.from(`# ${'\u{AC00}'.repeat(Math.floor((THEME_FILE_MAX_BYTES - 200) / 3))}\nbackground = #101010\n`);
    assert.ok(korean.length <= THEME_FILE_MAX_BYTES, 'setup');
    assert.equal(only(readThemeFile(new Uint8Array(korean), 'k')).theme.background, '#101010');
    // UTF-8 with a BOM, and UTF-16 with one, are text.
    assert.equal(only(readThemeFile(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('background = #101010')]), 'bom')).theme.background, '#101010');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(itermDracula(), 'utf16le')]);
    assert.equal(only(readThemeFile(new Uint8Array(utf16), 'u.itermcolors')).theme.red, '#ff5555');
    assert.equal(only(readThemeFile(utf16.buffer.slice(utf16.byteOffset, utf16.byteOffset + utf16.length), 'u.itermcolors')).theme.red, '#ff5555', 'an ArrayBuffer too');
  });

  test('TI-32: more schemes than are listed are counted, not dropped without a word (T9)', () => {
    const scheme = (i) => ({ name: `S${i}`, background: '#101010', foreground: '#eeeeee' });
    const many = readThemeFile(JSON.stringify({ schemes: Array.from({ length: 150 }, (_, i) => scheme(i)) }), 'many150.json');
    assert.equal(many.schemes.length, 100);
    assert.equal(many.total, 150, 'how many the file holds');
    assert.equal(readThemeFile(JSON.stringify([scheme(1), scheme(2)]), 'two.json').total, 2);
  });

  test('TI-33: characters that do not show are dropped from names, and a name of nothing but them is no name (T10)', () => {
    for (const invisible of ['\u{3164}', '\u{115F}', '\u{1160}', '\u{00AD}', '\u{034F}', '\u{180E}', '\u{E0041}', '\u{E007F}', '\u{FFA0}', '\u{2028}', '\u{2064}', '\u{1D173}', '\u{FFF9}']) {
      assert.equal(cleanThemeName(`Dra${invisible}cula`).replace(' ', ''), 'Dracula', `U+${invisible.codePointAt(0).toString(16)} survived`);
      assert.equal(cleanThemeName(invisible.repeat(5)), '', `a name of U+${invisible.codePointAt(0).toString(16)} alone is not blank`);
    }
    // The same characters the side bar refuses in a branch name (terminalStatus.js), except git's own punctuation.
    const gitOnly = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);
    const survivors = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (gitOnly.has(ch) || cleanBranchName(`a${ch}b`) !== '') continue;
      if (cleanThemeName(`a${ch}b`).includes(ch)) survivors.push(`U+${cp.toString(16)}`);
    }
    assert.deepEqual(survivors, [], 'shown in a theme name, refused in a branch name');
    // Combining marks pile up into a smear over the card: a few per letter at most.
    const zalgo = cleanThemeName(`Z${'\u{0336}\u{0337}\u{0338}'.repeat(30)}algo`);
    assert.ok(Array.from(zalgo).length <= 'Zalgo'.length + 4, `kept ${Array.from(zalgo).length} characters: ${JSON.stringify(zalgo)}`);
    assert.equal(cleanThemeName('Phở Bò'), 'Phở Bò', 'ordinary accents stay');
    assert.equal(cleanThemeName('\u{0301}\u{0302}\u{200D}'), '', 'marks with nothing to sit on show nothing');
    assert.equal(only(readThemeFile(JSON.stringify({ name: '\u{3164}\u{3164}', background: '#101010' }), '\u{115F}.json')).name, 'Imported Theme');
    assert.equal(shownName('x'.repeat(100), 20), `${'x'.repeat(19)}…`, 'a shown name is cut with an ellipsis');
  });

  test('TI-34: labels are made unique as they load, built-in names included (T11)', () => {
    const cleaned = sanitizeCustomThemes([
      { id: 'custom:a', label: 'Dracula', theme: { background: '#101010' } },
      { id: 'custom:b', label: 'Mine', theme: { background: '#101010' } },
      { id: 'custom:c', label: 'mine', theme: { background: '#101010' } },
      { id: 'custom:d', label: 'Mine (2)', theme: { background: '#101010' } },
    ]);
    assert.deepEqual(cleaned.map((t) => t.label), ['Dracula (2)', 'Mine', 'mine (2)', 'Mine (3)']);
    const labels = cleaned.map((t) => t.label.toLowerCase());
    assert.equal(new Set(labels).size, labels.length);
  });

  test('TI-35: blank lines and a BOM before the XML declaration are allowed (T13)', () => {
    for (const lead of ['\n', '  \n\t', '\u{FEFF}', '\u{FEFF}\r\n']) {
      assert.equal(only(readThemeFile(`${lead}${itermDracula()}`, 'lead.itermcolors')).theme.red, '#ff5555', JSON.stringify(lead));
    }
  });

  test('TI-36: Ghostty 1.2\'s cell-foreground and cell-background count as not given (T15)', () => {
    const scheme = only(readThemeFile(
      'background = #101010\nforeground = #eeeeee\ncursor-color = cell-foreground\ncursor-text = cell-background\nselection-background = cell-background\nselection-foreground = cell-foreground',
      'Ghostty 1.2'
    ));
    assert.equal(scheme.theme.cursor, '#eeeeee', 'the cursor follows the foreground');
    assert.equal(scheme.theme.cursorAccent, '#101010');
    assert.ok(scheme.filled.includes('selectionBackground'), 'the selection comes from the default');
    assert.match(refusal(readThemeFile('background = cell-foreground', 'x')), /background "cell-foreground" is not a colour/, 'only where Ghostty takes it');
  });

  test('TI-37: JSON nested deeper than any scheme is says so (T16)', () => {
    for (const deep of ['['.repeat(5000) + ']'.repeat(5000), '{"a":'.repeat(3000) + '1' + '}'.repeat(3000), '['.repeat(100)]) {
      assert.match(refusal(readThemeFile(deep, 'deep.json')), /nested more deeply than any color scheme/);
    }
    assert.equal(readThemeFile(`{"schemes": [${JSON.stringify(WT_CAMPBELL)}], "x": [[[[1]]]]}`, 'ok.json').ok, true, 'ordinary nesting is fine');
  });
});

// ---- Found in the second review --------------------------------------------------------

describe('Theme import: what the second review found', () => {
  test('TI-40: a JSON error is quoted whole up to its own length, and cut with an ellipsis past it (R9)', () => {
    // Node 22+ says "Expected double-quoted property name in JSON at position
    // 26 (line 1 column 27)" — past 60 characters, where names stop. Older
    // engines say less, and the case then only holds the cut below.
    const text = '{"background": "#101010", x: 1}';
    let engine = '';
    try {
      JSON.parse(text);
    } catch (err) {
      engine = err.message;
    }
    const error = refusal(readThemeFile(text, 'x.json'));
    const quoted = error.replace(/^It is not valid JSON: /, '');
    if (engine.length <= 120) assert.equal(quoted, engine, 'the message was cut short of its own length');
    else assert.ok(quoted.endsWith('…') && quoted.length <= 121, `cut without an ellipsis: ${quoted}`);
    const long = shownName(`${'word '.repeat(40)}end`, 120);
    assert.ok(Array.from(long).length === 120 && long.endsWith('…'), `a long text is not cut at its cap with an ellipsis: ${long.length}`);
  });

  test('TI-41: Braille blank, the object replacement character and private-use characters are no name (R10)', () => {
    for (const blank of ['\u{2800}\u{2800}', '\u{FFFC}', '\u{2800}\u{200D}', '\u{E000}\u{E001}', '\u{F0000}', '\u{E000}\u{2800}']) {
      assert.equal(cleanThemeName(blank), '', `${JSON.stringify(blank)} is a name`);
    }
    assert.equal(cleanThemeName('Night\u{2800}Owl'), 'NightOwl', 'Braille blank is dropped where it sits');
    assert.equal(cleanThemeName('Icons \u{E0B0}'), 'Icons \u{E0B0}', 'a private-use glyph beside letters stays (Powerline fonts use them)');
    assert.equal(only(readThemeFile(JSON.stringify({ name: '\u{2800}', background: '#101010' }), '\u{200B}.json')).name, 'Imported Theme');
  });

  test('TI-42: two names that read the same are the same name (R11)', () => {
    let themes = [];
    const add = (name) => {
      const result = addCustomTheme(themes, { ok: true, name, theme: { background: '#101010' }, filled: [] });
      themes = result.themes;
      return result.entry.label;
    };
    assert.equal(add('Caf\u{00E9}'), 'Caf\u{00E9}');
    assert.equal(add('Cafe\u{0301}'), 'Cafe\u{0301} (2)', 'NFD after NFC');
    assert.equal(add('Nord'), 'Nord (2)', 'a built-in name');
    const read = (label) => label.replace(/[\u{200D}\u{FE0F}]/gu, '');
    assert.equal(read(add('Nord\u{200D}')), 'Nord (3)', 'a joiner hides nothing');
    assert.equal(read(add('Nord\u{FE0F}')), 'Nord (4)', 'nor a variation selector');
    assert.equal(add('\u{FF2E}\u{FF2F}\u{FF32}\u{FF24}'), '\u{FF2E}\u{FF2F}\u{FF32}\u{FF24} (5)', 'nor full-width letters');
    const loaded = sanitizeCustomThemes([
      { id: 'custom:a', label: 'Caf\u{00E9}', theme: { background: '#101010' } },
      { id: 'custom:b', label: 'Cafe\u{0301}', theme: { background: '#101010' } },
    ]);
    assert.equal(loaded[0].label, 'Caf\u{00E9}');
    assert.equal(loaded[1].label, 'Cafe\u{0301} (2)', 'two ways of writing one name loaded as two names');
  });

  test('TI-43: combining marks are capped per letter, joiners and modifiers in between or not (R12)', () => {
    const marksIn = (s) => Array.from(s).filter((c) => /\p{M}/u.test(c)).length;
    for (const between of ['\u{200D}', '\u{200C}', '\u{1F3FB}', '\u{FE0F}', '']) {
      const name = cleanThemeName(`a${`\u{0301}\u{0302}\u{0303}\u{0304}${between}`.repeat(11)}b`);
      assert.ok(marksIn(name) <= 8, `${JSON.stringify(between)} in between: ${marksIn(name)} marks kept`);
      assert.ok(Array.from(name).length <= 14, `${JSON.stringify(between)} in between: ${Array.from(name).length} characters kept`);
    }
    assert.equal(cleanThemeName('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'), '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}', 'an emoji family stays whole');
    assert.equal(cleanThemeName('\u{1F44D}\u{1F3FD} ok'), '\u{1F44D}\u{1F3FD} ok', 'a skin tone stays');
  });

  test('TI-44: an unclosed block comment and commas with nothing before them are refused; a CR-only line ends a comment (R12)', () => {
    const scheme = '"background":"#101010","foreground":"#eeeeee"';
    assert.match(refusal(readThemeFile(`{${scheme}} /* never closed`, 'x.json')), /comment that is never closed/);
    assert.match(refusal(readThemeFile(`{${scheme}, /* "x": 1 }`, 'x.json')), /comment that is never closed/);
    for (const broken of ['{,}', '[,]', '{"schemes":[,]}', `{${scheme},,}`, `[,{${scheme}}]`]) {
      assert.match(refusal(readThemeFile(broken, 'x.json')), /not valid JSON/, broken);
    }
    assert.equal(only(readThemeFile(`{\r// a comment\r${scheme}\r}`, 'cr.json')).theme.background, '#101010');
    assert.equal(only(readThemeFile(`{${scheme}, // x\n /* y */ }`, 'ok.json')).theme.background, '#101010', 'a real trailing comma still goes');
  });
});
