type NwaHeader = {
  channels: number;
  bitsPerSample: number;
  sampleRate: number;
  compressionLevel: number;
  useRunLength: number;
  blocks: number;
  dataSize: number;
  compressedDataSize: number;
  sampleCount: number;
  blockSize: number;
  restSize: number;
};

const NWA_HEADER_SIZE = 0x2c;

export function decodeNwaToWav(input: Uint8Array) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const header = readNwaHeader(view);
  validateNwaHeader(header);

  if (header.compressionLevel === -1) {
    return decodeUncompressedNwa(input, header);
  }

  const offsetsStart = NWA_HEADER_SIZE;
  const audioDataStart = offsetsStart + header.blocks * 4;
  if (input.byteLength < audioDataStart) {
    throw new Error('NWAのブロック情報が不足しています。');
  }

  const offsets = Array.from({ length: header.blocks }, (_, index) => view.getInt32(offsetsStart + index * 4, true));
  validateNwaOffsets(offsets, header.compressedDataSize);

  const wav = new Uint8Array(WAV_HEADER_SIZE + header.dataSize);
  writeWavHeader(wav, header.dataSize, header.channels, header.bitsPerSample, header.sampleRate);

  const bytesPerSample = header.bitsPerSample / 8;
  let outputOffset = WAV_HEADER_SIZE;

  for (let blockIndex = 0; blockIndex < header.blocks; blockIndex += 1) {
    const decodedBlockSize = (blockIndex === header.blocks - 1 ? getLastBlockSampleCount(header) : header.blockSize) * bytesPerSample;
    const compressedStart = audioDataStart + offsets[blockIndex];
    const nextOffset = blockIndex === header.blocks - 1 ? header.compressedDataSize : offsets[blockIndex + 1];
    const compressedEnd = Math.min(audioDataStart + nextOffset, input.byteLength);

    if (compressedStart < audioDataStart || compressedStart > compressedEnd) {
      throw new Error('NWAの圧縮ブロック位置が不正です。');
    }

    decodeNwaBlock(input.subarray(compressedStart, compressedEnd), wav, outputOffset, decodedBlockSize, header);
    outputOffset += decodedBlockSize;
  }

  return wav;
}

function readNwaHeader(view: DataView): NwaHeader {
  if (view.byteLength < NWA_HEADER_SIZE) {
    throw new Error('NWAヘッダーが不足しています。');
  }

  const header: NwaHeader = {
    channels: view.getInt16(0, true),
    bitsPerSample: view.getInt16(2, true),
    sampleRate: view.getInt32(4, true),
    compressionLevel: view.getInt32(8, true),
    useRunLength: view.getInt32(12, true),
    blocks: view.getInt32(16, true),
    dataSize: view.getInt32(20, true),
    compressedDataSize: view.getInt32(24, true),
    sampleCount: view.getInt32(28, true),
    blockSize: view.getInt32(32, true),
    restSize: view.getInt32(36, true),
  };

  if (header.compressionLevel === -1) {
    const bytesPerSample = header.bitsPerSample / 8;
    header.blockSize = 65536;
    header.restSize = (header.dataSize % (header.blockSize * bytesPerSample)) / bytesPerSample;
    header.blocks = Math.floor(header.dataSize / (header.blockSize * bytesPerSample)) + (header.restSize > 0 ? 1 : 0);
    if (header.dataSize > 0 && header.restSize === 0) {
      header.restSize = header.blockSize;
    }
  }

  return header;
}

function validateNwaHeader(header: NwaHeader) {
  if (header.channels !== 1 && header.channels !== 2) {
    throw new Error(`NWAはモノラル/ステレオのみ対応しています。channels=${header.channels}`);
  }
  if (header.bitsPerSample !== 8 && header.bitsPerSample !== 16) {
    throw new Error(`NWAは8bit/16bitのみ対応しています。bits=${header.bitsPerSample}`);
  }
  if (header.sampleRate <= 0) {
    throw new Error('NWAのサンプルレートが不正です。');
  }
  if (header.compressionLevel < -1 || header.compressionLevel > 5) {
    throw new Error(`NWAの圧縮レベルに対応していません。level=${header.compressionLevel}`);
  }
  if (header.blocks <= 0 || header.blocks > 1000000) {
    throw new Error(`NWAのブロック数が不正です。blocks=${header.blocks}`);
  }

  const bytesPerSample = header.bitsPerSample / 8;
  if (header.dataSize !== header.sampleCount * bytesPerSample) {
    throw new Error('NWAのデータサイズが不正です。');
  }
  if (header.sampleCount !== (header.blocks - 1) * header.blockSize + getLastBlockSampleCount(header)) {
    throw new Error('NWAのサンプル数が不正です。');
  }
}

function getLastBlockSampleCount(header: NwaHeader) {
  return header.restSize || header.blockSize;
}

