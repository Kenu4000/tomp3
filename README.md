# tomp3

Vite + React + TypeScriptで作った、静的ホスティング向けのMP3一括変換Webアプリです。音声・動画ファイルをアップロードせず、`ffmpeg.wasm`を使ってユーザーのブラウザ内だけでMP3に変換します。

## 主な機能

- 複数ファイルの追加
  - スマホ向けの大きな「ファイルを選択」ボタン
  - PC向けのドラッグ&ドロップ
- `wav`, `flac`, `ogg`, `opus`, `m4a`, `aac`, `webm`, `mp4`などをMP3へ変換
- 変換できないファイルはファイル単位で失敗表示し、アプリ全体は停止しません
- bitrate: `128k` / `192k` / `256k` / `320k`
- sample rate: `original` / `44100` / `48000`
- channels: `original` / `mono` / `stereo`
- ファイルごとの状態、進捗、エラーメッセージ、個別MP3ダウンロード
- 変換済みMP3をJSZipでまとめてZIP保存
- GitHub Pagesに公開できる静的アプリ構成
- モバイルファースト、カード型ファイル一覧、下部固定操作バー、ダークモード対応

## 重要な制約

- Node.jsサーバー、Express、外部API、サーバーアップロードは使いません。
- 変換処理はすべてブラウザ内で行われます。
- 大容量ファイルや大量のファイルは、端末やブラウザのメモリ不足で失敗する場合があります。
- 変換中に画面を閉じる、タブを移動する、端末をスリープするなどの操作をすると、処理が止まる可能性があります。
- GitHub Pagesでは`SharedArrayBuffer`に必要なヘッダーを自由に設定できないことがあるため、このアプリはマルチスレッド版ではなく通常の`@ffmpeg/core`を使います。
- iPhone Safariを含むモバイルブラウザでは、ファイルサイズやバックグラウンド動作の制限がPCより厳しい場合があります。

## 使い方

1. 「ファイルを選択」から変換したい音声・動画ファイルを追加します。PCではドラッグ&ドロップも使えます。
2. 必要に応じて「変換設定」を開き、bitrate / sample rate / channelsを選びます。
3. 画面下部の「変換開始」を押します。
4. 各ファイルカードで状態と進捗を確認します。
5. 変換が終わったファイルは「MP3を保存」から個別保存できます。
6. 変換済みファイルをまとめて保存したい場合は、画面下部の「ZIPで保存」を押します。

## ローカル開発

```bash
npm install
npm run dev
```

## ビルド

```bash
npm run build
npm run preview
```

`vite.config.ts`では`base: './'`を指定しているため、GitHub Pagesのプロジェクトページ配下でもアセットを相対パスで読み込めます。

## GitHub Pagesへの公開手順

### 方法1: GitHub Actionsで公開する（推奨）

このリポジトリには`.github/workflows/deploy.yml`が含まれています。

1. GitHubリポジトリへpushします。
2. GitHubのリポジトリ画面で **Settings > Pages** を開きます。
3. **Build and deployment** のSourceで **GitHub Actions** を選びます。
4. `main`ブランチへpushすると、Actionsが`npm install`と`npm run build`を実行し、`dist`をGitHub Pagesへデプロイします。

### 方法2: gh-pagesコマンドで公開する

`package.json`には以下のdeploy scriptがあります。

```bash
npm run deploy
```

初回は`package.json`の`homepage`を自分のGitHub Pages URLに変更してください。

```json
"homepage": "https://<your-github-username>.github.io/tomp3/"
```

その後、以下を実行します。

```bash
npm install
npm run deploy
```

## 技術構成

- Vite
- React
- TypeScript
- ffmpeg.wasm (`@ffmpeg/ffmpeg` + `@ffmpeg/core`)
- JSZip
- GitHub Actions / GitHub Pages
