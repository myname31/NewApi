const crypto = require('crypto');

const URL_TTL_MS = 4 * 60 * 1000;

const urlTTLCache = new Map();

function getCachedUrl(hash) {
  const entry = urlTTLCache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > URL_TTL_MS) {
    urlTTLCache.delete(hash);
    return null;
  }
  return entry.url;
}

function setCachedUrl(hash, url) {
  urlTTLCache.set(hash, { url, timestamp: Date.now() });
}

function invalidateCachedUrl(hash) {
  urlTTLCache.delete(hash);
}

// Generates Stateless Base64URL Token (No JSON File Needed)
function createStreamToken(videoUrl, quality, type, hostHeader) {
  const videoId = (videoUrl.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/) || [])[1];
  const payload = `${videoId}:${type === 'audio' ? 'a' : 'v'}:${quality}`;
  const hash = Buffer.from(payload).toString('base64url');
  return { hash, streamUrl: `https://${hostHeader}/api/v1/yt/stream/${hash}` };
}

// Parses Stateless Base64URL Token Back to Meta Object
function parseStreamToken(hash) {
  try {
    const decoded = Buffer.from(hash, 'base64url').toString('utf8');
    const [videoId, typeChar, quality] = decoded.split(':');
    if (!videoId) return null;
    return {
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      type: typeChar === 'a' ? 'audio' : 'video',
      quality: quality
    };
  } catch (e) {
    return null;
  }
}

async function fetchInnertubePlayer(videoId) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; US) gzip',
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': '20.10.38'
    },
    body: JSON.stringify({
      videoId: videoId,
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en', gl: 'US' } }
    }),
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error('Innertube HTTP error ' + res.status);
  const data = await res.json();
  if (data.playabilityStatus?.status !== 'OK') {
    throw new Error(`Innertube status: ${data.playabilityStatus?.status}`);
  }
  return data;
}

const videoInfoCache = new Map();
const VIDEO_INFO_CACHE_TTL_MS = 600000;

