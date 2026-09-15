const HEADER_BYTES = 44;
const RIFF_PREAMBLE_BYTES = 8;
const FMT_CHUNK_BYTES = 16;
const PCM_FORMAT = 1;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const MAX_INT16 = 32767;
const MIN_INT16 = -32768;

type HeaderField =
  | { kind: "text"; value: string }
  | { kind: "uint16"; value: number }
  | { kind: "uint32"; value: number };

/** 16-bit samples for float samples in the range -1 to 1. Holding audio
 *  this way takes half the memory of the model's float output. */
export function toPcm16(samples: Float32Array): Int16Array {
  return Int16Array.from(samples, toInt16);
}

/** Mono 16-bit PCM WAV bytes for chunks of samples, in order. */
export function encodeWav(chunks: Int16Array[], sampleRate: number): Uint8Array {
  const dataBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  writeFields(view, headerFields(sampleRate, dataBytes));
  let offset = HEADER_BYTES;
  for (const chunk of chunks) {
    chunk.forEach((sample, index) => {
      view.setInt16(offset + index * BYTES_PER_SAMPLE, sample, true);
    });
    offset += chunk.byteLength;
  }
  return bytes;
}

function headerFields(sampleRate: number, dataBytes: number): HeaderField[] {
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  return [
    { kind: "text", value: "RIFF" },
    { kind: "uint32", value: HEADER_BYTES - RIFF_PREAMBLE_BYTES + dataBytes },
    { kind: "text", value: "WAVE" },
    { kind: "text", value: "fmt " },
    { kind: "uint32", value: FMT_CHUNK_BYTES },
    { kind: "uint16", value: PCM_FORMAT },
    { kind: "uint16", value: CHANNELS },
    { kind: "uint32", value: sampleRate },
    { kind: "uint32", value: sampleRate * blockAlign },
    { kind: "uint16", value: blockAlign },
    { kind: "uint16", value: BITS_PER_SAMPLE },
    { kind: "text", value: "data" },
    { kind: "uint32", value: dataBytes },
  ];
}

function writeFields(view: DataView, fields: HeaderField[]): void {
  let offset = 0;
  for (const field of fields) {
    if (field.kind === "text") {
      [...field.value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
      offset += field.value.length;
    } else if (field.kind === "uint16") {
      view.setUint16(offset, field.value, true);
      offset += 2;
    } else {
      view.setUint32(offset, field.value, true);
      offset += 4;
    }
  }
}

function toInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  if (clamped < 0) {
    return Math.round(clamped * -MIN_INT16);
  }
  return Math.round(clamped * MAX_INT16);
}
