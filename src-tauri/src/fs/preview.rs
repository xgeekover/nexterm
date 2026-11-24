//! Images the editor shows as pictures rather than as text: `read_image`,
//! behind `fs_read_image`.
//!
//! `read_file` refuses every file that is not UTF-8 text and hands back a
//! `String`, so no image could come back over IPC. This hands back the bytes
//! as base64, for a `data:` URI: the only image source besides the app's own
//! files that its CSP allows (`img-src 'self' data:`).
//!
//! What a file is, is decided by its bytes and never by its name: PNG, JPEG,
//! GIF and WebP by their signatures, SVG by being UTF-8 text whose first
//! element is `<svg`. Nothing is decoded here. A raster image's size is read
//! from its header, so a 33-byte PNG that declares 100000 × 100000 is refused
//! before a webview could try to make a bitmap of it.
//!
//! Refusals start with fixed words the editor tells apart — `NOT_FOUND`,
//! `NOT_AN_IMAGE`, `TOO_LARGE` — which the browser stand-in in src/lib/ipc.js
//! copies. Anything else is a read that failed ("Failed to read file …"), in
//! `read_file`'s words.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::io::Read;

use super::{open_regular_file, resolve_path, size_label, Opened};
use crate::models::ImagePreview;

/// The largest image file shown. It travels as base64, a third larger, and
/// the webview decodes it into a bitmap on top.
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// The longest side a header may declare.
pub const MAX_IMAGE_SIDE: u32 = 32_768;

/// The most pixels a header may declare: 32 Mi, which is 128 MiB decoded at
/// four bytes a pixel.
pub const MAX_IMAGE_PIXELS: u64 = 32 * 1024 * 1024;

/// How much is read before the format and the size are known. Every header
/// but a JPEG's and a GIF's sits in the first 30 bytes. A JPEG's frame header
/// comes after its metadata segments, and a GIF's first image descriptor
/// after its colour table and extensions (a comment, XMP); when those are
/// longer than this the rest of the file — at most `MAX_IMAGE_BYTES` — is
/// read and the walk goes on (`Header::Short`).
const HEADER_PROBE_BYTES: u64 = 64 * 1024;

/// Nothing at the path, or a link that leads nowhere.
pub const NOT_FOUND: &str = "File not found";
/// Not a regular file, none of the formats shown, a header that is cut short
/// or not valid, or an SVG that is not UTF-8.
pub const NOT_AN_IMAGE: &str = "File is not an image NexTerm can show";
/// Over `MAX_IMAGE_BYTES`, or a header declaring more than `MAX_IMAGE_SIDE`
/// or `MAX_IMAGE_PIXELS`.
pub const TOO_LARGE: &str = "Image is too large to preview";

/// The image at `path_str`: a confined path, as `fs_read_image` hands it on.
///
/// Opened without waiting on it and asked of the open handle whether it is a
/// regular file (`open_regular_file`), so a FIFO or a device named
/// `photo.png` is refused and never waited on. Refused before anything is
/// read when it is over `MAX_IMAGE_BYTES`; after its first 64 KB when those
/// are no image, or when the header they hold is short, invalid or declares
/// too many pixels; and once read when it grew past the limit meanwhile or is
/// an SVG that is not UTF-8. The read itself is capped one byte past the
/// limit, whatever the size said.
///
/// Links are followed, as `read_file` follows them: the path was confined
/// with every link in it resolved. A file swapped for a link between the two
/// is the race `fs_read_file` has too.
pub fn read_image(path_str: &str) -> Result<ImagePreview, String> {
    let path = resolve_path(path_str);
    let failed = |e: std::io::Error| format!("Failed to read file '{path_str}': {e}");
    let (file, meta) = match open_regular_file(&path, true).map_err(failed)? {
        Opened::File(file, meta) => (file, meta),
        Opened::NotFound => return Err(format!("{NOT_FOUND}: {path_str}")),
        Opened::NotAFile => return Err(not_an_image(path_str, "it is not a file")),
    };
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(too_many_bytes(path_str, meta.len()));
    }

    let mut reader = file.take(MAX_IMAGE_BYTES + 1);
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    (&mut reader).take(HEADER_PROBE_BYTES).read_to_end(&mut bytes).map_err(failed)?;
    // Short of the probe, the file ended: there is no more to read.
    let mut complete = (bytes.len() as u64) < HEADER_PROBE_BYTES;

    let Some(format) = Format::of(&bytes) else {
        return Err(not_an_image(path_str, "it is no PNG, JPEG, GIF, WebP or SVG"));
    };
    let mut header = format.header(&bytes);
    if matches!(header, Header::Short) && !complete {
        read_rest(&mut reader, &mut bytes, path_str)?;
        complete = true;
        header = format.header(&bytes);
    }
    let (width, height) = match header {
        Header::Size(width, height) => {
            if width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
                return Err(too_many_pixels(path_str, width, height));
            }
            (Some(width), Some(height))
        }
        Header::Vector => (None, None),
        Header::Short => return Err(not_an_image(path_str, "its header is cut short")),
        Header::Invalid => return Err(not_an_image(path_str, "its header is not valid")),
    };
    if !complete {
        read_rest(&mut reader, &mut bytes, path_str)?;
    }
    // An `<img>` reads an SVG as UTF-8 whatever its prolog says; anything
    // else would show as an error, or as somebody else's text.
    if format == Format::Svg && std::str::from_utf8(&bytes).is_err() {
        return Err(not_an_image(path_str, "it is an SVG that is not UTF-8"));
    }

    Ok(ImagePreview {
        mime: format.mime().to_string(),
        data: STANDARD.encode(&bytes),
        bytes: bytes.len() as u64,
        width,
        height,
    })
}

