/** A WAV file around raw 16-bit little-endian mono PCM. The local speech
 *  server returns PCM for each piece of text; the pieces are joined here
 *  and given one header. */

const HEADER_BYTES = 44;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const RIFF_PREAMBLE_BYTES = 8;
const FMT_CHUNK_BYTES = 16;
const PCM_FORMAT = 1;

type HeaderField =
  | { kind: "text"; value: string }
  | { kind: "uint16"; value: number }
  | { kind: "uint32"; value: number };

/** The 44-byte header, field by field, in file order. */
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

export function wavFile(pcmChunks: Uint8Array[], sampleRate: number): Uint8Array {
  const dataBytes = pcmChunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = new Uint8Array(HEADER_BYTES);
  writeFields(new DataView(header.buffer), headerFields(sampleRate, dataBytes));
  return concatBytes([header, ...pcmChunks]);
}
