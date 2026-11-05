/** MP3 factice : `frames` trames MPEG-1 couche III à 128 kb/s, 44,1 kHz (417 octets, 1 152 échantillons chacune). */
export function fakeMp3(frames: number, id3 = false): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  const tag = id3 ? Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]) : Buffer.alloc(0);
  return Buffer.concat([tag, ...Array.from({ length: frames }, () => frame)]);
}
