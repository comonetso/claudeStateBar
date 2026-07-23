import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import { log } from './logger';
import { getRunsOnRemote } from './runtimeContext';

// Provider-neutral sound engine: plays OS-native chimes for warning/danger/completion/
// question/workflow events and amplifies WAV gain in-memory. Decision logic ("when to
// play") lives in the caller (orchestrator), NOT here — this module only plays.

// Play N beeps using OS-native commands (non-blocking, errors silently ignored).
// count=1: warning (single tone), count=2: danger (two ascending tones).
export function playBeep(count: number): void {
    const kind = count === 1 ? 'warning' : 'danger';
    const soundPath = getSoundPath(kind);
    const gain = getSoundGain(kind);
    playSoundFile(soundPath, count, `beep:${kind}`, gain);
}

export type SoundKind = 'warning' | 'danger' | 'completion' | 'question' | 'workflow';

// Default WAV paths per platform — used when the user setting is empty.
const DEFAULT_WAVS: Record<SoundKind, string> = {
    warning: process.platform === 'win32' ? 'C:\\Windows\\Media\\Windows Notify.wav'
        : process.platform === 'darwin' ? '/System/Library/Sounds/Glass.aiff' : '',
    danger:  process.platform === 'win32' ? 'C:\\Windows\\Media\\Windows Critical Stop.wav'
        : process.platform === 'darwin' ? '/System/Library/Sounds/Glass.aiff' : '',
    completion: process.platform === 'win32' ? 'C:\\Windows\\Media\\tada.wav'
        : process.platform === 'darwin' ? '/System/Library/Sounds/Hero.aiff' : '',
    question: process.platform === 'win32' ? 'C:\\Windows\\Media\\Speech On.wav'
        : process.platform === 'darwin' ? '/System/Library/Sounds/Ping.aiff' : '',
    // Workflow/subagent "all done" — distinct tone from tada.wav (completion).
    workflow: process.platform === 'win32' ? 'C:\\Windows\\Media\\Ring06.wav'
        : process.platform === 'darwin' ? '/System/Library/Sounds/Funk.aiff' : ''
};

export function getSoundPath(kind: SoundKind): string {
    const cfg = vscode.workspace.getConfiguration('claudeContextBar');
    const key = kind === 'warning' ? 'soundWarning'
        : kind === 'danger' ? 'soundDanger'
        : kind === 'completion' ? 'soundCompletion'
        : kind === 'workflow' ? 'soundWorkflow'
        : 'soundQuestion';
    const user = cfg.get<string>(key, '').trim();
    return user || DEFAULT_WAVS[kind];
}

export function getSoundGain(kind: SoundKind): number {
    const cfg = vscode.workspace.getConfiguration('claudeContextBar');
    const key = kind === 'warning' ? 'soundWarningGain'
        : kind === 'danger' ? 'soundDangerGain'
        : kind === 'completion' ? 'soundCompletionGain'
        : kind === 'workflow' ? 'soundWorkflowGain'
        : 'soundQuestionGain';
    const raw = cfg.get<number>(key, 100);
    // Clamp to documented range
    if (!Number.isFinite(raw)) return 100;
    return Math.max(50, Math.min(300, Math.round(raw)));
}