/// The rest of the file, refused when it holds more than the limit: it grew
/// after its size was asked.
fn read_rest(reader: &mut std::io::Take<std::fs::File>, bytes: &mut Vec<u8>, path_str: &str) -> Result<(), String> {
    reader
        .read_to_end(bytes)
        .map_err(|e| format!("Failed to read file '{path_str}': {e}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        let now = reader.get_ref().metadata().map_or(bytes.len() as u64, |m| m.len());
        return Err(too_many_bytes(path_str, now));
    }
    Ok(())
}

fn not_an_image(path_str: &str, why: &str) -> String {
    format!("{NOT_AN_IMAGE} ({why}): {path_str}")
}

fn too_many_bytes(path_str: &str, size: u64) -> String {
    format!(
        "{TOO_LARGE} ({}; the limit is {} MB): {path_str}",
        size_label(size),
        MAX_IMAGE_BYTES / (1024 * 1024)
    )
}

fn too_many_pixels(path_str: &str, width: u32, height: u32) -> String {
    format!(
        "{TOO_LARGE} ({width} × {height}; the limit is {MAX_IMAGE_SIDE} px per side and {} Mi pixels): {path_str}",
        MAX_IMAGE_PIXELS / (1024 * 1024)
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format {
    Png,
    Jpeg,
    Gif,
    Webp,
    Svg,
}

/// What a header says of the image's size.
#[derive(Debug, PartialEq, Eq)]
enum Header {
    /// Width and height in pixels, neither of them zero.
    Size(u32, u32),
    /// An SVG: no pixel size of its own. Its `width`, `height` and `viewBox`
    /// can be in any unit or missing, and the `<img>` sizes it; reading them
    /// would be parsing XML for a label.
    Vector,
    /// The bytes end before the header does.
    Short,
    /// The signature is there and what follows it is not that format.
    Invalid,
}

impl Format {
    /// The format `bytes` start as, whatever the file is called.
    fn of(bytes: &[u8]) -> Option<Format> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Format::Png)
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Format::Jpeg)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(Format::Gif)
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(&b"WEBP"[..]) {
            Some(Format::Webp)
        } else if starts_as_svg(bytes) {
            Some(Format::Svg)
        } else {
            None
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Format::Png => "image/png",
            Format::Jpeg => "image/jpeg",
            Format::Gif => "image/gif",
            Format::Webp => "image/webp",
            Format::Svg => "image/svg+xml",
        }
    }

    fn header(self, bytes: &[u8]) -> Header {
        match self {
            Format::Png => png_header(bytes),
            Format::Jpeg => jpeg_header(bytes),
            Format::Gif => gif_header(bytes),
            Format::Webp => webp_header(bytes),
            Format::Svg => Header::Vector,
        }
    }
}

fn sized(width: u32, height: u32) -> Header {
    if width == 0 || height == 0 {
        Header::Invalid
    } else {
        Header::Size(width, height)
    }
}

fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 2).map(|b| u32::from(u16::from_be_bytes([b[0], b[1]])))
}

fn le16(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 2).map(|b| u32::from(u16::from_le_bytes([b[0], b[1]])))
}

fn le24(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 3).map(|b| u32::from_le_bytes([b[0], b[1], b[2], 0]))
}

/// The signature (8 bytes), then the first chunk, which must be IHDR: its
/// length (13), its type, width and height (4 bytes each, big-endian), five
/// one-byte fields and the chunk's CRC — 33 bytes in all.
fn png_header(bytes: &[u8]) -> Header {
    if bytes.len() < 33 {
        return Header::Short;
    }
    if bytes[8..12] != [0, 0, 0, 13] || &bytes[12..16] != b"IHDR" {
        return Header::Invalid;
    }
    let (Some(width), Some(height)) = (
        bytes.get(16..20).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]])),
        bytes.get(20..24).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]])),
    ) else {
        return Header::Short;
    };
    sized(width, height)
}

