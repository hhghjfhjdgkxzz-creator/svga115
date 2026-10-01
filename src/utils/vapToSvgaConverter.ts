import { 
  extractVapConfigFromBlob, 
  detectVapChannelLayout, 
  WebGLVapRenderer, 
  seekVideoToFrame, 
  VapConfig 
} from './vapEngine';
import { extractAudioFromVap } from './vapFFmpeg';
import { ensureMp3WithId3 } from './svgaAudio';
import { encodeSVGA } from './svgaEncoder';

export interface VapToSvgaOptions {
  targetFps?: number;
  compressionQuality?: number; // 5 - 100
  targetWidth?: number;
  targetHeight?: number;
  preserveAudio?: boolean;
  onProgress?: (progress: number, logMessage: string) => void;
}

export interface VapToSvgaResult {
  svgaBlob: Blob;
  metadata: {
    width: number;
    height: number;
    fps: number;
    totalFrames: number;
    durationSeconds: number;
    hasAudio: boolean;
    svgaSize: number;
  };
}

/**
 * High-performance, frame-accurate converter from Tencent VAP / YYEVA (Alpha MP4) to SVGA 2.0.
 * Accurately extracts RGB and Alpha channels using WebGL GPU blending,
 * preserves embedded audio, and generates a valid, standard-compliant SVGA 2.0 animation.
 */
