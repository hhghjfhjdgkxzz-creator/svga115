import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { Readable, pipeline } from 'stream';

// Handle uncaught exceptions gracefully to prevent stream aborts from crashing the process
process.on('uncaughtException', (err: any) => {
  if (
    err?.code === 'ECONNRESET' ||
    err?.code === 'EPIPE' ||
    err?.name === 'AbortError' ||
    err?.message?.includes('terminated') ||
    err?.message?.includes('premature')
  ) {
    return;
  }
  console.error('[Uncaught Exception]', err);
});

process.on('unhandledRejection', (reason: any) => {
  if (
    reason?.code === 'ECONNRESET' ||
    reason?.name === 'AbortError' ||
    reason?.message?.includes('terminated')
  ) {
    return;
  }
  console.error('[Unhandled Rejection]', reason);
});

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Ensure uploads directory exists in public/uploads for Vercel/Vite static serving
const UPLOADS_DIR = path.resolve(process.cwd(), 'public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype.includes('video') ? '.mp4' : file.mimetype.includes('svga') ? '.svga' : '.bin');
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/\.[^/.]+$/, '');
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    cb(null, `${safeName}_${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 } // 250MB limit
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// File Upload Endpoint: Uploads real video / SVGA / image media
app.post('/api/upload', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filename = req.file.filename;
  const fileUrl = `/uploads/${filename}`;
  const fileSize = req.file.size;
  const mimeType = req.file.mimetype;

  res.json({
    success: true,
    url: fileUrl,
    filename,
    size: fileSize,
    mimeType
  });
});

// Video / Audio / SVGA Streaming with HTTP 206 Partial Content (Range requests)
// Critical for iOS Safari & Android mobile video playback!
app.get('/uploads/:filename', (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  let contentType = 'application/octet-stream';
  if (filename.endsWith('.mp4')) contentType = 'video/mp4';
  else if (filename.endsWith('.webm')) contentType = 'video/webm';
  else if (filename.endsWith('.mov')) contentType = 'video/quicktime';
  else if (filename.endsWith('.webp')) contentType = 'image/webp';
  else if (filename.endsWith('.png')) contentType = 'image/png';
  else if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) contentType = 'image/jpeg';
  else if (filename.endsWith('.gif')) contentType = 'image/gif';
  else if (filename.endsWith('.svga') || filename.endsWith('.svga2')) contentType = 'application/octet-stream';

  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Type',
    'Cache-Control': 'public, max-age=31536000, immutable'
  };

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).set(commonHeaders).send(`Requested range not satisfiable\n${start} >= ${fileSize}`);
      return;
    }

    const chunksize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });

    fileStream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).end();
      }
    });

    res.writeHead(206, {
      ...commonHeaders,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunksize,
      'Content-Type': contentType,
    });

    pipeline(fileStream, res, () => {});
  } else {
    res.writeHead(200, {
      ...commonHeaders,
      'Content-Length': fileSize,
      'Content-Type': contentType,
    });

    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).end();
      }
    });

    pipeline(fileStream, res, () => {});
  }
});

// Proxy Media Endpoint (for external CDN videos & images that block CORS or need page scraping)
app.get('/api/proxy-media', async (req: Request, res: Response) => {
  const abortController = new AbortController();

  req.on('close', () => {
    abortController.abort();
  });

  try {
    let targetUrl = req.query.url as string;
    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    const upstreamHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/*,video/*,*/*;q=0.8',
    };

    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    // Top4Top link handling (Top4Top page scraping & hotlink headers)
    if (targetUrl.includes('top4top.io')) {
      upstreamHeaders['Referer'] = 'https://top4top.io/';
      upstreamHeaders['Origin'] = 'https://top4top.io';

      const isDirectFile = /\.(mp4|svga|svga2|webm|mov|png|jpg|jpeg|gif|webp)($|\?)/i.test(targetUrl);
      if (!isDirectFile || targetUrl.includes('/downloadf-') || targetUrl.includes('/index.php') || targetUrl.includes('/p_')) {
        try {
          const pageRes = await fetch(targetUrl, { 
            headers: upstreamHeaders,
            signal: abortController.signal
          });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const matches = html.match(/https?:\/\/[a-z0-9]+\.top4top\.io\/[^\s"'<>]+?\.(mp4|svga|svga2|webm|mov|png|jpg|jpeg|gif|webp)/gi);
            if (matches && matches.length > 0) {
              targetUrl = matches[0];
            }
          }
        } catch {
          // Ignore scraping abort/error
        }
      }
    }

    // ImgBB / PostImg / generic image page scraping
    if (
      (targetUrl.includes('ibb.co') || targetUrl.includes('postimg.cc')) &&
      !/\.(png|jpg|jpeg|gif|webp)($|\?)/i.test(targetUrl)
    ) {
      try {
        const pageRes = await fetch(targetUrl, { 
          headers: upstreamHeaders,
          signal: abortController.signal
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                          html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i) ||
                          html.match(/https?:\/\/[a-z0-9\.\-]+\/images\/[^\s"'<>]+?\.(png|jpg|jpeg|webp)/i);
          if (ogMatch && ogMatch[1]) {
            targetUrl = ogMatch[1];
          }
        }
      } catch {
        // Ignore scraping error
      }
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl, {
        headers: upstreamHeaders,
        signal: abortController.signal
      });
    } catch {
      // Retry with neutral headers if abort not triggered
      if (abortController.signal.aborted) return;
      upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': '*/*'
        },
        signal: abortController.signal
      });
    }

    // If 403 hotlink protection triggered, retry with neutral headers
    if (upstream.status === 403 || upstream.status === 401) {
      upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': '*/*'
        },
        signal: abortController.signal
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
      if (!res.headersSent) {
        return res.status(upstream.status).send(`Upstream error: ${upstream.statusText}`);
      }
      return;
    }

    let contentType = upstream.headers.get('content-type') || '';
    if (!contentType || contentType.includes('text/html') || contentType.includes('text/plain')) {
      if (/\.mp4($|\?)/i.test(targetUrl)) contentType = 'video/mp4';
      else if (/\.(svga|svga2)($|\?)/i.test(targetUrl)) contentType = 'application/octet-stream';
      else if (/\.webm($|\?)/i.test(targetUrl)) contentType = 'video/webm';
      else if (/\.(jpg|jpeg)($|\?)/i.test(targetUrl)) contentType = 'image/jpeg';
      else if (/\.png($|\?)/i.test(targetUrl)) contentType = 'image/png';
      else if (/\.webp($|\?)/i.test(targetUrl)) contentType = 'image/webp';
      else if (/\.gif($|\?)/i.test(targetUrl)) contentType = 'image/gif';
      else contentType = 'image/png';
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (upstream.headers.get('content-range')) {
      res.setHeader('Content-Range', upstream.headers.get('content-range')!);
      res.status(206);
    }
    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length')!);
    }

    if (upstream.body && typeof (Readable as any).fromWeb === 'function') {
      try {
        const nodeStream = (Readable as any).fromWeb(upstream.body);
        nodeStream.on('error', () => {
          // Suppress stream abort error
        });
        pipeline(nodeStream, res, () => {});
      } catch {
        const arrayBuffer = await upstream.arrayBuffer();
        if (!res.headersSent) {
          res.send(Buffer.from(arrayBuffer));
        }
      }
    } else {
      const arrayBuffer = await upstream.arrayBuffer();
      if (!res.headersSent) {
        res.send(Buffer.from(arrayBuffer));
      }
    }
  } catch (err: any) {
    if (abortController.signal.aborted || err?.name === 'AbortError' || err?.message?.includes('terminated')) {
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Proxy request failed' });
    }
  }
});

async function startServer() {
  if (!isProd) {
    // Development mode with Vite Middleware
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Production mode
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT} (Production: ${isProd})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