async function fetchFormatUrl(headers, key, type, quality, preferredCdn = null, timeoutMs = 4000) {
  const cdns = preferredCdn ? [preferredCdn, 'cdn400.savetube.vip', 'cdn406.savetube.vip'] : ['cdn400.savetube.vip', 'cdn406.savetube.vip', 'cdn401.savetube.vip'];
  for (const cdn of [...new Set(cdns)]) {
    try {
      const downloadRes = await fetch(`https://${cdn}/download`, {
        method: 'POST', headers,
        body: JSON.stringify({ downloadType: type, quality: String(quality), key: key }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!downloadRes.ok) continue;
      const downloadData = await downloadRes.json();
      if (downloadData.data?.downloadUrl) return downloadData.data.downloadUrl;
    } catch {}
  }
  return null;
}

async function getVideoInfo(youtubeUrl) {
  const cached = videoInfoCache.get(youtubeUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://ytmp4.co.za',
    'Referer': 'https://ytmp4.co.za/',
    'Content-Type': 'application/json'
  };

  let assignedCdn = null;
  try {
    const cdnRes = await fetch('https://media.savetube.vip/api/random-cdn', { headers, signal: AbortSignal.timeout(2000) });
    if (cdnRes.ok) assignedCdn = (await cdnRes.json()).cdn;
  } catch {}

  const cdnList = [assignedCdn, 'cdn400.savetube.vip', 'cdn406.savetube.vip', 'cdn401.savetube.vip'].filter(Boolean);
  let b64Data = null, usedCdn = null;

  for (const cdn of [...new Set(cdnList)]) {
    try {
      const infoRes = await fetch(`https://${cdn}/v2/info`, {
        method: 'POST', headers, body: JSON.stringify({ url: youtubeUrl }), signal: AbortSignal.timeout(4000)
      });
      if (!infoRes.ok) continue;
      const json = await infoRes.json();
      if (json.status && json.data) { b64Data = json.data; usedCdn = cdn; break; }
    } catch {}
  }

  if (!b64Data) throw new Error('Video tidak ditemukan atau server CDN sibuk');

  const rawBuf = Buffer.from(b64Data.trim(), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex'), rawBuf.subarray(0, 16));
  let decrypted = Buffer.concat([decipher.update(rawBuf.subarray(16)), decipher.final()]);
  const videoInfo = JSON.parse(decrypted.toString('utf8'));

  const result = { videoInfo, headers, usedCdn };
  videoInfoCache.set(youtubeUrl, { data: result, expiresAt: Date.now() + VIDEO_INFO_CACHE_TTL_MS });
  return result;
}

async function resolveInstantCdnStream(videoId, title, quality = '360', ext = 'mp4') {
  if (!videoId) return null;
  const cleanTitle = (title || 'video').toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/[\s-]+/g, '-');
  const cdns = ['cdn405.savetube.vip', 'cdn400.savetube.vip', 'cdn406.savetube.vip', 'cdn401.savetube.vip'];
  
  const results = await Promise.all(cdns.map(async (cdn) => {
    const url = `https://${cdn}/media/${videoId}/${cleanTitle}-${quality}-ytshorts.savetube.me.${ext}`;
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
      if (res.ok) return url;
    } catch {}
    return null;
  }));
  return results.find(Boolean) || null;
}

async function resolveFreshUrl(youtubeUrl, quality, type) {
  const videoId = (youtubeUrl.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/) || [])[1];
  if (!videoId) throw new Error('ID Video YouTube tidak valid');
  const qualityNum = String(quality).replace(/[^0-9]/g, '') || '360';

  if (type === 'audio') {
    let videoTitle = '';
    try {
      const innertubeData = await fetchInnertubePlayer(videoId);
      videoTitle = innertubeData.videoDetails?.title || '';
    } catch {}

    const title = videoTitle || videoInfoCache.get(youtubeUrl)?.data?.videoInfo?.title || 'audio';
    const instantMp3 = await resolveInstantCdnStream(videoId, title, '128', 'mp3');
    if (instantMp3) return instantMp3;

    try {
      const { videoInfo, headers, usedCdn } = await getVideoInfo(youtubeUrl);
      if (videoInfo.key) {
        const url = await fetchFormatUrl(headers, videoInfo.key, 'audio', '128', usedCdn, 4000);
        if (url) return url;
      }
    } catch {}

    try {
      const innertubeData = await fetchInnertubePlayer(videoId);
      const progressiveFormats = (innertubeData.streamingData?.formats || []).filter(f => f.url);
      if (progressiveFormats[0]?.url) return progressiveFormats[0].url;
    } catch {}
  } else {
    try {
      const innertubeData = await fetchInnertubePlayer(videoId);
      const streamingData = innertubeData.streamingData;
      if (streamingData) {
        const progressiveFormats = (streamingData.formats || []).filter(f => f.url);
        if (qualityNum === '720') {
          const prog720 = progressiveFormats.find(f => f.itag === 22);
          if (prog720?.url) return prog720.url;
        }
        const prog360 = progressiveFormats.find(f => f.itag === 18) || progressiveFormats[0];
        if (prog360?.url) return prog360.url;
      }
    } catch {}

    try {
      const { videoInfo, headers, usedCdn } = await getVideoInfo(youtubeUrl);
      if (videoInfo.key) {
        const url = await fetchFormatUrl(headers, videoInfo.key, 'video', qualityNum, usedCdn, 4000);
        if (url) return url;
      }
    } catch {}
  }

  throw new Error(`Format ${type} ${quality} tidak tersedia`);
}

const inFlightResolutions = new Map();

