/**
 * PCM16 WAV -> IMA ADPCM WAV (Microsoft/DVI, format tag 0x0011), no dependencies.
 *
 * Each 16-bit sample is replaced by a 4-bit code: the difference from a predicted value, quantised with a
 * step size that adapts to the signal (bigger steps for loud passages, smaller for quiet ones). Result is
 * exactly ~4x smaller than PCM16 and plays natively on Android (Media3/ExoPlayer WavExtractor), iOS and browsers.
 */

const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/** Bytes per ADPCM block (mono). 512 is the common choice for 16–24 kHz audio. */
const BLOCK_ALIGN = 512;
const SAMPLES_PER_BLOCK = (BLOCK_ALIGN - 4) * 2 + 1; // 1017

export interface Pcm16 {
  samples: Int16Array; // mono
  sampleRate: number;
}

/** Parses a PCM 16-bit WAV (any channel count, downmixed to mono). Returns null for anything else. */
export function parsePcm16Wav(buf: Buffer): Pcm16 | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: real format is the first 2 bytes of the sub-format GUID.
      if (format === 0xfffe && size >= 26 && body + 26 <= buf.length) format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || channels < 1 || !sampleRate) return null;
      // Streamed WAVs (e.g. some TTS APIs) put 0 / 0xFFFFFFFF here: use what is actually present.
      if (size === 0 || body + size > buf.length) size = buf.length - body;
      const frames = Math.floor(size / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        for (let c = 0; c < channels; c += 1) sum += buf.readInt16LE(body + (i * channels + c) * 2);
        samples[i] = Math.round(sum / channels);
      }
      return { samples, sampleRate };
    }
    offset = body + size + (size & 1);
  }
  return null;
}

/** Encodes mono PCM16 into an IMA ADPCM WAV file. */
export function encodeImaAdpcmWav({ samples, sampleRate }: Pcm16): Buffer {
  const blocks = Math.max(1, Math.ceil(samples.length / SAMPLES_PER_BLOCK));
  const dataSize = blocks * BLOCK_ALIGN;
  const header = Buffer.alloc(60);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(header.length - 8 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(20, 16);
  header.writeUInt16LE(0x0011, 20); // WAVE_FORMAT_IMA_ADPCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(Math.round((sampleRate * BLOCK_ALIGN) / SAMPLES_PER_BLOCK), 28);
  header.writeUInt16LE(BLOCK_ALIGN, 32);
  header.writeUInt16LE(4, 34); // bits per sample
  header.writeUInt16LE(2, 36); // cbSize
  header.writeUInt16LE(SAMPLES_PER_BLOCK, 38);
  header.write('fact', 40, 'ascii');
  header.writeUInt32LE(4, 44);
  header.writeUInt32LE(samples.length, 48); // real sample count (last block is padded)
  header.write('data', 52, 'ascii');
  header.writeUInt32LE(dataSize, 56);

  const data = Buffer.alloc(dataSize);
  let index = 0;
  for (let b = 0; b < blocks; b += 1) {
    const start = b * SAMPLES_PER_BLOCK;
    const out = b * BLOCK_ALIGN;
    // Block header: the first sample verbatim + current step index.
    let predictor = start < samples.length ? samples[start] : 0;
    data.writeInt16LE(predictor, out);
    data[out + 2] = index;
    data[out + 3] = 0;
    for (let i = 1; i < SAMPLES_PER_BLOCK; i += 1) {
      const pos = start + i;
      const sample = pos < samples.length ? samples[pos] : predictor;
      let step = STEP_TABLE[index];
      let diff = sample - predictor;
      let code = 0;
      if (diff < 0) {
        code = 8;
        diff = -diff;
      }
      let vpdiff = step >> 3;
      if (diff >= step) { code |= 4; diff -= step; vpdiff += step; }
      step >>= 1;
      if (diff >= step) { code |= 2; diff -= step; vpdiff += step; }
      step >>= 1;
      if (diff >= step) { code |= 1; vpdiff += step; }
      predictor += code & 8 ? -vpdiff : vpdiff;
      if (predictor > 32767) predictor = 32767;
      else if (predictor < -32768) predictor = -32768;
      index += INDEX_TABLE[code];
      if (index < 0) index = 0;
      else if (index > 88) index = 88;
      // Two codes per byte, earlier sample in the low nibble.
      const byte = out + 4 + ((i - 1) >> 1);
      if ((i - 1) & 1) data[byte] |= code << 4;
      else data[byte] = code;
    }
  }
  return Buffer.concat([header, data]);
}

/** PCM16 WAV -> IMA ADPCM WAV, or null when the input isn't PCM16 WAV. */
export function compressWavToImaAdpcm(wav: Buffer): Buffer | null {
  const pcm = parsePcm16Wav(wav);
  if (!pcm || pcm.samples.length === 0) return null;
  return encodeImaAdpcmWav(pcm);
}