/// The signature (6 bytes), then the logical screen descriptor: width and
/// height (2 bytes each, little-endian), a flags byte, the background colour
/// and the aspect ratio. Then the global colour table, when the flags' top
/// bit says there is one (3 × 2^(n + 1) bytes, n the flags' low three bits),
/// any number of extensions — 0x21, a label, then sub-blocks of a length
/// byte and that many bytes, ending at a length of 0 — and the first image
/// descriptor: 0x2c, then the frame's left, top, width and height (2 bytes
/// each, little-endian).
///
/// A browser draws a GIF at its logical screen, grown to cover the first
/// frame when that reaches past it (Chromium's decoder, and so WebView2,
/// does): a 1 × 1 screen can carry a 23000 × 23000 frame. So the size is
/// max(screen, left + width) × max(screen, top + height).
///
/// Bounded: every step moves forward, by a length read from the bytes, and
/// the walk never leaves the bytes it was given (at most `MAX_IMAGE_BYTES`).
/// It stops at the first image descriptor. The bytes ending before it are
/// `Short`; the trailer (0x3b), or any other byte where a block must start,
/// before any image is `Invalid`.
fn gif_header(bytes: &[u8]) -> Header {
    let (Some(screen_width), Some(screen_height), Some(&flags)) = (le16(bytes, 6), le16(bytes, 8), bytes.get(10)) else {
        return Header::Short;
    };
    let mut at = 13usize;
    if flags & 0x80 != 0 {
        at += 3usize << ((flags & 0x07) + 1);
    }
    loop {
        match bytes.get(at) {
            None => return Header::Short,
            Some(0x2c) => {
                let (Some(left), Some(top), Some(width), Some(height)) =
                    (le16(bytes, at + 1), le16(bytes, at + 3), le16(bytes, at + 5), le16(bytes, at + 7))
                else {
                    return Header::Short;
                };
                return sized(screen_width.max(left + width), screen_height.max(top + height));
            }
            Some(0x21) => {
                // The introducer and the label, then the sub-blocks.
                at += 2;
                loop {
                    let Some(&length) = bytes.get(at) else {
                        return Header::Short;
                    };
                    at += 1 + usize::from(length);
                    if length == 0 {
                        break;
                    }
                }
            }
            Some(_) => return Header::Invalid,
        }
    }
}

/// `RIFF`, the file's length, `WEBP`, then the first chunk's type and length,
/// and in it:
/// - `VP8 ` (lossy): a 3-byte frame tag that says a key frame, the start code
///   9d 01 2a, then width and height in 14 bits each (little-endian);
/// - `VP8L` (lossless): the byte 2f, then 32 bits holding width − 1 and
///   height − 1 in 14 bits each and a version that must be 0;
/// - `VP8X` (extended): flags, 3 reserved bytes, then the canvas's width − 1
///   and height − 1 in 24 bits each.
fn webp_header(bytes: &[u8]) -> Header {
    let Some(chunk) = bytes.get(12..16) else {
        return Header::Short;
    };
    match chunk {
        b"VP8 " => {
            let Some(frame) = bytes.get(20..30) else {
                return Header::Short;
            };
            if frame[0] & 1 != 0 || frame[3..6] != [0x9d, 0x01, 0x2a] {
                return Header::Invalid;
            }
            match (le16(frame, 6), le16(frame, 8)) {
                (Some(width), Some(height)) => sized(width & 0x3fff, height & 0x3fff),
                _ => Header::Short,
            }
        }
        b"VP8L" => {
            let Some(head) = bytes.get(20..25) else {
                return Header::Short;
            };
            let bits = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
            if head[0] != 0x2f || bits >> 29 != 0 {
                return Header::Invalid;
            }
            sized(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff))
        }
        b"VP8X" => {
            let Some(head) = bytes.get(20..30) else {
                return Header::Short;
            };
            match (le24(head, 4), le24(head, 7)) {
                (Some(width), Some(height)) => sized(1 + width, 1 + height),
                _ => Header::Short,
            }
        }
        _ => Header::Invalid,
    }
}

/// The size in a JPEG's frame header (SOFn), found by walking the segments
/// after the start of the image by their lengths, never by looking inside
/// them.
///
/// Bounded: every step moves forward, the walk never leaves the bytes it was
/// given (at most `MAX_IMAGE_BYTES`), and it stops at the first start of scan
/// or end of image. Image data comes after the frame header, so meeting it
/// first means the header is not valid.
fn jpeg_header(bytes: &[u8]) -> Header {
    let mut at = 2;
    loop {
        match bytes.get(at) {
            None => return Header::Short,
            Some(0xff) => {}
            Some(_) => return Header::Invalid,
        }
        // A marker may be padded with any number of 0xff bytes.
        while bytes.get(at) == Some(&0xff) {
            at += 1;
        }
        let Some(&marker) = bytes.get(at) else {
            return Header::Short;
        };
        at += 1;
        match marker {
            // Markers without a length: TEM and the restart markers.
            0x01 | 0xd0..=0xd7 => continue,
            // A stuffed byte, a second start of image, the end of the image
            // or the start of its data: no frame header before any of them.
            0x00 | 0xd8 | 0xd9 | 0xda => return Header::Invalid,
            _ => {}
        }
        let Some(length) = be16(bytes, at) else {
            return Header::Short;
        };
        if length < 2 {
            return Header::Invalid;
        }
        // Every SOFn but DHT (c4), JPG (c8) and DAC (cc), which share the
        // range: length (2), precision (1), height (2), width (2).
        if matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            return match (be16(bytes, at + 3), be16(bytes, at + 5)) {
                (Some(height), Some(width)) => sized(width, height),
                _ => Header::Short,
            };
        }
        at += length as usize;
    }
}

/// Whether `bytes` start as an SVG document: a UTF-8 byte order mark at
/// most, then any whitespace, XML declaration, processing instructions,
/// comments and doctype, then an `<svg` element. Only what was read before
/// the format is known is looked at, so a prolog longer than that is no SVG.
fn starts_as_svg(bytes: &[u8]) -> bool {
    let mut rest = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    loop {
        rest = trim_xml_space(rest);
        let skipped = if let Some(after) = rest.strip_prefix(b"<?") {
            after_needle(after, b"?>")
        } else if let Some(after) = rest.strip_prefix(b"<!--") {
            after_needle(after, b"-->")
        } else if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case(b"<!DOCTYPE") {
            after_doctype(&rest[9..])
        } else {
            return rest
                .strip_prefix(b"<svg")
                .and_then(|after| after.first())
                .is_some_and(|next| matches!(next, b' ' | b'\t' | b'\r' | b'\n' | b'>' | b'/'));
        };
        match skipped {
            Some(after) => rest = after,
            None => return false,
        }
    }
}

