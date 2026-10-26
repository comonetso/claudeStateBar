// 확장 core/sound.ts 의 amplifyWavToTemp 와 같은 방식으로 WAV 샘플을 키운다.
// 확장은 임시 파일에 캐시하고, 여기서는 데몬 메모리에 둔다.
// 지원: 16비트 정수 · 8비트 정수 · 32비트 실수 PCM. 그 밖의 형식이나 WAV 가 아니면 원본 그대로.
export function amplifyWav(source: Buffer, gainPercent: number): Buffer {
  if (gainPercent === 100) return source;
  if (source.length < 44 || source.toString("ascii", 0, 4) !== "RIFF" || source.toString("ascii", 8, 12) !== "WAVE") {
    return source;
  }

  let fmtOffset = -1;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let p = 12;
  while (p + 8 <= source.length) {
    const id = source.toString("ascii", p, p + 4);
    const size = source.readUInt32LE(p + 4);
    if (id === "fmt ") {
      fmtOffset = p + 8;
      fmtSize = size;
    } else if (id === "data") {
      dataOffset = p + 8;
      dataSize = size;
      break;
    }
    p += 8 + size + (size % 2);
  }
  if (fmtOffset < 0 || dataOffset < 0 || fmtSize < 16) return source;

  const audioFormat = source.readUInt16LE(fmtOffset);
  const bitsPerSample = source.readUInt16LE(fmtOffset + 14);
  const out = Buffer.from(source);
  const dataEnd = Math.min(dataOffset + dataSize, out.length);
  const gain = gainPercent / 100;

  if (audioFormat === 1 && bitsPerSample === 16) {
    for (let i = dataOffset; i + 2 <= dataEnd; i += 2) {
      const v = Math.round(out.readInt16LE(i) * gain);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
    }
  } else if (audioFormat === 1 && bitsPerSample === 8) {
    for (let i = dataOffset; i < dataEnd; i++) {
      const v = Math.round((out.readUInt8(i) - 128) * gain) + 128;
      out.writeUInt8(Math.max(0, Math.min(255, v)), i);
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    for (let i = dataOffset; i + 4 <= dataEnd; i += 4) {
      out.writeFloatLE(Math.max(-1, Math.min(1, out.readFloatLE(i) * gain)), i);
    }
  } else {
    return source;
  }
  return out;
}
