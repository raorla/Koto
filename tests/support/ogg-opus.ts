// Fabrique un vrai vocal Telegram (OGG/Opus, mono, 48 kHz) à partir d'un audio quelconque :
// Chrome encode en Opus (WebCodecs), puis on range les paquets dans un conteneur OGG (RFC 7845).
// Sert aux tests réels de la transcription, sans ffmpeg.
import type { Browser } from 'playwright';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(data: Buffer): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

function oggPage(packets: Buffer[], granule: bigint, serial: number, sequence: number, flags: number): Buffer {
  const lacing: number[] = [];
  for (const packet of packets) {
    for (let left = packet.length; ; left -= 255) {
      lacing.push(Math.min(left, 255));
      if (left < 255) break;
    }
  }
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header[5] = flags;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = lacing.length;
  const page = Buffer.concat([header, Buffer.from(lacing), ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/** Conteneur OGG pour des paquets Opus de 20 ms (960 échantillons à 48 kHz). */
export function muxOggOpus(packets: Buffer[], preSkip = 312): Buffer {
  const serial = 0x6b6f746f;
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1; // version
  head[9] = 1; // mono
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48_000, 12);
  const vendor = Buffer.from('Koto tests', 'utf8');
  const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.from(new Uint32Array([vendor.length]).buffer), vendor, Buffer.alloc(4)]);
  const pages = [oggPage([head], 0n, serial, 0, 0x02), oggPage([tags], 0n, serial, 1, 0)];
  let granule = BigInt(preSkip);
  for (let i = 0; i < packets.length; i += 50) {
    const batch = packets.slice(i, i + 50);
    granule += BigInt(batch.length * 960);
    pages.push(oggPage(batch, granule, serial, pages.length, i + 50 >= packets.length ? 0x04 : 0));
  }
  return Buffer.concat(pages);
}

// Script de page en texte (pas en fonction) : le transpileur des tests y glisserait ses propres helpers.
const ENCODE_SCRIPT = `async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const decoded = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(bytes.buffer);
  // Rééchantillonnage en mono 48 kHz.
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 48000), 48000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const pcm = (await offline.startRendering()).getChannelData(0);

  const out = [];
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      let s = '';
      for (const b of buf) s += String.fromCharCode(b);
      out.push(btoa(s));
    },
    error: (e) => { failure = e; },
  });
  encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 });
  for (let offset = 0; offset < pcm.length; offset += 960) {
    const frame = new Float32Array(960);
    frame.set(pcm.subarray(offset, offset + 960));
    encoder.encode(new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: (offset / 48000) * 1e6, data: frame }));
  }
  await encoder.flush();
  if (failure) throw failure;
  return out;
}`;

/** Encode un audio (MP3, WAV…) en paquets Opus avec WebCodecs dans Chrome, puis en fichier OGG/Opus. */
export async function toTelegramVoice(browser: Browser, audio: Buffer): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    // WebCodecs n'existe que dans un contexte sécurisé : localhost en est un (page servie par Playwright).
    await page.route('http://localhost/koto-audio', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>audio</title>' }));
    await page.goto('http://localhost/koto-audio');
    const packets = (await page.evaluate(`(${ENCODE_SCRIPT})(${JSON.stringify(audio.toString('base64'))})`)) as string[];
    return muxOggOpus(packets.map((p) => Buffer.from(p, 'base64')));
  } finally {
    await page.close();
  }
}
