import { useState, useRef, useEffect } from "react";
import { createFFmpeg, fetchFile } from "@ffmpeg/ffmpeg";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { library } from "@fortawesome/fontawesome-svg-core";
import { fas } from "@fortawesome/free-solid-svg-icons";
import { far } from "@fortawesome/free-regular-svg-icons";
import { fab } from "@fortawesome/free-brands-svg-icons";

library.add(fas, far, fab);

// グローバルにffmpegを作成して1回だけロード
const ffmpeg = createFFmpeg({ log: true });
let isFFmpegLoaded = false;

// 真ん中省略（全角18 / 半角30）
function truncateMiddle(str, maxLength = 30) {
  if (!str) return "";
  const isJapanese = /\P{ASCII}/u.test(str);
  const limit = isJapanese ? 18 : maxLength;
  if (str.length <= limit) return str;
  const half = Math.floor((limit - 3) / 2);
  return str.slice(0, half) + "..." + str.slice(-half);
}

function App() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const tableRef = useRef(null);

  // 入力設定
  const [loudness, setLoudness] = useState(-15);
  const [peak, setPeak] = useState(-2);
  const [bitrate, setBitrate] = useState(192);
  const [sampleRate, setSampleRate] = useState(48000);
  const [channel, setChannel] = useState("stereo");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");

  // 初回マウント時にプリロード
  useEffect(() => {
    (async () => {
      if (!isFFmpegLoaded) {
        await ffmpeg.load();
        isFFmpegLoaded = true;
      }
    })();
  }, []);

  // ダウンロード処理
  const handleDownload = (fileBase64, fileName) => {
    const link = document.createElement("a");
    link.href = fileBase64;
    link.download = fileName;
    link.click();
  };

  // ラウドネス処理
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return alert("音声ファイルを選択してください。");

    setLoading(true);
    try {
      // ffmpegロード確認
      if (!isFFmpegLoaded) {
        await ffmpeg.load();
        isFFmpegLoaded = true;
      }

      // ログ格納用
      let ffmpegLogs = [];
      ffmpeg.setLogger(({ type, message }) => {
        if (type === "fferr") {
          ffmpegLogs.push(message);
        }
      });

      // 入力ファイルを仮想FSに書き込み
      ffmpeg.FS("writeFile", "input.mp3", await fetchFile(file));

      // === 1パス目：解析 ===
      await ffmpeg.run("-i", "input.mp3", "-af", `loudnorm=I=${loudness}:TP=${peak}:print_format=json`, "-f", "null", "-");

      // JSON抽出
      const analyzeLog = ffmpegLogs.join("\n");
      ffmpegLogs = []; // リセット
      const jsonMatch = analyzeLog.match(/{[\s\S]*}/);
      if (!jsonMatch) {
        alert("解析用JSONが取得できませんでした");
        return;
      }
      const loudnormData = JSON.parse(jsonMatch[0]);

      // 数値化
      const measuredI = parseFloat(loudnormData.input_i);
      const measuredLRA = parseFloat(loudnormData.input_lra);
      const measuredTP = parseFloat(loudnormData.input_tp);
      const measuredThresh = parseFloat(loudnormData.input_thresh);
      const offset = parseFloat(loudnormData.target_offset);

      if (isNaN(measuredI) || isNaN(measuredLRA) || isNaN(measuredTP) || isNaN(measuredThresh) || isNaN(offset)) {
        alert("解析値を取得できませんでした");
        return;
      }

      // === 2パス目：正規化（直接 input.mp3 → output.mp3）===
      const filterCmd = `loudnorm=I=${loudness}:TP=${peak}:LRA=11:measured_I=${measuredI}:measured_LRA=${measuredLRA}:measured_TP=${measuredTP}:measured_thresh=${measuredThresh}:offset=${offset}`;

      await ffmpeg.run("-i", "input.mp3", "-af", filterCmd, "-ar", `${sampleRate}`, "-b:a", `${bitrate}k`, "-ac", `${channel === "mono" ? 1 : 2}`, "output.mp3");

      // === 再解析（処理後LUFS測定） ===
      await ffmpeg.run("-i", "output.mp3", "-af", `loudnorm=I=${loudness}:TP=${peak}:print_format=json`, "-f", "null", "-");

      const finalLog = ffmpegLogs.join("\n");
      const jsonMatch2 = finalLog.match(/{[\s\S]*}/);
      let finalLoudness = null;
      let finalPeak = null;

      if (jsonMatch2) {
        const finalData = JSON.parse(jsonMatch2[0]);
        finalLoudness = finalData.input_i ? parseFloat(finalData.input_i).toFixed(1) : null;
        finalPeak = finalData.input_tp ? parseFloat(finalData.input_tp).toFixed(1) : null;
      }

      // 出力ファイル取得
      const data = ffmpeg.FS("readFile", "output.mp3");
      const blob = new Blob([data.buffer], { type: "audio/mp3" });
      const fileBase64 = URL.createObjectURL(blob);

      // ファイル名生成
      const finalName = `${prefix ? prefix + "_" : ""}${file.name.replace(/\.[^/.]+$/, "")}${suffix ? "_" + suffix : ""}.mp3`;

      // 結果追加
      setResults((prev) => [
        ...prev,
        {
          loudness: `${finalLoudness} LUFS`,
          truePeak: `${finalPeak} dBTP`,
          sampleRate: `${sampleRate} Hz`,
          bitrate: `${bitrate} kbps`,
          channel: channel === "stereo" ? "ステレオ" : "モノラル",
          fileName: finalName,
          fileBase64,
        },
      ]);

      // テーブルまでスクロール
      setTimeout(() => {
        if (tableRef.current) {
          tableRef.current.scrollIntoView({ behavior: "smooth" });
        }
      }, 100);
    } catch (err) {
      alert(`エラー: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 py-10 px-6 lg:py-16">
      <div className="lg_container">
        <h1 className="leading-none text-2xl font-bold text-center text-[#9375FF] lg:text-4xl">
          <FontAwesomeIcon icon="fa-solid fa-compact-disc" />
          ラウドネス処理ツール<br className="md:hidden" />（数十秒音源向け）
        </h1>
        <p className="mt-5 mb-6 lg:mt-7 lg:mb-8">
          <strong>注意事項：</strong>
          <br />
          こちらのツールは簡易的なラウドネス処理ツールです。
          <br />
          1分未満の音源であれば問題なく処理できますが、1〜5分程度の音源では処理に時間がかかる場合があります。
          <br />
          また、目安として5分以上の音源を処理すると、ブラウザがクラッシュ・停止する恐れがあるためお控えください。
          <br />
          書き出しフォーマットは、現時点ではMP3のみ対応しております。
        </p>
      </div>

      {/* 入力フォーム */}
      <form className="lg_container bg-white p-6 rounded shadow-md space-y-6" onSubmit={handleSubmit}>
        <h2 className="text-lg font-bold mb-4">
          <FontAwesomeIcon icon="fa-solid fa-gears" className="mr-1" />
          ラウドネス設定
        </h2>

        {/* ファイル選択 */}
        <div>
          <label className="block mb-1">▼音声ファイル</label>
          <label htmlFor="file-upload" className={`btn-normal px-4 py-2 inline-block ${loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
            ファイルを選択
          </label>
          {file && <p className="text-sm text-gray-600 mt-1">選択中：{truncateMiddle(file.name, 30)}</p>}
          <input id="file-upload" type="file" accept="audio/*" className="hidden" onChange={(e) => setFile(e.target.files[0])} disabled={loading} />
        </div>

        {/* ラウドネス・ピーク */}
        <div className="flex flex-col space-y-6 md:flex-row md:gap-4 md:space-y-0">
          <div className="md:w-1/2">
            <label className="block mb-1">▼ラウドネス（LUFS）</label>
            <input type="number" className="form-box" value={loudness} onChange={(e) => setLoudness(e.target.value)} />
          </div>

          <div className="md:w-1/2">
            <label className="block mb-1">▼トゥルーピーク（dBTP）</label>
            <input type="number" className="form-box" value={peak} onChange={(e) => setPeak(e.target.value)} />
          </div>
        </div>

        {/* サンプリング・ビットレート・チャンネル */}
        <div className="flex flex-col space-y-6 md:flex-row md:gap-4 md:space-y-0">
          <div className="md:w-1/3">
            <label className="block mb-1">▼サンプリング周波数</label>
            <select className="form-box cursor-pointer" value={sampleRate} onChange={(e) => setSampleRate(e.target.value)}>
              {[8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}Hz
                </option>
              ))}
            </select>
          </div>

          <div className="md:w-1/3">
            <label className="block mb-1">▼ビットレート</label>
            <select className="form-box cursor-pointer" value={bitrate} onChange={(e) => setBitrate(e.target.value)}>
              {[64, 96, 128, 160, 192, 256, 320].map((br) => (
                <option key={br} value={br}>
                  {br}kbps
                </option>
              ))}
            </select>
          </div>

          <div className="md:w-1/3">
            <label className="block mb-1">▼出力チャンネル</label>
            <select className="form-box cursor-pointer" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="stereo">ステレオ</option>
              <option value="mono">モノラル</option>
            </select>
          </div>
        </div>

        {/* 接頭辞・接尾辞 */}
        <div className="flex flex-col space-y-6 md:flex-row md:gap-4 md:space-y-0">
          <div className="md:w-1/2">
            <label className="block mb-1">▼接頭辞（prefix）</label>
            <input type="text" className="form-box" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </div>

          <div className="md:w-1/2">
            <label className="block mb-1">▼末尾辞（suffix）</label>
            <input type="text" className="form-box" value={suffix} onChange={(e) => setSuffix(e.target.value)} />
          </div>
        </div>

        <div>
          <button type="submit" className={`block mx-auto btn-colored px-4 py-2 ${loading ? "opacity-50 cursor-not-allowed" : ""}`} disabled={loading}>
            {loading ? (
              <span className="flex items-center space-x-2">
                <FontAwesomeIcon icon="fa-solid fa-spinner" className="animate-spin" />
                <span>処理中...</span>
              </span>
            ) : (
              "ラウドネス処理を実行"
            )}
          </button>
        </div>
      </form>

      {/* 結果テーブル */}
      {results.length > 0 && (
        <div ref={tableRef} className="lg_container bg-white p-6 rounded shadow-md mt-10">
          <h2 className="text-lg font-bold mb-4">
            <FontAwesomeIcon icon="fa-solid fa-print" className="mr-1" />
            ラウドネス処理結果
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[928px] text-left border-2 border-gray-400 text-sm">
              <thead>
                <tr className="border-b-2 border-gray-400 text-center">
                  <th className="table-box w-[240px]">ファイル名</th>
                  <th className="table-box">ラウドネス</th>
                  <th className="table-box">トゥルーピーク</th>
                  <th className="table-box">サンプリング周波数</th>
                  <th className="table-box">ビットレート</th>
                  <th className="table-box">チャンネル</th>
                  <th className="table-box w-[130px]">ダウンロード</th>
                </tr>
              </thead>
              <tbody>
                {results.map((item, idx) => (
                  <tr key={idx} className="text-center">
                    <td className="table-box w-[240px]">{truncateMiddle(item.fileName, 30)}</td>
                    <td className="table-box">{item.loudness}</td>
                    <td className="table-box">{item.truePeak}</td>
                    <td className="table-box">{item.sampleRate}</td>
                    <td className="table-box">{item.bitrate}</td>
                    <td className="table-box">{item.channel}</td>
                    <td className="table-box w-[130px]">
                      <button
                        className={`btn-colored px-3 py-1 ${loading || !item.fileBase64 ? "opacity-50 cursor-not-allowed" : ""}`}
                        disabled={loading || !item.fileBase64}
                        onClick={() => handleDownload(item.fileBase64, item.fileName)}
                      >
                        ダウンロード
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