async function getOrResolveStreamUrl(hash, meta) {
  let cached = getCachedUrl(hash);
  if (cached) return cached;
  if (inFlightResolutions.has(hash)) return await inFlightResolutions.get(hash);

  const task = (async () => {
    try {
      const url = await resolveFreshUrl(meta.videoUrl, meta.quality, meta.type);
      setCachedUrl(hash, url);
      return url;
    } finally { inFlightResolutions.delete(hash); }
  })();

  inFlightResolutions.set(hash, task);
  return await task;
}

function formatDurationSec(seconds) {
  if (!seconds) return null;
  const s = parseInt(seconds, 10);
  if (isNaN(s)) return null;
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

async function scrapeYoutube(youtubeUrl, hostHeader) {
  const videoId = (youtubeUrl.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/) || [])[1];
  if (!videoId) throw new Error('ID Video YouTube tidak valid');

  try {
    const innertubeData = await fetchInnertubePlayer(videoId);
    const videoDetails = innertubeData.videoDetails || {};
    return {
      id: videoId,
      title: videoDetails.title || 'YouTube Video',
      duration: formatDurationSec(videoDetails.lengthSeconds),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      resolutions: {
        video: ['360', '720', '1080'].map(q => ({ quality: `${q}p`, stream_url: createStreamToken(youtubeUrl, q, 'video', hostHeader).streamUrl })),
        audio: ['128'].map(q => ({ quality: `${q}kbps`, stream_url: createStreamToken(youtubeUrl, q, 'audio', hostHeader).streamUrl }))
      }
    };
  } catch (err) {
    const { videoInfo } = await getVideoInfo(youtubeUrl);
    return {
      id: videoId,
      title: videoInfo.title,
      duration: videoInfo.durationLabel || null,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      resolutions: {
        video: (videoInfo.video_formats || []).map(f => ({ quality: `${f.height || f.quality}p`, stream_url: createStreamToken(youtubeUrl, f.height || f.quality, 'video', hostHeader).streamUrl })),
        audio: (videoInfo.audio_formats || []).map(f => ({ quality: `${f.quality || '128'}kbps`, stream_url: createStreamToken(youtubeUrl, f.quality || '128', 'audio', hostHeader).streamUrl }))
      }
    };
  }
}

async function searchAndScrapeYoutube(query, hostHeader, page = 1, limit = 5) {
  const res = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error('Gagal terhubung ke YouTube');
  const html = await res.text();
  const match = html.match(/ytInitialData\s*=\s*({.*?});<\/script>/s);
  if (!match) throw new Error('Gagal mem-parsing data');

  const contents = JSON.parse(match[1]).contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

  const searchItems = [];
  for (const item of contents) {
    if (item.videoRenderer?.videoId) {
      const v = item.videoRenderer;
      searchItems.push({
        id: v.videoId,
        title: v.title?.runs?.[0]?.text || 'Untitled',
        channel: v.ownerText?.runs?.[0]?.text || 'Unknown',
        duration: v.lengthText?.simpleText || null,
        views: v.viewCountText?.simpleText || null,
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${v.videoId}`
      });
    }
  }

  const totalItems = searchItems.length;
  const totalPages = Math.ceil(totalItems / limit) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const pageItems = searchItems.slice((currentPage - 1) * limit, currentPage * limit);

  return {
    pagination: { page: currentPage, limit, total_items: totalItems, total_pages: totalPages },
    data: pageItems.map(item => ({
      ...item,
      resolutions: {
        video: ['360', '720', '1080'].map(q => ({ quality: `${q}p`, stream_url: createStreamToken(item.url, q, 'video', hostHeader).streamUrl })),
        audio: ['128'].map(q => ({ quality: `${q}kbps`, stream_url: createStreamToken(item.url, q, 'audio', hostHeader).streamUrl }))
      }
    }))
  };
}

module.exports = { 
  scrapeYoutube, 
  searchAndScrapeYoutube, 
  getOrResolveStreamUrl, 
  getVideoInfo,
  parseStreamToken,
  invalidateCachedUrl 
};