function validateNwaOffsets(offsets: number[], compressedDataSize: number) {
  let previous = 0;
  for (const offset of offsets) {
    if (offset < previous || offset < 0 || offset >= compressedDataSize) {
      throw new Error('NWAのブロックオフセットが不正です。');
    }
    previous = offset;
  }
}

function decodeUncompressedNwa(input: Uint8Array, header: NwaHeader) {
  const audioStart = NWA_HEADER_SIZE;
  const audioEnd = audioStart + header.dataSize;
  if (input.byteLength < audioEnd) {
    throw new Error('NWAのPCMデータが不足しています。');
  }

  const wav = new Uint8Array(WAV_HEADER_SIZE + header.dataSize);
  writeWavHeader(wav, header.dataSize, header.channels, header.bitsPerSample, header.sampleRate);
  wav.set(input.subarray(audioStart, audioEnd), WAV_HEADER_SIZE);
  return wav;
}

function decodeNwaBlock(block: Uint8Array, output: Uint8Array, outputOffset: number, outputSize: number, header: NwaHeader) {
  const bytesPerSample = header.bitsPerSample / 8;
  const sampleCount = outputSize / bytesPerSample;
  const predictor = [0, 0];
  let sourceOffset = 0;

  predictor[0] = readInitialSample(block, sourceOffset, header.bitsPerSample);
  sourceOffset += bytesPerSample;

  if (header.channels === 2) {
    predictor[1] = readInitialSample(block, sourceOffset, header.bitsPerSample);
    sourceOffset += bytesPerSample;
  }

  const bits = new BitReader(block, sourceOffset);
  const outputView = new DataView(output.buffer, output.byteOffset, output.byteLength);
  let flipFlag = 0;
  let runLength = 0;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    if (runLength === 0) {
      const exponent = bits.read(3);
      if (exponent === 7) {
        if (bits.read(1) === 1) {
          predictor[flipFlag] = 0;
        } else {
          const width = header.compressionLevel >= 3 ? 8 : 8 - header.compressionLevel;
          const shift = header.compressionLevel >= 3 ? 9 : 9 + header.compressionLevel;
          applyNwaDelta(predictor, flipFlag, bits.read(width), width, shift);
        }
      } else if (exponent !== 0) {
        const width = header.compressionLevel >= 3 ? header.compressionLevel + 3 : 5 - header.compressionLevel;
        const shift = header.compressionLevel >= 3 ? 1 + exponent : 2 + exponent + header.compressionLevel;
        applyNwaDelta(predictor, flipFlag, bits.read(width), width, shift);
      } else if (header.useRunLength === 1) {
        runLength = bits.read(1);
        if (runLength === 1) {
          runLength = bits.read(2);
          if (runLength === 3) {
            runLength = bits.read(8);
          }
        }
      }
    } else {
      runLength -= 1;
    }

    const sampleOffset = outputOffset + sampleIndex * bytesPerSample;
    if (header.bitsPerSample === 8) {
      output[sampleOffset] = predictor[flipFlag] & 0xff;
    } else {
      outputView.setInt16(sampleOffset, predictor[flipFlag], true);
    }

    if (header.channels === 2) {
      flipFlag ^= 1;
    }
  }
}

function readInitialSample(block: Uint8Array, offset: number, bitsPerSample: number) {
  if (offset + bitsPerSample / 8 > block.byteLength) return 0;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  return bitsPerSample === 8 ? view.getUint8(offset) : view.getUint16(offset, true);
}

function applyNwaDelta(predictor: number[], channel: number, encoded: number, width: number, shift: number) {
  const signMask = 1 << (width - 1);
  const valueMask = signMask - 1;
  const value = (encoded & valueMask) << shift;
  predictor[channel] += (encoded & signMask) !== 0 ? -value : value;
}

class BitReader {
  private bitPosition: number;

  constructor(
    private readonly data: Uint8Array,
    byteOffset: number,
  ) {
    this.bitPosition = byteOffset * 8;
  }

  read(width: number) {
    let value = 0;
    for (let bit = 0; bit < width; bit += 1) {
      const absoluteBit = this.bitPosition + bit;
      const byte = this.data[absoluteBit >> 3] ?? 0;
      value |= ((byte >> (absoluteBit & 7)) & 1) << bit;
    }
    this.bitPosition += width;
    return value;
  }
}

const WAV_HEADER_SIZE = 44;

function writeWavHeader(output: Uint8Array, dataSize: number, channels: number, bitsPerSample: number, sampleRate: number) {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const bytesPerSample = (bitsPerSample + 7) >> 3;
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      output[offset + index] = value.charCodeAt(index);
    }
  };

  writeAscii(0, 'RIFF');
  view.setInt32(4, dataSize + 0x24, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setInt32(16, 16, true);
  view.setInt16(20, 1, true);
  view.setInt16(22, channels, true);
  view.setInt32(24, sampleRate, true);
  view.setInt32(28, bytesPerSample * sampleRate * channels, true);
  view.setInt16(32, bytesPerSample * channels, true);
  view.setInt16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setInt32(40, dataSize, true);
}
