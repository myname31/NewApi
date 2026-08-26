const express = require('express');
const cors = require('cors');
const { Readable } = require('stream');
const { 
  scrapeYoutube, 
  searchAndScrapeYoutube, 
  getOrResolveStreamUrl, 
  getVideoInfo,
  parseStreamToken,
  invalidateCachedUrl 
} = require('./services/youtubeScraper');

const app = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', true);

app.use(cors());
app.use(express.json());

// 1. Endpoint Search
app.get('/api/v1/yt/search', async (req, res) => {
  const { q, page = 1, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ status: false, message: 'Parameter "q" wajib diisi.' });

  try {
    const data = await searchAndScrapeYoutube(q, req.headers['x-forwarded-host'] || req.headers.host, parseInt(page), parseInt(limit));
    res.json({ status: true, ...data });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// 2. Endpoint Download Single Metadata
app.get('/api/v1/yt/download', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ status: false, message: 'Parameter "url" wajib diisi.' });

  try {
    const data = await scrapeYoutube(url, req.headers['x-forwarded-host'] || req.headers.host);
    res.json({ status: true, data });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// 3. Endpoint Proxy Stream Media
app.get(['/api/v1/yt/stream/:hash', '/d/:hash'], async (req, res) => {
  const { hash } = req.params;
  
  // Parse stateless Base64URL token
  const meta = parseStreamToken(hash);

  if (!meta || !meta.videoUrl) {
    return res.status(404).send('Stream Token Tidak Ditemukan');
  }

  try {
    let targetUrl = await getOrResolveStreamUrl(hash, meta);
    const isGoogle = targetUrl.includes('googlevideo.com');

    const proxyHeaders = {
      'User-Agent': isGoogle
        ? 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; US) gzip'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    };

    if (req.headers['range']) proxyHeaders['Range'] = req.headers['range'];

    let remoteRes = await fetch(targetUrl, { headers: proxyHeaders, redirect: 'follow' });

    if (remoteRes.status === 403 || remoteRes.status === 410) {
      invalidateCachedUrl(hash);
      targetUrl = await getOrResolveStreamUrl(hash, meta);
      remoteRes = await fetch(targetUrl, { headers: proxyHeaders, redirect: 'follow' });
    }

    if (!remoteRes.ok && remoteRes.status !== 206) {
      throw new Error(`Upstream error: ${remoteRes.status}`);
    }

    const responseHeaders = {};
    for (const [key, value] of remoteRes.headers.entries()) {
      if (['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    }

    responseHeaders['Accept-Ranges'] = 'bytes';
    responseHeaders['Content-Disposition'] = req.path.startsWith('/d/') ? 'attachment' : 'inline';
    responseHeaders['Content-Type'] = meta.type === 'audio' ? 'audio/mpeg' : 'video/mp4';

    res.writeHead(remoteRes.status, responseHeaders);

    if (remoteRes.body) {
      const nodeStream = Readable.fromWeb(remoteRes.body);
      nodeStream.pipe(res);
      res.on('close', () => nodeStream.destroy());
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).send('Proxy Error: ' + err.message);
  }
});

// 4. Endpoint Raw Info Video (Mentahan Savetube)
app.get('/api/v1/yt/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ status: false, message: 'Parameter "url" wajib diisi.' });

  try {
    const data = await getVideoInfo(url);
    res.json({ status: true, data: data.videoInfo });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

app.listen(PORT, () => console.log(`Server ytjs berjalan di port ${PORT}`));
