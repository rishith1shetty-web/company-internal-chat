/**
 * Build assets for the Windows desktop client: the application icon, and the mark the offline
 * screen shows when nothing can be fetched.
 *
 * BOTH ARE DERIVED FROM public/brand/rising-path-mark.png, THE EXACT EXISTING ASSET. Nothing here
 * draws, redraws, recolours or approximates the company logo (§27) — it decodes that one file,
 * scales it down by averaging pixels, and repackages the results. The output is the same artwork
 * at the sizes Windows asks for.
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN A DEPENDENCY. Turning one PNG into a multi-size .ico is
 * about a hundred lines of zlib and struct packing, and the alternative is `sharp` — a native
 * module with a platform-specific binary, pulled in for a file that changes when the company
 * rebrands. That is the trade CLAUDE.md §3 asks to be made deliberately, and it is made here in
 * favour of no dependency at all. Node's own zlib does the only hard part.
 *
 * Both outputs are generated, so desktop/assets/ is git-ignored: it is build output, reproduced
 * by `npm run desktop:build`, not source.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'public', 'brand', 'rising-path-mark.png');
const ASSET_DIR = join(root, 'desktop', 'assets');
const BUILD_DIR = join(root, 'dist-desktop');

/**
 * Must match `PACKAGED_CONFIG_FILENAME` in desktop/config.ts.
 *
 * Written out rather than imported: this script is plain ESM run by node, and importing a
 * TypeScript module here would mean compiling one to run the build that compiles it.
 * `tests/desktop/config.test.ts` asserts the two agree.
 */
const PACKAGED_CONFIG = 'packaged-server.json';

/*
 * Load `.env`, so `npm run desktop:package:win` picks up DESKTOP_SERVER_URL from the project's own
 * configuration rather than requiring it to be typed into the shell every time. Node's built-in
 * loader, as in server.ts and prisma.config.ts — no dependency (CLAUDE.md §3). It does NOT override
 * a variable already set in the environment, so a one-off shell value still wins for a one-off build.
 */
try {
  process.loadEnvFile(join(root, '.env'));
} catch {
  // No .env on this machine: the package simply defaults to localhost.
}

/** The sizes Windows draws an application icon at: tray, taskbar, Alt-Tab, and the desktop. */
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** What the offline screen displays. Larger than it renders, for high-DPI displays. */
const OFFLINE_MARK_SIZE = 256;

// ---------------------------------------------------------------------------------------------
// PNG decoding
// ---------------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, as PNG defines it. Table built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Decodes an 8-bit truecolour-with-alpha PNG into flat RGBA bytes.
 *
 * Deliberately narrow: it supports exactly the shape of the brand asset (colour type 6, bit depth
 * 8, no interlacing) and refuses anything else loudly rather than producing a subtly wrong icon.
 * A general PNG decoder is a library; this is a build step for one known file.
 */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG file.');

  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colourType = data[9];
      const interlace = data[12];

      if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
        throw new Error(
          `Unsupported PNG (bit depth ${bitDepth}, colour type ${colourType}, interlace ${interlace}). ` +
            'Expected 8-bit RGBA, non-interlaced.',
        );
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  const stride = width * 4;

  /*
   * Undo the per-scanline filters. Each row is prefixed with a filter byte and is predicted from
   * the pixel to its left (a), the row above (b) and the pixel above-left (c). This is the whole
   * of PNG's compression cleverness and it has to be reversed exactly.
   */
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const target = y * stride;

    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x];
      const a = x >= 4 ? pixels[target + x - 4] : 0;
      const b = y > 0 ? pixels[target - stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[target - stride + x - 4] : 0;

      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + a;
          break;
        case 2:
          restored = value + b;
          break;
        case 3:
          restored = value + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          restored = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`Unknown PNG filter ${filter} on row ${y}.`);
      }

      pixels[target + x] = restored & 0xff;
    }
  }

  return { width, height, pixels };
}

// ---------------------------------------------------------------------------------------------
// Scaling and encoding
// ---------------------------------------------------------------------------------------------

/**
 * Box-filter downscale: every output pixel is the average of the input pixels it covers.
 *
 * Averaging rather than sampling, because a logo reduced by picking one pixel in five loses its
 * thin strokes entirely — the mark would come out ragged at 16px, which is the size most often
 * seen. Colour is averaged weighted by alpha, so transparent edge pixels do not pull the colour
 * of the result towards whatever happens to sit behind them.
 */
function resize(image, size) {
  const output = Buffer.alloc(size * size * 4);
  const scaleX = image.width / size;
  const scaleY = image.height / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));

    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));

      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      let weight = 0;
      let count = 0;

      for (let sy = y0; sy < y1 && sy < image.height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < image.width; sx += 1) {
          const index = (sy * image.width + sx) * 4;
          const a = image.pixels[index + 3];

          r += image.pixels[index] * a;
          g += image.pixels[index + 1] * a;
          b += image.pixels[index + 2] * a;
          alpha += a;
          weight += a;
          count += 1;
        }
      }

      const target = (y * size + x) * 4;
      if (weight === 0) {
        // Fully transparent region: the colour is meaningless, so leave it at zero.
        output[target] = 0;
        output[target + 1] = 0;
        output[target + 2] = 0;
        output[target + 3] = 0;
      } else {
        output[target] = Math.round(r / weight);
        output[target + 1] = Math.round(g / weight);
        output[target + 2] = Math.round(b / weight);
        output[target + 3] = Math.round(alpha / count);
      }
    }
  }

  return { width: size, height: size, pixels: output };
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));

  return Buffer.concat([length, typed, crc]);
}

