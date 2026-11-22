// What to declare in hello.video (box 0.28.0): only what this PC plays without dropping frames.
// Apps pick direct play or a server transcode from it, so it must not overpromise.
//
// Chromium's navigator.mediaCapabilities.decodingInfo() tells us, per codec and size, whether
// the GPU decodes it in hardware (powerEfficient). mpv uses the same D3D11/DXVA decoders
// (--hwdec=auto-safe), so that is a fair stand-in. Its "smooth" is optimistic for software
// decoding (it says yes to 4K AV1 on a VM with no GPU), so we don't use it.
//
//   h264                  always (software decodes 1080p fine)
//   hevc / vp9 / av1      only with a hardware decoder (at 1080p)
//   maxHeight 2160        a monitor of 2160+ px is attached AND h264 or hevc decodes 4K in hardware
//   containers / audio    everything mpv demuxes and decodes (cheap; audio is always software)
//   passthrough           none: mpv's audio-spdif isn't enabled
//   ranges (box 0.28.1)   "sdr"; plus "hdr10" "hlg" when Windows HDR is on for a monitor (mpv
//                         then plays HDR as HDR there, --target-colorspace-hint). With HDR off
//                         mpv tone-maps HDR to SDR well, but apps should transcode for it.
//                         HDR10+ and Dolby Vision aren't claimed (mpv shows them as HDR10).
//
// No Electron imports (unit-tested); the probe itself runs in main.ts.

import type { VideoCaps } from "./protocol";

export type Codec = "h264" | "hevc" | "vp9" | "av1";
export const CODECS: Record<Codec, string> = {
  h264: "avc1.640033",
  hevc: "hvc1.1.6.L153.B0",
  vp9: "vp09.00.51.08",
  av1: "av01.0.13M.08",
};
export const PROBE_HEIGHTS = [1080, 2160] as const;

/** decodingInfo results, keyed "<codec>@<height>". */
export type DecodeProbe = Partial<Record<string, { supported: boolean; smooth: boolean; powerEfficient: boolean }>>;

/**
 * Is this display in an HDR mode? Electron's display.colorSpace with Windows HDR on reports an
 * scRGB-linear (or PQ/HLG) transfer; SDR displays report SRGB, e.g.
 * "{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}".
 */
export function isHdrColorSpace(colorSpace: string | undefined): boolean {
  const transfer = /transfer:\s*([A-Z0-9_]+)/i.exec(colorSpace ?? "")?.[1] ?? "";
  return /SCRGB|PQ|SMPTEST2084|HLG|ARIB/i.test(transfer);
}

export function videoCaps(probe: DecodeProbe, tallestMonitorPx: number, hdrMonitor = false): VideoCaps {
  const hw = (c: Codec, h: number) => Boolean(probe[`${c}@${h}`]?.supported && probe[`${c}@${h}`]?.powerEfficient);
  const video: Codec[] = ["h264"];
  for (const c of ["hevc", "av1", "vp9"] as Codec[]) if (hw(c, 1080)) video.push(c);
  const fourK = tallestMonitorPx >= 2160 && (hw("h264", 2160) || hw("hevc", 2160));
  return {
    containers: ["mp4", "mkv", "mov", "webm", "ts", "hls"],
    video,
    audio: ["aac", "mp3", "ac3", "eac3", "dts", "truehd", "opus", "flac"],
    maxHeight: fourK ? 2160 : 1080,
    seek: true,
    ranges: hdrMonitor ? ["sdr", "hdr10", "hlg"] : ["sdr"],
    tracks: true, // box 0.29.0: audio tracks and subtitles (src/video-tracks.ts)
  };
}

/** The JavaScript main.ts runs in a hidden page to fill a DecodeProbe. */
export const PROBE_SCRIPT = `(async () => {
  const codecs = ${JSON.stringify(CODECS)};
  const out = {};
  for (const [name, c] of Object.entries(codecs)) for (const h of ${JSON.stringify(PROBE_HEIGHTS)}) {
    try {
      const i = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: {
        contentType: 'video/mp4; codecs="' + c + '"', width: Math.round(h * 16 / 9), height: h,
        bitrate: h > 1080 ? 40e6 : 10e6, framerate: 30 } });
      out[name + '@' + h] = { supported: i.supported, smooth: i.smooth, powerEfficient: i.powerEfficient };
    } catch (e) { /* unknown codec string: leave it out */ }
  }
  return out;
})()`;