fn trim_xml_space(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        .unwrap_or(bytes.len());
    &bytes[start..]
}

/// What follows the first `needle` in `bytes`.
fn after_needle<'a>(bytes: &'a [u8], needle: &[u8]) -> Option<&'a [u8]> {
    bytes
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| &bytes[at + needle.len()..])
}

/// What follows the `>` that closes a doctype, past quoted strings and an
/// internal subset in brackets, which may hold `>` of their own.
fn after_doctype(bytes: &[u8]) -> Option<&[u8]> {
    let mut depth = 0usize;
    let mut quote = None;
    for (at, &byte) in bytes.iter().enumerate() {
        match (quote, byte) {
            (Some(open), _) if byte == open => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(byte),
            (None, b'[') => depth += 1,
            (None, b']') => depth = depth.saturating_sub(1),
            (None, b'>') if depth == 0 => return Some(&bytes[at + 1..]),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-preview-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    /// A PNG's signature and IHDR chunk, CRC included (not checked here, nor
    /// by the reader): the 33 bytes the reader looks at.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0x5b, 0x36, 0xc5, 0xf8]);
        assert_eq!(bytes.len(), 33);
        bytes
    }

    /// A GIF89a of one frame covering its logical screen: `gif_with`.
    fn gif(width: u16, height: u16) -> Vec<u8> {
        gif_with((width, height), &[], (0, 0, width, height))
    }

    /// A GIF89a: the logical screen `screen` (width, height) with a global
    /// colour table of two colours, then `blocks` as they are (extensions),
    /// then one image descriptor of `frame` (left, top, width, height), a
    /// byte of LZW data and the trailer.
    fn gif_with(screen: (u16, u16), blocks: &[u8], frame: (u16, u16, u16, u16)) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&screen.0.to_le_bytes());
        bytes.extend_from_slice(&screen.1.to_le_bytes());
        // A global colour table of 2^(0 + 1) colours, black and white.
        bytes.extend_from_slice(&[0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]);
        bytes.extend_from_slice(blocks);
        bytes.push(0x2c);
        for value in [frame.0, frame.1, frame.2, frame.3] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&[0x00, 0x02, 0x02, 0x44, 0x01, 0x00, b';']);
        bytes
    }

    /// A graphic control extension, a comment of two sub-blocks and the
    /// NETSCAPE2.0 loop extension: what an animated GIF carries before its
    /// first frame.
    const GIF_EXTENSIONS: &[u8] = b"\x21\xf9\x04\x04\x0a\x00\x00\x00\
\x21\xfe\x05hello\x06 world\x00\
\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00";

    /// A JPEG laid out as `sips` writes one: start of image, a JFIF APP0, an
    /// APP1 of `app1_len` bytes (Exif, in a camera's), then the baseline frame
    /// header SOF0, a start of scan and the end of the image.
    fn jpeg(width: u16, height: u16, app1_len: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8];
        bytes.extend_from_slice(b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x48\x00\x48\x00\x00");
        bytes.extend_from_slice(&[0xff, 0xe1]);
        bytes.extend_from_slice(&app1_len.to_be_bytes());
        bytes.extend(std::iter::repeat_n(0u8, usize::from(app1_len) - 2));
        bytes.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        bytes.extend_from_slice(&[0xff, 0xda, 0x00, 0x0c, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, 0x12, 0x34]);
        bytes.extend_from_slice(&[0xff, 0xd9]);
        bytes
    }

    /// The first 30 bytes of what `cwebp` 1.x wrote for a 5 × 3 picture:
    /// lossy from a JPEG (`VP8 `), `-lossless` (`VP8L`), and lossy with alpha
    /// (`VP8X`). The reader looks no further.
    const WEBP_VP8: &[u8] = b"RIFFB\x00\x00\x00WEBPVP8 6\x00\x00\x00\xd0\x01\x00\x9d\x01\x2a\x05\x00\x03\x00";
    const WEBP_VP8L: &[u8] = b"RIFFt\x00\x00\x00WEBPVP8Lg\x00\x00\x00\x2f\x04\x80\x00\x10\x77\xa0\xa8\x6d\x23";
    const WEBP_VP8X: &[u8] = b"RIFF\\\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x10\x00\x00\x00\x04\x00\x00\x02\x00\x00";

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        s(&path)
    }

    fn refusal(path: &str) -> String {
        match read_image(path) {
            Ok(image) => panic!("{path} was read as {} {:?} × {:?}", image.mime, image.width, image.height),
            Err(err) => err,
        }
    }

    /// The words src/lib/ipc.js copies and the editor tells refusals apart
    /// by. Changing one here means changing it there, in the same change.
    #[test]
    fn the_refusal_words_are_fixed() {
        assert_eq!(NOT_FOUND, "File not found");
        assert_eq!(NOT_AN_IMAGE, "File is not an image NexTerm can show");
        assert_eq!(TOO_LARGE, "Image is too large to preview");
        assert_eq!(MAX_IMAGE_BYTES, 20 * 1024 * 1024);
        assert_eq!((MAX_IMAGE_SIDE, MAX_IMAGE_PIXELS), (32_768, 33_554_432));

        let dir = scratch("words");
        assert_eq!(refusal(&s(&dir.join("missing.png"))), format!("File not found: {}", s(&dir.join("missing.png"))));
        let text = write(&dir, "text.png", b"hello");
        assert!(refusal(&text).starts_with("File is not an image NexTerm can show ("), "{}", refusal(&text));
        let huge = write(&dir, "huge.png", &png(100_000, 100_000));
        assert_eq!(
            refusal(&huge),
            format!("Image is too large to preview (100000 × 100000; the limit is 32768 px per side and 32 Mi pixels): {huge}")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The name says nothing: a PNG called `.txt`, a JPEG with no extension
    /// and a GIF called `.png` are all what their bytes are.
    #[test]
    fn the_format_is_the_bytes_whatever_the_name() {
        let dir = scratch("formats");
        let cases: Vec<(&str, Vec<u8>, &str, u32, u32)> = vec![
            ("notes.txt", png(640, 480), "image/png", 640, 480),
            ("photo", jpeg(1920, 1080, 76), "image/jpeg", 1920, 1080),
            ("a.png", gif(320, 200), "image/gif", 320, 200),
            ("lossy.gif", WEBP_VP8.to_vec(), "image/webp", 5, 3),
            ("lossless.jpg", WEBP_VP8L.to_vec(), "image/webp", 5, 3),
            ("alpha.bin", WEBP_VP8X.to_vec(), "image/webp", 5, 3),
        ];
        for (name, bytes, mime, width, height) in cases {
            let image = read_image(&write(&dir, name, &bytes)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!((image.mime.as_str(), image.width, image.height), (mime, Some(width), Some(height)), "{name}");
            assert_eq!(image.bytes, bytes.len() as u64, "{name}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// Images real encoders wrote, from the repository: the app's icon and
    /// the README's animated GIF.
    #[test]
    fn real_files_read_as_what_they_are() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
        let icon = read_image(&s(&repo.join("icons").join("32x32.png"))).unwrap();
        assert_eq!((icon.mime.as_str(), icon.width, icon.height), ("image/png", Some(32), Some(32)));
        let demo = read_image(&s(&repo.join("..").join("docs").join("nexterm-demo.gif"))).unwrap();
        assert_eq!((demo.mime.as_str(), demo.width, demo.height), ("image/gif", Some(980), Some(442)));
    }

    /// The bytes come back exactly, in the standard alphabet with padding
    /// that a `data:` URI takes — including bytes that are not UTF-8.
    #[test]
    fn the_data_is_the_files_bytes_in_base64() {
        let dir = scratch("base64");
        // 33 bytes, so what follows starts a group of three: bytes chosen to
        // be `/` and `+` in the standard alphabet (`_` and `-` URL-safe),
        // and one left over, which is padded.
        let mut bytes = png(2, 2);
        bytes.extend_from_slice(&[0xff, 0xfe, 0x00, 0x80, 0x3e, 0x3f, 0xfb]);
        let image = read_image(&write(&dir, "pixel.png", &bytes)).unwrap();
        assert_eq!(STANDARD.decode(&image.data).unwrap(), bytes);
        assert!(image.data.starts_with("iVBORw0KGgo"), "{}", image.data);
        assert!(image.data.ends_with("//4AgD4/+w=="), "{}", image.data);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Text, a format not shown and a file shorter than any signature are
    /// refused with the fixed words, whatever they are called.
    #[test]
    fn what_is_no_image_is_refused_as_such() {
        let dir = scratch("not-image");
        let cases: [(&str, &[u8]); 7] = [
            ("text.png", b"just some text\n"),
            ("empty.png", b""),
            ("short.png", b"\x89PN"),
            ("bmp.png", b"BM\x3a\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00\x28\x00\x00\x00"),
            ("page.svg", b"<!DOCTYPE html><html><body><svg></svg></body></html>"),
            ("svgz.svg", b"\x1f\x8b\x08\x00\x00\x00\x00\x00"),
            ("riff.webp", b"RIFF\x10\x00\x00\x00WAVEfmt "),
        ];
        for (name, bytes) in cases {
            let err = refusal(&write(&dir, name, bytes));
            assert!(err.starts_with(NOT_AN_IMAGE), "{name}: {err}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// The sizes the human chose: 20 MB, 32768 px a side, 32 Mi pixels.
    /// Refused from the header — a 33-byte file would decode to 40 GB.
    #[test]
    fn a_header_declaring_too_many_pixels_is_refused_without_decoding() {
        let dir = scratch("pixels");
        let refused: Vec<(&str, Vec<u8>)> = vec![
            ("tiny-huge.png", png(100_000, 100_000)),
            ("wide.png", png(32_769, 1)),
            ("tall.gif", gif(1, 40_000)),
            ("wide.jpg", jpeg(65_535, 600, 20)),
            // Each side under the limit, the two together over it.
            ("area.png", png(8_192, 4_097)),
            ("area.jpg", jpeg(8_000, 4_200, 20)),
            ("canvas.webp", {
                let mut bytes = WEBP_VP8X.to_vec();
                bytes[24..27].copy_from_slice(&[0xff, 0xff, 0x00]); // 65536 wide
                bytes
            }),
        ];
        for (name, bytes) in refused {
            let err = refusal(&write(&dir, name, &bytes));
            assert!(err.starts_with(TOO_LARGE) && err.contains(" × "), "{name}: {err}");
            assert!(err.contains("the limit is 32768 px per side and 32 Mi pixels"), "{name}: {err}");
        }
        // Exactly at either limit is shown.
        for (name, bytes, width, height) in [
            ("at-side.png", png(32_768, 1), 32_768, 1),
            ("at-area.png", png(32_768, 1_024), 32_768, 1_024),
            ("at-area.gif", gif(8_192, 4_096), 8_192, 4_096),
        ] {
            let image = read_image(&write(&dir, name, &bytes)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!((image.width, image.height), (Some(width), Some(height)), "{name}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// Cut short or not what its signature says: refused, never guessed at.
    #[test]
    fn a_header_cut_short_or_not_valid_is_refused() {
        let dir = scratch("header");
        let png_ok = png(10, 10);
        let jpeg_ok = jpeg(10, 10, 20);
        let mut not_ihdr = png_ok.clone();
        not_ihdr[12..16].copy_from_slice(b"IDAT");
        let mut no_frame = jpeg_ok.clone();
        // The frame header dropped: the scan comes first.
        let sof = no_frame.windows(2).position(|w| w == [0xff, 0xc0]).unwrap();
        no_frame.drain(sof..sof + 19);
        let mut vp8_not_key = WEBP_VP8.to_vec();
        vp8_not_key[20] |= 1;
        let mut vp8l_version = WEBP_VP8L.to_vec();
        vp8l_version[24] |= 0x20;
        let cases: Vec<(&str, Vec<u8>, &str)> = vec![
            ("cut.png", png_ok[..32].to_vec(), "cut short"),
            ("cut.gif", gif(10, 10)[..12].to_vec(), "cut short"),
            ("cut.jpg", jpeg_ok[..40].to_vec(), "cut short"),
            // Up to the frame header's first height byte: its scan (14
            // bytes), data (2), end (2) and 13 of its 19 bytes are gone.
            ("cut-sof.jpg", jpeg_ok[..jpeg_ok.len() - 31].to_vec(), "cut short"),
            ("cut.webp", WEBP_VP8.to_vec()[..28].to_vec(), "cut short"),
            ("cut-x.webp", WEBP_VP8X.to_vec()[..16].to_vec(), "cut short"),
            ("not-ihdr.png", not_ihdr, "not valid"),
            ("zero.png", png(0, 10), "not valid"),
            ("zero.gif", gif(10, 0), "not valid"),
            ("no-frame.jpg", no_frame, "not valid"),
            // After a 4-byte APP0, no marker where the next must be.
            ("garbage.jpg", vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x7f, 0x00], "not valid"),
            ("bad-length.jpg", vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00], "not valid"),
            ("not-key.webp", vp8_not_key, "not valid"),
            ("version.webp", vp8l_version, "not valid"),
            ("chunk.webp", b"RIFF\x10\x00\x00\x00WEBPALPH\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00".to_vec(), "not valid"),
        ];
        for (name, bytes, why) in cases {
            let err = refusal(&write(&dir, name, &bytes));
            assert!(err.starts_with(NOT_AN_IMAGE) && err.contains(why), "{name}: {err}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// A photo's metadata can put its frame header well past the first
    /// bytes read; the rest is read and the walk goes on.
    #[test]
    fn a_jpeg_frame_header_past_the_first_bytes_read_is_still_found() {
        let dir = scratch("far-sof");
        let mut far = vec![0xff, 0xd8];
        for _ in 0..3 {
            far.extend_from_slice(&[0xff, 0xe2, 0xff, 0xff]);
            far.extend(std::iter::repeat_n(0u8, 0xffff - 2));
        }
        let tail = jpeg(4_000, 3_000, 20);
        far.extend_from_slice(&tail[2..]);
        assert!(far.len() as u64 > 3 * HEADER_PROBE_BYTES, "premise: the frame header is past the probe");
        let image = read_image(&write(&dir, "far.jpg", &far)).unwrap();
        assert_eq!((image.width, image.height, image.bytes), (Some(4_000), Some(3_000), far.len() as u64));

        let mut far_huge = far[..far.len() - tail.len() + 2].to_vec();
        far_huge.extend_from_slice(&jpeg(30_000, 30_000, 20)[2..]);
        assert!(refusal(&write(&dir, "far-huge.jpg", &far_huge)).starts_with(TOO_LARGE));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Checked before anything is read: sparse files of only zeros, which
    /// would be refused as no image if they were read, are refused by size.
    #[test]
    fn a_file_over_the_limit_is_refused_by_its_size_before_it_is_read() {
        let dir = scratch("bytes");
        let big = dir.join("big.png");
        fs::File::create(&big).unwrap().set_len(25 * 1024 * 1024).unwrap();
        let just_over = dir.join("just-over.png");
        fs::File::create(&just_over).unwrap().set_len(MAX_IMAGE_BYTES + 1).unwrap();

        let err = refusal(&s(&big));
        assert_eq!(err, format!("Image is too large to preview (25.0 MB; the limit is 20 MB): {}", s(&big)));
        let err = refusal(&s(&just_over));
        assert!(err.starts_with(TOO_LARGE) && err.contains("(20.1 MB; the limit is 20 MB)"), "{err}");

        // Exactly at the limit is read and shown.
        let at_limit = dir.join("at-limit.png");
        fs::write(&at_limit, png(64, 64)).unwrap();
        fs::OpenOptions::new().write(true).open(&at_limit).unwrap().set_len(MAX_IMAGE_BYTES).unwrap();
        let image = read_image(&s(&at_limit)).unwrap();
        assert_eq!((image.bytes, image.width), (MAX_IMAGE_BYTES, Some(64)));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A FIFO would hold an ordinary open until something wrote to it, and a
    /// folder is no file either. The read runs on a thread with a deadline,
    /// so waiting fails here instead of hanging the suite.
    #[cfg(unix)]
    #[test]
    fn a_fifo_or_a_folder_is_refused_without_waiting_on_it() {
        use std::os::unix::ffi::OsStrExt;
        let dir = scratch("fifo");
        let fifo = dir.join("photo.png");
        let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0, "premise: a FIFO");
        let path = s(&fifo);
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(read_image(&path));
        });
        let read = finished.recv_timeout(std::time::Duration::from_secs(5));
        let folder = refusal(&s(&dir));
        let _ = fs::remove_dir_all(&dir);
        let err = read.expect("the read is still waiting on the FIFO").unwrap_err();
        assert!(err.starts_with(NOT_AN_IMAGE) && err.contains("not a file"), "{err}");
        assert!(folder.starts_with(NOT_AN_IMAGE) && folder.contains("not a file"), "a folder: {folder}");
    }

    /// SVG is shown (as an `<img>` from a data URI, never inline) when it is
    /// UTF-8 text whose first element is `<svg`, after whatever may come
    /// first in an SVG file. It has no pixel size, so none is sent.
    #[test]
    fn an_svg_is_found_after_a_bom_a_prolog_comments_and_a_doctype() {
        let dir = scratch("svg");
        let shown: [(&str, &[u8]); 8] = [
            ("plain.txt", b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"/>"),
            ("bom.svg", b"\xef\xbb\xbf<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            ("prolog.svg", b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<svg>\n</svg>"),
            ("comment.svg", b"<!-- Generator: Adobe Illustrator 27.0 -->\r\n<svg\tviewBox=\"0 0 1 1\"></svg>"),
            ("all.svg", b"\xef\xbb\xbf  <?xml version=\"1.0\"?>\n<!-- a -->\n<?xml-stylesheet href=\"x.css\"?>\n<!--b--><svg/>"),
            (
                "doctype.svg",
                b"<?xml version=\"1.0\"?>\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg>",
            ),
            (
                "subset.svg",
                b"<!DOCTYPE svg [\n<!ENTITY ns_svg \"http://www.w3.org/2000/svg\">\n<!ENTITY a \"]>\">\n]>\n<svg xmlns=\"&ns_svg;\"/>",
            ),
            ("unicode.svg", "<svg><text>한글 ✅</text></svg>".as_bytes()),
        ];
        for (name, bytes) in shown {
            let image = read_image(&write(&dir, name, bytes)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!((image.mime.as_str(), image.width, image.height), ("image/svg+xml", None, None), "{name}");
            assert_eq!(STANDARD.decode(&image.data).unwrap(), bytes, "{name}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// Not UTF-8, a first element that is not `<svg`, or a prolog that never
    /// ends: refused as no image.
    #[test]
    fn an_svg_that_is_not_utf8_or_not_an_svg_is_refused() {
        let dir = scratch("svg-not");
        let refused: [(&str, &[u8], &str); 9] = [
            ("latin1.svg", b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><svg><text>caf\xe9</text></svg>", "not UTF-8"),
            ("utf16.svg", b"\xff\xfe<\x00s\x00v\x00g\x00>\x00", "no PNG"),
            ("utf16be.svg", b"\xfe\xff\x00<\x00s\x00v\x00g\x00>", "no PNG"),
            ("svgfoo.svg", b"<svgfoo></svgfoo>", "no PNG"),
            ("upper.svg", b"<SVG></SVG>", "no PNG"),
            ("note.svg", b"<?xml version=\"1.0\"?><note><svg/></note>", "no PNG"),
            ("open-comment.svg", b"<!-- never closed <svg>", "no PNG"),
            ("open-prolog.svg", b"<?xml version=\"1.0\" <svg>", "no PNG"),
            ("bare.svg", b"<svg", "no PNG"),
        ];
        for (name, bytes, why) in refused {
            let err = refusal(&write(&dir, name, bytes));
            assert!(err.starts_with(NOT_AN_IMAGE) && err.contains(why), "{name}: {err}");
        }

        // The non-UTF-8 byte far past the first 64 KB: found once it is all read.
        let mut late = b"<svg>".to_vec();
        late.extend(std::iter::repeat_n(b' ', 100_000));
        late.extend_from_slice(b"\xe9</svg>");
        assert!(refusal(&write(&dir, "late.svg", &late)).contains("not UTF-8"));
        // A comment longer than what is read before the format is known.
        let mut long = b"<!--".to_vec();
        long.extend(std::iter::repeat_n(b'x', 70_000));
        long.extend_from_slice(b"--><svg/>");
        assert!(refusal(&write(&dir, "long-comment.svg", &long)).starts_with(NOT_AN_IMAGE));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A GIF's size is its logical screen grown to cover its first frame,
    /// found past the colour table and every extension (reviewer A, R1): a
    /// 1 × 1 screen holding a 23000 × 23000 frame is refused by its pixels.
    #[test]
    fn a_gif_is_sized_by_its_first_frame_as_well_as_its_screen() {
        let dir = scratch("gif-frame");
        let hostile = write(&dir, "hostile.gif", &gif_with((1, 1), &[], (0, 0, 23_000, 23_000)));
        assert_eq!(
            refusal(&hostile),
            format!("Image is too large to preview (23000 × 23000; the limit is 32768 px per side and 32 Mi pixels): {hostile}")
        );
        // The same frame behind a graphic control extension, a comment and a loop extension.
        let behind = write(&dir, "behind.gif", &gif_with((1, 1), GIF_EXTENSIONS, (0, 0, 23_000, 23_000)));
        assert!(refusal(&behind).starts_with(TOO_LARGE) && refusal(&behind).contains("(23000 × 23000;"), "{}", refusal(&behind));
        // A small frame placed far out: the grown side is past the limit.
        let far = write(&dir, "far.gif", &gif_with((1, 1), GIF_EXTENSIONS, (40_000, 0, 1, 1)));
        assert!(refusal(&far).contains("(40001 × 1;"), "{}", refusal(&far));

        let shown: Vec<(&str, Vec<u8>, u32, u32)> = vec![
            ("plain.gif", gif(4, 3), 4, 3),
            ("animated.gif", gif_with((4, 3), GIF_EXTENSIONS, (0, 0, 4, 3)), 4, 3),
            // A frame inside the screen: the screen.
            ("inside.gif", gif_with((100, 80), GIF_EXTENSIONS, (10, 10, 20, 20)), 100, 80),
            // A frame reaching past it: the screen grown to cover it.
            ("past.gif", gif_with((10, 10), &[], (5, 6, 10, 10)), 15, 16),
            // No global colour table: the first block follows the screen.
            ("no-table.gif", {
                let mut bytes = gif_with((7, 5), &[], (0, 0, 7, 5));
                bytes.drain(10..19);
                bytes.splice(10..10, [0x00, 0x00, 0x00]);
                bytes
            }, 7, 5),
        ];
        for (name, bytes, width, height) in shown {
            let image = read_image(&write(&dir, name, &bytes)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!((image.mime.as_str(), image.width, image.height), ("image/gif", Some(width), Some(height)), "{name}");
            assert_eq!(image.bytes, bytes.len() as u64, "{name}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// Cut short before the first image descriptor, or ending without one:
    /// refused, never sized by the screen alone.
    #[test]
    fn a_gif_without_a_whole_first_image_descriptor_is_refused() {
        let dir = scratch("gif-short");
        let whole = gif_with((4, 3), GIF_EXTENSIONS, (0, 0, 4, 3));
        let descriptor = whole.iter().rposition(|&b| b == 0x2c).unwrap();
        let in_table = 13 + 3;
        let in_comment = 19 + 8 + 4;
        let cases: Vec<(&str, Vec<u8>, &str)> = vec![
            ("screen-only.gif", whole[..13].to_vec(), "cut short"),
            ("in-table.gif", whole[..in_table].to_vec(), "cut short"),
            ("in-comment.gif", whole[..in_comment].to_vec(), "cut short"),
            ("before-image.gif", whole[..descriptor].to_vec(), "cut short"),
            ("in-descriptor.gif", whole[..descriptor + 6].to_vec(), "cut short"),
            // The trailer before any image, and a byte that starts no block.
            ("trailer.gif", {
                let mut bytes = whole[..descriptor].to_vec();
                bytes.push(b';');
                bytes
            }, "not valid"),
            ("garbage.gif", {
                let mut bytes = whole.clone();
                bytes[descriptor] = 0x7f;
                bytes
            }, "not valid"),
        ];
        for (name, bytes, why) in cases {
            let err = refusal(&write(&dir, name, &bytes));
            assert!(err.starts_with(NOT_AN_IMAGE) && err.contains(why), "{name}: {err}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// A first image descriptor past the first bytes read, behind a comment
    /// of 80 KB: the rest of the file is read and the walk goes on — the
    /// frame is found, and sizes the image or refuses it.
    #[test]
    fn a_gif_frame_past_the_first_bytes_read_is_still_found() {
        let dir = scratch("gif-far");
        let mut comment = vec![0x21, 0xfe];
        for _ in 0..320 {
            comment.push(0xff);
            comment.extend(std::iter::repeat_n(b'x', 0xff));
        }
        comment.push(0x00);
        assert!(comment.len() as u64 > HEADER_PROBE_BYTES, "premise: the descriptor is past the probe");
        let far = gif_with((4, 3), &comment, (0, 0, 4, 3));
        let image = read_image(&write(&dir, "far.gif", &far)).unwrap();
        assert_eq!((image.width, image.height, image.bytes), (Some(4), Some(3), far.len() as u64));
        let far_huge = write(&dir, "far-huge.gif", &gif_with((1, 1), &comment, (0, 0, 23_000, 23_000)));
        assert!(refusal(&far_huge).contains("(23000 × 23000;"), "{}", refusal(&far_huge));
        // Cut inside that comment: cut short, after all of it was read.
        let cut = write(&dir, "far-cut.gif", &far[..70_000]);
        assert!(refusal(&cut).contains("cut short"), "{}", refusal(&cut));
        let _ = fs::remove_dir_all(&dir);
    }
}
