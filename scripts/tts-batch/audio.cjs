'use strict';

// PCM processing only: no ffmpeg, speech recognizer, model, or native dependency.
function readWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected a RIFF/WAVE file');
  let format, pcm;
  for (let pos = 12; pos + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(pos + 4), start = pos + 8;
    if (start + size > buffer.length) throw new Error('Truncated WAV chunk');
    const name = buffer.toString('ascii', pos, pos + 4);
    if (name === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format');
      format = { codec: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), rate: buffer.readUInt32LE(start + 4), align: buffer.readUInt16LE(start + 12), bits: buffer.readUInt16LE(start + 14) };
    }
    if (name === 'data') pcm = buffer.subarray(start, start + size);
    pos = start + size + (size % 2);
  }
  if (!format || !pcm || format.codec !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) || format.align !== format.channels * 2 || format.rate < 8000 || format.rate > 96000 || pcm.length % format.align) throw new Error('Only complete 16-bit PCM mono/stereo WAV is supported');
  if (pcm.length === 0 || pcm.length / format.align / format.rate > 600) throw new Error('Audio must be between 0 and 600 seconds');
  return { ...format, pcm, duration: pcm.length / format.align / format.rate };
}

function wav(pcm, rate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function sliceWav(audio, start, end) {
  const a = Math.max(0, Math.floor(start * audio.rate)) * audio.align;
  const b = Math.min(audio.pcm.length, Math.ceil(end * audio.rate) * audio.align);
  if (b <= a) throw new Error('Empty audio cut');
  return wav(audio.pcm.subarray(a, b), audio.rate, audio.channels);
}

function silenceSettings(options = {}) {
  const thresholdDb = options.thresholdDb ?? -42, minSilenceSec = options.minSilenceSec ?? 1.2;
  if (!Number.isFinite(thresholdDb) || thresholdDb < -80 || thresholdDb > -15 || !Number.isFinite(minSilenceSec) || minSilenceSec < 0.3 || minSilenceSec > 10) throw new Error('Invalid silence settings');
  return { thresholdDb, minSilenceSec };
}

function analyze(audio, segments, options = {}) {
  const { thresholdDb, minSilenceSec } = silenceSettings(options);
  const frameSamples = Math.round(audio.rate * 0.02), frames = [];
  const totalSamples = audio.pcm.length / 2;
  let silenceStart = null;
  const silences = [];
  for (let offset = 0; offset < totalSamples; offset += frameSamples * audio.channels) {
    const end = Math.min(totalSamples, offset + frameSamples * audio.channels);
    let sum = 0, peak = 0;
    for (let j = offset; j < end; j++) {
      const v = audio.pcm.readInt16LE(j * 2) / 32768;
      sum += v * v; peak = Math.max(peak, Math.abs(v));
    }
    const db = 20 * Math.log10(Math.max(1e-8, Math.sqrt(sum / (end - offset))));
    const t = offset / audio.channels / audio.rate;
    frames.push([Number(t.toFixed(3)), Number(db.toFixed(1))]);
    // Peak gate protects brief consonants within an otherwise quiet frame.
    const quiet = db <= thresholdDb && peak <= 10 ** ((thresholdDb + 12) / 20);
    if (quiet && silenceStart === null) silenceStart = t;
    if ((!quiet || end === totalSamples) && silenceStart !== null) {
      const stop = quiet ? audio.duration : t;
      if (stop - silenceStart >= minSilenceSec) silences.push({ start: silenceStart, end: stop, duration: stop - silenceStart });
      silenceStart = null;
    }
  }
  const candidates = silences.filter(s => s.start >= 0.3 && s.end <= audio.duration - 0.3);
  const reasons = [];
  if (candidates.length !== segments.length - 1) reasons.push(`Expected ${segments.length - 1} internal long pauses; found ${candidates.length}. No automatic selection of the longest pauses.`);
  const clips = [];
  if (!reasons.length) {
    const wordCounts = segments.map(s => s.text.trim().split(/\s+/u).length);
    const speechTotal = audio.duration - silences.reduce((n, s) => n + s.duration, 0);
    const wordTotal = wordCounts.reduce((n, w) => n + w, 0);
    for (let i = 0; i < segments.length; i++) {
      const start = i ? candidates[i - 1].end - 0.15 : 0;
      const end = i < candidates.length ? candidates[i].start + 0.15 : audio.duration;
      const duration = end - start, expected = speechTotal * wordCounts[i] / wordTotal;
      if (duration < 2 || duration < expected * 0.45 || duration > expected * 2.2) reasons.push(`Segment ${i + 1}: implausible duration ${duration.toFixed(2)}s for its text; manual review required.`);
      clips.push({ index: i + 1, id: segments[i].id, start, end, duration });
    }
  }
  return { status: reasons.length ? 'manual_boundaries_required' : 'candidate_cuts_need_listening', semanticVerified: false, thresholdDb, minSilenceSec, frameSec: 0.02, duration: audio.duration, silences, candidates, clips: reasons.length ? [] : clips, reasons, frames };
}

module.exports = { readWav, wav, sliceWav, analyze, silenceSettings };