// Amplify a WAV file by gainPercent (50–300) by parsing the PCM data chunk and
// scaling each sample. Returns a path to a cached temp file. Falls back to the
// original path if anything goes wrong (unsupported format, parse error, etc.).
//
// Cache key: source file mtime + size + gain. The cache lives in
// %TEMP%/claudeContextBar/amplified/ and is invalidated when the source file
// changes (different mtime/size produces a different key).
//
// Supported PCM formats: 16-bit signed, 8-bit unsigned, 32-bit IEEE float.
// Other formats (24-bit, ADPCM, etc.) fall back to the original file.
function amplifyWavToTemp(srcPath: string, gainPercent: number): string {
    if (gainPercent === 100) return srcPath;
    try {
        const stat = fs.statSync(srcPath);
        const cacheDir = path.join(os.tmpdir(), 'claudeContextBar', 'amplified');
        const keyMaterial = `${srcPath}|${stat.mtimeMs}|${stat.size}|${gainPercent}`;
        const hash = crypto.createHash('sha1').update(keyMaterial).digest('hex').slice(0, 16);
        const base = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
        const outPath = path.join(cacheDir, `${base}_g${gainPercent}_${hash}.wav`);
        if (fs.existsSync(outPath)) return outPath;

        const buf = fs.readFileSync(srcPath);
        // Minimum RIFF/WAVE header sanity
        if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
            log(`[amp] not a RIFF/WAVE file, skipping: ${srcPath}`);
            return srcPath;
        }

        // Walk chunks to find "fmt " and "data"
        let fmtOffset = -1, fmtSize = 0;
        let dataOffset = -1, dataSize = 0;
        let p = 12;
        while (p + 8 <= buf.length) {
            const id = buf.toString('ascii', p, p + 4);
            const size = buf.readUInt32LE(p + 4);
            if (id === 'fmt ') { fmtOffset = p + 8; fmtSize = size; }
            else if (id === 'data') { dataOffset = p + 8; dataSize = size; break; }
            p += 8 + size + (size % 2);  // chunks are 2-byte aligned
        }
        if (fmtOffset < 0 || dataOffset < 0 || fmtSize < 16) {
            log(`[amp] missing fmt/data chunks: ${srcPath}`);
            return srcPath;
        }

        const audioFormat = buf.readUInt16LE(fmtOffset);          // 1 = PCM, 3 = IEEE float
        const bitsPerSample = buf.readUInt16LE(fmtOffset + 14);
        const out = Buffer.from(buf);  // copy
        const dataEnd = Math.min(dataOffset + dataSize, out.length);
        const gain = gainPercent / 100;

        if (audioFormat === 1 && bitsPerSample === 16) {
            for (let i = dataOffset; i + 2 <= dataEnd; i += 2) {
                const s = out.readInt16LE(i);
                let v = Math.round(s * gain);
                if (v > 32767) v = 32767;
                else if (v < -32768) v = -32768;
                out.writeInt16LE(v, i);
            }
        } else if (audioFormat === 1 && bitsPerSample === 8) {
            // 8-bit PCM is unsigned, centred at 128
            for (let i = dataOffset; i < dataEnd; i++) {
                const s = out.readUInt8(i) - 128;
                let v = Math.round(s * gain) + 128;
                if (v > 255) v = 255;
                else if (v < 0) v = 0;
                out.writeUInt8(v, i);
            }
        } else if (audioFormat === 3 && bitsPerSample === 32) {
            for (let i = dataOffset; i + 4 <= dataEnd; i += 4) {
                let v = out.readFloatLE(i) * gain;
                if (v > 1) v = 1;
                else if (v < -1) v = -1;
                out.writeFloatLE(v, i);
            }
        } else {
            log(`[amp] unsupported WAV format (audioFormat=${audioFormat}, bits=${bitsPerSample}), skipping: ${srcPath}`);
            return srcPath;
        }

        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(outPath, out);
        log(`[amp] cached ${outPath} (gain=${gainPercent}%, ${bitsPerSample}-bit fmt=${audioFormat})`);
        return outPath;
    } catch (e: any) {
        log(`[amp] failed for ${srcPath}: ${e?.message ?? e}`);
        return srcPath;
    }
}

