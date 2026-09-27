const EPO_ROOT = 'https://ops.epo.org/3.2';
const EPO_REST_ROOT = 'https://ops.epo.org';
const GOOGLE_PATENTS_ROOT = 'https://patents.google.com';
let tokenCache = { value: '', expiresAt: 0 };

const entityMap = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = value => String(value || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => entityMap[n]);
const stripTags = value => decodeXml(String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
const decodeHtml = value => stripTags(String(value || '').replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' '));
const matchOne = (text, pattern) => stripTags(text.match(pattern)?.[1] || '');
const matchMany = (text, pattern) => [...text.matchAll(pattern)].map(x => stripTags(x[1])).filter(Boolean);

export function parseOpsXml(xml, kind = 'utility') {
  const total = Number(xml.match(/total-result-count=["'](\d+)["']/)?.[1] || xml.match(/total-result-count[^>]*>(\d+)</)?.[1] || 0);
  const blocks = [...xml.matchAll(/<(?:ops:)?exchange-document\b[\s\S]*?<\/(?:ops:)?exchange-document>/g)].map(x => x[0]);
  const seen = new Set();
  const results = [];
  for (const block of blocks) {
    const country = matchOne(block, /<(?:docdb:)?country>([\s\S]*?)<\/(?:docdb:)?country>/);
    const number = matchOne(block, /<(?:docdb:)?doc-number>([\s\S]*?)<\/(?:docdb:)?doc-number>/);
    const code = matchOne(block, /<(?:docdb:)?kind>([\s\S]*?)<\/(?:docdb:)?kind>/);
    const publication = `${country}${number}${code}`.replace(/\s/g, '');
    if (!publication || seen.has(publication)) continue;
    const isDesign = country === 'US' && (/^D/i.test(number) || /^S\d?$/i.test(code));
    if (kind === 'design' && !isDesign) continue;
    if (kind === 'utility' && isDesign) continue;
    seen.add(publication);
    const englishTitles = matchMany(block, /<(?:[^:>]+:)?invention-title\b[^>]*\blang=["']en["'][^>]*>([\s\S]*?)<\/(?:[^:>]+:)?invention-title>/gi);
    const titles = matchMany(block, /<(?:[^:>]+:)?invention-title\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?invention-title>/g);
    const applicants = matchMany(block, /<(?:[^:>]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?name>/g).slice(0, 3);
    const date = matchOne(block, /<(?:docdb:)?date>([\s\S]*?)<\/(?:docdb:)?date>/);
    results.push({
      publication,
      title: englishTitles.find(Boolean) || titles.find(Boolean) || 'Untitled patent document',
      applicants: [...new Set(applicants)],
      publicationDate: /^\d{8}$/.test(date) ? `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}` : date,
      country,
      kindCode: code,
      source: country === 'WO' ? 'WIPO/PCT via EPO OPS' : 'US via EPO OPS',
      type: isDesign ? 'design' : (code.startsWith('A') ? 'application' : 'utility'),
      url: `https://worldwide.espacenet.com/patent/search?q=pn%3D${encodeURIComponent(publication)}`,
      legalStatus: 'unknown'
    });
  }
  return { total, results };
}

const imageUrl = path => path ? `https://patentimages.storage.googleapis.com/${String(path).replace(/^\/+/, '')}` : '';

export function parseGoogleJson(payload, kind = 'utility', limit = 30) {
  const rows = (payload?.results?.cluster || []).flatMap(cluster => cluster?.result || []);
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const patent = row?.patent || {};
    const publication = String(patent.publication_number || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!publication || seen.has(publication)) continue;
    const isDesign = /^USD\d+S\d?$/i.test(publication);
    const isPct = /^WO/i.test(publication);
    if (kind === 'design' && !isDesign) continue;
    if (kind === 'utility' && (!/^US/i.test(publication) || isDesign)) continue;
    if (kind === 'pct' && !isPct) continue;
    seen.add(publication);
    const country = isPct ? 'WO' : 'US';
    const countryState = (patent.family_metadata?.aggregated?.country_status || [])
      .find(item => item?.country_code === country)?.best_patent_stage?.state || 'UNKNOWN';
    const figures = (patent.figures || []).slice(0, 8).map(item => imageUrl(item?.thumbnail || item?.full)).filter(Boolean);
    results.push({
      publication,
      title: decodeHtml(patent.title) || 'Untitled patent document',
      summary: decodeHtml(patent.snippet),
      applicants: patent.assignee ? [decodeHtml(patent.assignee)] : [],
      inventor: decodeHtml(patent.inventor),
      priorityDate: patent.priority_date || '',
      filingDate: patent.filing_date || '',
      publicationDate: patent.publication_date || '',
      country,
      kindCode: publication.match(/([A-Z]\d?|S\d?)$/)?.[1] || '',
      source: isPct ? 'Google Patents (WO/PCT)' : 'Google Patents (US)',
      type: isDesign ? 'design' : (/A\d?$/i.test(publication) ? 'application' : 'utility'),
      url: `${GOOGLE_PATENTS_ROOT}/patent/${encodeURIComponent(publication)}/en`,
      thumbnail: imageUrl(patent.thumbnail) || figures[0] || '',
      figures,
      legalStatus: String(countryState).toLowerCase()
    });
    if (results.length >= limit) break;
  }
  return { total: Number(payload?.results?.total_num_results || results.length), results };
}

function cors(origin, allowed) {
  const requested = origin || '';
  const allow = requested === allowed || requested.startsWith('http://localhost:') ? requested : allowed;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

async function getToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  if (!env.EPO_CLIENT_ID || !env.EPO_CLIENT_SECRET) throw new Error('EPO credentials are not configured');
  const credentials = btoa(`${env.EPO_CLIENT_ID}:${env.EPO_CLIENT_SECRET}`);
  const response = await fetch(`${EPO_ROOT}/auth/accesstoken`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`EPO authentication failed (${response.status})`);
  const data = await response.json();
  tokenCache = { value: data.access_token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 1200) - 60) * 1000 };
  return tokenCache.value;
}

function buildCql(params) {
  const { kind, keywords } = requestInputs(params);
  const country = kind === 'pct' ? 'WO' : 'US';
  const phrases = keywords.filter(word => word.includes(' '));
  const focused = phrases.length ? phrases : keywords.slice(0, 4);
  const clauses = focused.map(word => word.includes(' ') ? `ta all "${word.replace(/"/g, '')}"` : `ta="${word.replace(/"/g, '')}"`);
  const query = `(${clauses.join(' or ')}) and pn=${country}`;
  return { kind, query };
}

function requestInputs(params) {
  const kind = ['utility', 'design', 'pct'].includes(params.get('kind')) ? params.get('kind') : 'utility';
  const keywords = (params.get('keywords') || '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[a-z0-9][a-z0-9 -]{1,48}$/.test(x)).slice(0, 6);
  if (!keywords.length) throw new Error('At least one English keyword is required');
  const cpc = (params.get('cpc') || '').replace(/[^A-Za-z0-9/]/g, '').slice(0, 24);
  return { kind, keywords, cpc };
}

function buildGoogleEndpoint(params) {
  const { kind, keywords, cpc } = requestInputs(params);
  const phrases = keywords.filter(word => word.includes(' '));
  const focused = phrases.length ? phrases : keywords.slice(0, 4);
  const nested = new URLSearchParams();
  nested.set('q', `(${focused.map(word => word.includes(' ') ? `"${word}"` : word).join(' OR ')})`);
  nested.set('country', kind === 'pct' ? 'WO' : 'US');
  nested.set('language', 'ENGLISH');
  if (kind === 'design') nested.set('type', 'DESIGN');
  else nested.set('type', 'PATENT');
  // CPC remains available in the audit query, but is intentionally not an AND
  // filter here: product-level CPC guesses are often broad or imperfect and can
  // otherwise hide highly relevant keyword results.
  return { kind, query: nested.toString(), endpoint: `${GOOGLE_PATENTS_ROOT}/xhr/query?url=${encodeURIComponent(nested.toString())}&exp=` };
}

async function searchOps(request, env) {
  const url = new URL(request.url);
  const { kind, query } = buildCql(url.searchParams);
  const range = Math.min(50, Math.max(5, Number(url.searchParams.get('limit') || 24)));
  const cacheKey = new Request(`${url.origin}/cache/v2/${kind}/${encodeURIComponent(query)}/${range}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const token = await getToken(env);
  const endpoint = `${EPO_ROOT}/rest-services/published-data/search/biblio?q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/xml', Range: `1-${range}` } });
  if (!response.ok) throw new Error(`EPO search failed (${response.status}: ${response.headers.get('x-rejection-reason') || 'unknown'})`);
  const parsed = parseOpsXml(await response.text(), kind);
  parsed.results = parsed.results.map(item => ({ ...item, thumbnail: `${url.origin}/image?publication=${encodeURIComponent(item.publication)}` }));
  const result = Response.json({ ok: true, provider: 'EPO OPS', query, kind, total: parsed.total, results: parsed.results }, { headers: { 'Cache-Control': 'public, max-age=1800' } });
  await cache.put(cacheKey, result.clone());
  return result;
}

function publicationParts(value) {
  const match = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^(US|WO)(D?\d+)(A\d?|B\d?|S\d?)$/);
  if (!match) throw new Error('Invalid US/WO publication number');
  return { country: match[1], number: match[2], kind: match[3], epodoc: `${match[1]}${match[2]}.${match[3]}` };
}

async function patentImage(request, env) {
  const url = new URL(request.url);
  const parts = publicationParts(url.searchParams.get('publication'));
  const page = Math.min(6, Math.max(1, Number(url.searchParams.get('page') || 1)));
  const cacheKey = new Request(`${url.origin}/cache/image/${parts.epodoc}/${page}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const token = await getToken(env);
  const referenceCandidates = [...new Set([
    parts.epodoc,
    parts.kind === 'S' ? `${parts.country}${parts.number}.S1` : '',
    `${parts.country}${parts.number}`
  ].filter(Boolean))];
  let xml = '';
  let inquiryStatus = 404;
  for (const reference of referenceCandidates) {
    for (const root of [EPO_REST_ROOT, EPO_ROOT]) {
      const inquiryUrl = `${root}/rest-services/published-data/publication/epodoc/${encodeURIComponent(reference)}/images`;
      const inquiry = await fetch(inquiryUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/ops+xml' } });
      inquiryStatus = inquiry.status;
      if (inquiry.ok) { xml = await inquiry.text(); break; }
    }
    if (xml) break;
  }
  if (!xml) throw new Error(`EPO image inquiry failed (${inquiryStatus})`);
  const drawingBlock = xml.match(/<(?:ops:)?document-instance\b[^>]*\bdesc=["']Drawing["'][\s\S]*?<\/(?:ops:)?document-instance>/i)?.[0] || '';
  const link = drawingBlock.match(/\blink=["']([^"']+)["']/i)?.[1] || xml.match(/<(?:ops:)?document-instance\b[^>]*\blink=["']([^"']+\/thumbnail)["']/i)?.[1];
  const sourceSystem = drawingBlock.match(/\bsystem=["']([^"']+)["']/i)?.[1] || '';
  if (!link) throw new Error('No patent drawing is available');
  let imageResponse;
  const cleanLink = link.replace(/^\/+/, '');
  const imagePath = cleanLink.startsWith('published-data/images/') ? `/rest-services/${cleanLink}` : `/rest-services/published-data/images/${cleanLink}`;
  const firstPagePath = imagePath.replace(/\/thumbnail$/i, '/firstpage');
  const variants = [{ path: imagePath, accept: 'image/png' }, { path: firstPagePath, accept: 'image/jpeg' }];
  for (const root of [EPO_ROOT, EPO_REST_ROOT]) {
    for (const variant of variants) {
      const query = new URLSearchParams({ Range: String(page) });
      if (sourceSystem) query.set('From', sourceSystem);
      imageResponse = await fetch(`${root}${variant.path}?${query}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: variant.accept, 'X-OPS-Range': String(page) }
      });
      if (imageResponse.ok && (imageResponse.headers.get('content-type') || '').startsWith('image/')) break;
    }
    if (imageResponse?.ok && (imageResponse.headers.get('content-type') || '').startsWith('image/')) break;
  }
  if (!imageResponse?.ok) throw new Error(`EPO image retrieval failed (${imageResponse?.status || 502})`);
  const contentType = imageResponse.headers.get('content-type') || 'image/png';
  if (!contentType.startsWith('image/')) throw new Error('EPO did not return an image');
  const result = new Response(imageResponse.body, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=604800' } });
  await cache.put(cacheKey, result.clone());
  return result;
}

async function searchGoogle(request) {
  const url = new URL(request.url);
  const { kind, query, endpoint } = buildGoogleEndpoint(url.searchParams);
  const limit = Math.min(50, Math.max(5, Number(url.searchParams.get('limit') || 24)));
  const cacheKey = new Request(`${url.origin}/cache/google/${kind}/${encodeURIComponent(query)}/${limit}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (compatible; AmazonPatentRiskWorkbench/1.0; +https://meibeiwu.github.io/us-patent-risk-workbench/)'
    }
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'Google Patents request limit reached; please retry later' : `Google Patents search failed (${response.status})`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error('Google Patents temporarily rejected automated search; please retry later');
  const parsed = parseGoogleJson(await response.json(), kind, limit);
  const result = Response.json({ ok: true, provider: 'Google Patents', query, kind, total: parsed.total, results: parsed.results }, { headers: { 'Cache-Control': 'public, max-age=1800' } });
  await cache.put(cacheKey, result.clone());
  return result;
}

async function search(request, env) {
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider') || (env.EPO_CLIENT_ID && env.EPO_CLIENT_SECRET ? 'epo' : 'google');
  return provider === 'epo' ? searchOps(request, env) : searchGoogle(request);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin, env.ALLOWED_ORIGIN || 'https://meibeiwu.github.io');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health') return Response.json({ ok: true, provider: 'Google Patents', searchReady: true, epoConfigured: Boolean(env.EPO_CLIENT_ID && env.EPO_CLIENT_SECRET) }, { headers });
      if (url.pathname === '/image' && request.method === 'GET') {
        try {
          const response = await patentImage(request, env);
          const merged = new Headers(response.headers);Object.entries(headers).forEach(([k,v])=>merged.set(k,v));
          return new Response(response.body, { status: response.status, headers: merged });
        } catch {
          return new Response(null, { status: 204, headers: { ...headers, 'Cache-Control': 'public, max-age=3600', 'X-Image-Unavailable': 'true' } });
        }
      }
      if (url.pathname !== '/search' || request.method !== 'GET') return Response.json({ ok: false, error: 'Not found' }, { status: 404, headers });
      const response = await search(request, env);
      const merged = new Headers(response.headers);Object.entries(headers).forEach(([k,v])=>merged.set(k,v));
      return new Response(response.body, { status: response.status, headers: merged });
    } catch (error) {
      return Response.json({ ok: false, error: error.message || 'Search failed' }, { status: 400, headers });
    }
  }
};
