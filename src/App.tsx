import { useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import JSZip from 'jszip';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

type Bitrate = '128k' | '192k' | '256k' | '320k';
type SampleRate = 'original' | '44100' | '48000';
type Channels = 'original' | 'mono' | 'stereo';
type FileStatus = 'queued' | 'converting' | 'done' | 'failed';

type ConversionItem = {
  id: string;
  file: File;
  status: FileStatus;
  progress: number;
  error?: string;
  outputUrl?: string;
  outputName: string;
  outputBlob?: Blob;
};

const bitrateOptions: Bitrate[] = ['128k', '192k', '256k', '320k'];
const sampleRateOptions: SampleRate[] = ['original', '44100', '48000'];
const channelOptions: Channels[] = ['original', 'mono', 'stereo'];
const acceptedExtensions = ['wav', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'webm', 'mp4', 'mov', 'mkv', 'mp3'];

function App() {
  const [items, setItems] = useState<ConversionItem[]>([]);
  const [bitrate, setBitrate] = useState<Bitrate>('192k');
  const [sampleRate, setSampleRate] = useState<SampleRate>('original');
  const [channels, setChannels] = useState<Channels>('original');
  const [isConverting, setIsConverting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [appMessage, setAppMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const currentIdRef = useRef<string | null>(null);

  const completedItems = useMemo(() => items.filter((item) => item.outputBlob), [items]);
  const hasQueuedOrFailed = useMemo(
    () => items.some((item) => item.status === 'queued' || item.status === 'failed'),
    [items],
  );

  const addFiles = (fileList: FileList | File[]) => {
    const nextItems = Array.from(fileList).map((file) => ({
      id: `${file.name}-${file.lastModified}-${file.size}-${createId()}`,
      file,
      status: 'queued' as const,
      progress: 0,
      outputName: toMp3Name(file.name),
    }));
    setItems((current) => [...current, ...nextItems]);
    setAppMessage(nextItems.length ? `${nextItems.length}件のファイルを追加しました。` : '');
  };

  const loadFfmpeg = async () => {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;

    const ffmpeg = ffmpegRef.current ?? new FFmpeg();
    ffmpegRef.current = ffmpeg;
    ffmpeg.on('progress', ({ progress }) => {
      const id = currentIdRef.current;
      if (!id) return;
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, progress: Math.max(item.progress, Math.min(99, Math.round(progress * 100))) } : item,
        ),
      );
    });

    setAppMessage('ffmpeg.wasmを読み込んでいます。初回は少し時間がかかります。');
    await ffmpeg.load({ coreURL, wasmURL });
    return ffmpeg;
  };

  const convertOne = async (ffmpeg: FFmpeg, item: ConversionItem) => {
    const inputName = `input-${item.id}.${getExtension(item.file.name) || 'bin'}`;
    const outputName = `output-${item.id}.mp3`;
    currentIdRef.current = item.id;

    setItems((current) =>
      current.map((currentItem) =>
        currentItem.id === item.id
          ? { ...currentItem, status: 'converting', progress: 1, error: undefined, outputBlob: undefined, outputUrl: undefined }
          : currentItem,
      ),
    );

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(item.file));
      const args = ['-i', inputName, '-vn', '-codec:a', 'libmp3lame', '-b:a', bitrate];
      if (sampleRate !== 'original') args.push('-ar', sampleRate);
      if (channels !== 'original') args.push('-ac', channels === 'mono' ? '1' : '2');
      args.push(outputName);

      await ffmpeg.exec(args);
      const data = await ffmpeg.readFile(outputName);
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
      const copiedBytes = new Uint8Array(bytes.byteLength);
      copiedBytes.set(bytes);
      const blob = new Blob([copiedBytes], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);

      setItems((current) =>
        current.map((currentItem) => {
          if (currentItem.id !== item.id) return currentItem;
          if (currentItem.outputUrl) URL.revokeObjectURL(currentItem.outputUrl);
          return { ...currentItem, status: 'done', progress: 100, outputBlob: blob, outputUrl: url, error: undefined };
        }),
      );
    } catch (error) {
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === item.id
            ? {
                ...currentItem,
                status: 'failed',
                progress: 0,
                error: error instanceof Error ? error.message : 'このファイルは変換できませんでした。',
              }
            : currentItem,
        ),
      );
    } finally {
      await Promise.allSettled([ffmpeg.deleteFile(inputName), ffmpeg.deleteFile(outputName)]);
      currentIdRef.current = null;
    }
  };

  const startConversion = async () => {
    if (isConverting || !hasQueuedOrFailed) return;
    setIsConverting(true);
    try {
      const ffmpeg = await loadFfmpeg();
      const targets = items.filter((item) => item.status === 'queued' || item.status === 'failed');
      for (const item of targets) {
        await convertOne(ffmpeg, item);
      }
      setAppMessage('変換処理が完了しました。成功したファイルは保存できます。');
    } catch (error) {
      setAppMessage(error instanceof Error ? error.message : 'ffmpeg.wasmの読み込みに失敗しました。');
    } finally {
      setIsConverting(false);
    }
  };

  const downloadZip = async () => {
    if (!completedItems.length || zipBusy) return;
    setZipBusy(true);
    try {
      const zip = new JSZip();
      completedItems.forEach((item) => {
        if (item.outputBlob) zip.file(uniqueZipName(zip, item.outputName), item.outputBlob);
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, `tomp3-${new Date().toISOString().slice(0, 10)}.zip`);
    } finally {
      setZipBusy(false);
    }
  };

  const clearAll = () => {
    items.forEach((item) => item.outputUrl && URL.revokeObjectURL(item.outputUrl));
    setItems([]);
    setAppMessage('一覧をクリアしました。');
  };

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Static / No upload / Browser only</p>
        <h1>MP3一括変換</h1>
        <p className="lead">音声・動画ファイルを端末内でMP3に変換します。ファイルはサーバーへ送信されません。</p>
      </section>

      <section
        className={`drop-zone ${isDragging ? 'is-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          multiple
          accept={acceptedExtensions.map((ext) => `.${ext}`).join(',')}
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.currentTarget.value = '';
          }}
        />
        <button className="primary add-button" type="button" onClick={() => inputRef.current?.click()}>
          ファイルを選択
        </button>
        <p>スマホでは上のボタンから追加してください。PCではここにドラッグ&ドロップできます。</p>
        <small>対応目安: wav / flac / ogg / opus / m4a / aac / webm / mp4 など</small>
      </section>

      <details className="settings-card" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
        <summary>変換設定</summary>
        <div className="settings-grid">
          <label>
            bitrate
            <select value={bitrate} onChange={(event) => setBitrate(event.target.value as Bitrate)} disabled={isConverting}>
              {bitrateOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            sample rate
            <select value={sampleRate} onChange={(event) => setSampleRate(event.target.value as SampleRate)} disabled={isConverting}>
              {sampleRateOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label>
            channels
            <select value={channels} onChange={(event) => setChannels(event.target.value as Channels)} disabled={isConverting}>
              {channelOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        </div>
      </details>

      <section className="notice">
        <strong>注意:</strong> 大容量ファイルや多数の同時追加ではブラウザのメモリ不足で失敗する場合があります。変換中は画面を閉じたり、端末をスリープさせたりしないでください。
      </section>

      {appMessage && <p className="app-message" role="status">{appMessage}</p>}

      <section className="file-list" aria-label="変換ファイル一覧">
        {items.length === 0 ? (
          <div className="empty-card">まだファイルがありません。まずは「ファイルを選択」から追加してください。</div>
        ) : (
          items.map((item) => <FileCard key={item.id} item={item} />)
        )}
      </section>

      {items.length > 0 && (
        <button className="ghost clear-button" type="button" onClick={clearAll} disabled={isConverting}>
          一覧をクリア
        </button>
      )}

      <nav className="bottom-bar" aria-label="変換操作">
        <button className="primary" type="button" onClick={startConversion} disabled={isConverting || !hasQueuedOrFailed}>
          {isConverting ? '変換中...' : '変換開始'}
        </button>
        <button className="secondary" type="button" onClick={downloadZip} disabled={!completedItems.length || zipBusy}>
          {zipBusy ? 'ZIP作成中...' : 'ZIPで保存'}
        </button>
      </nav>
    </main>
  );
}

function FileCard({ item }: { item: ConversionItem }) {
  return (
    <article className="file-card">
      <div className="file-card__header">
        <div>
          <h2>{item.file.name}</h2>
          <p>{getExtension(item.file.name).toUpperCase() || 'UNKNOWN'} · {formatBytes(item.file.size)}</p>
        </div>
        <span className={`status status--${item.status}`}>{statusLabel(item.status)}</span>
      </div>
      <div className="progress-row" aria-label={`${item.file.name}の進捗 ${item.progress}%`}>
        <div className="progress-bar"><span style={{ width: `${item.progress}%` }} /></div>
        <span>{item.progress}%</span>
      </div>
      {item.error && <p className="error-message">{item.error}</p>}
      <a
        className={`download-link ${!item.outputUrl ? 'is-disabled' : ''}`}
        href={item.outputUrl ?? '#'}
        download={item.outputName}
        aria-disabled={!item.outputUrl}
        onClick={(event) => {
          if (!item.outputUrl) event.preventDefault();
        }}
      >
        MP3を保存
      </a>
    </article>
  );
}

function createId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getExtension(name: string) {
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
}

function toMp3Name(name: string) {
  const base = name.replace(/\.[^/.]+$/, '') || 'converted';
  return `${base}.mp3`;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function statusLabel(status: FileStatus) {
  return ({ queued: '待機中', converting: '変換中', done: '完了', failed: '失敗' } satisfies Record<FileStatus, string>)[status];
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function uniqueZipName(zip: JSZip, fileName: string) {
  if (!zip.file(fileName)) return fileName;
  const base = fileName.replace(/\.mp3$/i, '');
  let index = 2;
  let candidate = `${base}-${index}.mp3`;
  while (zip.file(candidate)) {
    index += 1;
    candidate = `${base}-${index}.mp3`;
  }
  return candidate;
}

export default App;