// Play a sound file by absolute path. Supports .wav (SoundPlayer.PlaySync — fast & sync)
// and .mp3 / other formats (WPF MediaPlayer — async, sleeps for media duration).
//
// Guard: if this extension instance itself runs on a remote host (extensionKind=workspace),
// sounds would play on the REMOTE server's audio device — which the user can't hear.
// With extensionKind=["ui"] the extension always runs on the local VS Code host, so audio
// works even when the workspace is a Remote-SSH folder. We check extensionUri.scheme (set
// in activate) rather than vscode.env.remoteName, which only reflects the workspace
// connection — not where the extension process actually lives.
export function playSoundFile(soundPath: string, repeat: number = 1, label: string = 'beep', gainPercent: number = 100): void {
    if (getRunsOnRemote()) {
        log(`[${label}] skipped — extension process is on remote host; sound only plays on local UI host`);
        return;
    }
    if (!soundPath) {
        log(`[${label}] empty soundPath, skipping`);
        return;
    }
    const isWav = soundPath.toLowerCase().endsWith('.wav');
    // WAV gets in-memory PCM amplification (can go above 100%, real volume boost).
    // MP3/other formats can only be ATTENUATED via the media player's Volume property
    // (0–1 range); we can't amplify them without re-encoding.
    let effectivePath = soundPath;
    if (isWav && gainPercent !== 100) {
        effectivePath = amplifyWavToTemp(soundPath, gainPercent);
    }
    log(`[${label}] playSoundFile path="${effectivePath}" repeat=${repeat} gain=${gainPercent}% platform=${process.platform}`);
    if (process.platform === 'win32') {
        const escaped = effectivePath.replace(/'/g, "''");
        let single: string;
        if (isWav) {
            single = `(New-Object System.Media.SoundPlayer '${escaped}').PlaySync()`;
        } else {
            // WPF MediaPlayer for MP3/other formats. Volume is 0–1 (no amplification possible).
            // For gain > 100, we fall back to original volume; for gain < 100, attenuate.
            const volume = Math.min(1, Math.max(0, gainPercent / 100));
            single = `Add-Type -AssemblyName presentationCore; $p = [System.Windows.Media.MediaPlayer]::new(); $p.Volume = ${volume.toFixed(3)}; $p.Open([System.Uri]::new('${escaped}')); $i = 0; while(-not $p.NaturalDuration.HasTimeSpan -and $i -lt 30){Start-Sleep -Milliseconds 50; $i++}; $p.Play(); $dur = if($p.NaturalDuration.HasTimeSpan){[Math]::Min($p.NaturalDuration.TimeSpan.TotalMilliseconds + 200, 10000)}else{5000}; Start-Sleep -Milliseconds $dur`;
        }
        const cmd = Array.from({ length: repeat }, () => single).join('; ');
        const full = `powershell -NoProfile -NonInteractive -c "${cmd}"`;
        log(`[${label}] exec (${isWav ? 'wav' : 'mp3/other'}): ${full.substring(0, 200)}${full.length > 200 ? '...' : ''}`);
        cp.exec(full, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
            if (err) log(`[${label}] exec error: ${err.message}`);
            if (stderr?.trim()) log(`[${label}] stderr: ${stderr.trim()}`);
            else log(`[${label}] exec completed`);
        });
    } else if (process.platform === 'darwin') {
        // afplay supports WAV, MP3, AIFF, AAC etc. natively. --volume 0..2.
        // For WAV we already amplified the file; pass volume 1.0. For MP3, pass gain/100 capped at 2.
        const escaped = effectivePath.replace(/"/g, '\\"');
        const afVol = isWav ? 1 : Math.min(2, Math.max(0, gainPercent / 100));
        const single = `afplay --volume ${afVol.toFixed(3)} "${escaped}"`;
        const cmd = Array.from({ length: repeat }, () => single).join(' && sleep 0.3 && ');
        cp.exec(cmd, (err) => { if (err) log(`[${label}] afplay error: ${err.message}`); });
    } else {
        // Linux: try paplay (WAV/OGG) → mpg123/ffplay (MP3) → aplay → fallback bell.
        // paplay has --volume (0–65536, 65536 = 100%); for gain > 100 we cap at ~200%.
        const esc = effectivePath.replace(/"/g, '\\"');
        const paVolStr = isWav ? '' : ` --volume=${Math.round(Math.min(2, Math.max(0, gainPercent / 100)) * 65536)}`;
        const playOne = soundPath
            ? `paplay${paVolStr} "${esc}" 2>/dev/null || mpg123 -q "${esc}" 2>/dev/null || ffplay -nodisp -autoexit -loglevel quiet "${esc}" 2>/dev/null || aplay -q "${esc}" 2>/dev/null || true`
            : 'paplay /usr/share/sounds/freedesktop/stereo/bell.oga 2>/dev/null || beep 2>/dev/null || true';
        const cmd = Array.from({ length: repeat }, () => playOne).join('; sleep 0.3; ');
        cp.exec(cmd, { shell: '/bin/bash' }, (err) => { if (err) log(`[${label}] linux error: ${err.message}`); });
    }
}

// 3-note ascending arpeggio (600→800→1000 Hz) — "Claude finished" positive signal,
// distinct from warning (single) and danger (double ascending pair).
export function playCompletionSound(): void {
    playSoundFile(getSoundPath('completion'), 1, 'beep:completion', getSoundGain('completion'));
}

// Distinct chime for "the entire workflow / all subagents finished" — a one-shot
// gate signal (not the per-activity completion beep). Default Ring06.wav on
// Windows, intentionally a different tone from tada.wav (completion).
export function playWorkflowCompleteSound(): void {
    playSoundFile(getSoundPath('workflow'), 1, 'beep:workflow', getSoundGain('workflow'));
}

// Distinct chime for "Claude is paused waiting on the user" (AskUserQuestion /
// ExitPlanMode / optional stuck-tool-use heuristic). Default Speech On.wav on
// Windows — a short, clearly different tone from tada.wav.
export function playQuestionSound(): void {
    playSoundFile(getSoundPath('question'), 1, 'beep:question', getSoundGain('question'));
}