/** Encodes RGBA back to a PNG. Filter 0 throughout: deflate does the work, and this is a build. */
function encodePng(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);

  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Packs several PNGs into a Windows .ico.
 *
 * Every entry is stored as a PNG rather than as a BMP with an AND mask. Windows Vista and later
 * read PNG-in-ICO natively, the alpha channel survives without a separate mask, and the file is a
 * fraction of the size — the BMP form exists for Windows XP, which is not a target here.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  const encoded = images.map((image) => encodePng(image));

  let offset = header.length + directory.length;

  encoded.forEach((data, index) => {
    const image = images[index];
    const entry = index * 16;

    // 256 is stored as 0: the field is one byte, so 256 does not fit and 0 means "256".
    directory[entry] = image.width >= 256 ? 0 : image.width;
    directory[entry + 1] = image.height >= 256 ? 0 : image.height;
    directory[entry + 2] = 0; // palette size — none, it is truecolour
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);

    offset += data.length;
  });

  return Buffer.concat([header, directory, ...encoded]);
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

function generateAssets() {
  if (!existsSync(SOURCE)) {
    throw new Error(`The brand mark is missing: ${SOURCE}`);
  }

  const source = decodePng(readFileSync(SOURCE));
  console.log(`[assets] Source mark ${source.width}x${source.height}`);

  mkdirSync(ASSET_DIR, { recursive: true });

  const ico = buildIco(ICON_SIZES.map((size) => resize(source, size)));
  writeFileSync(join(ASSET_DIR, 'icon.ico'), ico);
  console.log(`[assets] icon.ico  ${ICON_SIZES.join(', ')}px  (${ico.length} bytes)`);

  // electron-builder wants a PNG alongside the .ico for non-Windows targets and for the
  // installer's own artwork.
  const largest = encodePng(resize(source, 256));
  writeFileSync(join(ASSET_DIR, 'icon.png'), largest);

  const mark = encodePng(resize(source, OFFLINE_MARK_SIZE));
  writeFileSync(join(ASSET_DIR, 'rising-path-mark.png'), mark);
  console.log(`[assets] rising-path-mark.png  ${OFFLINE_MARK_SIZE}px  (${mark.length} bytes)`);
}

/**
 * Copies the static files next to the compiled main process.
 *
 * `main.js` resolves everything relative to its own directory, so the offline page and the icons
 * have to sit beside it both when running from dist-desktop and when packed into the installer.
 */
function stageBuildOutput() {
  if (!existsSync(BUILD_DIR)) {
    console.log('[assets] dist-desktop not built yet; skipping the copy step.');
    return;
  }

  mkdirSync(join(BUILD_DIR, 'assets'), { recursive: true });

  copyFileSync(join(root, 'desktop', 'offline.html'), join(BUILD_DIR, 'offline.html'));
  for (const name of ['icon.ico', 'icon.png', 'rising-path-mark.png']) {
    copyFileSync(join(ASSET_DIR, name), join(BUILD_DIR, 'assets', name));
  }

  console.log('[assets] Staged offline.html and icons into dist-desktop.');

  writePackagedServerUrl();
}

/**
 * Carries DESKTOP_SERVER_URL from the BUILD environment into the shipped application.
 *
 * WHY THIS EXISTS. `desktop/main.ts` reads `process.env.DESKTOP_SERVER_URL` at run time, in the
 * employee's Electron process — so setting that variable while running electron-builder changed
 * nothing at all about the installer it produced. The packaged client still defaulted to
 * localhost, and the only way to point it anywhere was to hand-write server.json on every machine.
 *
 * So the build writes the value into a small generated file beside `main.js`. It is picked up by
 * the `dist-desktop/**` entry in the electron-builder `files` list, so it travels inside the asar
 * with no packaging change, and `resolveServerUrl` treats it as the level BELOW server.json — a
 * default for a fresh installation, never something that overrides a site's own configuration.
 *
 * The address itself is never written into tracked source (CLAUDE.md §7): it comes from the
 * environment, and this output is git-ignored along with the rest of dist-desktop.
 */
function writePackagedServerUrl() {
  const target = join(BUILD_DIR, PACKAGED_CONFIG);
  const configured = (process.env.DESKTOP_SERVER_URL ?? '').trim();

  if (configured.length === 0) {
    /*
     * Remove a file left by a previous build rather than leaving it in place.
     *
     * Without this, once anybody had built with an address set, every later build would keep
     * shipping it — a stale address baked into an installer that nobody meant to configure, which
     * is far worse than the honest localhost default.
     */
    if (existsSync(target)) {
      rmSync(target);
      console.log(`[assets] DESKTOP_SERVER_URL not set; removed the stale ${PACKAGED_CONFIG}.`);
    } else {
      console.log(`[assets] DESKTOP_SERVER_URL not set; the package will default to localhost.`);
    }
    return;
  }

  // Validated here so a typo fails the build, rather than shipping an installer that cannot
  // start. Same two protocols the client accepts at run time.
  let origin;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`protocol ${parsed.protocol} is not http or https`);
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      throw new Error('it must not contain a username or password');
    }
    origin = parsed.origin;
  } catch (error) {
    throw new Error(
      `DESKTOP_SERVER_URL is not a usable address (${String(error.message ?? error)}). ` +
        'Use the form http://server:3000 or https://chat.example.local',
    );
  }

  writeFileSync(target, `${JSON.stringify({ serverUrl: origin }, null, 2)}
`, 'utf8');
  console.log(`[assets] ${PACKAGED_CONFIG}  serverUrl=${origin}  (from DESKTOP_SERVER_URL)`);
}

generateAssets();
stageBuildOutput();
