const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const ytDlp = require('yt-dlp-exec');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to fetch Pinterest media metadata
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate Pinterest URL
  const isPinterest = /https?:\/\/(www\.)?(pinterest\.[a-z.]+|pin\.it)\/.+/i.test(url.trim());
  if (!isPinterest) {
    return res.status(400).json({ error: 'Please enter a valid Pinterest link.' });
  }

  try {
    const rawOutput = await ytDlp(url.trim(), {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true
    });

    const info = typeof rawOutput === 'string' ? JSON.parse(rawOutput) : rawOutput;
    const title = info.title || 'Pinterest Media';
    const thumbnail = info.thumbnail || (info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : null);

    const formats = [];
    const seenUrls = new Set();

    if (info.formats && Array.isArray(info.formats)) {
      // Filter for valid video or media streams with direct http/https URLs
      const validFormats = info.formats
        .filter(f => f.url && f.url.startsWith('http') && !f.url.includes('.m3u8'))
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      for (const f of validFormats) {
        if (!seenUrls.has(f.url)) {
          seenUrls.add(f.url);
          const height = f.height ? `${f.height}p` : (f.format_note || 'Standard');
          const ext = f.ext || 'mp4';
          formats.push({
            label: height,
            url: f.url,
            ext: ext,
            type: f.vcodec && f.vcodec !== 'none' ? 'Video' : 'Media'
          });
        }
      }
    }

    // Fallback if no specific formats were extracted but a direct URL is present
    if (formats.length === 0 && info.url && info.url.startsWith('http')) {
      formats.push({
        label: 'HD',
        url: info.url,
        ext: info.ext || 'mp4',
        type: 'Video'
      });
    }

    // Fallback for image / photo pins
    if (formats.length === 0 && thumbnail) {
      formats.push({
        label: 'Original Image',
        url: thumbnail,
        ext: 'jpg',
        type: 'Image'
      });
    }

    if (formats.length === 0) {
      return res.status(404).json({ error: 'Could not extract downloadable media from this Pinterest URL.' });
    }

    return res.json({
      title,
      thumbnail,
      formats
    });
  } catch (err) {
    console.error('Error fetching media:', err.message || err);
    return res.status(500).json({
      error: 'Failed to extract media from Pinterest. Please ensure the link is public and accessible.'
    });
  }
});

// Proxy download route to bypass CORS & force download attachment
app.get('/api/download', (req, res) => {
  const fileUrl = req.query.url;
  let filename = req.query.filename || 'pinterest-video.mp4';

  if (!fileUrl) {
    return res.status(400).send('File URL is required');
  }

  // Sanitize filename to avoid header injection
  filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

  const parsedUrl = new URL(fileUrl);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  const requestOptions = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.pinterest.com/'
    }
  };

  const proxyReq = client.get(fileUrl, requestOptions, (proxyRes) => {
    // Handle HTTP redirects (301, 302, 303, 307, 308)
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      return res.redirect(`/api/download?url=${encodeURIComponent(proxyRes.headers.location)}&filename=${encodeURIComponent(filename)}`);
    }

    if (proxyRes.statusCode !== 200) {
      return res.status(proxyRes.statusCode).send('Failed to fetch media file from source');
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (proxyRes.headers['content-type']) {
      res.setHeader('Content-Type', proxyRes.headers['content-type']);
    }
    if (proxyRes.headers['content-length']) {
      res.setHeader('Content-Length', proxyRes.headers['content-length']);
    }

    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy download error:', err);
    if (!res.headersSent) {
      res.status(500).send('Error downloading file');
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Fallback route to serve index.html for SPA/root
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
