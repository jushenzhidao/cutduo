/**
 * src/pipeline.mjs · 分片渲染管道（与具体版式无关）
 *
 * 这段逻辑原先在四个入口里各有一份（render.mjs / kits/desk / kits/mg /
 * kits/editorial），边界完全一致：切帧区间 → 每片喂一个 ffmpeg 编 mpegts →
 * concat 成无声片 → 合音轨。差异只在「谁来画帧」，所以把画帧留给调用方，
 * 其余收到这里。
 *
 * 不抽的东西：worker 的创建（`new Worker(new URL(import.meta.url))` 必须由
 * 各入口自己发起，否则 worker 会跑错文件）、渲染器构造（各版式不同）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

export const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
export const FFPROBE = process.env.FFPROBE || '/opt/homebrew/bin/ffprobe';

/** 把总帧数切成 N 个区间；区间边界必须与改造前逐字一致，否则成片帧序会错位。 */
export function planShards(frames, workers, tmpDir) {
  const per = Math.ceil(frames / workers);
  const out = [];
  for (let i = 0; i < workers; i++) {
    const s = i * per;
    const e = Math.min(frames, s + per);
    if (s < e) out.push({ i, s, e, part: path.join(tmpDir, `seg-${i}.ts`) });
  }
  return out;
}

/** 单片 ffmpeg 参数。参数顺序保持原样：顺序变了编码结果可能变。 */
export function partArgs({ pipe, fps, width, height, crf, preset, jpeg, x264Threads, part }) {
  const input =
    pipe === 'raw'
      ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0']
      : ['-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'mjpeg', '-i', 'pipe:0'];
  return [
    '-hide_banner', '-loglevel', 'error', '-y', ...input,
    '-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p',
    ...(x264Threads ? ['-threads', String(x264Threads)] : []),
    '-f', 'mpegts', part,
  ];
}

/**
 * 逐帧渲染并写进 ffmpeg stdin。[start, end) 半开区间。
 * @param {{renderer:{renderFrame:(t:number)=>void}, canvas:any, fps:number,
 *          start:number, end:number, ff:import('node:child_process').ChildProcess,
 *          pipe?:string, jpeg?:number}} o
 */
export async function pumpFrames({ renderer, canvas, fps, start, end, ff, pipe, jpeg }) {
  const done = once(ff, 'close');
  for (let f = start; f < end; f++) {
    renderer.renderFrame(f / fps);
    const buf = pipe === 'raw' ? canvas.data() : canvas.toBuffer('image/jpeg', jpeg);
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error('ffmpeg exit ' + code);
}

/** 起一个只接收帧流的 ffmpeg 子进程。 */
export function spawnPart(args) {
  return spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'inherit'] });
}

/**
 * concat 各分片 → 合音轨 → 落到 out。同步（原实现如此，调用点依赖它串行）。
 * @returns {{silent:string, dur:string}} 无声片路径与实际时长（秒，3 位小数）
 */
export function concatParts({ parts, tmpDir, out, audio, fps, frames }) {
  const list = path.join(tmpDir, 'list.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  const silent = path.join(tmpDir, 'silent.mp4');
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent,
  ]);

  const dur = (frames / fps).toFixed(3);
  if (audio && fs.existsSync(audio)) {
    // 音轨策略：AAC 直接 copy（无损、快）；其它格式（尤其 vo.py 产出的 wav/PCM）
    // 必须转 AAC —— mp4 里塞 pcm_s16le 会让浏览器/Safari/部分播放器整轨静音。
    let acodec = '';
    try {
      acodec = execFileSync(FFPROBE, [
        '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', audio,
      ], { encoding: 'utf8' }).trim();
    } catch {
      /* 探测失败按需要转码处理 */
    }
    const audioArgs = acodec === 'aac'
      ? ['-c:a', 'copy']
      : ['-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '1'];
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', silent, '-i', audio,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...audioArgs,
      '-t', dur, '-movflags', '+faststart', out,
    ]);
    if (acodec && acodec !== 'aac') console.log(`  音轨 ${acodec} → aac 160k（mp4 不吃 PCM）`);
  } else {
    // +faststart 必须与有音轨分支一致：它把 moov atom 挪到文件头，播放器不必下完整片就能起播。
    // 合并前只有 mg 与 editorial 这么写，paper/desk 漏了 —— 统一后所有 mp4 都带上。
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', silent, '-c', 'copy', '-t', dur, '-movflags', '+faststart', out,
    ]);
  }
  return { silent, dur };
}

/** 收尾统计：体积与耗时都从产物实测，不估算。 */
export function report({ out, frames, fps, startedAt, workers }) {
  const size = (fs.statSync(out).size / 1048576).toFixed(2);
  const dur = (frames / fps).toFixed(3);
  console.log(`✓ ${out}`);
  console.log(
    `  ${frames} 帧 / ${dur}s / ${fps}fps / ${size}MB / ` +
    `${((Date.now() - startedAt) / 1000).toFixed(1)}s / ${workers} workers`
  );
}
