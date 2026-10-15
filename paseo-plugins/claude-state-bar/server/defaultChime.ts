import type { SoundKind } from "../shared/sound";

// 리눅스 직원 기본음. 직접 만든 짧은 음형이라 운영체제 음원 파일·외부 도구·API 키가 필요 없다.
const NOTES: Record<SoundKind, number[]> = {
  completion: [523, 659, 784],
  question: [659, 880],
  warning: [784, 659],
  danger: [880, 440, 880],
  workflow: [784, 988, 784, 988],
  // 압축 준비(10-15) — 끝남(올라가는 세 음)과 갈리게 낮게 두 번 두드린 뒤 올린다
  compact: [392, 392, 587],
};

export function defaultChime(kind: SoundKind): Buffer {
  const rate = 22050;
  const tone = Math.round(rate * 0.16);
  const gap = Math.round(rate * 0.045);
  const notes = NOTES[kind];
  const samples = notes.length * (tone + gap);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  notes.forEach((hz, n) => {
    for (let i = 0; i < tone; i++) {
      // 시작·끝 12ms를 낮춰 딱 소리를 막고, 300% 까지는 찌그러지지 않게 한다(10-15 부터 최대 1000% — 그 위는 끝이 잘린다).
      const fade = Math.min(1, i / (rate * 0.012), (tone - 1 - i) / (rate * 0.012));
      const sample = Math.round(9000 * fade * Math.sin(2 * Math.PI * hz * i / rate));
      wav.writeInt16LE(sample, 44 + (n * (tone + gap) + i) * 2);
    }
  });
  return wav;
}