export async function convertVapToSvga(
  fileOrBlob: File | Blob,
  options: VapToSvgaOptions = {}
): Promise<VapToSvgaResult> {
  const { onProgress } = options;

  onProgress?.(5, 'قراءة وتحليل بيانات وهيكل ملف VAP...');

  // 1. Extract VAP / YYEVA embedded configuration if present
  let config: VapConfig | null = null;
  try {
    config = await extractVapConfigFromBlob(fileOrBlob);
  } catch (e) {
    console.warn('VAP config extraction notice:', e);
  }

  // 2. Setup video element
  const videoUrl = URL.createObjectURL(fileOrBlob);
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      let isSettled = false;
      const onLoaded = () => {
        if (!isSettled) {
          isSettled = true;
          resolve();
        }
      };
      const onError = () => {
        if (!isSettled) {
          isSettled = true;
          reject(new Error('تعذر تحميل وتشغيل فيديو VAP. تأكد من أن الملف سليم.'));
        }
      };

      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      setTimeout(() => {
        if (!isSettled && video.readyState >= 1) {
          isSettled = true;
          resolve();
        }
      }, 5000);
    });

    const vw = video.videoWidth || 750;
    const vh = video.videoHeight || 750;
    const duration = Math.max(0.1, video.duration || 1);

    // Detect layout and frame regions using optical and box analysis
    const detected = detectVapChannelLayout(video, config);

    const rgbRect = detected.rgbFrame || [0, 0, Math.round(vw / 2), vh];
    const alphaRect = detected.aFrame || [Math.round(vw / 2), 0, Math.round(vw / 2), vh];

    // Determine final dimensions
    let outW = options.targetWidth || detected.outputWidth || rgbRect[2] || Math.round(vw / 2);
    let outH = options.targetHeight || detected.outputHeight || rgbRect[3] || vh;

    // Quality downscaling if specified
    const quality = Math.max(5, Math.min(100, options.compressionQuality ?? 80));
    if (quality < 50 && !options.targetWidth && !options.targetHeight) {
      const scaleFactor = Math.max(0.65, quality / 70);
      outW = Math.max(100, Math.round(outW * scaleFactor));
      outH = Math.max(100, Math.round(outH * scaleFactor));
    }

    // Determine FPS and frames count
    const detectedFps = config?.info?.fps || config?.fps || 24;
    const targetFps = Math.max(8, Math.min(60, options.targetFps || detectedFps));
    const totalFrames = Math.max(1, Math.round(duration * targetFps));

    onProgress?.(15, `بدء استخراج الإطارات (${totalFrames} إطار، ${outW}×${outH}px، ${targetFps} FPS)...`);

    // 3. Audio Extraction (in parallel or background)
    let audioEntity: any = null;
    let audioBytes: Uint8Array | null = null;
    if (options.preserveAudio !== false) {
      try {
        const audioBlob = await extractAudioFromVap(fileOrBlob);
        if (audioBlob && audioBlob.size > 500) {
          const rawBytes = new Uint8Array(await audioBlob.arrayBuffer());
          audioBytes = ensureMp3WithId3(rawBytes);
          audioEntity = {
            audioKey: 'audio_0',
            startFrame: 0,
            endFrame: totalFrames,
            startTime: 0,
            totalTime: Math.round(duration * 1000)
          };
        }
      } catch (err) {
        // No audio track or extraction skipped
        console.info('No audio track extracted from VAP (silent animation):', err);
      }
    }

    // 4. Initialize WebGL VAP Alpha Blending Renderer
    const renderer = new WebGLVapRenderer(outW, outH);
    const imagesMap: Record<string, Uint8Array> = {};
    const sprites: any[] = [];

    // Add audio track if present
    if (audioBytes && audioEntity) {
      imagesMap['audio_0'] = audioBytes;
    }

    // 5. Render and capture each frame
    try {
      await seekVideoToFrame(video, 0.001);
    } catch {}

    for (let i = 0; i < totalFrames; i++) {
      const targetTime = Math.max(0.001, Math.min(duration - 0.001, (i / totalFrames) * duration));
      await seekVideoToFrame(video, targetTime);

      // Render blended RGBA on WebGL canvas
      renderer.render(
        video,
        rgbRect,
        alphaRect,
        0,    // threshold
        true, // unmultiply
        false,// invertAlpha
        false // rawMode
      );

      // Convert canvas to PNG bytes with safety fallback
      const pngBlob: Blob = await new Promise((resolve) => {
        let isResolved = false;
        try {
          renderer.canvas.toBlob((b) => {
            if (!isResolved) {
              isResolved = true;
              resolve(b || new Blob());
            }
          }, 'image/png');
        } catch {
          // ignore
        }
        setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            try {
              const dataUrl = renderer.canvas.toDataURL('image/png');
              const bin = atob(dataUrl.split(',')[1]);
              const u8 = new Uint8Array(bin.length);
              for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
              resolve(new Blob([u8], { type: 'image/png' }));
            } catch {
              resolve(new Blob());
            }
          }
        }, 400);
      });

      const arrayBuffer = await pngBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const imgKey = `frame_${i}`;
      imagesMap[imgKey] = bytes;

      // Create sprite for this frame
      const framesForSprite = [];
      for (let fIdx = 0; fIdx < totalFrames; fIdx++) {
        framesForSprite.push({
          alpha: fIdx === i ? 1.0 : 0.0,
          layout: { x: 0, y: 0, width: outW, height: outH },
          transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
        });
      }

      sprites.push({
        imageKey: imgKey,
        frames: framesForSprite
      });

      if (i % 3 === 0 || i === totalFrames - 1) {
        const pct = Math.round(15 + (i / totalFrames) * 75);
        onProgress?.(pct, `استخراج وضغط إطار VAP (${i + 1}/${totalFrames})...`);
      }
    }

    // 6. Encode to SVGA 2.0 Protobuf Deflate
    onProgress?.(92, 'حزم وتشفير ملف SVGA النهائي...');

    const movieData: any = {
      version: '2.0',
      params: {
        viewBoxWidth: outW,
        viewBoxHeight: outH,
        fps: Math.round(targetFps),
        frames: totalFrames
      },
      images: imagesMap,
      sprites,
      audios: audioEntity ? [audioEntity] : []
    };

    const compressionLevel = quality < 60 ? 9 : quality < 85 ? 8 : 6;
    const svgaBlob = await encodeSVGA(movieData, { level: compressionLevel });

    onProgress?.(100, 'تم تحويل ملف VAP إلى SVGA بنجاح!');

    return {
      svgaBlob,
      metadata: {
        width: outW,
        height: outH,
        fps: Math.round(targetFps),
        totalFrames,
        durationSeconds: duration,
        hasAudio: !!audioEntity,
        svgaSize: svgaBlob.size
      }
    };
  } finally {
    URL.revokeObjectURL(videoUrl);
    video.src = '';
    video.remove();
  }
}
