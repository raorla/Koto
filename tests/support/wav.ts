/** WAV PCM 16 bits mono : `segments` alterne silences et « paroles » (son harmonique qui fait réagir la détection de voix). */
export function makeWav(segments: { seconds: number; voice: boolean }[], rate = 16_000): Buffer {
  const samples: number[] = [];
  for (const segment of segments) {
    const count = Math.round(segment.seconds * rate);
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      samples.push(segment.voice ? 0.25 * Math.sin(2 * Math.PI * 180 * t) + 0.12 * Math.sin(2 * Math.PI * 540 * t) * Math.sin(2 * Math.PI * 3 * t) : 0);
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 0x7fff), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
